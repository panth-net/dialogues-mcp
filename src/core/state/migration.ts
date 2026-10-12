import fs from "node:fs";
import path from "node:path";
import {
  dataDir,
  installStatePath,
  isInside,
  isSafeId,
  legacyHomeDataDir,
  packageRoot,
  repoDataDir,
  sourceCacheRootFor
} from "../paths.js";
import { integrityOk, countRows, openDatabase } from "../db/sqlite.js";
import { MIGRATED_UNRECORDED_URL } from "../sources/http.js";
import { readJsonFile, renameWithRetry, sha256File, tempSibling, writeFileAtomic, writeJsonAtomic } from "./files.js";

// Copy-and-verify migration from pre-1.0 locations into the data folder.
// Originals are never moved or deleted. Existing destination files are never
// overwritten: identical ones are skipped and different ones are reported as
// conflicts for the user to resolve.

export type MigrationKind =
  | "index"
  | "source-cache"
  | "jesuit-legacy-text"
  | "vangogh-legacy-letters"
  | "user-corpus"
  | "workspace-file"
  | "workspace-folder";

export type MigrationItem = {
  kind: MigrationKind;
  corpus_id?: string;
  source: string;
  destination: string;
  bytes: number;
  action: "copy" | "skip-identical" | "conflict";
  detail?: string;
  transform?: "download-state" | "installed-corpora" | "migrated-sidecar";
};

export type MigrationPlan = {
  data_dir: string;
  sources: Array<{ path: string; kind: string; exists: boolean }>;
  items: MigrationItem[];
  totals: { copy: number; skip_identical: number; conflict: number; bytes_to_copy: number };
};

const WORKSPACE_FOLDERS = ["source-cache", "harvests", "curation", "exports", "imports", "selection", "logs"];
const WORKSPACE_FILES = ["preferences.json", "installed-corpora.json"];

function listFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) found.push(full);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return found;
}

function sameFile(a: string, b: string): boolean {
  try {
    if (fs.statSync(a).size !== fs.statSync(b).size) return false;
    return sha256File(a) === sha256File(b);
  } catch {
    return false;
  }
}

function plannedItem(item: Omit<MigrationItem, "action" | "bytes">): MigrationItem {
  const bytes = fs.statSync(item.source).size;
  if (!fs.existsSync(item.destination)) return { ...item, bytes, action: "copy" };
  if (!item.transform && sameFile(item.source, item.destination)) return { ...item, bytes, action: "skip-identical" };
  if (item.transform && fs.existsSync(item.destination)) {
    return { ...item, bytes, action: "skip-identical", detail: "destination already exists; kept as is" };
  }
  return { ...item, bytes, action: "conflict", detail: "a different file already exists at the destination; neither was changed" };
}

function workspaceItems(root: string, target: string): MigrationItem[] {
  const items: MigrationItem[] = [];
  for (const folder of WORKSPACE_FOLDERS) {
    for (const file of listFiles(path.join(root, folder))) {
      const relative = path.relative(root, file);
      const parts = relative.split(path.sep);
      if (folder === "source-cache" && parts[1] && !isSafeId(parts[1])) continue;
      if (/\.lock$|\.tmp-\d+-/.test(file)) continue;
      const transform = folder === "source-cache" && path.basename(file) === "download-state.json" ? "download-state" as const : undefined;
      items.push(plannedItem({
        kind: "workspace-folder",
        corpus_id: folder === "source-cache" ? parts[1] : undefined,
        source: file,
        destination: path.join(target, relative),
        transform
      }));
    }
  }
  for (const name of WORKSPACE_FILES) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    items.push(plannedItem({
      kind: "workspace-file",
      source: file,
      destination: path.join(target, name),
      transform: name === "installed-corpora.json" ? "installed-corpora" : undefined
    }));
  }
  return items;
}

/** Index files and data kept inside a checkout or older package. */
function checkoutItems(root: string, target: string): MigrationItem[] {
  const items: MigrationItem[] = [];
  const corpora = path.join(root, "corpora");
  if (fs.existsSync(corpora)) {
    for (const entry of fs.readdirSync(corpora, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
      const index = path.join(corpora, entry.name, "index.sqlite");
      if (fs.existsSync(index)) {
        items.push(plannedItem({ kind: "index", corpus_id: entry.name, source: index, destination: path.join(target, "indexes", entry.name, "index.sqlite") }));
      }
    }
    const jesuitRaw = path.join(corpora, "jesuit-relations", "data", "raw");
    for (const file of listFiles(jesuitRaw)) {
      const match = path.basename(file).match(/^(jesuits\d{2}jesuuoft)_djvu\.txt$/);
      if (!match) continue;
      items.push(plannedItem({
        kind: "jesuit-legacy-text",
        corpus_id: "jesuit-relations",
        source: file,
        destination: path.join(target, "source-cache", "jesuit-relations", "raw", `${match[1]}.txt`),
        transform: "migrated-sidecar"
      }));
    }
    const vangoghData = path.join(corpora, "vangogh-letters", "data");
    for (const file of listFiles(path.join(vangoghData, "local-source"))) {
      items.push(plannedItem({
        kind: "vangogh-legacy-letters",
        corpus_id: "vangogh-letters",
        source: file,
        destination: path.join(target, "source-cache", "vangogh-letters", "local-source", path.relative(path.join(vangoghData, "local-source"), file))
      }));
    }
    for (const name of ["import-manifest.json", "import-report.md"]) {
      const file = path.join(vangoghData, name);
      if (fs.existsSync(file)) {
        items.push(plannedItem({ kind: "vangogh-legacy-letters", corpus_id: "vangogh-letters", source: file, destination: path.join(target, "source-cache", "vangogh-letters", name) }));
      }
    }
  }
  const userCorpora = path.join(root, "user-corpora");
  if (fs.existsSync(userCorpora)) {
    for (const entry of fs.readdirSync(userCorpora, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
      const corpusRoot = path.join(userCorpora, entry.name);
      for (const file of listFiles(corpusRoot)) {
        const relative = path.relative(corpusRoot, file);
        if (/^index\.sqlite(-.*)?$/.test(relative)) {
          if (relative === "index.sqlite") {
            items.push(plannedItem({ kind: "index", corpus_id: entry.name, source: file, destination: path.join(target, "indexes", entry.name, "index.sqlite") }));
          }
          continue;
        }
        items.push(plannedItem({ kind: "user-corpus", corpus_id: entry.name, source: file, destination: path.join(target, "user-corpora", entry.name, relative) }));
      }
    }
  }
  return items;
}

export function migrationSources(extra: string[] = [], options: { onlyFrom?: boolean } = {}): Array<{ path: string; kind: "legacy-home" | "repo-workspace" | "checkout" }> {
  const target = path.resolve(dataDir());
  const sources: Array<{ path: string; kind: "legacy-home" | "repo-workspace" | "checkout" }> = [];
  const add = (candidate: string, kind: "legacy-home" | "repo-workspace" | "checkout") => {
    const resolved = path.resolve(candidate);
    if (resolved === target || isInside(resolved, target) && kind !== "checkout") return;
    if (sources.some((source) => source.path === resolved && source.kind === kind)) return;
    sources.push({ path: resolved, kind });
  };
  if (!options.onlyFrom) {
    add(legacyHomeDataDir(), "legacy-home");
    add(repoDataDir(), "repo-workspace");
    add(packageRoot(), "checkout");
  }
  for (const root of extra) {
    add(root, "checkout");
    add(path.join(root, "workspace"), "repo-workspace");
  }
  return sources;
}

export function planMigration(options: { from?: string[]; onlyFrom?: boolean } = {}): MigrationPlan {
  const target = path.resolve(dataDir());
  const sources = migrationSources(options.from, { onlyFrom: options.onlyFrom });
  const items: MigrationItem[] = [];
  for (const source of sources) {
    if (!fs.existsSync(source.path)) continue;
    if (source.kind === "checkout") items.push(...checkoutItems(source.path, target));
    else items.push(...workspaceItems(source.path, target));
  }
  // First source wins for a destination; later duplicates are dropped.
  const seen = new Set<string>();
  const unique = items.filter((item) => (seen.has(item.destination) ? false : (seen.add(item.destination), true)));
  const totals = {
    copy: unique.filter((item) => item.action === "copy").length,
    skip_identical: unique.filter((item) => item.action === "skip-identical").length,
    conflict: unique.filter((item) => item.action === "conflict").length,
    bytes_to_copy: unique.filter((item) => item.action === "copy").reduce((sum, item) => sum + item.bytes, 0)
  };
  return {
    data_dir: target,
    sources: sources.map((source) => ({ ...source, exists: fs.existsSync(source.path) })),
    items: unique,
    totals
  };
}

function rewriteDownloadState(text: string, corpusId: string | undefined): string {
  if (!corpusId) return text;
  const parsed = JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>;
  const newRoot = sourceCacheRootFor(corpusId);
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") {
      const match = value.match(new RegExp(`source-cache[\\\\/]${corpusId}[\\\\/](.+)$`));
      return match ? path.join(newRoot, ...match[1].split(/[\\/]/)) : value;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]));
    }
    return value;
  };
  return `${JSON.stringify(rewrite(parsed), null, 2)}\n`;
}

function rewriteInstalledCorpora(text: string, sourceRoot: string): string {
  const parsed = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
  const entries = Array.isArray(parsed) ? parsed : (parsed as { corpora?: unknown[] }).corpora ?? [];
  // Relative entries used to be resolved against the checkout; make them absolute.
  const checkout = path.dirname(sourceRoot);
  const corpora = entries.map((entry) => {
    const record = typeof entry === "string" ? { path: entry } : entry as { path: string; id?: string };
    return { ...record, path: path.isAbsolute(record.path) ? record.path : path.resolve(checkout, record.path) };
  });
  return `${JSON.stringify({ corpora }, null, 2)}\n`;
}

function verifySqliteCopy(source: string, copy: string): void {
  const read = (file: string) => {
    const db = openDatabase(file, { readOnly: true });
    try {
      const integrity = integrityOk(db);
      if (!integrity.ok) throw new Error(`integrity check failed: ${integrity.detail}`);
      return { documents: countRows(db, "documents"), chunks: countRows(db, "chunks") };
    } finally {
      db.close();
    }
  };
  const before = read(source);
  const after = read(copy);
  if (before.documents !== after.documents || before.chunks !== after.chunks) {
    throw new Error("copied index does not match the original");
  }
}

function copyVerified(item: MigrationItem): void {
  fs.mkdirSync(path.dirname(item.destination), { recursive: true });
  const temp = tempSibling(item.destination, "migrating");
  try {
    if (item.transform === "download-state") {
      writeFileAtomic(temp, rewriteDownloadState(fs.readFileSync(item.source, "utf8"), item.corpus_id));
    } else if (item.transform === "installed-corpora") {
      writeFileAtomic(temp, rewriteInstalledCorpora(fs.readFileSync(item.source, "utf8"), path.dirname(item.source)));
    } else {
      fs.copyFileSync(item.source, temp);
      if (item.kind === "index") verifySqliteCopy(item.source, temp);
      else if (sha256File(item.source) !== sha256File(temp)) throw new Error("copied file does not match the original");
    }
    if (fs.existsSync(item.destination)) throw new Error("destination appeared during migration; left unchanged");
    renameWithRetry(temp, item.destination);
    if (needsMigratedSidecar(item)) writeMigratedSidecar(item);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/**
 * Downloaded files from earlier versions have no record of the URL they came
 * from. Mark them as migrated (with their hash) so the search file can still be
 * rebuilt offline; a later forced download replaces the mark with a real record.
 */
function needsMigratedSidecar(item: MigrationItem): boolean {
  if (item.transform === "migrated-sidecar") return true;
  const parts = item.destination.split(/[\\/]/);
  const at = parts.lastIndexOf("source-cache");
  return at >= 0 && parts[at + 2] === "raw" && !item.destination.endsWith(".source.json") && !fs.existsSync(`${item.source}.source.json`);
}

function writeMigratedSidecar(item: MigrationItem): void {
  const sidecar = `${item.destination}.source.json`;
  if (fs.existsSync(sidecar)) return;
  writeJsonAtomic(sidecar, {
    source_url: MIGRATED_UNRECORDED_URL,
    final_url: MIGRATED_UNRECORDED_URL,
    sha256: sha256File(item.destination),
    bytes: fs.statSync(item.destination).size,
    fetched_at: fs.statSync(item.source).mtime.toISOString(),
    migrated: true
  });
}

/** Legacy Jesuit text came with no download record; create one so it can be reindexed. */
function recordJesuitLegacyState(copiedIds: string[]): void {
  if (!copiedIds.length) return;
  const statePath = path.join(sourceCacheRootFor("jesuit-relations"), "download-state.json");
  if (fs.existsSync(statePath)) return;
  const at = new Date().toISOString();
  writeJsonAtomic(statePath, {
    corpus_id: "jesuit-relations",
    generated_at: at,
    selection: { mode: "all-volumes" },
    downloaded: copiedIds.map((id) => ({ id, status: "text" })),
    skipped: [],
    no_text: []
  });
}

export function applyMigration(plan: MigrationPlan) {
  if (path.resolve(plan.data_dir) !== path.resolve(dataDir())) {
    throw new Error("This migration plan was made for a different data folder. Preview again.");
  }
  const results = { copied: 0, skipped: 0, conflicts: [] as MigrationItem[], errors: [] as Array<{ item: MigrationItem; error: string }> };
  const jesuitIds: string[] = [];
  for (const item of plan.items) {
    if (item.action === "skip-identical") {
      results.skipped += 1;
      // Repairs earlier runs that copied files without the migration mark.
      if (needsMigratedSidecar(item) && fs.existsSync(item.destination)) writeMigratedSidecar(item);
      continue;
    }
    if (item.action === "conflict") {
      results.conflicts.push(item);
      continue;
    }
    try {
      copyVerified(item);
      results.copied += 1;
      if (item.kind === "jesuit-legacy-text") jesuitIds.push(path.basename(item.destination, ".txt"));
    } catch (error) {
      results.errors.push({ item, error: error instanceof Error ? error.message : String(error) });
    }
  }
  recordJesuitLegacyState(jesuitIds);
  const record = {
    at: new Date().toISOString(),
    data_dir: plan.data_dir,
    sources: plan.sources.filter((source) => source.exists).map((source) => source.path),
    copied: results.copied,
    skipped_identical: results.skipped,
    conflicts: results.conflicts.length,
    errors: results.errors.length
  };
  const stateResult = readJsonFile<Record<string, unknown>>(installStatePath());
  if (stateResult.status === "corrupt") {
    throw new Error(`install-state.json is unreadable (${stateResult.error}); the migration copied files but did not record itself. Fix or remove ${installStatePath()}.`);
  }
  const state = stateResult.status === "ok" ? stateResult.value : {};
  const migrations = Array.isArray(state.migrations) ? state.migrations as unknown[] : [];
  writeJsonAtomic(installStatePath(), { ...state, migrations: [...migrations, record] });
  return {
    ok: results.errors.length === 0,
    ...record,
    conflict_items: results.conflicts.map((item) => ({ source: item.source, destination: item.destination })),
    error_items: results.errors.map((entry) => ({ source: entry.item.source, error: entry.error })),
    note: "Originals were not moved or deleted. After you confirm everything works from the new folder, you may remove the old copies yourself."
  };
}

/** Quick check used by setup/doctor/ready: is there anything worth migrating? */
function migratedSources(target: string): Set<string> {
  const state = readJsonFile<{ migrations?: Array<{ data_dir?: string; sources?: string[]; errors?: number; conflicts?: number }> }>(installStatePath());
  if (state.status !== "ok" || !Array.isArray(state.value.migrations)) return new Set();
  const done = state.value.migrations.filter((record) =>
    record.data_dir && path.resolve(record.data_dir) === target && record.errors === 0 && record.conflicts === 0);
  return new Set(done.flatMap((record) => record.sources ?? []).map((source) => path.resolve(source)));
}

export function legacyDataDetected(): { detected: boolean; sources: string[] } {
  const target = path.resolve(dataDir());
  // Originals are kept after a migration; a cleanly migrated source is not reported again.
  const done = migratedSources(target);
  const found: string[] = [];
  const home = legacyHomeDataDir();
  if (path.resolve(home) !== target && ["logs", "source-cache", "preferences.json", "installed-corpora.json"].some((name) => fs.existsSync(path.join(home, name)))) {
    found.push(home);
  }
  const root = packageRoot();
  const corpora = path.join(root, "corpora");
  if (fs.existsSync(corpora) && fs.readdirSync(corpora).some((id) => fs.existsSync(path.join(corpora, id, "index.sqlite")))) found.push(root);
  const repo = repoDataDir();
  if (path.resolve(repo) !== target && fs.existsSync(path.join(repo, "source-cache"))) found.push(repo);
  const pending = found.filter((source) => !done.has(path.resolve(source)));
  return { detected: pending.length > 0, sources: pending };
}

