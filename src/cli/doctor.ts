import fs from "node:fs";
import path from "node:path";
import { listCorpusCapsules } from "../core/corpus/loader.js";
import {
  DATA_SUBDIRS,
  dataDir,
  ensureDataDirectories,
  indexesRoot,
  isSourceCheckout,
  packageRoot,
  runtimeConfig,
  userCorporaRoot
} from "../core/paths.js";
import { getGenericIndexStats } from "../core/db/genericIndex.js";
import { fts5Available } from "../core/db/sqlite.js";
import { pdfSupportStatus } from "../core/import/pdf.js";
import { MIN_NODE_VERSION, nodeVersionSupported, packageInfo } from "../core/version.js";
import { legacyDataDetected } from "../core/state/migration.js";
import { createDialoguesServer } from "../mcp/server.js";
import { CLIENT_ADAPTERS } from "../setup/clients.js";
import { resolveServerLaunch } from "../setup/launch.js";
import { CLIENT_IDS, readInstallState, updateInstallState } from "../setup/ownership.js";
import { installSkill } from "../setup/skill.js";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  next_step?: string | null;
  repaired?: boolean;
};

export type DoctorReport = {
  ok: boolean;
  version: string;
  packageRoot: string;
  dataDir: string;
  dataDirOrigin: string;
  checks: DoctorCheck[];
  corpus_errors: Array<{ rootPath: string; corpusId?: string; message: string }>;
};

function checkNode(): DoctorCheck {
  const ok = nodeVersionSupported();
  return {
    name: "node",
    ok,
    detail: `Node.js ${process.versions.node} (minimum ${MIN_NODE_VERSION})`,
    next_step: ok ? null : "Install the current Node.js LTS release from nodejs.org."
  };
}

function checkSqlite(): DoctorCheck {
  const result = fts5Available();
  return { name: "sqlite", ok: result.ok, detail: result.detail, next_step: result.ok ? null : "Use an official Node.js build, version 22.16 or newer (it includes SQLite with full-text search)." };
}

function checkDataDirs(fix: boolean): DoctorCheck {
  const dir = dataDir();
  const required = [dir, ...DATA_SUBDIRS.map((subdir) => path.join(dir, subdir))];
  const missing = required.filter((entry) => !fs.existsSync(entry));
  if (missing.length && fix) ensureDataDirectories(dir);
  const stillMissing = required.filter((entry) => !fs.existsSync(entry));
  return {
    name: "data_folder",
    ok: stillMissing.length === 0,
    detail: stillMissing.length ? `missing: ${stillMissing.join(", ")}` : `${dir}`,
    next_step: stillMissing.length ? "Run: dialogues doctor --fix" : null,
    repaired: missing.length > 0 && stillMissing.length === 0
  };
}

/** Leftovers from interrupted work: staging folders, temp files, dead locks. */
function checkLeftovers(fix: boolean): DoctorCheck {
  const leftovers: string[] = [];
  const scan = (dir: string, pattern: RegExp) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      if (pattern.test(entry)) leftovers.push(path.join(dir, entry));
    }
  };
  scan(userCorporaRoot(), /^\.staging-/);
  if (fs.existsSync(indexesRoot())) {
    for (const id of fs.readdirSync(indexesRoot())) {
      scan(path.join(indexesRoot(), id), /\.(building|previous|tmp)-\d+-[0-9a-f]+(-journal)?$/);
    }
  }
  scan(dataDir(), /\.tmp-\d+-[0-9a-f]+$/);
  if (fix) for (const entry of leftovers) fs.rmSync(entry, { recursive: true, force: true });
  return {
    name: "interrupted_work",
    ok: leftovers.length === 0 || fix,
    detail: leftovers.length ? `${leftovers.length} leftover temporary item(s)${fix ? " removed" : ""}` : "none",
    next_step: leftovers.length && !fix ? "Run: dialogues doctor --fix" : null,
    repaired: fix && leftovers.length > 0
  };
}

function checkMcpServer(): DoctorCheck {
  try {
    createDialoguesServer();
    return { name: "mcp_server", ok: true, detail: "MCP server builds successfully", next_step: null };
  } catch (error) {
    return { name: "mcp_server", ok: false, detail: error instanceof Error ? error.message : String(error), next_step: "Reinstall Dialogues." };
  }
}

function checkCorpusIndexes(): DoctorCheck {
  try {
    const { corpora } = listCorpusCapsules();
    const indexed = corpora.filter((capsule) => getGenericIndexStats(capsule).indexed);
    return {
      name: "collections",
      ok: true,
      detail: indexed.length
        ? `${indexed.length} of ${corpora.length} collection(s) have a search file`
        : `no search files yet (${corpora.length} collection(s) available)`,
      next_step: indexed.length ? null : "Ask Dialogues (in your AI app) which collections to download, or import a folder with dialogues import-folder <path>."
    };
  } catch (error) {
    return { name: "collections", ok: false, detail: error instanceof Error ? error.message : String(error), next_step: "Check the corpus.yaml files of your collections." };
  }
}

/** Refresh app entries Dialogues owns when its launch paths changed (e.g. after a Node or npm move). */
function checkOwnedEntries(fix: boolean): DoctorCheck {
  let state;
  try {
    state = readInstallState();
  } catch (error) {
    return { name: "connected_apps", ok: false, detail: error instanceof Error ? error.message : String(error), next_step: null };
  }
  const owned = CLIENT_IDS.filter((client) => state.owned?.[client]);
  if (!owned.length) return { name: "connected_apps", ok: true, detail: "no app connected by this setup yet", next_step: "Run: dialogues setup --client <app>" };
  const launch = (() => {
    try {
      return resolveServerLaunch(dataDir());
    } catch {
      return null;
    }
  })();
  if (!launch) return { name: "connected_apps", ok: false, detail: "the installed server script is missing", next_step: "Reinstall Dialogues." };
  const notes: string[] = [];
  let ok = true;
  let repaired = false;
  for (const client of owned) {
    const record = state.owned?.[client] ?? null;
    if (!fix) {
      notes.push(`${client}: recorded at ${record?.location}`);
      continue;
    }
    // Owned and unmodified entries are rewritten in place; anything else is left alone.
    const outcome = CLIENT_ADAPTERS[client].install(launch, { owned: record, replace: false });
    if (outcome.status === "updated") repaired = true;
    if (!["installed", "updated", "unchanged"].includes(outcome.status)) ok = false;
    if (outcome.owned) {
      const ownedRecord = outcome.owned;
      updateInstallState((next) => {
        next.owned = next.owned ?? {};
        next.owned[client] = { ...ownedRecord, data_dir: dataDir(), installed_version: packageInfo().version, installed_at: new Date().toISOString(), skill: record?.skill ?? null };
      });
    }
    if (record?.skill) {
      const skill = installSkill(client, record.skill);
      if (skill.digest && skill.path) {
        updateInstallState((next) => {
          const entry = next.owned?.[client];
          if (entry) entry.skill = { path: skill.path as string, digest: skill.digest as string };
        });
      }
    }
    notes.push(`${client}: ${outcome.status}`);
  }
  return { name: "connected_apps", ok, detail: notes.join("; "), next_step: ok ? null : "Run dialogues setup --client <app> --replace for apps reported as conflict.", repaired };
}

function checkGitignoreProtections(): DoctorCheck | null {
  if (!isSourceCheckout()) return null;
  const gitignore = path.join(packageRoot(), ".gitignore");
  const text = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
  const required = ["corpora/*/data/", "corpora/*/index.sqlite", "user-corpora/", "workspace/"];
  const missing = required.filter((pattern) => !text.includes(pattern));
  return {
    name: "gitignore_data_protection",
    ok: missing.length === 0,
    detail: missing.length ? `missing patterns: ${missing.join(", ")}` : "data and index ignore rules present",
    next_step: missing.length ? "Restore the data/index ignore rules in .gitignore." : null
  };
}

function checkLegacyData(): DoctorCheck {
  const legacy = legacyDataDetected();
  return {
    name: "earlier_install",
    ok: true,
    detail: legacy.detected ? `collections from an earlier install found in: ${legacy.sources.join(", ")}` : "none found",
    next_step: legacy.detected ? "Preview copying them here: dialogues migrate (then --apply). Originals are kept." : null
  };
}

export async function runDoctor(options: { fix?: boolean } = {}): Promise<DoctorReport> {
  const fix = Boolean(options.fix);
  const { errors } = listCorpusCapsules();
  const pdf = await pdfSupportStatus();
  const checks: DoctorCheck[] = [
    { name: "cli", ok: true, detail: `${packageInfo().name} ${packageInfo().version}`, next_step: null },
    checkNode(),
    checkDataDirs(fix),
    checkLeftovers(fix),
    checkSqlite(),
    { name: "pdf_support", ok: true, detail: pdf.available ? pdf.detail : `optional: ${pdf.detail}`, next_step: null },
    checkMcpServer(),
    checkCorpusIndexes(),
    checkOwnedEntries(fix),
    checkLegacyData(),
    ...[checkGitignoreProtections()].filter((check): check is DoctorCheck => Boolean(check))
  ];
  const config = runtimeConfig();
  return {
    ok: checks.every((check) => check.ok) && errors.length === 0,
    version: packageInfo().version,
    packageRoot: packageRoot(),
    dataDir: config.dataDir,
    dataDirOrigin: config.origin,
    checks,
    corpus_errors: errors
  };
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [`Dialogues doctor (${report.version})`, `Data folder: ${report.dataDir} (${report.dataDirOrigin})`];
  for (const check of report.checks) {
    lines.push(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`);
    if (check.repaired) lines.push("  repaired");
    if (check.next_step) lines.push(`  next: ${check.next_step}`);
  }
  for (const error of report.corpus_errors) {
    lines.push(`FAIL corpus ${error.rootPath}: ${error.message}`);
  }
  return lines.join("\n");
}
