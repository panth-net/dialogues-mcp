import fs from "node:fs";
import path from "node:path";
import {
  dataDir,
  ensureDataDirectories,
  isInside,
  packageRoot,
  pointerPath,
  readSavedPointer,
  runtimeConfig,
  userHome
} from "../core/paths.js";
import { readJsonFile, writeJsonAtomic } from "../core/state/files.js";
import { packageInfo, nodeVersionSupported, MIN_NODE_VERSION } from "../core/version.js";
import { fts5Available } from "../core/db/sqlite.js";
import { pdfSupportStatus } from "../core/import/pdf.js";
import { listCorpusCapsules } from "../core/corpus/loader.js";
import { corpusCoverage } from "../core/corpus/coverage.js";
import { legacyDataDetected, planMigration, applyMigration } from "../core/state/migration.js";
import { CLIENT_ADAPTERS, type InstallOutcome, type UninstallOutcome } from "./clients.js";
import { findOnPath, runCommand } from "./exec.js";
import { resolveServerLaunch, cliScriptPath } from "./launch.js";
import { CLIENT_IDS, readInstallState, updateInstallState, type ClientId } from "./ownership.js";
import { installSkill, uninstallSkill, type SkillOutcome } from "./skill.js";
import { probeServer, type ProbeResult } from "./probe.js";

export const EXIT = { ok: 0, failed: 1, partial: 2, needsSelection: 3, conflict: 4 } as const;

const DATA_MARKER = ".dialogues-data-dir";

export function firstMessage(): string {
  try {
    const prompts = JSON.parse(fs.readFileSync(path.join(packageRoot(), "resources", "install-prompts.json"), "utf8")) as { first_message: string };
    return prompts.first_message;
  } catch {
    return "Hi! I want to use Dialogues. Show me the document collections, recommend where to start, and help me choose. Ask me before downloading anything.";
  }
}

export const PRIVACY_NOTE = "Dialogues runs on your computer: document collections and search files are stored in your Dialogues folder. When you ask about a collection, the passages it finds are sent to the AI app you are using. Dialogues itself needs no account, API key, or hosted service, and downloads collections only when you agree.";

/** Refuse data folders that would be dangerous to fill or later delete. */
export function assertUsableDataDir(dir: string): void {
  const resolved = path.resolve(dir);
  const root = path.parse(resolved).root;
  if (resolved === root) throw new Error("The Dialogues folder cannot be the root of a drive.");
  if (resolved === path.resolve(userHome())) throw new Error("The Dialogues folder cannot be your home folder itself; choose a folder inside it, such as ~/Dialogues.");
  if (isInside(path.join(packageRoot(), "node_modules"), resolved) || (isInside(packageRoot(), resolved) && !fs.existsSync(path.join(packageRoot(), "tsconfig.json")))) {
    throw new Error("The Dialogues folder cannot be inside the installed program folder, which is replaced on update.");
  }
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error("The Dialogues folder cannot be a symbolic link or junction.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) throw new Error(`${resolved} exists and is not a folder.`);
}

function writeDataMarker(dir: string): void {
  const marker = path.join(dir, DATA_MARKER);
  if (!fs.existsSync(marker)) writeJsonAtomic(marker, { created_at: new Date().toISOString(), created_by: packageInfo().version });
}

export function hasDataMarker(dir: string): boolean {
  return fs.existsSync(path.join(dir, DATA_MARKER));
}

type PointerOutcome = { status: "saved" | "unchanged" | "switched" | "kept-existing" | "not-saved"; previous: string | null; detail: string };

/** Remember the chosen folder. Never overwrites a file Dialogues did not write. */
function savePointer(dir: string, explicit: boolean): PointerOutcome {
  const file = pointerPath();
  const existing = readJsonFile<Record<string, unknown>>(file);
  if (existing.status === "corrupt" || (existing.status === "ok" && existing.value.dialogues_pointer_version !== 1)) {
    return { status: "not-saved", previous: null, detail: `${file} exists but was not written by Dialogues; it was left alone. Pass --data-dir each time, or set DIALOGUES_HOME.` };
  }
  const saved = readSavedPointer();
  if (saved && path.resolve(saved.data_dir) === path.resolve(dir)) return { status: "unchanged", previous: saved.data_dir, detail: "Data folder already remembered." };
  if (saved && !explicit) return { status: "kept-existing", previous: saved.data_dir, detail: `Keeping the remembered folder ${saved.data_dir}.` };
  writeJsonAtomic(file, { dialogues_pointer_version: 1, data_dir: path.resolve(dir), saved_at: new Date().toISOString() });
  return saved
    ? { status: "switched", previous: saved.data_dir, detail: `Switched the remembered folder from ${saved.data_dir}. Collections in the old folder were not moved; run dialogues migrate --from to copy them.` }
    : { status: "saved", previous: null, detail: "Data folder remembered for future commands." };
}

export type SetupOptions = {
  clients: ClientId[];
  replace?: boolean;
  skill?: boolean;
  dryRun?: boolean;
  probe?: boolean;
  migrate?: boolean;
  vscodeProfile?: string;
};

export type ClientSetupResult = InstallOutcome & { display_name: string; restart: string; skill: SkillOutcome | null };

export async function runSetup(options: SetupOptions) {
  const config = runtimeConfig();
  const dir = config.dataDir;
  const warnings = [...config.warnings];
  if (!nodeVersionSupported()) {
    return { ok: false, exit_code: EXIT.failed, status: "unsupported-node", detail: `Dialogues needs Node.js ${MIN_NODE_VERSION} or newer; this is ${process.versions.node}. Install the current Node.js LTS release from nodejs.org, then retry.` };
  }
  if (options.clients.length === 0) {
    return {
      ok: false,
      exit_code: EXIT.needsSelection,
      status: "needs-selection",
      detail: "Choose the app to connect: --client claude-desktop, claude-code, codex, cursor, vscode, or antigravity.",
      detected: CLIENT_IDS.map((id) => ({ client: id, ...CLIENT_ADAPTERS[id].detect() }))
    };
  }
  assertUsableDataDir(dir);
  if (!options.dryRun) {
    ensureDataDirectories(dir);
    writeDataMarker(dir);
  }
  const pointer = options.dryRun
    ? { status: "not-saved" as const, previous: null, detail: "Dry run." }
    : savePointer(dir, config.origin === "flag" || config.origin === "legacy-flag");

  const legacy = legacyDataDetected();
  let migration: unknown = null;
  if (legacy.detected) {
    const plan = planMigration();
    migration = options.migrate && !options.dryRun
      ? applyMigration(plan)
      : { preview: true, sources: legacy.sources, files_to_copy: plan.totals.copy, bytes_to_copy: plan.totals.bytes_to_copy, conflicts: plan.totals.conflict, next_step: "Run dialogues migrate --apply to copy earlier collections into this folder (originals are kept)." };
  }

  const launch = resolveServerLaunch(dir);
  const state = readInstallState();
  const results: ClientSetupResult[] = [];
  for (const client of options.clients) {
    const adapter = CLIENT_ADAPTERS[client];
    const owned = state.owned?.[client] ?? null;
    const outcome = adapter.install(launch, { owned, replace: options.replace, dryRun: options.dryRun, vscodeProfile: options.vscodeProfile });
    let skill: SkillOutcome | null = null;
    if (adapter.supportsSkills && options.skill !== false && ["installed", "updated", "unchanged"].includes(outcome.status)) {
      skill = installSkill(client, owned?.skill, { dryRun: options.dryRun });
    }
    if (outcome.owned && !options.dryRun) {
      const record = outcome.owned;
      updateInstallState((next) => {
        next.owned = next.owned ?? {};
        next.owned[client] = {
          ...record,
          data_dir: dir,
          installed_version: packageInfo().version,
          installed_at: new Date().toISOString(),
          skill: skill?.digest && skill.path ? { path: skill.path, digest: skill.digest } : owned?.skill ?? null
        };
      });
    }
    results.push({ ...outcome, display_name: adapter.displayName, restart: adapter.restartHint, skill });
  }

  let probe: ProbeResult | null = null;
  if (options.probe !== false && !options.dryRun) probe = await probeServer(launch);

  const succeeded = results.filter((result) => ["installed", "updated", "unchanged"].includes(result.status));
  const conflicts = results.filter((result) => result.status === "conflict");
  const exitCode = succeeded.length === results.length
    ? (probe && !probe.ok ? EXIT.partial : EXIT.ok)
    : succeeded.length > 0 ? EXIT.partial : conflicts.length === results.length ? EXIT.conflict : EXIT.failed;
  return {
    ok: exitCode === EXIT.ok,
    exit_code: exitCode,
    status: exitCode === EXIT.ok ? "connected" : exitCode === EXIT.partial ? "partly-connected" : conflicts.length ? "conflict" : "failed",
    version: packageInfo().version,
    data_dir: dir,
    data_dir_origin: config.origin,
    pointer,
    warnings,
    clients: results,
    server_check: probe,
    migration,
    collections_downloaded: false,
    restart: succeeded.map((result) => `${result.display_name}: ${result.restart}`),
    first_message: firstMessage(),
    privacy: PRIVACY_NOTE,
    next_step: succeeded.length
      ? `Fully quit and reopen ${succeeded.map((result) => result.display_name).join(" and ")}, then send: ${firstMessage()}`
      : "Nothing was connected. Read the details above, then retry."
  };
}

/** Read-only status: no writes, no network, no app changes. */
export async function runReady() {
  const config = runtimeConfig();
  const dir = config.dataDir;
  const problems: string[] = [];
  const nodeOk = nodeVersionSupported();
  if (!nodeOk) problems.push(`Node.js ${process.versions.node} is older than ${MIN_NODE_VERSION}.`);
  const sqlite = fts5Available();
  if (!sqlite.ok) problems.push(`SQLite full-text search is unavailable: ${sqlite.detail}`);
  const exists = fs.existsSync(dir);
  if (!exists) problems.push(`Data folder ${dir} does not exist yet. Run dialogues setup --client <app>.`);
  let state: ReturnType<typeof readInstallState> = {};
  try {
    state = readInstallState();
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const clients = CLIENT_IDS.flatMap((client) => {
    const owned = state.owned?.[client];
    if (!owned) return [];
    return [{ client, display_name: CLIENT_ADAPTERS[client].displayName, location: owned.location, data_dir: owned.data_dir, installed_version: owned.installed_version, matches_data_dir: path.resolve(owned.data_dir) === path.resolve(dir) }];
  });
  if (exists && clients.length === 0) problems.push("No app is connected yet. Run dialogues setup --client <app>.");
  const { corpora, errors } = listCorpusCapsules();
  const counts: Record<string, number> = {};
  for (const capsule of corpora) {
    let stateName = "unknown";
    try {
      stateName = corpusCoverage(capsule).state;
    } catch {
      stateName = "unreadable-state";
    }
    counts[stateName] = (counts[stateName] ?? 0) + 1;
  }
  const pdf = await pdfSupportStatus();
  return {
    ok: problems.length === 0,
    version: packageInfo().version,
    node: { version: process.versions.node, supported: nodeOk, minimum: MIN_NODE_VERSION },
    data_dir: dir,
    data_dir_origin: config.origin,
    data_dir_exists: exists,
    remembered_data_dir: readSavedPointer()?.data_dir ?? null,
    sqlite,
    pdf_support: pdf,
    connected_apps: clients,
    collections: { total: corpora.length, by_state: counts, load_errors: errors.length },
    legacy_data: legacyDataDetected(),
    problems
  };
}

export type UninstallOptions = {
  clients?: ClientId[];
  all?: boolean;
  deleteData?: boolean;
  confirmDataDir?: string;
  dryRun?: boolean;
  vscodeProfile?: string;
};

export function runUninstall(options: UninstallOptions) {
  const dir = dataDir();
  const state = readInstallState();
  const targets = options.all || !options.clients?.length
    ? CLIENT_IDS.filter((client) => state.owned?.[client])
    : options.clients;
  const results: Array<UninstallOutcome & { skill: SkillOutcome | null }> = [];
  for (const client of targets) {
    const owned = state.owned?.[client] ?? null;
    const outcome = CLIENT_ADAPTERS[client].uninstall({ owned, dryRun: options.dryRun, vscodeProfile: options.vscodeProfile });
    const skill = owned?.skill ? uninstallSkill(owned.skill, { dryRun: options.dryRun }) : null;
    if (!options.dryRun && ["removed", "absent"].includes(outcome.status)) {
      updateInstallState((next) => {
        if (next.owned) delete next.owned[client];
      });
    }
    results.push({ ...outcome, skill });
  }

  // Forget the remembered folder only if it is ours and points here.
  let pointer = "kept";
  const saved = readSavedPointer();
  const remaining = readInstallState().owned ?? {};
  if (saved && path.resolve(saved.data_dir) === path.resolve(dir) && Object.keys(remaining).length === 0) {
    if (!options.dryRun) fs.rmSync(pointerPath(), { force: true });
    pointer = "removed";
  }

  let data: { deleted: boolean; detail: string } = { deleted: false, detail: `Your collections were kept in ${dir}.` };
  if (options.deleteData) {
    const resolved = path.resolve(dir);
    if (!options.confirmDataDir || path.resolve(options.confirmDataDir) !== resolved) {
      data = { deleted: false, detail: `To delete collection data, repeat the exact folder: --delete-data --confirm-data-dir "${resolved}"` };
    } else {
      try {
        assertUsableDataDir(resolved);
        if (!hasDataMarker(resolved)) throw new Error(`${resolved} does not look like a Dialogues data folder (no ${DATA_MARKER} marker), so it was not deleted.`);
        if (!options.dryRun) fs.rmSync(resolved, { recursive: true, force: true });
        data = { deleted: !options.dryRun, detail: options.dryRun ? `Dry run: would delete ${resolved}.` : `Deleted ${resolved}. Folders you imported from and externally registered collections were not touched.` };
      } catch (error) {
        data = { deleted: false, detail: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  const failed = results.filter((result) => result.status === "failed");
  return {
    ok: failed.length === 0,
    exit_code: failed.length === 0 ? EXIT.ok : failed.length === results.length ? EXIT.failed : EXIT.partial,
    data_dir: dir,
    clients: results,
    pointer,
    data,
    next_step: "To remove the program itself: npm uninstall -g dialogues-mcp. Restart any app that was disconnected."
  };
}

function npmExecutable(): string | null {
  const beside = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
  if (fs.existsSync(beside)) return beside;
  return findOnPath("npm");
}

/** Explicit, user-requested update of the global npm package. */
export function runUpdate(options: { dryRun?: boolean; version?: string } = {}) {
  const before = packageInfo();
  if (fs.existsSync(path.join(packageRoot(), "tsconfig.json"))) {
    return { ok: false, exit_code: EXIT.failed, detail: "This is a source checkout. Update it with git pull, npm ci, and npm run build." };
  }
  const npm = npmExecutable();
  if (!npm) return { ok: false, exit_code: EXIT.failed, detail: "npm was not found next to this Node.js or on PATH." };
  const target = `${before.name}@${options.version ?? "latest"}`;
  if (!/^[a-z0-9@/._-]+$/i.test(target)) return { ok: false, exit_code: EXIT.failed, detail: "Invalid version." };
  if (options.dryRun) return { ok: true, exit_code: EXIT.ok, dry_run: true, from: before.version, command: [npm, "install", "-g", target] };
  const install = runCommand(npm, ["install", "-g", target], { timeoutMs: 10 * 60_000 });
  const recovery = `If something stopped working, reinstall the previous version: npm install -g ${before.name}@${before.version}`;
  if (install.status !== 0) {
    return { ok: false, exit_code: EXIT.failed, from: before.version, detail: `npm install failed (exit ${install.status ?? "unknown"}). Nothing else was changed.`, recovery };
  }
  // Ask the newly installed code for its version and let it refresh the
  // app entries it owns (paths can change between versions).
  const script = cliScriptPath();
  const versionCheck = runCommand(process.execPath, [script, "--version"], { timeoutMs: 30_000 });
  const refreshed = runCommand(process.execPath, [script, "doctor", "--fix", "--json", "--data-dir", dataDir()], { timeoutMs: 120_000 });
  const after = versionCheck.stdout.trim() || null;
  try {
    updateInstallState((state) => {
      state.last_update = { at: new Date().toISOString(), from: before.version, to: after };
    });
  } catch {
    // Recording the update is best effort.
  }
  return {
    ok: versionCheck.status === 0 && refreshed.status === 0,
    exit_code: versionCheck.status === 0 && refreshed.status === 0 ? EXIT.ok : EXIT.partial,
    from: before.version,
    to: after,
    entries_refreshed: refreshed.status === 0,
    detail: refreshed.status === 0 ? "Updated. Restart your connected apps." : "Updated, but refreshing app entries reported a problem; run dialogues doctor --fix.",
    recovery
  };
}
