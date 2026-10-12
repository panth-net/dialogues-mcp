import fs from "node:fs";
import { getCorpusCapsule, listCorpusCapsules } from "./loader.js";
import type { CorpusCapsule } from "./types.js";
import { countWords, GenericIndex } from "../db/genericIndex.js";
import { openDatabase, tableColumns } from "../db/sqlite.js";

export type CorpusSize = {
  id: string;
  title: string;
  indexed: boolean;
  documents: number;
  chunks: number;
  words: number | null;
  index_bytes: number;
  index_size: string;
  index_path: string;
};

function countWordsFromChunks(indexPath: string): number {
  const db = openDatabase(indexPath, { readOnly: true });
  try {
    const textColumn = tableColumns(db, "chunks").has("text_raw") ? "text_raw" : "text_norm";
    let words = 0;
    for (const row of db.prepare(`SELECT ${textColumn} AS text FROM chunks`).iterate() as Iterable<{ text: string }>) {
      words += countWords(row.text ?? "");
    }
    return words;
  } finally {
    db.close();
  }
}

/**
 * Local size from file stats and index metadata. Word counts come from the
 * metadata written at build time; older indexes are only scanned when the
 * caller asks for exact words (the `corpus size` command), never for listing.
 */
export function corpusSize(capsule: CorpusCapsule, options: { exactWords?: boolean } = {}): CorpusSize {
  const indexPath = capsule.indexPath;
  if (!fs.existsSync(indexPath)) {
    return {
      id: capsule.id,
      title: capsule.manifest.title,
      indexed: false,
      documents: 0,
      chunks: 0,
      words: 0,
      index_bytes: 0,
      index_size: formatBytes(0),
      index_path: indexPath
    };
  }
  const index = new GenericIndex(capsule);
  let stats;
  let generation;
  try {
    stats = index.stats();
    generation = index.generation();
  } finally {
    index.close();
  }
  const words = generation?.words ?? (options.exactWords ? countWordsFromChunks(indexPath) : null);
  const bytes = fs.statSync(indexPath).size;
  return {
    id: capsule.id,
    title: capsule.manifest.title,
    indexed: true,
    documents: stats.documents,
    chunks: stats.chunks,
    words,
    index_bytes: bytes,
    index_size: formatBytes(bytes),
    index_path: indexPath
  };
}

export function indexBytes(capsule: CorpusCapsule): number {
  try {
    return fs.statSync(capsule.indexPath).size;
  } catch {
    return 0;
  }
}

export function listCorpusSizes(corpusId?: string): { ok: boolean; sizes: CorpusSize[]; errors: Array<{ rootPath: string; corpusId?: string; message: string }> } {
  if (corpusId) {
    return { ok: true, sizes: [corpusSize(getCorpusCapsule(corpusId), { exactWords: true })], errors: [] };
  }
  const { corpora, errors } = listCorpusCapsules();
  return {
    ok: errors.length === 0,
    sizes: corpora.map((capsule) => corpusSize(capsule, { exactWords: true })).sort((a, b) => (b.words ?? 0) - (a.words ?? 0)),
    errors
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Math.round(value * 10) / 10} ${units[unit]}`;
}
