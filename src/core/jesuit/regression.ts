import type { CorpusCapsule } from "../corpus/types.js";
import { composeCorpusGuide } from "../guides/compose.js";
import { fetchCorpus, searchCorpus } from "../search/corpusTools.js";
import { suggestSearches } from "../search/suggest.js";
import { JESUIT_CORPUS_ID } from "./sources.js";

export type JesuitRegressionPrompt = {
  prompt: string;
  starterQueries: string[];
};

export const JESUIT_REGRESSION_PROMPTS: JesuitRegressionPrompt[] = [
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

export function runJesuitRegression(capsule: CorpusCapsule) {
  if (capsule.id !== JESUIT_CORPUS_ID) {
    throw new Error(`Jesuit regression only supports ${JESUIT_CORPUS_ID}`);
  }

  const guide = composeCorpusGuide(capsule);
  const prompts = JESUIT_REGRESSION_PROMPTS.map((item) => {
    const suggested = suggestSearches(capsule, item.prompt).suggested_queries.map((suggestion) => suggestion.query);
    const queries = [...new Set([...item.starterQueries, ...suggested])].slice(0, 5);
    const searches = queries.map((query) => {
      const result = searchCorpus(capsule, query, 2);
      return {
        query,
        count: result.count,
        first_id: result.results[0]?.id ?? null,
        first_citation: result.results[0]?.citation ?? null
      };
    });
    const firstHit = searches.find((search) => search.first_id);
    const fetched = firstHit?.first_id ? fetchCorpus(capsule, firstHit.first_id, 1) : null;
    return {
      prompt: item.prompt,
      called_guide: guide.length > 0,
      searches,
      fetched_id: firstHit?.first_id ?? null,
      fetched_citations: fetched?.passages.map((passage) => passage.citation) ?? [],
      response_requirements: [
        "quote only fetched passages",
        "cite document/passage IDs",
        "synthesize beyond snippets",
        "mention missionary/colonial source limitations",
        "report weak or absent evidence"
      ],
      passes_workflow_smoke_test:
        guide.length > 0 &&
        searches.length >= 2 &&
        searches.some((search) => search.count > 0) &&
        Boolean(fetched?.passages.some((passage) => passage.is_target))
    };
  });

  return {
    ok: prompts.every((prompt) => prompt.passes_workflow_smoke_test),
    corpus_id: capsule.id,
    prompt_count: prompts.length,
    prompts,
    reminder:
      "This is a tool workflow smoke test. Final answers must still be written by an AI that reads the guide, searches, fetches, quotes/cites, synthesizes, and states source limitations."
  };
}
