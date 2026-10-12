import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getCorpusCapsule } from "../corpus/loader.js";
import { dataPath, isSourceCheckout } from "../paths.js";
import { sourceManifestPathForCapsule, tryLoadSourceManifest, validateSourceManifest, writeSourceManifest } from "../sources/sourceManifest.js";
import type { SourceItem, SourceManifest, SourcePath } from "../sources/types.js";
import {
  curationRoot,
  getCandidate,
  listCandidates,
  openCandidateDb,
  updateCandidateReview,
  type CandidateRecord
} from "./candidateDb.js";

const REVIEW_COLUMNS = [
  "id",
  "title",
  "date",
  "author",
  "recipient",
  "document_type",
  "source_url",
  "score",
  "signals",
  "paths",
  "selected",
  "why_keep",
  "why_skip",
  "notes"
];

function csvEscape(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((item) => item.some((fieldValue) => fieldValue.trim()));
}

function boolValue(value: string): boolean | undefined {
  if (!value.trim()) return undefined;
  if (/^(true|1|yes|y)$/i.test(value.trim())) return true;
  if (/^(false|0|no|n)$/i.test(value.trim())) return false;
  throw new Error(`Invalid boolean value in review CSV: ${value}`);
}

function listValue(value: string): string[] {
  return value.split(/[;|]/).map((item) => item.trim()).filter(Boolean);
}

export function exportReviewCsv(corpusId: string, pathId?: string) {
  const db = openCandidateDb(corpusId);
  try {
    const candidates = listCandidates(db, corpusId, pathId);
    fs.mkdirSync(curationRoot(corpusId), { recursive: true });
    const filePath = path.join(curationRoot(corpusId), `review-${pathId ?? "all"}.csv`);
    const lines = [
      REVIEW_COLUMNS.join(","),
      ...candidates.map((candidate) => [
        candidate.id,
        candidate.title,
        candidate.date,
        candidate.author,
        candidate.recipient,
        candidate.document_type,
        candidate.source_url,
        candidate.score,
        candidate.signals.join(";"),
        candidate.paths.join(";"),
        candidate.selected === 1 ? "true" : "false",
        candidate.why_keep,
        candidate.why_skip,
        ""
      ].map(csvEscape).join(","))
    ];
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
    return { ok: true, corpus_id: corpusId, path: pathId ?? null, rows: candidates.length, review_path: filePath };
  } finally {
    db.close();
  }
}

export function importReviewCsv(corpusId: string, filePath: string) {
  const resolved = path.resolve(filePath);
  const rows = parseCsv(fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, ""));
  const header = rows.shift();
  if (!header) throw new Error("Review CSV is empty");
  const index = new Map(header.map((column, offset) => [column, offset]));
  for (const required of ["id", "selected"]) {
    if (!index.has(required)) throw new Error(`Review CSV missing required column: ${required}`);
  }
  const db = openCandidateDb(corpusId);
  try {
    let imported = 0;
    for (const row of rows) {
      const get = (column: string) => row[index.get(column) ?? -1] ?? "";
      const id = get("id").trim();
      if (!id) continue;
      const candidate = getCandidate(db, id);
      if (!candidate || candidate.corpus_id !== corpusId) throw new Error(`Bad candidate id in review CSV: ${id}`);
      const scoreRaw = get("score").trim();
      updateCandidateReview(db, id, {
        score: scoreRaw ? Number.parseInt(scoreRaw, 10) : undefined,
        selected: boolValue(get("selected")),
        whyKeep: get("why_keep").trim() || undefined,
        whySkip: get("why_skip").trim() || undefined,
        signals: index.has("signals") ? listValue(get("signals")) : undefined,
        paths: index.has("paths") ? listValue(get("paths")) : undefined
      });
      imported += 1;
    }
    return { ok: true, corpus_id: corpusId, imported, review_path: resolved };
  } finally {
    db.close();
  }
}

function sanitizeMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMetadata);
  if (!value || typeof value !== "object") return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(raw_metadata|full.?text|transcri|ocr|body|content|text)$/i.test(key)) continue;
    sanitized[key] = sanitizeMetadata(child);
  }
  return sanitized;
}

function metadataForCandidate(candidate: CandidateRecord): Record<string, unknown> | undefined {
  if (!candidate.metadata_json) return undefined;
  try {
    const parsed = JSON.parse(candidate.metadata_json) as unknown;
    const sanitized = sanitizeMetadata(parsed);
    return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
      ? sanitized as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function sourceItemForCandidate(candidate: CandidateRecord): SourceItem {
  return {
    id: candidate.id,
    source_type: candidate.source_type as SourceItem["source_type"],
    url: candidate.source_url ?? undefined,
    api_url: candidate.api_url ?? undefined,
    title: candidate.title ?? undefined,
    author: candidate.author ?? undefined,
    recipient: candidate.recipient ?? undefined,
    date: candidate.date ?? undefined,
    document_type: candidate.document_type ?? undefined,
    rights_level: candidate.rights_level,
    selected: true,
    paths: candidate.paths,
    curator_score: candidate.score,
    signals: candidate.signals,
    why_keep: candidate.why_keep ?? undefined,
    why_skip: candidate.why_skip ?? undefined,
    metadata: metadataForCandidate(candidate)
  };
}

function pathsFromCandidates(candidates: CandidateRecord[], existing?: SourceManifest): Record<string, SourcePath> {
  const paths: Record<string, SourcePath> = existing?.paths ? { ...existing.paths } : {};
  for (const pathId of new Set(candidates.flatMap((candidate) => candidate.paths))) {
    if (!paths[pathId]) paths[pathId] = { title: pathId.replace(/-/g, " "), point: "Curated source path." };
  }
  return paths;
}

export function exportCuratedManifest(corpusId: string, options: { mode?: string; path?: string; writeCapsule?: boolean } = {}) {
  const capsule = getCorpusCapsule(corpusId);
  const existing = tryLoadSourceManifest(capsule) ?? undefined;
  const db = openCandidateDb(corpusId);
  try {
    const selected = listCandidates(db, corpusId, options.path).filter((candidate) => candidate.selected === 1);
    const mode = options.mode ?? existing?.default_mode ?? "curated-core";
    const manifest: SourceManifest = {
      version: 1,
      corpus_id: corpusId,
      source_policy: existing?.source_policy ?? "user_downloaded_from_original_sources",
      default_mode: mode,
      download_modes: existing?.download_modes ?? {
        "curated-core": {
          visible_to_users: true,
          description: "Selected documents that best reveal thinking, reasoning, reactions, and working context."
        },
        "full-dev": {
          visible_to_users: false,
          description: "Curator-only harvest of all candidate records."
        }
      },
      paths: pathsFromCandidates(selected, existing),
      items: selected.map(sourceItemForCandidate)
    };
    // Built-in capsules are package resources: writing into one is an explicit
    // contributor action in a source checkout. By default exports go to the data folder.
    if (options.writeCapsule && capsule.source === "built_in" && !isSourceCheckout()) {
      throw new Error("--write-capsule only works from a Dialogues source checkout; installed built-in capsules are read-only.");
    }
    const outputPath = options.writeCapsule
      ? sourceManifestPathForCapsule(capsule) ?? path.join(capsule.rootPath, "source-manifest.yaml")
      : dataPath("exports", corpusId, "source-manifest.yaml");
    const validated = validateSourceManifest(YAML.parse(YAML.stringify(manifest)), corpusId);
    writeSourceManifest(outputPath, validated);
    return {
      ok: true,
      corpus_id: corpusId,
      mode,
      path: options.path ?? null,
      selected_items: selected.length,
      source_manifest_path: outputPath,
      note: "Curated manifest includes metadata and source URLs only; source text is not exported."
    };
  } finally {
    db.close();
  }
}
