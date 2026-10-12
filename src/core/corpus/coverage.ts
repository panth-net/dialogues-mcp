import type { CorpusCapsule } from "./types.js";
import { getGenericIndexStats } from "../db/genericIndex.js";
import { canDownloadText } from "../sources/rights.js";
import { selectedManifestItems } from "../sources/sourceManifest.js";
import { collectionState, sampleSummary, type CollectionState } from "../sources/download.js";

export type CorpusCoverage = {
  state: CollectionState;
  indexed: boolean;
  indexed_documents: number;
  indexed_chunks: number;
  selected_source_items: number | null;
  downloaded_source_items: number | null;
  selected_source_percent: number | null;
  manifest_items: number | null;
  full_archive_total: number | null;
  full_archive_percent: number | null;
  sample_available: boolean;
  coverage_note: string;
};

function percent(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

const STATE_NOTES: Record<CollectionState, string> = {
  catalog_only: "Catalog only: Dialogues lists where these documents are, but has no permitted text to download. Import your own permitted copy to search it.",
  user_supplied: "Your own collection: coverage depends on the files you imported.",
  not_downloaded: "Not downloaded yet. Nothing from this collection is on this computer.",
  sample: "A small sample is searchable. It is a deliberate selection, not the whole collection; more can be downloaded on request.",
  partial_selection: "Part of the curated source list is searchable. Some items are not downloaded, failed, or were left out on purpose.",
  selected_set_complete: "The curated source list shipped with Dialogues is downloaded. That list is a selection, not the full external archive."
};

export function corpusCoverage(capsule: CorpusCapsule): CorpusCoverage {
  const stats = getGenericIndexStats(capsule);
  const { state, manifest, download } = collectionState(capsule);
  // An index with no download record (a user import, or a migrated index)
  // is searchable even though no selection was recorded.
  const effective: CollectionState = state === "not_downloaded" && stats.indexed ? "partial_selection" : state;
  const selected = manifest ? selectedManifestItems(manifest) : [];
  const selectedText = selected.filter(canDownloadText);
  const downloaded = download ? selectedText.filter((item) => download.items[item.id]?.status === "text").length : null;
  return {
    state: effective,
    indexed: stats.indexed,
    indexed_documents: stats.documents,
    indexed_chunks: stats.chunks,
    selected_source_items: manifest ? selected.length : null,
    downloaded_source_items: downloaded,
    selected_source_percent: manifest && downloaded !== null ? percent(downloaded, selectedText.length) : null,
    manifest_items: manifest?.items.length ?? null,
    full_archive_total: null,
    full_archive_percent: null,
    sample_available: Boolean(sampleSummary(capsule)),
    coverage_note: effective === "partial_selection" && stats.indexed && !download?.approvals.length
      ? "Searchable from an earlier install or import; which items it covers was not recorded."
      : STATE_NOTES[effective]
  };
}
