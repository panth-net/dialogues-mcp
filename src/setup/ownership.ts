import path from "node:path";
import { dataDir, installStatePath } from "../core/paths.js";
import { readJsonFile, sha256Text, withLock, writeJsonAtomic } from "../core/state/files.js";

// install-state.json records only what Dialogues itself created: which app
// entry or skill file, where, a digest of what was written, the data folder,
// and the version. It never stores other app settings or secrets.

export type ClientId = "claude-desktop" | "claude-code" | "codex" | "cursor" | "vscode" | "antigravity";

export const CLIENT_IDS: ClientId[] = ["claude-desktop", "claude-code", "codex", "cursor", "vscode", "antigravity"];

export type OwnedEntry = {
  adapter: string;
  location: string;
  entry_name: string;
  entry_digest: string;
  data_dir: string;
  installed_version: string;
  installed_at: string;
  verified: boolean;
  skill?: { path: string; digest: string } | null;
};

export type InstallState = {
  migrations?: unknown[];
  owned?: Partial<Record<ClientId, OwnedEntry>>;
  last_update?: Record<string, unknown>;
  [key: string]: unknown;
};

export function digestEntry(entry: unknown): string {
  return sha256Text(stableStringify(entry));
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function readInstallState(): InstallState {
  const result = readJsonFile<InstallState>(installStatePath());
  if (result.status === "missing") return {};
  if (result.status === "corrupt") {
    throw new Error(`install-state.json in ${dataDir()} is unreadable (${result.error}). Dialogues will not overwrite it; fix or remove it, then retry.`);
  }
  return result.value && typeof result.value === "object" ? result.value : {};
}

export function updateInstallState(mutate: (state: InstallState) => void): InstallState {
  return withLock(path.join(dataDir(), ".install-state.lock"), "updating install state", () => {
    const state = readInstallState();
    mutate(state);
    writeJsonAtomic(installStatePath(), state);
    return state;
  });
}

export function ownedEntry(client: ClientId): OwnedEntry | null {
  return readInstallState().owned?.[client] ?? null;
}
