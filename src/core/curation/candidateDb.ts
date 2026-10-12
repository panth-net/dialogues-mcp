import fs from "node:fs";
import path from "node:path";
import { assertSafeId, dataPath } from "../paths.js";
import { bindAll, openDatabase, type Database } from "../db/sqlite.js";
import type { RightsLevel, SourceItem } from "../sources/types.js";

export type CandidateRecord = {
  id: string;
  corpus_id: string;
  source_type: string;
  source_url: string | null;
  api_url: string | null;
  title: string | null;
  author: string | null;
  recipient: string | null;
  date: string | null;
  document_type: string | null;
  rights_level: RightsLevel | "unknown";
  extraction_status: string | null;
  text_path: string | null;
  raw_path: string | null;
  metadata_json: string | null;
  score: number;
  selected: number;
  why_keep: string | null;
  why_skip: string | null;
  signals: string[];
  paths: string[];
};

export function harvestRoot(corpusId: string): string {
  return dataPath("harvests", assertSafeId(corpusId, "corpus ID"));
}

export function curationRoot(corpusId: string): string {
  return dataPath("curation", assertSafeId(corpusId, "corpus ID"));
}

export function candidateDbPath(corpusId: string): string {
  return path.join(harvestRoot(corpusId), "candidates.sqlite");
}

export function openCandidateDb(corpusId: string): Database {
  fs.mkdirSync(harvestRoot(corpusId), { recursive: true });
  const db = openDatabase(candidateDbPath(corpusId));
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_candidates (
      id TEXT PRIMARY KEY,
      corpus_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_url TEXT,
      api_url TEXT,
      title TEXT,
      author TEXT,
      recipient TEXT,
      date TEXT,
      document_type TEXT,
      rights_level TEXT,
      extraction_status TEXT,
      text_path TEXT,
      raw_path TEXT,
      metadata_json TEXT,
      score INTEGER DEFAULT 0,
      selected INTEGER DEFAULT 0,
      why_keep TEXT,
      why_skip TEXT
    );

    CREATE TABLE IF NOT EXISTS candidate_signals (
      candidate_id TEXT NOT NULL,
      signal TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS candidate_paths (
      candidate_id TEXT NOT NULL,
      path_id TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS source_candidates_corpus_idx ON source_candidates(corpus_id);
    CREATE INDEX IF NOT EXISTS source_candidates_score_idx ON source_candidates(score);
    CREATE INDEX IF NOT EXISTS candidate_signals_signal_idx ON candidate_signals(signal);
    CREATE INDEX IF NOT EXISTS candidate_paths_path_idx ON candidate_paths(path_id);
  `);
  return db;
}

function replaceList(db: Database, table: "candidate_signals" | "candidate_paths", id: string, values: string[]): void {
  const column = table === "candidate_signals" ? "signal" : "path_id";
  db.prepare(`DELETE FROM ${table} WHERE candidate_id = ?`).run(id);
  const insert = db.prepare(`INSERT INTO ${table} (candidate_id, ${column}) VALUES (?, ?)`);
  for (const value of [...new Set(values.filter(Boolean))]) insert.run(id, value);
}

export function upsertCandidate(
  db: Database,
  corpusId: string,
  item: SourceItem,
  input: {
    extractionStatus?: string;
    textPath?: string;
    rawPath?: string;
    metadata?: Record<string, unknown>;
    score?: number;
    selected?: boolean;
  } = {}
): void {
  db.prepare(`
    INSERT INTO source_candidates (
      id, corpus_id, source_type, source_url, api_url, title, author, recipient, date,
      document_type, rights_level, extraction_status, text_path, raw_path, metadata_json,
      score, selected, why_keep, why_skip
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      corpus_id = excluded.corpus_id,
      source_type = excluded.source_type,
      source_url = excluded.source_url,
      api_url = excluded.api_url,
      title = excluded.title,
      author = excluded.author,
      recipient = excluded.recipient,
      date = excluded.date,
      document_type = excluded.document_type,
      rights_level = excluded.rights_level,
      extraction_status = excluded.extraction_status,
      text_path = COALESCE(excluded.text_path, source_candidates.text_path),
      raw_path = COALESCE(excluded.raw_path, source_candidates.raw_path),
      metadata_json = excluded.metadata_json,
      score = excluded.score,
      selected = CASE WHEN source_candidates.selected = 1 THEN 1 ELSE excluded.selected END,
      why_keep = COALESCE(source_candidates.why_keep, excluded.why_keep),
      why_skip = COALESCE(source_candidates.why_skip, excluded.why_skip)
  `).run(...bindAll([
    item.id,
    corpusId,
    item.source_type,
    item.url ?? null,
    item.api_url ?? null,
    item.title ?? null,
    item.author ?? null,
    item.recipient ?? null,
    item.date ?? null,
    item.document_type ?? null,
    item.rights_level ?? "unknown",
    input.extractionStatus ?? null,
    input.textPath ?? null,
    input.rawPath ?? null,
    JSON.stringify(input.metadata ?? item.metadata ?? {}),
    input.score ?? item.curator_score ?? 0,
    (input.selected ?? item.selected ?? false) ? 1 : 0,
    item.why_keep ?? null,
    item.why_skip ?? null
  ]));
  replaceList(db, "candidate_signals", item.id, item.signals ?? []);
  replaceList(db, "candidate_paths", item.id, item.paths ?? []);
}

export function updateCandidateReview(
  db: Database,
  id: string,
  input: {
    score?: number;
    selected?: boolean;
    whyKeep?: string;
    whySkip?: string;
    signals?: string[];
    paths?: string[];
  }
): void {
  const row = db.prepare("SELECT id FROM source_candidates WHERE id = ?").get(id);
  if (!row) throw new Error(`Unknown candidate id in review import: ${id}`);
  if (input.score !== undefined || input.selected !== undefined || input.whyKeep !== undefined || input.whySkip !== undefined) {
    db.prepare(`
      UPDATE source_candidates
      SET score = COALESCE(?, score),
          selected = COALESCE(?, selected),
          why_keep = COALESCE(?, why_keep),
          why_skip = COALESCE(?, why_skip)
      WHERE id = ?
    `).run(...bindAll([
      input.score ?? null,
      input.selected === undefined ? null : input.selected ? 1 : 0,
      input.whyKeep ?? null,
      input.whySkip ?? null,
      id
    ]));
  }
  if (input.signals) replaceList(db, "candidate_signals", id, input.signals);
  if (input.paths) replaceList(db, "candidate_paths", id, input.paths);
}

export function updateCandidateScore(
  db: Database,
  id: string,
  score: number,
  signals: string[],
  selected?: boolean
): void {
  db.prepare("UPDATE source_candidates SET score = ?, selected = CASE WHEN ? IS NULL THEN selected ELSE ? END WHERE id = ?")
    .run(...bindAll([score, selected === undefined ? null : selected ? 1 : 0, selected === undefined ? null : selected ? 1 : 0, id]));
  replaceList(db, "candidate_signals", id, signals);
}

function listValues(db: Database, table: "candidate_signals" | "candidate_paths", id: string): string[] {
  const column = table === "candidate_signals" ? "signal" : "path_id";
  return (db.prepare(`SELECT ${column} AS value FROM ${table} WHERE candidate_id = ? ORDER BY ${column}`)
    .all(id) as Array<{ value: string }>).map((row) => row.value);
}

export function listCandidates(db: Database, corpusId: string, pathId?: string): CandidateRecord[] {
  const rows = db.prepare("SELECT * FROM source_candidates WHERE corpus_id = ? ORDER BY score DESC, date, id")
    .all(corpusId) as unknown as Array<Omit<CandidateRecord, "signals" | "paths">>;
  return rows
    .map((row) => ({
      ...row,
      signals: listValues(db, "candidate_signals", row.id),
      paths: listValues(db, "candidate_paths", row.id)
    }))
    .filter((row) => !pathId || row.paths.includes(pathId));
}

export function getCandidate(db: Database, id: string): CandidateRecord | null {
  const row = db.prepare("SELECT * FROM source_candidates WHERE id = ?").get(id) as unknown as Omit<CandidateRecord, "signals" | "paths"> | undefined;
  if (!row) return null;
  return {
    ...row,
    signals: listValues(db, "candidate_signals", row.id),
    paths: listValues(db, "candidate_paths", row.id)
  };
}
