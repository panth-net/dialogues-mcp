import fs from "node:fs";
import path from "node:path";
import { dataPath } from "../paths.js";
import { sha256Text } from "../state/files.js";
import type { RightsLevel, SourceItem, SourceDownloadSelection } from "./types.js";

export const BLOCKED_TEXT_RIGHTS = new Set<RightsLevel>([
  "borrow_only",
  "catalog_only",
  "user_supplied_only"
]);

export const CONFIRMATION_RIGHTS = new Set<RightsLevel>([
  "noncommercial_open_license",
  "rights_confirmed_user_download",
  "unknown"
]);

export function rightsLevelForItem(item: SourceItem): RightsLevel {
  return item.rights_level ?? "unknown";
}

export function canDownloadText(item: SourceItem): boolean {
  return !BLOCKED_TEXT_RIGHTS.has(rightsLevelForItem(item));
}

export function rightsSummary(items: SourceItem[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const item of items) {
    const rights = rightsLevelForItem(item);
    summary[rights] = (summary[rights] ?? 0) + 1;
  }
  return summary;
}

export function requiresRightsConfirmation(items: SourceItem[]): boolean {
  if (items.length === 0) return false;
  return true;
}

export function assertDownloadAllowedByRights(item: SourceItem): void {
  const rights = rightsLevelForItem(item);
  if (rights === "borrow_only") {
    throw new Error(`Source item ${item.id} is borrow_only and must not be scraped or downloaded.`);
  }
  if (rights === "catalog_only") {
    throw new Error(`Source item ${item.id} is catalog_only and must not download source text.`);
  }
  if (rights === "user_supplied_only") {
    throw new Error(`Source item ${item.id} requires user-supplied local files and must not download source text.`);
  }
}

/**
 * Consent records are kept apart from operation logs (DIALOGUES_LOG=off does
 * not disable them) and from download reports, whose timestamps describe the
 * download, not the agreement. A confirmation is what the client reported; it
 * is not independent proof of who agreed.
 */
export function consentLogPath(): string {
  return dataPath("consents.jsonl");
}

/** @deprecated Use consentLogPath. */
export const sourceDownloadLogPath = consentLogPath;

export type ConsentRecord = {
  consented_at: string;
  corpus_id: string;
  mode: string | null;
  path: string | null;
  selection_id: string | null;
  notice_sha256: string;
  rights_notice: string;
  source_count: number;
  rights_levels: Record<string, number>;
  confirmation: boolean;
  channel: string;
};

export function appendRightsConfirmationLog(input: {
  corpusId: string;
  selection: SourceDownloadSelection & { selectionId?: string };
  rightsNotice: string;
  sourceCount: number;
  rightsLevels: Record<string, number>;
  confirmation: boolean;
  channel?: string;
}): string {
  const record: ConsentRecord = {
    consented_at: new Date().toISOString(),
    corpus_id: input.corpusId,
    mode: input.selection.mode ?? null,
    path: input.selection.path ?? null,
    selection_id: input.selection.selectionId ?? null,
    notice_sha256: sha256Text(input.rightsNotice),
    rights_notice: input.rightsNotice,
    source_count: input.sourceCount,
    rights_levels: input.rightsLevels,
    confirmation: input.confirmation,
    channel: input.channel ?? "unspecified"
  };
  const logPath = consentLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
  return logPath;
}

export function readConsentRecords(corpusId?: string): ConsentRecord[] {
  if (!fs.existsSync(consentLogPath())) return [];
  return fs.readFileSync(consentLogPath(), "utf8")
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const parsed = JSON.parse(line) as ConsentRecord;
        return !corpusId || parsed.corpus_id === corpusId ? [parsed] : [];
      } catch {
        return [];
      }
    });
}
