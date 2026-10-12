import type { CorpusCapsule } from "./types.js";
import { composeCorpusGuide } from "../guides/compose.js";
import { getGenericIndexStats } from "../db/genericIndex.js";
import { fetchCorpus, searchCorpus } from "../search/corpusTools.js";
import { suggestSearches } from "../search/suggest.js";
import { canDownloadText, rightsLevelForItem } from "../sources/rights.js";
import { selectedManifestItems, tryLoadSourceManifest } from "../sources/sourceManifest.js";
import type { SourceItem, SourcePath } from "../sources/types.js";
import { JESUIT_CORPUS_ID } from "../jesuit/sources.js";

export type RegressionSearch = {
  query: string;
  path?: string;
  count: number;
  first_id: string | null;
  first_citation: string | null;
  error?: string;
};

export type CorpusRegressionPrompt = {
  prompt: string;
  path?: string;
  starterQueries: string[];
  searches: RegressionSearch[];
  fetched_id: string | null;
  fetched_citations: string[];
  response_requirements: string[];
  expected_no_text: boolean;
  note?: string;
  passes_workflow_smoke_test: boolean;
};

export type CorpusRegressionResponse = {
  ok: boolean;
  status: "passed" | "missing_index" | "catalog_or_user_supplied_only" | "failed";
  corpus_id: string;
  indexed: boolean;
  prompt_count: number;
  prompts: CorpusRegressionPrompt[];
  reminder: string;
  next_step: string;
};

type RegressionSeed = {
  prompt: string;
  starterQueries: string[];
  path?: string;
  expectedNoText?: boolean;
  note?: string;
};

const STOP_WORDS = new Set([
  "about",
  "after",
  "and",
  "are",
  "before",
  "between",
  "collection",
  "document",
  "documents",
  "from",
  "into",
  "letter",
  "letters",
  "notes",
  "papers",
  "path",
  "source",
  "that",
  "the",
  "their",
  "this",
  "through",
  "with"
]);

export const JESUIT_REGRESSION_PROMPTS: RegressionSeed[] = [
  {
    prompt: "What did the Wendat value about freedom?",
    starterQueries: [
      "liberty OR liberte OR freedom OR libre",
      "obey OR command OR commander",
      "Huron OR Wendat"
    ]
  },
  {
    prompt: "How did councils work?",
    starterQueries: [
      "council OR conseil OR assembly",
      "chief OR captain OR capitaine OR chef",
      "voice OR vote OR voices"
    ]
  },
  {
    prompt: "What do these documents misunderstand about Indigenous life?",
    starterQueries: [
      "custom OR coutume OR law OR loi",
      "savage OR sauvage",
      "superstition OR devil OR diable"
    ]
  },
  {
    prompt: "What would Graeber and Wengrow care about here?",
    starterQueries: [
      "council OR conseil OR liberty",
      "custom OR law OR authority",
      "chief OR captain OR obey"
    ]
  },
  {
    prompt: "Find moments where Jesuits seem confused or frustrated by Indigenous autonomy.",
    starterQueries: [
      "liberty OR libre OR independence",
      "refuse OR refused OR refusal",
      "obey OR command OR impatient"
    ]
  }
];

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function normalizeFtsQuery(query: string | null): string | null {
  if (!query) return null;
  const parts = query
    .split(/\s+OR\s+/i)
    .map((part) => part.replace(/[`"]/g, "").trim())
    .filter((part) => part && !part.includes("-") && !/[<>:]/.test(part))
    .filter((part) => /^[\p{L}\p{N}\s'.]+$/u.test(part))
    .slice(0, 8);
  return parts.length ? unique(parts).join(" OR ") : null;
}

function queryList(values: Array<string | null>): string[] {
  return unique(values.map(normalizeFtsQuery).filter((value): value is string => Boolean(value)));
}

function terms(input: string | undefined): string[] {
  return unique(input?.match(/[A-Za-z][A-Za-z0-9-]{2,}/g) ?? [])
    .map((term) => term.toLowerCase().replace(/-/g, " "))
    .flatMap((term) => term.split(/\s+/))
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
}

function queryFromTerms(inputTerms: string[]): string | null {
  const picked = unique(inputTerms)
    .filter((term) => /^[A-Za-z][A-Za-z0-9-]*$/.test(term))
    .slice(0, 5);
  return picked.length ? picked.join(" OR ") : null;
}

function sourceItemTerms(items: SourceItem[]): string[] {
  return items.flatMap((item) => [
    ...terms(item.title),
    ...terms(item.document_type),
    ...(item.signals ?? []).flatMap(terms),
    ...terms(item.why_keep)
  ]);
}

function manifestPromptSeeds(capsule: CorpusCapsule): RegressionSeed[] | null {
  const manifest = tryLoadSourceManifest(capsule);
  if (!manifest) return null;
  const selected = selectedManifestItems(manifest);
  return Object.entries(manifest.paths).map(([pathId, sourcePath]) => {
    const pathItems = selected.filter((item) => (item.paths ?? []).includes(pathId));
    const textItems = pathItems.filter(canDownloadText);
    const prompt = `Use the ${sourcePath.title} path to recover source evidence and limitations.`;
    const starterQueries = manifestStarterQueries(capsule, pathId, sourcePath, textItems);
    const expectedNoText = textItems.length === 0;
    return {
      prompt,
      path: pathId,
      starterQueries,
      expectedNoText,
      note: expectedNoText
        ? `No selected downloadable text items for this path; selected rights are ${rightsSummaryForPath(pathItems)}.`
        : undefined
    };
  });
}

function rightsSummaryForPath(items: SourceItem[]): string {
  const summary: Record<string, number> = {};
  for (const item of items) {
    const rights = rightsLevelForItem(item);
    summary[rights] = (summary[rights] ?? 0) + 1;
  }
  return Object.entries(summary).map(([rights, count]) => `${rights}:${count}`).join(", ") || "none";
}

function pathSearchRuleQueries(capsule: CorpusCapsule, pathId: string): string[] {
  const queries: string[] = [];
  for (const line of capsule.searchRules.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").map((cell) => cell.trim());
    if (cells.length < 4 || cells[1] !== pathId) continue;
    const vocabulary = cells[2] ?? "";
    const quoted = [...vocabulary.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    queries.push(...(quoted.length ? quoted : [vocabulary]));
  }
  return queries;
}

function manifestStarterQueries(
  capsule: CorpusCapsule,
  pathId: string,
  sourcePath: SourcePath,
  textItems: SourceItem[]
): string[] {
  const question = `${sourcePath.title} ${sourcePath.point ?? ""}`.trim();
  const suggested = suggestSearches(capsule, question).suggested_queries.map((item) => item.query);
  const fromSearchRules = pathSearchRuleQueries(capsule, pathId);
  const fromSignals = queryFromTerms(sourceItemTerms(textItems));
  const fromPath = queryFromTerms([...terms(sourcePath.title), ...terms(sourcePath.point)]);
  return queryList([
    ...fromSearchRules,
    fromSignals,
    ...suggested,
    fromPath
  ]).slice(0, 5);
}

function regressionSeeds(capsule: CorpusCapsule): RegressionSeed[] {
  if (capsule.id === JESUIT_CORPUS_ID) return JESUIT_REGRESSION_PROMPTS;
  const manifestSeeds = manifestPromptSeeds(capsule);
  if (manifestSeeds) return manifestSeeds;
  const suggested = suggestSearches(capsule, capsule.manifest.description).suggested_queries.map((item) => item.query);
  return [{
    prompt: `Search ${capsule.manifest.title} for source evidence, then fetch exact passages.`,
    starterQueries: unique([...suggested, "letter OR report OR account"]).slice(0, 5)
  }];
}

function searchSafely(capsule: CorpusCapsule, query: string, path?: string): RegressionSearch {
  try {
    const result = searchCorpus(capsule, query, 2, path ? { path } : {});
    return {
      query,
      path,
      count: result.count,
      first_id: result.results[0]?.id ?? null,
      first_citation: result.results[0]?.citation ?? null
    };
  } catch (error) {
    return {
      query,
      path,
      count: 0,
      first_id: null,
      first_citation: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function responseRequirements(capsule: CorpusCapsule, expectedNoText: boolean): string[] {
  const common = [
    "read the corpus guide first",
    "search before answering",
    "fetch exact passages before quoting",
    "cite document/chunk IDs",
    "report weak or absent evidence"
  ];
  if (expectedNoText) {
    return [
      "state that this path is catalog-only or user-supplied until permitted text is installed",
      "do not invent passage evidence from metadata",
      "use source notes and download options to explain the limitation"
    ];
  }
  if (capsule.id === JESUIT_CORPUS_ID) {
    return [...common, "mention missionary/colonial source limitations"];
  }
  return [...common, "mention source posture and rights limitations"];
}

export function runCorpusRegression(capsule: CorpusCapsule): CorpusRegressionResponse {
  const guide = composeCorpusGuide(capsule);
  const stats = getGenericIndexStats(capsule);
  const seeds = regressionSeeds(capsule);
  const prompts = seeds.map((seed) => {
    if (seed.expectedNoText) {
      return {
        prompt: seed.prompt,
        path: seed.path,
        starterQueries: seed.starterQueries,
        searches: [],
        fetched_id: null,
        fetched_citations: [],
        response_requirements: responseRequirements(capsule, true),
        expected_no_text: true,
        note: seed.note,
        passes_workflow_smoke_test: guide.length > 0
      };
    }

    const queries = queryList([
      ...seed.starterQueries,
      ...suggestSearches(capsule, seed.prompt).suggested_queries.map((suggestion) => suggestion.query)
    ]).slice(0, 5);
    const searches = queries.map((query) => searchSafely(capsule, query, seed.path));
    const firstHit = searches.find((search) => search.first_id);
    const fetched = firstHit?.first_id ? fetchCorpus(capsule, firstHit.first_id, 1) : null;
    return {
      prompt: seed.prompt,
      path: seed.path,
      starterQueries: seed.starterQueries,
      searches,
      fetched_id: firstHit?.first_id ?? null,
      fetched_citations: fetched?.passages.map((passage) => passage.citation) ?? [],
      response_requirements: responseRequirements(capsule, false),
      expected_no_text: false,
      note: seed.note,
      passes_workflow_smoke_test:
        guide.length > 0 &&
        searches.length >= 1 &&
        searches.some((search) => search.count > 0) &&
        Boolean(fetched?.passages.some((passage) => passage.is_target))
    };
  });

  const ok = prompts.every((prompt) => prompt.passes_workflow_smoke_test);
  const hasSearchablePrompt = prompts.some((prompt) => !prompt.expected_no_text);
  const status = ok
    ? hasSearchablePrompt ? "passed" : "catalog_or_user_supplied_only"
    : !stats.indexed && hasSearchablePrompt ? "missing_index" : "failed";
  const nextStep = status === "missing_index"
    ? `Install or download source text first, then rerun: dialogues corpus download ${capsule.id} --yes`
    : status === "catalog_or_user_supplied_only"
      ? "This corpus/path is catalog-only or user-supplied until permitted source text is installed."
      : status === "passed"
        ? "Use these smoke-test prompts as workflow checks; final answers still require fetched evidence."
        : "Inspect failed searches, source status, and guide vocabulary before release.";

  return {
    ok,
    status,
    corpus_id: capsule.id,
    indexed: stats.indexed,
    prompt_count: prompts.length,
    prompts,
    reminder:
      "This is a tool workflow smoke test. Final answers must still be written by an AI that reads the guide, searches, fetches, quotes/cites, synthesizes, and states source limitations.",
    next_step: nextStep
  };
}

export function runJesuitRegression(capsule: CorpusCapsule): CorpusRegressionResponse {
  if (capsule.id !== JESUIT_CORPUS_ID) {
    throw new Error(`Jesuit regression only supports ${JESUIT_CORPUS_ID}`);
  }
  return runCorpusRegression(capsule);
}
