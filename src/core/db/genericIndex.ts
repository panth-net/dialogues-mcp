import fs from "node:fs";
import path from "node:path";
import type { CorpusCapsule } from "../corpus/types.js";
import { assertCorpusIndexable } from "../corpus/loader.js";
import { makeStableId, parseStableId } from "../ids.js";
import { chunkText, normalizeChunkText } from "../import/chunk.js";
import { bindAll, countRows, integrityOk, openDatabase, tableColumns, transaction, type Database } from "./sqlite.js";
import { renameWithRetry, tempSibling } from "../state/files.js";
import { withCorpusWriter } from "../state/corpusLock.js";

export const INDEX_FORMAT_VERSION = 2;

export type GenericIndexStats = {
  indexed: boolean;
  documents: number;
  chunks: number;
  indexPath: string;
};

export type IndexGeneration = {
  generation_id: string;
  built_at: string;
  format_version: number;
  documents: number;
  chunks: number;
  words: number | null;
  coverage: string | null;
  selection: Record<string, unknown> | null;
};

export type ReindexOptions = {
  /** What this generation covers, e.g. "sample", "selected-set", "user-import". */
  coverage?: string;
  /** The approved selection the generation was built from. */
  selection?: Record<string, unknown>;
  /** The caller already holds this collection's writer lock (e.g. a download job). */
  lockHeld?: boolean;
};

export type GenericDocumentInput = {
  id: string;
  title: string;
  sourcePath: string;
  text: string;
  chunks?: GenericChunkInput[];
  author?: string | null;
  date?: string | null;
  language?: string | null;
  sourceUrl?: string | null;
  licenseNotice?: string | null;
  documentType?: string | null;
  sourceCollection?: string | null;
  sourceItemId?: string | null;
  rightsLevel?: string | null;
  selectionPaths?: string[];
  curatorScore?: number | null;
  metadata?: Record<string, unknown>;
};

export type GenericChunkInput = {
  chunkIndex?: number;
  text: string;
  citation?: string | null;
  metadata?: Record<string, unknown>;
};

export type SearchFilters = {
  author?: string;
  dateStart?: string;
  dateEnd?: string;
  language?: string;
  documentId?: string;
  path?: string;
  minCuratorScore?: number;
  documentType?: string;
};

export const LOCAL_SQLITE_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS corpora (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL,
  title TEXT,
  author TEXT,
  date TEXT,
  language TEXT,
  source_path TEXT,
  source_url TEXT,
  license_notice TEXT,
  document_type TEXT,
  source_collection TEXT,
  source_item_id TEXT,
  rights_level TEXT,
  selection_paths TEXT,
  curator_score INTEGER,
  metadata_json TEXT,
  FOREIGN KEY (corpus_id) REFERENCES corpora(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  text_raw TEXT NOT NULL,
  text_norm TEXT NOT NULL,
  citation TEXT,
  metadata_json TEXT,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chunks_corpus_idx ON chunks(corpus_id);
CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks(document_id, chunk_index);
CREATE INDEX IF NOT EXISTS documents_corpus_idx ON documents(corpus_id);
CREATE INDEX IF NOT EXISTS documents_author_idx ON documents(author);
CREATE INDEX IF NOT EXISTS documents_date_idx ON documents(date);
CREATE INDEX IF NOT EXISTS documents_language_idx ON documents(language);
CREATE INDEX IF NOT EXISTS documents_type_idx ON documents(document_type);
CREATE INDEX IF NOT EXISTS documents_source_item_idx ON documents(source_item_id);
CREATE INDEX IF NOT EXISTS documents_curator_score_idx ON documents(curator_score);

CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text_norm,
  corpus_id UNINDEXED,
  document_id UNINDEXED,
  chunk_id UNINDEXED
);
`;

export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export function normalizeText(input: string): string {
  return normalizeChunkText(input);
}

function citation(title: string | null, documentId: string, chunkIndex: number): string {
  return `${title?.trim() || documentId}, chunk ${chunkIndex}`;
}

function isLikelyNonEvidenceChunk(input: string): boolean {
  const text = input.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  if (!text) return true;
  if (lower.includes("project gutenberg") || lower.includes("gutenberg ebook")) return true;
  if (lower.includes("produced by") && lower.includes("transcrib")) return true;
  if (lower.includes("transcriber's note")) return true;
  if (lower.includes("selected from the compilation") && lower.includes("letters of")) return true;
  if (/^(contents|table of contents)\b/i.test(text)) return true;

  const dashCount = (text.match(/[—–]/g) ?? []).length;
  const sentenceCount = (text.match(/[.!?]/g) ?? []).length;
  const chapterListing = /\bchapter\s+(?:[ivxlcdm]+|\d+)\b/i.test(text);
  return dashCount >= 10 && sentenceCount <= 4 && (chapterListing || text.length < 1800);
}

function safeJsonParse(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function buildFilterSql(filters: SearchFilters = {}, documentColumns: Set<string>): { sql: string; bindings: unknown[] } {
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (filters.author) {
    clauses.push("LOWER(COALESCE(d.author, '')) LIKE LOWER(?)");
    bindings.push(`%${filters.author}%`);
  }
  if (filters.dateStart) {
    clauses.push("COALESCE(d.date, '') >= ?");
    bindings.push(filters.dateStart);
  }
  if (filters.dateEnd) {
    clauses.push("COALESCE(d.date, '') <= ?");
    bindings.push(filters.dateEnd);
  }
  if (filters.language) {
    clauses.push("LOWER(COALESCE(d.language, '')) = LOWER(?)");
    bindings.push(filters.language);
  }
  if (filters.documentId) {
    clauses.push("c.document_id = ?");
    bindings.push(filters.documentId);
  }
  if (filters.path) {
    if (documentColumns.has("selection_paths")) {
      clauses.push("(',' || COALESCE(d.selection_paths, '') || ',') LIKE ?");
      bindings.push(`%,${filters.path},%`);
    } else {
      clauses.push("0");
    }
  }
  if (filters.minCuratorScore !== undefined) {
    if (documentColumns.has("curator_score")) {
      clauses.push("COALESCE(d.curator_score, 0) >= ?");
      bindings.push(filters.minCuratorScore);
    } else {
      clauses.push("0");
    }
  }
  if (filters.documentType) {
    if (documentColumns.has("document_type")) {
      clauses.push("LOWER(COALESCE(d.document_type, '')) = LOWER(?)");
      bindings.push(filters.documentType);
    } else {
      clauses.push("0");
    }
  }
  return {
    sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "",
    bindings
  };
}

// Chunk text is indexed with Han characters spaced one per token, so an
// unspaced run like 黃山 must become the phrase "黃 山" to match.
function expandHanRunsForFts(query: string): string {
  return query.replace(/\p{Script=Han}{2,}/gu, (run) => `"${[...run].join(" ")}"`);
}

export class GenericIndex {
  private db: Database;
  private documentColumns: Set<string>;

  constructor(private capsule: CorpusCapsule, readonly readonly = true) {
    if (!fs.existsSync(capsule.indexPath)) {
      throw new Error(`Index not found for ${capsule.id}. Run reindex_corpus first.`);
    }
    this.db = openDatabase(capsule.indexPath, { readOnly: readonly });
    this.documentColumns = tableColumns(this.db, "documents");
  }

  close(): void {
    this.db.close();
  }

  stats(): GenericIndexStats {
    return {
      indexed: true,
      documents: countRows(this.db, "documents"),
      chunks: countRows(this.db, "chunks"),
      indexPath: this.capsule.indexPath
    };
  }

  /**
   * Documents in this index other than `skipIds`, with their stored passages,
   * ready to be written into a new generation unchanged (same chunk numbers,
   * citations, and therefore the same passage IDs).
   */
  exportDocuments(skipIds: Set<string>): GenericDocumentInput[] {
    const documents = this.db.prepare("SELECT * FROM documents ORDER BY id").all() as Array<Record<string, unknown>>;
    const chunkQuery = this.db.prepare("SELECT chunk_index, text_raw, citation, metadata_json FROM chunks WHERE document_id = ? ORDER BY chunk_index");
    const value = (row: Record<string, unknown>, key: string) => (row[key] === undefined || row[key] === null ? null : String(row[key]));
    return documents.filter((row) => !skipIds.has(String(row.id))).map((row) => {
      const chunks = (chunkQuery.all(String(row.id)) as Array<{ chunk_index: number; text_raw: string; citation: string | null; metadata_json: string | null }>).map((chunk) => ({
        chunkIndex: Number(chunk.chunk_index),
        text: chunk.text_raw,
        citation: chunk.citation,
        metadata: safeJsonParse(chunk.metadata_json)
      }));
      return {
        id: String(row.id),
        title: value(row, "title") ?? String(row.id),
        sourcePath: value(row, "source_path") ?? "",
        text: chunks.map((chunk) => chunk.text).join("\n\n"),
        chunks,
        author: value(row, "author"),
        date: value(row, "date"),
        language: value(row, "language"),
        sourceUrl: value(row, "source_url"),
        licenseNotice: value(row, "license_notice"),
        documentType: value(row, "document_type"),
        sourceCollection: value(row, "source_collection"),
        sourceItemId: value(row, "source_item_id"),
        rightsLevel: value(row, "rights_level"),
        selectionPaths: (value(row, "selection_paths") ?? "").split(",").filter(Boolean),
        curatorScore: row.curator_score === null || row.curator_score === undefined ? null : Number(row.curator_score),
        metadata: { ...safeJsonParse(value(row, "metadata_json")), kept_from_previous_search_file: true }
      };
    });
  }

  generation(): IndexGeneration | null {
    if (!tableColumns(this.db, "index_meta").size) return null;
    const rows = this.db.prepare("SELECT key, value FROM index_meta").all() as Array<{ key: string; value: string }>;
    const meta = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    if (!meta.generation_id) return null;
    let selection: Record<string, unknown> | null = null;
    try {
      selection = meta.selection ? JSON.parse(meta.selection) as Record<string, unknown> : null;
    } catch {
      selection = null;
    }
    return {
      generation_id: meta.generation_id,
      built_at: meta.built_at ?? "",
      format_version: Number(meta.format_version ?? 0),
      documents: Number(meta.documents ?? 0),
      chunks: Number(meta.chunks ?? 0),
      words: meta.words ? Number(meta.words) : null,
      coverage: meta.coverage ?? null,
      selection
    };
  }

  availablePaths(): string[] {
    if (!this.documentColumns.has("selection_paths")) return [];
    const rows = this.db
      .prepare("SELECT selection_paths FROM documents WHERE COALESCE(selection_paths, '') <> ''")
      .all() as Array<{ selection_paths: string | null }>;
    return [...new Set(rows.flatMap((row) => (row.selection_paths ?? "").split(",").filter(Boolean)))].sort();
  }

  private documentColumn(name: string): string {
    return this.documentColumns.has(name) ? `d.${name} AS ${name}` : `NULL AS ${name}`;
  }

  // How many chunks match in total, and how they spread across documents and
  // dates - so answers can sample representatively and say when more exists.
  matchStats(query: string, filters: SearchFilters = {}) {
    const filter = buildFilterSql(filters, this.documentColumns);
    const rows = this.db
      .prepare(
        `SELECT
           c.document_id AS document_id,
           ${this.documentColumn("title")},
           ${this.documentColumn("date")},
           COUNT(*) AS matches
         FROM chunks_fts
         JOIN chunks c ON chunks_fts.chunk_id = c.id
         LEFT JOIN documents d ON d.id = c.document_id
         WHERE chunks_fts MATCH ?
         ${filter.sql}
         GROUP BY c.document_id
         ORDER BY matches DESC`
      )
      .all(...bindAll([expandHanRunsForFts(query), ...filter.bindings])) as Array<{
        document_id: string;
        title: string | null;
        date: string | null;
        matches: number;
      }>;
    const documents = rows.map((row) => ({ ...row, matches: Number(row.matches) }));
    return {
      total_matches: documents.reduce((sum, row) => sum + row.matches, 0),
      documents
    };
  }

  search(query: string, limit: number, filters: SearchFilters = {}) {
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    const filter = buildFilterSql(filters, this.documentColumns);
    const ftsQuery = expandHanRunsForFts(query);
    const rows = this.db
      .prepare(
        `SELECT
           c.id AS chunk_id,
           c.document_id AS document_id,
           d.title AS title,
           d.author AS author,
           d.date AS date,
           d.language AS language,
           ${this.documentColumn("document_type")},
           ${this.documentColumn("source_collection")},
           ${this.documentColumn("source_item_id")},
           ${this.documentColumn("rights_level")},
           ${this.documentColumn("selection_paths")},
           ${this.documentColumn("curator_score")},
           c.chunk_index AS chunk_index,
           c.citation AS citation,
           c.metadata_json AS chunk_metadata_json,
           d.metadata_json AS document_metadata_json,
           snippet(chunks_fts, 0, '[', ']', '...', 32) AS snippet
         FROM chunks_fts
         JOIN chunks c ON chunks_fts.chunk_id = c.id
         LEFT JOIN documents d ON d.id = c.document_id
         WHERE chunks_fts MATCH ?
         ${filter.sql}
         ORDER BY bm25(chunks_fts)
         LIMIT ?`
      )
      .all(...bindAll([ftsQuery, ...filter.bindings, boundedLimit])) as Array<{
        document_id: string;
        title: string | null;
        author: string | null;
        date: string | null;
        language: string | null;
        document_type: string | null;
        source_collection: string | null;
        source_item_id: string | null;
        rights_level: string | null;
        selection_paths: string | null;
        curator_score: number | null;
        chunk_index: number;
        citation: string | null;
        chunk_metadata_json: string | null;
        document_metadata_json: string | null;
        snippet: string | null;
      }>;

    return rows.map((row) => ({
      id: makeStableId(this.capsule.id, row.document_id, row.chunk_index),
      corpus_id: this.capsule.id,
      document_id: row.document_id,
      title: row.title,
      chunk_index: row.chunk_index,
      snippet: row.snippet ?? "",
      citation: row.citation ?? citation(row.title, row.document_id, row.chunk_index),
      metadata: {
        author: row.author,
        date: row.date,
        language: row.language,
        document_type: row.document_type,
        source_collection: row.source_collection,
        source_item_id: row.source_item_id,
        rights_level: row.rights_level,
        selection_paths: row.selection_paths ? row.selection_paths.split(",").filter(Boolean) : [],
        curator_score: row.curator_score,
        document: safeJsonParse(row.document_metadata_json),
        chunk: safeJsonParse(row.chunk_metadata_json)
      }
    }));
  }

  fetch(id: string, contextWindow = 2) {
    const parsed = parseStableId(id);
    if (!parsed || parsed.corpusId !== this.capsule.id) {
      throw new Error(
        `Invalid ID. Expected corpus:${this.capsule.id}:doc:<document_id>:chunk:<chunk_index>`
      );
    }
    const boundedWindow = Math.max(0, Math.min(contextWindow, 10));
    const start = Math.max(0, parsed.chunkIndex - boundedWindow);
    const end = parsed.chunkIndex + boundedWindow;
    const rows = this.db
      .prepare(
        `SELECT c.document_id, d.title, d.author, d.date, d.language,
                ${this.documentColumn("document_type")},
                ${this.documentColumn("source_collection")},
                ${this.documentColumn("source_item_id")},
                ${this.documentColumn("rights_level")},
                ${this.documentColumn("selection_paths")},
                ${this.documentColumn("curator_score")},
                d.metadata_json AS document_metadata_json,
                c.chunk_index, c.text_raw, c.citation, c.metadata_json AS chunk_metadata_json
         FROM chunks c
         LEFT JOIN documents d ON d.id = c.document_id
         WHERE c.document_id = ? AND c.chunk_index BETWEEN ? AND ?
         ORDER BY c.chunk_index`
      )
      .all(parsed.documentId, start, end) as Array<{
        document_id: string;
        title: string | null;
        author: string | null;
        date: string | null;
        language: string | null;
        document_type: string | null;
        source_collection: string | null;
        source_item_id: string | null;
        rights_level: string | null;
        selection_paths: string | null;
        curator_score: number | null;
        document_metadata_json: string | null;
        chunk_index: number;
        text_raw: string;
        citation: string | null;
        chunk_metadata_json: string | null;
      }>;

    if (rows.length === 0) {
      throw new Error(`No passage found for ${id}`);
    }
    if (!rows.some((row) => row.chunk_index === parsed.chunkIndex)) {
      throw new Error(`Target passage not found for ${id}`);
    }

    return {
      id,
      corpus_id: this.capsule.id,
      document_id: parsed.documentId,
      context_window: boundedWindow,
      metadata: rows[0] ? {
        title: rows[0].title,
        author: rows[0].author,
        date: rows[0].date,
        language: rows[0].language,
        document_type: rows[0].document_type,
        source_collection: rows[0].source_collection,
        source_item_id: rows[0].source_item_id,
        rights_level: rows[0].rights_level,
        selection_paths: rows[0].selection_paths ? rows[0].selection_paths.split(",").filter(Boolean) : [],
        curator_score: rows[0].curator_score,
        document: safeJsonParse(rows[0].document_metadata_json)
      } : {},
      passages: rows.map((row) => ({
        chunk_index: row.chunk_index,
        text: row.text_raw,
        is_target: row.chunk_index === parsed.chunkIndex,
        citation: row.citation ?? citation(row.title, row.document_id, row.chunk_index),
        metadata: safeJsonParse(row.chunk_metadata_json)
      }))
    };
  }
}

export function getGenericIndexStats(capsule: CorpusCapsule): GenericIndexStats {
  if (!fs.existsSync(capsule.indexPath)) {
    return { indexed: false, documents: 0, chunks: 0, indexPath: capsule.indexPath };
  }
  const index = new GenericIndex(capsule);
  try {
    return index.stats();
  } finally {
    index.close();
  }
}

export function getIndexGeneration(capsule: CorpusCapsule): IndexGeneration | null {
  if (!fs.existsSync(capsule.indexPath)) return null;
  const index = new GenericIndex(capsule);
  try {
    return index.generation();
  } finally {
    index.close();
  }
}

function buildIndexFile(
  capsule: CorpusCapsule,
  filePath: string,
  documents: GenericDocumentInput[],
  options: ReindexOptions
): { documents: number; chunks: number; generationId: string } {
  const db = openDatabase(filePath);
  try {
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec(LOCAL_SQLITE_SCHEMA);
    const now = new Date().toISOString();
    const insertCorpus = db.prepare(
      "INSERT INTO corpora (id, title, manifest_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    );
    const insertDocument = db.prepare(
      `INSERT INTO documents
       (id, corpus_id, title, author, date, language, source_path, source_url, license_notice,
        document_type, source_collection, source_item_id, rights_level, selection_paths, curator_score, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertChunk = db.prepare(
      `INSERT INTO chunks
       (id, corpus_id, document_id, chunk_index, text_raw, text_norm, citation, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertFts = db.prepare(
      "INSERT INTO chunks_fts (text_norm, corpus_id, document_id, chunk_id) VALUES (?, ?, ?, ?)"
    );
    const insertMeta = db.prepare("INSERT INTO index_meta (key, value) VALUES (?, ?)");
    const generationId = `${now.replace(/[-:.TZ]/g, "")}-${process.pid}`;
    let chunkCount = 0;
    let wordCount = 0;

    transaction(db, () => {
      insertCorpus.run(...bindAll([capsule.id, capsule.manifest.title, JSON.stringify(capsule.manifest), now, now]));
      for (const document of documents) {
        insertDocument.run(...bindAll([
          document.id,
          capsule.id,
          document.title,
          document.author,
          document.date,
          document.language,
          document.sourcePath,
          document.sourceUrl,
          document.licenseNotice,
          document.documentType,
          document.sourceCollection,
          document.sourceItemId,
          document.rightsLevel,
          (document.selectionPaths ?? []).join(","),
          document.curatorScore,
          JSON.stringify(document.metadata ?? {})
        ]));
        const chunks: GenericChunkInput[] = document.chunks?.length
          ? document.chunks
          : chunkText(document.text, capsule.manifest.chunking).map((chunk) => ({
              chunkIndex: chunk.chunk_index,
              text: chunk.text_raw
            }));

        chunks.forEach((chunk, index) => {
          const chunkIndex = chunk.chunkIndex ?? index;
          const textRaw = chunk.text.trim();
          if (!textRaw) return;
          if (isLikelyNonEvidenceChunk(textRaw)) return;
          const textNorm = normalizeText(textRaw);
          const stableChunkId = makeStableId(capsule.id, document.id, chunkIndex);
          const chunkCitation = chunk.citation ?? citation(document.title, document.id, chunkIndex);
          insertChunk.run(...bindAll([
            stableChunkId,
            capsule.id,
            document.id,
            chunkIndex,
            textRaw,
            textNorm,
            chunkCitation,
            JSON.stringify(chunk.metadata ?? {})
          ]));
          insertFts.run(...bindAll([textNorm, capsule.id, document.id, stableChunkId]));
          chunkCount += 1;
          wordCount += countWords(textRaw);
        });
      }
      const meta: Record<string, string> = {
        generation_id: generationId,
        built_at: now,
        format_version: String(INDEX_FORMAT_VERSION),
        documents: String(documents.length),
        chunks: String(chunkCount),
        words: String(wordCount),
        coverage: options.coverage ?? "",
        selection: JSON.stringify(options.selection ?? null)
      };
      for (const [key, value] of Object.entries(meta)) insertMeta.run(key, value);
    });

    // Validate the new generation before it may replace anything.
    const integrity = integrityOk(db);
    if (!integrity.ok) throw new Error(`New index failed integrity check: ${integrity.detail}`);
    const storedDocuments = countRows(db, "documents");
    const storedChunks = countRows(db, "chunks");
    if (storedDocuments !== documents.length || storedChunks !== chunkCount) {
      throw new Error(`New index is incomplete: expected ${documents.length} documents/${chunkCount} chunks, found ${storedDocuments}/${storedChunks}.`);
    }
    if (documents.length > 0 && storedChunks === 0) {
      throw new Error("New index contains no searchable passages; the previous index was kept.");
    }
    return { documents: storedDocuments, chunks: storedChunks, generationId };
  } finally {
    db.close();
  }
}

/**
 * Build a complete replacement index beside the current one, validate it,
 * then swap it in. A failed build leaves the previous index untouched and
 * searchable.
 */
export function reindexGenericCorpus(
  capsule: CorpusCapsule,
  documents: GenericDocumentInput[],
  options: ReindexOptions = {}
): GenericIndexStats {
  assertCorpusIndexable(capsule);
  if (documents.length === 0) {
    throw new Error(`No documents to index for ${capsule.id}; the previous index was kept.`);
  }
  const build = () => {
    fs.mkdirSync(path.dirname(capsule.indexPath), { recursive: true });
    const staged = tempSibling(capsule.indexPath, "building");
    const previous = tempSibling(capsule.indexPath, "previous");
    try {
      buildIndexFile(capsule, staged, documents, options);
      const hadPrevious = fs.existsSync(capsule.indexPath);
      if (hadPrevious) {
        try {
          renameWithRetry(capsule.indexPath, previous);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
            throw new Error(`The search file for ${capsule.id} is in use (for example by an open AI app). The previous search file is unchanged; close the app or wait, then run: dialogues reindex ${capsule.id}`);
          }
          throw error;
        }
      }
      try {
        renameWithRetry(staged, capsule.indexPath);
      } catch (error) {
        if (hadPrevious) renameWithRetry(previous, capsule.indexPath);
        throw error;
      }
      fs.rmSync(previous, { force: true });
    } finally {
      for (const leftover of [staged, `${staged}-journal`]) fs.rmSync(leftover, { force: true });
    }
    return getGenericIndexStats(capsule);
  };
  return options.lockHeld ? build() : withCorpusWriter(capsule.id, "rebuilding the search file", build);
}
