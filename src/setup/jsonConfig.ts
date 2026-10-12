import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { renameWithRetry, sha256Text } from "../core/state/files.js";

// Edits one key inside an app's JSON or JSONC config while preserving every
// other entry, comments, and formatting. The file is backed up first, the
// edit is written to a temp file and renamed, and a concurrent change made by
// the app (or the user) between read and write aborts the edit.

export class ConfigConflictError extends Error {}

export type JsonConfigRead = {
  exists: boolean;
  text: string;
  digest: string;
  value: Record<string, unknown>;
};

export function readJsonConfig(filePath: string, options: { allowComments: boolean }): JsonConfigRead {
  if (!fs.existsSync(filePath)) return { exists: false, text: "", digest: sha256Text(""), value: {} };
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) return { exists: true, text, digest: sha256Text(text), value: {} };
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: options.allowComments, disallowComments: !options.allowComments });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) {
    const detail = errors.length ? printParseErrorCode(errors[0].error) : "not a JSON object";
    throw new ConfigConflictError(`${path.basename(filePath)} could not be read safely (${detail}). It was not changed; fix it in the app or a text editor, then retry.`);
  }
  return { exists: true, text, digest: sha256Text(text), value: value as Record<string, unknown> };
}

export function getAtPath(value: Record<string, unknown>, keyPath: string[]): unknown {
  let current: unknown = value;
  for (const key of keyPath) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function backupPath(filePath: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${filePath}.dialogues-backup-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Set (or with `value === undefined`, remove) one key path. Returns the backup
 * path, or null when the file did not exist before.
 */
export function writeJsonConfigKey(
  filePath: string,
  before: JsonConfigRead,
  keyPath: string[],
  value: unknown,
  options: { dryRun?: boolean } = {}
): { backupPath: string | null; changed: boolean } {
  const baseText = before.exists && before.text.trim() ? before.text : "{}\n";
  const edits = modify(baseText, keyPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } });
  const nextText = applyEdits(baseText, edits);
  if (nextText === before.text) return { backupPath: null, changed: false };
  if (options.dryRun) return { backupPath: null, changed: true };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let backup: string | null = null;
  if (before.exists) {
    backup = backupPath(filePath);
    fs.copyFileSync(filePath, backup);
  }
  const temp = `${filePath}.dialogues-tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  try {
    fs.writeFileSync(temp, nextText.endsWith("\n") ? nextText : `${nextText}\n`, "utf8");
    // Detect a change made after we read the file.
    const current = fs.existsSync(filePath) ? sha256Text(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) : sha256Text("");
    if (current !== before.digest) {
      throw new ConfigConflictError(`${path.basename(filePath)} changed while Dialogues was editing it. Nothing was written; retry when the app is closed.`);
    }
    renameWithRetry(temp, filePath);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { backupPath: backup, changed: true };
}
