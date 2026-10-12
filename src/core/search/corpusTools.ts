import fs from "node:fs";
import type { CorpusCapsule } from "../corpus/types.js";
import { assertCorpusIndexable } from "../corpus/loader.js";
import { GenericIndex, type SearchFilters } from "../db/genericIndex.js";
import { VANGOGH_CORPUS_ID } from "../vangogh/ids.js";
import { buildIndexFromDownloads, loadDownloadState } from "../sources/download.js";
import { appendLogEvent } from "../logs/events.js";
import { canDownloadText, rightsSummary } from "../sources/rights.js";
import { selectedManifestItems, tryLoadSourceManifest } from "../sources/sourceManifest.js";
import type { SourceItem } from "../sources/types.js";
import { ruleSuggestions } from "./suggest.js";

const SEARCH_STOP_WORDS = new Set([
  "about",
  "after",
  "and",
  "are",
  "but",
  "can",
  "did",
  "does",
  "for",
  "from",
  "how",
  "into",
  "just",
  "like",
  "not",
  "the",
  "then",
  "they",
  "this",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with"
]);

function naturalLanguageSearchQuery(query: string): string {
  const trimmed = query.replace(/\s+/g, " ").trim();
  if (!trimmed) return "topic";
  if (/\bOR\b|\bAND\b|\bNEAR\b|['"*()]/i.test(trimmed)) return trimmed;
  const terms = [...trimmed.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]{1,}/gu)]
    .map((match) => match[0].toLowerCase())
    .filter((term) => term.length >= 3 && !SEARCH_STOP_WORDS.has(term));
  return [...new Set(terms)].slice(0, 8).join(" OR ") || trimmed;
}

/** Distinct search terms: each quoted phrase counts once; OR/AND/NEAR/NOT do not count. */
export function queryTermCount(query: string): number {
  const phrases = (query.match(/"[^"]+"/g) ?? []).map((phrase) => phrase.toLowerCase());
  const words = [...query.replace(/"[^"]+"/g, " ").matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)]
    .map((match) => match[0].toLowerCase())
    .filter((word) => word.length >= 2 && !/^(or|and|near|not)$/.test(word));
  return new Set([...phrases, ...words]).size;
}

export const WIDE_NET_TERMS = 6;

/**
 * Search matches words, not ideas, so a one- or two-word query finds only the
 * passages that use those exact words. Say so in the response, where the model
 * decides its next query, rather than only in instructions it read at startup.
 */
export function wideNetHint(termCount: number): string | null {
  if (termCount >= WIDE_NET_TERMS) return null;
  const used = termCount === 1 ? "1 word, so it found only passages that contain it" : `${termCount} words, so it found only passages that contain them`;
  return `This search used ${used}. Searches here work best as a wide net: 8 to 20 words joined with OR - the subject's plain and formal names, synonyms, the person's and the period's own words, opposites, and the names of people, places, and things tied to it.`;
}

function isFtsSyntaxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fts|match|syntax|no such column/i.test(message);
}

function ensureReadableIndex(capsule: CorpusCapsule, filters: SearchFilters = {}): void {
  if (fs.existsSync(capsule.indexPath)) return;
  const noText = noSearchableTextResponse(capsule, "", filters);
  if (noText) {
    throw new Error(noText.next_steps.message);
  }
  if (capsule.source === "built_in") {
    throw new Error(
      `${capsule.manifest.title} is not downloaded yet. Ask to download it (a small sample is offered for some collections), or run: dialogues corpus download ${capsule.id}`
    );
  }
  throw new Error(`No search file for ${capsule.id} yet. Run: dialogues reindex ${capsule.id}`);
}

function selectionLabel(capsule: CorpusCapsule, filters: SearchFilters = {}): string {
  return filters.path ? `path ${filters.path}` : `corpus ${capsule.id}`;
}

function sourceItemTitle(item: SourceItem): string {
  return item.title ?? item.id;
}

function noSearchableTextMessage(capsule: CorpusCapsule, items: SourceItem[], filters: SearchFilters = {}): string {
  const label = selectionLabel(capsule, filters);
  const examples = items.slice(0, 3).map(sourceItemTitle).join("; ");
  return [
    `${label} has no readable text installed yet - its entries point at archives that offer no machine-readable text to download.`,
    examples ? `They include: ${examples}.` : "",
    `To make it searchable, import a permitted copy locally (dialogues import-folder), or suggest another collection that already has text.`
  ].filter(Boolean).join(" ");
}

function noSearchableTextResponse(capsule: CorpusCapsule, query: string, filters: SearchFilters = {}) {
  const manifest = tryLoadSourceManifest(capsule);
  if (!manifest) return null;
  const items = selectedManifestItems(manifest, { path: filters.path });
  if (items.length === 0) return null;
  const textItems = items.filter(canDownloadText);
  if (textItems.length > 0) return null;
  const message = noSearchableTextMessage(capsule, items, filters);
  return {
    ok: true,
    query,
    count: 0,
    results: [],
    source_status: "no_searchable_text",
    corpus_id: capsule.id,
    path: filters.path ?? null,
    rights_summary: rightsSummary(items),
    no_text_items: items.length,
    warning: message,
    next_steps: {
      message,
      suggested_queries: []
    }
  };
}

function pathNotIndexedResponse(capsule: CorpusCapsule, query: string, filters: SearchFilters = {}) {
  if (!filters.path) return null;
  const manifest = tryLoadSourceManifest(capsule);
  if (!manifest) return null;
  const items = selectedManifestItems(manifest, { path: filters.path });
  if (items.length === 0 || items.every((item) => !canDownloadText(item))) return null;
  const message = [
    `Path ${filters.path} has downloadable source text in the manifest, but it is not present in the local index.`,
    `Run: dialogues corpus download ${capsule.id} --path ${filters.path} --yes`,
    "Then search again and fetch exact passages before answering."
  ].join(" ");
  return {
    ok: true,
    query,
    count: 0,
    results: [],
    source_status: "path_not_indexed",
    corpus_id: capsule.id,
    path: filters.path,
    rights_summary: rightsSummary(items),
    no_text_items: 0,
    warning: message,
    next_steps: {
      message,
      suggested_queries: []
    }
  };
}

function validatePathFilter(capsule: CorpusCapsule, index: GenericIndex, filters: SearchFilters): void {
  if (!filters.path) return;
  const manifest = tryLoadSourceManifest(capsule);
  const manifestPaths = manifest ? Object.keys(manifest.paths).sort() : [];
  const indexedPaths = index.availablePaths();
  const available = manifestPaths.length ? manifestPaths : indexedPaths;
  if (available.length && !available.includes(filters.path)) {
    throw new Error(`Unknown path: ${filters.path}. Available paths: ${available.join(", ")}`);
  }
}

export function searchCorpus(capsule: CorpusCapsule, query: string, limit = 10, filters: SearchFilters = {}) {
  const started = Date.now();
  try {
    const noText = noSearchableTextResponse(capsule, query, filters);
    if (noText) return noText;
    const response = (() => {
      ensureReadableIndex(capsule, filters);
      const index = new GenericIndex(capsule);
      try {
        validatePathFilter(capsule, index, filters);
        const indexedPaths = index.availablePaths();
        if (filters.path && indexedPaths.length && !indexedPaths.includes(filters.path)) {
          const notIndexed = pathNotIndexedResponse(capsule, query, filters);
          if (notIndexed) return notIndexed;
        }
        let usedQuery = naturalLanguageSearchQuery(query);
        let results;
        try {
          results = index.search(usedQuery, limit, filters);
        } catch (error) {
          if (!isFtsSyntaxError(error) || usedQuery === query) throw error;
          usedQuery = naturalLanguageSearchQuery(query.replace(/\b(?:AND|OR|NEAR)\b/gi, " "));
          results = index.search(usedQuery, limit, filters);
        }
        const noTextAfterSearch = results.length === 0 ? noSearchableTextResponse(capsule, query, filters) : null;
        if (noTextAfterSearch) return noTextAfterSearch;
        const stats = results.length > 0
          ? index.matchStats(usedQuery, filters)
          : { total_matches: 0, documents: [] as ReturnType<GenericIndex["matchStats"]>["documents"] };
        const spreadDates = stats.documents
          .map((doc) => doc.date)
          .filter((date): date is string => Boolean(date))
          .sort();
        const dateSpan = spreadDates.length > 1 ? `, ${spreadDates[0]} to ${spreadDates[spreadDates.length - 1]}` : "";
        const hint = wideNetHint(queryTermCount(query));
        const sampled = stats.total_matches > results.length
          ? `Sampled ${results.length} of ${stats.total_matches} matching passages across ${stats.documents.length} document(s)${dateSpan}. Sample across the spread before answering, and tell the user more passages exist if they want fuller coverage.`
          : "Fetch promising hits before answering. Snippets are for triage, not final evidence.";
        return {
          ok: true,
          query,
          count: results.length,
          results,
          total_matches: stats.total_matches,
          matched_documents: stats.documents.length,
          match_spread: stats.documents.slice(0, 20),
          next_steps: {
            message: hint ? `${hint} ${sampled}` : sampled,
            // A narrow query also gets the curator's wider queries for this collection, when any match.
            suggested_queries: hint ? ruleSuggestions(capsule, query).slice(0, 3).map((item) => item.query) : []
          }
        };
      } finally {
        index.close();
      }
    })();
    appendLogEvent("searches", {
      command: "search",
      corpus_id: capsule.id,
      query,
      result_count: response.count,
      index_path: capsule.indexPath,
      duration_ms: Date.now() - started
    });
    return response;
  } catch (error) {
    appendLogEvent("errors", {
      command: "search",
      corpus_id: capsule.id,
      query,
      error: error instanceof Error ? error.message : String(error),
      index_path: capsule.indexPath,
      duration_ms: Date.now() - started
    });
    throw error;
  }
}

export function fetchCorpus(capsule: CorpusCapsule, id: string, contextWindow = 2) {
  const started = Date.now();
  try {
    const response = (() => {
      ensureReadableIndex(capsule);
      const index = new GenericIndex(capsule);
      try {
        return {
          ok: true,
          ...index.fetch(id, contextWindow),
          next_steps: {
            message: "Use fetched passages as evidence. Mention source limits and gaps when relevant.",
            suggested_queries: []
          }
        };
      } finally {
        index.close();
      }
    })();
    appendLogEvent("fetches", {
      command: "fetch",
      corpus_id: capsule.id,
      fetched_id: id,
      context_window: contextWindow,
      index_path: capsule.indexPath,
      duration_ms: Date.now() - started
    });
    return response;
  } catch (error) {
    appendLogEvent("errors", {
      command: "fetch",
      corpus_id: capsule.id,
      fetched_id: id,
      context_window: contextWindow,
      error: error instanceof Error ? error.message : String(error),
      index_path: capsule.indexPath,
      duration_ms: Date.now() - started
    });
    throw error;
  }
}

export function searchCorpusWithContext(
  capsule: CorpusCapsule,
  query: string,
  limit = 5,
  contextWindow = 1,
  filters: SearchFilters = {}
) {
  const boundedLimit = Math.max(1, Math.min(limit, 10));
  const search = searchCorpus(capsule, query, boundedLimit, filters);
  if (search.results.length === 0) {
    const warning = "warning" in search ? search.warning : undefined;
    const wider = ruleSuggestions(capsule, query).slice(0, 3).map((item) => item.query);
    return {
      ...search,
      warning: warning ?? "No results. Try source-specific vocabulary from the guide and search rules.",
      results: [],
      next_steps: {
        message: search.next_steps.message,
        suggested_queries: [...new Set([...search.next_steps.suggested_queries, ...wider])]
      }
    };
  }
  const index = new GenericIndex(capsule);
  try {
    return {
      ok: true,
      query,
      count: search.results.length,
      ...("total_matches" in search
        ? {
            total_matches: search.total_matches,
            matched_documents: search.matched_documents,
            match_spread: search.match_spread
          }
        : {}),
      warning: "Use this for exploration. Fetch exact passages again before making deep claims.",
      results: search.results.map((hit) => ({
        ...hit,
        context: index.fetch(hit.id, Math.max(0, Math.min(contextWindow, 5))).passages
      })),
      next_steps: {
        message: [wideNetHint(queryTermCount(query)), "Choose the best hit IDs and call fetch with enough context before answering."].filter(Boolean).join(" "),
        suggested_queries: search.next_steps.suggested_queries
      }
    };
  } finally {
    index.close();
  }
}

export async function reindexCorpus(capsule: CorpusCapsule) {
  const started = Date.now();
  assertCorpusIndexable(capsule);
  try {
    // Format parsers load only when a rebuild actually needs them.
    const { reindexUserCorpus } = await import("../import/importFolder.js");
    const { hasVanGoghLocalImport, reindexVanGoghLocalImport } = await import("../vangogh/import.js");
    const response = capsule.source !== "built_in"
      ? await reindexUserCorpus(capsule)
      : capsule.id === VANGOGH_CORPUS_ID && hasVanGoghLocalImport() && loadDownloadState(capsule.id).approvals.length === 0
        ? await reindexVanGoghLocalImport()
        : await (async () => {
            if (loadDownloadState(capsule.id).approvals.length === 0) {
              throw new Error(`Nothing has been downloaded for ${capsule.id} yet, so there is nothing to rebuild. Download it first: dialogues corpus download ${capsule.id}`);
            }
            const stats = await buildIndexFromDownloads(capsule.id);
            return { ok: true as const, corpus_id: capsule.id, source: "downloaded_text", ...stats };
          })();
    appendLogEvent("imports", {
      command: "reindex",
      corpus_id: capsule.id,
      result_count: "chunks" in response && typeof response.chunks === "number" ? response.chunks : undefined,
      index_path: response.indexPath,
      duration_ms: Date.now() - started
    });
    return response;
  } catch (error) {
    appendLogEvent("errors", {
      command: "reindex",
      corpus_id: capsule.id,
      error: error instanceof Error ? error.message : String(error),
      index_path: capsule.indexPath,
      duration_ms: Date.now() - started
    });
    throw error;
  }
}
