import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Paths are resolved lazily, never at import time: `mcp serve --data-dir`
// and `setup --data-dir` must be able to choose the data directory before any
// stateful module asks for it.

const thisFile = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFile);

export type DataDirOrigin =
  | "flag"
  | "legacy-flag"
  | "env"
  | "legacy-env"
  | "repo"
  | "saved"
  | "default";

export type RuntimeConfig = {
  dataDir: string;
  origin: DataDirOrigin;
  warnings: string[];
};

export const DATA_SUBDIRS = [
  "indexes",
  "source-cache",
  "user-corpora",
  "imports",
  "exports",
  "harvests",
  "curation",
  "selection",
  "logs",
  "mcp"
] as const;

/** @deprecated Use DATA_SUBDIRS. */
export const workspaceSubdirs = DATA_SUBDIRS;

let configured: RuntimeConfig | null = null;

export function packageRoot(): string {
  return process.env.DIALOGUES_REPO_ROOT
    ? path.resolve(process.env.DIALOGUES_REPO_ROOT)
    : path.resolve(thisDir, "..", "..");
}

/** Built-in capsules ship with the package and are read-only resources. */
export function builtInCorporaRoot(): string {
  return path.join(packageRoot(), "corpora");
}

export function isSourceCheckout(): boolean {
  // tsconfig.json is excluded from the published package.
  return fs.existsSync(path.join(packageRoot(), "tsconfig.json"));
}

export function userHome(): string {
  return os.homedir();
}

/** Small non-secret pointer that remembers the chosen data folder. */
export function pointerDir(): string {
  return path.join(userHome(), ".dialogues");
}

export function pointerPath(): string {
  return path.join(pointerDir(), "config.json");
}

export function defaultDataDir(): string {
  return path.join(userHome(), "Dialogues");
}

/** Pre-1.0 default runtime folder (now only a migration source). */
export function legacyHomeDataDir(): string {
  return path.join(userHome(), ".dialogues");
}

export function repoDataDir(): string {
  return path.join(packageRoot(), "workspace");
}

export type SavedPointer = {
  dialogues_pointer_version: 1;
  data_dir: string;
  saved_at: string;
};

export function readSavedPointer(): SavedPointer | null {
  try {
    const text = fs.readFileSync(pointerPath(), "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(text) as Partial<SavedPointer>;
    if (parsed && parsed.dialogues_pointer_version === 1 && typeof parsed.data_dir === "string" && parsed.data_dir.trim()) {
      return parsed as SavedPointer;
    }
  } catch {
    // Missing or unreadable pointer: fall through to the default.
  }
  return null;
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function resolveDataDir(options: { dataDir?: string; legacyWorkspace?: string } = {}): RuntimeConfig {
  const warnings: string[] = [];
  if (options.dataDir && options.legacyWorkspace && path.resolve(options.dataDir) !== path.resolve(options.legacyWorkspace)) {
    warnings.push("Both --data-dir and --workspace were given; using --data-dir.");
  }
  if (options.dataDir) return { dataDir: path.resolve(options.dataDir), origin: "flag", warnings };
  if (options.legacyWorkspace) return { dataDir: path.resolve(options.legacyWorkspace), origin: "legacy-flag", warnings };

  const home = envValue("DIALOGUES_HOME");
  const legacyEnv = envValue("DIALOGUES_WORKSPACE");
  if (home && legacyEnv && path.resolve(home) !== path.resolve(legacyEnv)) {
    warnings.push("Both DIALOGUES_HOME and DIALOGUES_WORKSPACE are set; using DIALOGUES_HOME.");
  }
  if (home) return { dataDir: path.resolve(home), origin: "env", warnings };
  if (legacyEnv) return { dataDir: path.resolve(legacyEnv), origin: "legacy-env", warnings };

  // Contributor mode is explicit; the working directory never selects it.
  if (process.env.DIALOGUES_WORKSPACE_MODE === "repo") {
    return { dataDir: repoDataDir(), origin: "repo", warnings };
  }

  const saved = readSavedPointer();
  if (saved) return { dataDir: path.resolve(saved.data_dir), origin: "saved", warnings };
  return { dataDir: defaultDataDir(), origin: "default", warnings };
}

/** Fix the data directory for this process. Call before any stateful work. */
export function configureRuntime(options: { dataDir?: string; legacyWorkspace?: string } = {}): RuntimeConfig {
  configured = resolveDataDir(options);
  // Child modules and spawned helpers read the same location.
  process.env.DIALOGUES_HOME = configured.dataDir;
  return configured;
}

export function runtimeConfig(): RuntimeConfig {
  if (!configured) configured = resolveDataDir();
  return configured;
}

/** For tests: forget the resolved location so the next call re-resolves. */
export function resetRuntimeForTests(): void {
  configured = null;
}

export function dataDir(): string {
  return runtimeConfig().dataDir;
}

export function dataPath(...segments: string[]): string {
  return path.join(dataDir(), ...segments);
}

export function userCorporaRoot(): string {
  return dataPath("user-corpora");
}

export function indexesRoot(): string {
  return dataPath("indexes");
}

export function indexPathFor(corpusId: string): string {
  return path.join(indexesRoot(), assertSafeId(corpusId, "corpus ID"), "index.sqlite");
}

export function sourceCacheRootFor(corpusId: string): string {
  return dataPath("source-cache", assertSafeId(corpusId, "corpus ID"));
}

export function logsRoot(): string {
  return dataPath("logs");
}

export function installedCorporaPath(): string {
  return dataPath("installed-corpora.json");
}

export function preferencesPath(): string {
  return dataPath("preferences.json");
}

export function installStatePath(): string {
  return dataPath("install-state.json");
}

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** IDs become path segments; anything else is rejected rather than joined. */
export function isSafeId(value: string): boolean {
  return SAFE_ID.test(value);
}

export function assertSafeId(value: string, label = "ID"): string {
  if (typeof value !== "string" || !isSafeId(value)) {
    throw new Error(`Invalid ${label}: expected lowercase letters, numbers, and hyphens.`);
  }
  return value;
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Real-path containment: also defeats symlink and junction escapes. */
export function isRealInside(parent: string, child: string): boolean {
  try {
    return isInside(fs.realpathSync.native(parent), fs.realpathSync.native(child));
  } catch {
    return false;
  }
}

export function ensureDataDirectories(dir = dataDir()): string[] {
  const created: string[] = [];
  for (const target of [dir, ...DATA_SUBDIRS.map((subdir) => path.join(dir, subdir))]) {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
      created.push(target);
    }
  }
  return created;
}

export function resolveFromPackage(...segments: string[]): string {
  return path.join(packageRoot(), ...segments);
}
