import fs from "node:fs";
import path from "node:path";
import { isInside } from "../paths.js";

// Folder imports read only what the user pointed at. The walker never follows
// symlinks or junctions, skips hidden/system/credential-looking entries
// without opening them, and stops at explicit size, count, and depth limits.

export type ImportLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
  maxArchiveEntries: number;
  maxArchiveBytes: number;
  maxPdfPages: number;
  maxProcessingMs: number;
};

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxFiles: 5000,
  maxFileBytes: 200 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxDepth: 20,
  maxArchiveEntries: 5000,
  maxArchiveBytes: 512 * 1024 * 1024,
  maxPdfPages: 2000,
  maxProcessingMs: 30 * 60 * 1000
};

export type WalkSkip = { path: string; reason: string };

export type WalkResult = {
  files: Array<{ absolute: string; relative: string; bytes: number }>;
  skipped: WalkSkip[];
  limitReached: string | null;
};

const SYSTEM_NAMES = new Set([
  "thumbs.db",
  "desktop.ini",
  "__macosx",
  "$recycle.bin",
  "system volume information",
  "node_modules"
]);

const CREDENTIAL_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn|asc|gpg)$/i,
  /^(credentials?|secrets?)(\..*)?$/i,
  /(^|[-_.])(keypair|wallet|service[-_]?account)([-_.].*)?\.json$/i,
  /^\.?(npmrc|netrc|pgpass|git-credentials)$/i
];

export function isCredentialLikeName(name: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(name));
}

/** Why an entry is skipped by name alone, or null. Contents are never read. */
export function skipReasonForName(name: string): string | null {
  if (isCredentialLikeName(name)) return "skipped: looks like a credential or secret file";
  if (name.startsWith(".")) return "skipped: hidden file or folder";
  if (SYSTEM_NAMES.has(name.toLowerCase())) return "skipped: system file or folder";
  return null;
}

/** Reject URLs and other schemes; Windows drive letters are allowed. */
export function assertLocalPathInput(input: string): void {
  if (typeof input !== "string" || !input.trim()) throw new Error("A local folder path is required.");
  if (/^[a-z][a-z0-9+.-]+:/i.test(input.trim())) {
    throw new Error("Only local folder paths are accepted, not URLs or other schemes.");
  }
}

export function walkFolder(root: string, limits: ImportLimits = DEFAULT_IMPORT_LIMITS, filter?: (relative: string) => string | null): WalkResult {
  const realRoot = fs.realpathSync.native(root);
  const files: WalkResult["files"] = [];
  const skipped: WalkSkip[] = [];
  let totalBytes = 0;
  let limitReached: string | null = null;

  const visit = (dir: string, depth: number): void => {
    if (limitReached) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      skipped.push({ path: path.relative(root, dir).replace(/\\/g, "/") || ".", reason: `unreadable folder (${(error as NodeJS.ErrnoException).code ?? "error"})` });
      return;
    }
    for (const entry of entries) {
      if (limitReached) return;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      const nameSkip = skipReasonForName(entry.name);
      if (nameSkip) {
        skipped.push({ path: relative, reason: nameSkip });
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolute);
      } catch (error) {
        skipped.push({ path: relative, reason: `unreadable (${(error as NodeJS.ErrnoException).code ?? "error"})` });
        continue;
      }
      // lstat reports symlinks and Windows junctions as symbolic links.
      if (stat.isSymbolicLink()) {
        skipped.push({ path: relative, reason: "skipped: symbolic link or junction" });
        continue;
      }
      if (stat.isDirectory()) {
        if (depth + 1 > limits.maxDepth) {
          skipped.push({ path: relative, reason: `skipped: deeper than ${limits.maxDepth} folders` });
          continue;
        }
        visit(absolute, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        skipped.push({ path: relative, reason: "skipped: not a regular file" });
        continue;
      }
      // Belt and braces: the real location must still be inside the folder.
      try {
        if (!isInside(realRoot, fs.realpathSync.native(absolute))) {
          skipped.push({ path: relative, reason: "skipped: resolves outside the selected folder" });
          continue;
        }
      } catch {
        skipped.push({ path: relative, reason: "unreadable" });
        continue;
      }
      const filterReason = filter?.(relative) ?? null;
      if (filterReason) {
        skipped.push({ path: relative, reason: filterReason });
        continue;
      }
      if (stat.size > limits.maxFileBytes) {
        skipped.push({ path: relative, reason: `skipped: larger than ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB` });
        continue;
      }
      if (files.length + 1 > limits.maxFiles) {
        limitReached = `more than ${limits.maxFiles} files`;
        return;
      }
      if (totalBytes + stat.size > limits.maxTotalBytes) {
        limitReached = `more than ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB in total`;
        return;
      }
      totalBytes += stat.size;
      files.push({ absolute, relative, bytes: stat.size });
    }
  };

  visit(root, 0);
  return { files, skipped, limitReached };
}

/** Archive entry names must be relative and stay inside the archive. */
export function isSafeArchiveEntryName(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) return false;
  return !normalized.split("/").some((part) => part === "..");
}
