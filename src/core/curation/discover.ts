import fs from "node:fs";
import path from "node:path";
import { getSourceAdapter } from "../sources/adapters.js";
import type { SourceItem } from "../sources/types.js";
import { harvestRoot, listCandidates, openCandidateDb, upsertCandidate } from "./candidateDb.js";
import { fetchBytes } from "../sources/http.js";

const LOC_DOMAINS = ["loc.gov"];

export type DiscoverSource = "loc-lincoln";

export type DiscoverOptions = {
  source?: DiscoverSource;
  query?: string;
  limit?: number;
  pageSize?: number;
  delayMs?: number;
  fetchText?: boolean;
  force?: boolean;
  yes?: boolean;
};

type LocSearchResult = Record<string, unknown>;

const DEFAULT_LINCOLN_QUERIES = [
  "letter",
  "draft",
  "memorandum",
  "notes",
  "petition",
  "telegram",
  "pardon",
  "emancipation",
  "law",
  "case",
  "appointment"
];

function rawRoot(corpusId: string): string {
  return path.join(harvestRoot(corpusId), "raw");
}

function normalizedRoot(corpusId: string): string {
  return path.join(harvestRoot(corpusId), "normalized");
}

function discoveryReportPath(corpusId: string): string {
  return path.join(harvestRoot(corpusId), "discovery-report.md");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text || undefined;
  }
  if (Array.isArray(value)) {
    return value.map(stringValue).filter(Boolean).join("; ") || undefined;
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter((item): item is string => Boolean(item));
}

function locItemId(result: LocSearchResult): string | undefined {
  for (const value of [
    result.item_id,
    result.id,
    result.url,
    result.number_lccn,
    ...stringList(result.aka)
  ]) {
    const text = stringValue(value);
    const malMatch = text?.match(/\bmal\d+\b/i);
    if (malMatch) return malMatch[0].toLowerCase();
    const itemMatch = text?.match(/\/item\/([^/?#]+)\/?/i);
    if (itemMatch?.[1]) return itemMatch[1].toLowerCase();
  }
  return undefined;
}

function canonicalLocUrl(result: LocSearchResult, itemId: string): string {
  const url = stringValue(result.url) ?? stringValue(result.id);
  if (url && /\/item\//i.test(url)) return url.startsWith("http://") ? url.replace(/^http:/i, "https:") : url;
  return `https://www.loc.gov/item/${itemId}/`;
}

function hasAny(haystack: string, terms: string[]): boolean {
  return terms.some((term) => haystack.includes(term));
}

function documentTypeForLincoln(result: LocSearchResult): string {
  const title = stringValue(result.title)?.toLowerCase() ?? "";
  const description = stringValue(result.description)?.toLowerCase() ?? "";
  const subjects = stringList(result.subject).join(" ").toLowerCase();
  const haystack = `${title}\n${description}\n${subjects}`;
  if (hasAny(haystack, ["telegram"])) return "telegram";
  if (hasAny(haystack, ["draft"])) return "draft";
  if (hasAny(haystack, ["memorandum", "memo"])) return "memorandum";
  if (hasAny(haystack, ["notes", "note"])) return "notes";
  if (hasAny(haystack, ["petition"])) return "petition";
  if (hasAny(haystack, ["pardon"])) return "pardon";
  if (hasAny(haystack, ["order"])) return "order";
  if (hasAny(haystack, ["law", "legal", "court", "case"])) return "legal_paper";
  if (hasAny(haystack, ["letter", "correspondence", " to abraham lincoln", "abraham lincoln to "])) return "letter";
  return "archive_item";
}

function lincolnSignalsAndPaths(result: LocSearchResult, documentType: string): {
  score: number;
  signals: string[];
  paths: string[];
} {
  const title = stringValue(result.title)?.toLowerCase() ?? "";
  const description = stringValue(result.description)?.toLowerCase() ?? "";
  const subjects = stringList(result.subject).join(" ").toLowerCase();
  const haystack = `${title}\n${description}\n${subjects}\n${documentType}`;
  const signals = new Set<string>();
  const paths = new Set<string>();
  let score = 0;

  if (hasAny(haystack, ["abraham lincoln to ", "lincoln, abraham"])) {
    signals.add("authored_by_target");
    paths.add("public-private-lincoln");
    score += 3;
  }
  if (hasAny(haystack, [" to abraham lincoln", "petition", "request", "seeks", "recommend", "protest"])) {
    signals.add("incoming_pressure");
    paths.add("incoming-pressure");
    score += 2;
  }
  if (hasAny(haystack, ["letter", "correspondence"])) {
    signals.add("letter");
    score += 2;
  }
  if (hasAny(haystack, ["draft", "revision", "revised", "amendment", "memorandum", "notes"])) {
    signals.add("draft_or_revision");
    paths.add("public-private-lincoln");
    score += 4;
  }
  if (hasAny(haystack, ["emancipation", "slavery", "slave", "colored", "contraband"])) {
    signals.add("constitutional_reasoning");
    paths.add("emancipation-in-motion");
    score += 3;
  }
  if (hasAny(haystack, ["law", "legal", "court", "case", "constitution", "constitutional", "jury"])) {
    signals.add("legal_reasoning");
    paths.add("legal-mind");
    score += 3;
  }
  if (hasAny(haystack, ["war", "army", "troop", "general", "telegram", "order", "pardon", "appointment", "commission"])) {
    signals.add("practical_logistics");
    paths.add("war-as-paperwork");
    score += 2;
  }
  if (hasAny(haystack, ["joke", "humor", "anecdote", "story", "autobiographical"])) {
    signals.add("joke_or_humor");
    paths.add("humor-human-lincoln");
    score += 2;
  }
  if (hasAny(haystack, ["posthumous", "memorial", "mourning", "commemorative", "assassination"])) {
    paths.add("lincoln-after-lincoln");
    score -= 4;
  }
  if (hasAny(haystack, ["cover letter", "forwards letter", "forwarded letter", "sends letter", "sent letter", "printed circular", "circular letter", "printed letter", "pamphlet"])) {
    score -= 16;
  }

  if (paths.size === 0) paths.add("public-private-lincoln");
  return { score, signals: [...signals].sort(), paths: [...paths].sort() };
}

function lincolnCandidate(result: LocSearchResult): SourceItem | null {
  const itemId = locItemId(result);
  if (!itemId || !itemId.startsWith("mal")) return null;
  const documentType = documentTypeForLincoln(result);
  const scored = lincolnSignalsAndPaths(result, documentType);
  const title = stringValue(result.title);
  return {
    id: `loc:${itemId}`,
    source_type: "loc_item",
    url: canonicalLocUrl(result, itemId),
    title,
    author: /^abraham lincoln to /i.test(title ?? "") ? "Abraham Lincoln" : undefined,
    date: stringValue(result.date),
    document_type: documentType,
    rights_level: "no_known_restrictions",
    selected: false,
    paths: scored.paths,
    curator_score: scored.score,
    signals: scored.signals,
    metadata: {
      loc_item_id: itemId,
      loc_collection: "Abraham Lincoln Papers",
      loc_original_format: result.original_format,
      loc_subject: result.subject,
      loc_description: result.description,
      discovered_from: "loc-lincoln"
    }
  };
}

async function fetchJson(url: URL): Promise<Record<string, unknown>> {
  const response = await fetchBytes(url.toString(), { allowedDomains: LOC_DOMAINS, maxAttempts: 4 });
  return JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
}

function locSearchUrl(query: string, page: number, pageSize: number): URL {
  const url = new URL("https://www.loc.gov/collections/abraham-lincoln-papers/");
  url.searchParams.set("fo", "json");
  url.searchParams.set("c", String(pageSize));
  url.searchParams.set("sp", String(page));
  url.searchParams.set("at", "results,pagination");
  url.searchParams.set("fa", "original-format:manuscript/mixed material");
  if (query) url.searchParams.set("q", query);
  return url;
}

function writeDiscoveryReport(input: {
  corpusId: string;
  source: DiscoverSource;
  queries: string[];
  discovered: number;
  duplicates: number;
  skipped: number;
  fetchedText: number;
  metadataOnly: number;
  errors: Array<{ id: string; reason: string }>;
}): void {
  const lines = [
    `# Discovery Report: ${input.corpusId}`,
    "",
    `Generated: ${new Date().toISOString()}`,
    `Source: ${input.source}`,
    `Queries: ${input.queries.join(", ")}`,
    "",
    "## Summary",
    "",
    `- New candidates: ${input.discovered}`,
    `- Duplicate candidates: ${input.duplicates}`,
    `- Skipped records: ${input.skipped}`,
    `- Fetched text: ${input.fetchedText}`,
    `- Metadata only: ${input.metadataOnly}`,
    `- Errors: ${input.errors.length}`,
    "",
    "## Errors",
    "",
    ...(input.errors.length ? input.errors.map((item) => `- ${item.id}: ${item.reason}`) : ["- None"])
  ];
  fs.mkdirSync(harvestRoot(input.corpusId), { recursive: true });
  fs.writeFileSync(discoveryReportPath(input.corpusId), `${lines.join("\n")}\n`, "utf8");
}

export async function discoverSources(corpusId: string, options: DiscoverOptions = {}) {
  if (!options.yes) {
    throw new Error("Source discovery can enumerate and optionally download broad archive material. Re-run with --yes after confirming source terms.");
  }
  const source = options.source ?? "loc-lincoln";
  if (source !== "loc-lincoln" || corpusId !== "lincoln-papers") {
    throw new Error("The first full-archive discovery source is loc-lincoln for corpus lincoln-papers.");
  }

  const queries = options.query
    ? options.query.split(",").map((query) => query.trim()).filter(Boolean)
    : DEFAULT_LINCOLN_QUERIES;
  const limit = Math.max(1, Math.min(options.limit ?? 500, 25000));
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 50, 100));
  const delayMs = Math.max(0, options.delayMs ?? 750);
  const db = openCandidateDb(corpusId);
  fs.mkdirSync(rawRoot(corpusId), { recursive: true });
  fs.mkdirSync(normalizedRoot(corpusId), { recursive: true });

  const existingCandidates = new Map(listCandidates(db, corpusId).map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>(existingCandidates.keys());
  const adapter = getSourceAdapter("loc_item");
  let discovered = 0;
  let duplicates = 0;
  let skipped = 0;
  let fetchedText = 0;
  let metadataOnly = 0;
  const errors: Array<{ id: string; reason: string }> = [];

  try {
    for (const query of queries) {
      let page = 1;
      while (discovered < limit) {
        const url = locSearchUrl(query, page, pageSize);
        const json = await fetchJson(url);
        const results = Array.isArray(json.results) ? json.results as LocSearchResult[] : [];
        if (results.length === 0) break;
        for (const result of results) {
          if (discovered >= limit) break;
          const candidate = lincolnCandidate(result);
          if (!candidate) {
            skipped += 1;
            continue;
          }
          const existing = existingCandidates.get(candidate.id);
          if (existing?.text_path && !options.force) {
            duplicates += 1;
            continue;
          }
          if (seen.has(candidate.id) && !existing) {
            duplicates += 1;
            continue;
          }
          if (!existing) {
            seen.add(candidate.id);
            upsertCandidate(db, corpusId, candidate);
            existingCandidates.set(candidate.id, {
              id: candidate.id,
              corpus_id: corpusId,
              source_type: candidate.source_type,
              source_url: candidate.url ?? null,
              api_url: candidate.api_url ?? null,
              title: candidate.title ?? null,
              author: candidate.author ?? null,
              recipient: candidate.recipient ?? null,
              date: candidate.date ?? null,
              document_type: candidate.document_type ?? null,
              rights_level: candidate.rights_level ?? "unknown",
              extraction_status: null,
              text_path: null,
              raw_path: null,
              metadata_json: JSON.stringify(candidate.metadata ?? {}),
              score: candidate.curator_score ?? 0,
              selected: candidate.selected ? 1 : 0,
              why_keep: candidate.why_keep ?? null,
              why_skip: candidate.why_skip ?? null,
              signals: candidate.signals ?? [],
              paths: candidate.paths ?? []
            });
            discovered += 1;
          }
          if (options.fetchText) {
            try {
              const fetched = await adapter.fetchItem(candidate, {
                rawRoot: rawRoot(corpusId),
                normalizedRoot: normalizedRoot(corpusId),
                force: options.force,
                http: { allowedDomains: LOC_DOMAINS }
              });
              if (fetched.status === "text") fetchedText += 1;
              else metadataOnly += 1;
              upsertCandidate(db, corpusId, candidate, {
                extractionStatus: fetched.status,
                textPath: fetched.textPath,
                rawPath: fetched.rawPath,
                metadata: fetched.metadata
              });
              const updated = existingCandidates.get(candidate.id);
              if (updated) {
                updated.extraction_status = fetched.status;
                updated.text_path = fetched.textPath ?? updated.text_path;
                updated.raw_path = fetched.rawPath ?? updated.raw_path;
              }
            } catch (error) {
              errors.push({ id: candidate.id, reason: error instanceof Error ? error.message : String(error) });
            }
            if (delayMs) await sleep(delayMs);
          }
        }
        page += 1;
        if (delayMs) await sleep(Math.min(delayMs, 1000));
      }
      if (discovered >= limit) break;
    }
  } finally {
    db.close();
  }

  writeDiscoveryReport({
    corpusId,
    source,
    queries,
    discovered,
    duplicates,
    skipped,
    fetchedText,
    metadataOnly,
    errors
  });

  return {
    ok: errors.length === 0,
    corpus_id: corpusId,
    source,
    queries,
    limit,
    discovered,
    duplicates,
    skipped,
    fetched_text: fetchedText,
    metadata_only: metadataOnly,
    errors,
    candidates_db_path: path.join(harvestRoot(corpusId), "candidates.sqlite"),
    harvest_path: harvestRoot(corpusId),
    discovery_report_path: discoveryReportPath(corpusId),
    note: "Discovered source records are candidates only. Review, score, and export selected records before adding them to the user-facing corpus."
  };
}
