import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeFailure, findOnPath, runCommand, type RunResult } from "./exec.js";
import { ConfigConflictError, getAtPath, readJsonConfig, writeJsonConfigKey } from "./jsonConfig.js";
import { codexBlock, codexBlockDigestInput, currentCodexBlock, replaceCodexBlock, scanCodexToml } from "./codexToml.js";
import { digestEntry, type ClientId, type OwnedEntry } from "./ownership.js";
import type { ServerLaunch } from "./launch.js";
import { renameWithRetry, sha256Text } from "../core/state/files.js";

export const ENTRY_NAME = "dialogues";

export type InstallStatus = "installed" | "updated" | "unchanged" | "conflict" | "failed" | "unsupported";

export type InstallOutcome = {
  client: ClientId;
  status: InstallStatus;
  location: string;
  backup_path: string | null;
  detail: string;
  /** What to record as owned when the entry was written or adopted. */
  owned?: Pick<OwnedEntry, "adapter" | "location" | "entry_name" | "entry_digest" | "verified">;
  recovery?: string;
};

export type UninstallStatus = "removed" | "absent" | "not-owned" | "modified" | "failed" | "unsupported";

export type UninstallOutcome = {
  client: ClientId;
  status: UninstallStatus;
  location: string;
  backup_path: string | null;
  detail: string;
};

export type InstallOptions = {
  replace?: boolean;
  dryRun?: boolean;
  owned: OwnedEntry | null;
  vscodeProfile?: string;
};

export type ClientAdapter = {
  id: ClientId;
  displayName: string;
  restartHint: string;
  supportsSkills: boolean;
  detect(): { hint: boolean; detail: string };
  location(options?: { vscodeProfile?: string }): string | null;
  install(launch: ServerLaunch, options: InstallOptions): InstallOutcome;
  uninstall(options: { owned: OwnedEntry | null; dryRun?: boolean; vscodeProfile?: string }): UninstallOutcome;
};

function home(): string {
  return os.homedir();
}

function appData(): string {
  return process.env.APPDATA || path.join(home(), "AppData", "Roaming");
}

function runCli(command: string, args: string[], timeoutMs = 60_000): RunResult {
  // Test hook: a .mjs/.js stand-in for a vendor CLI runs under this Node.
  if (/\.(mjs|js)$/i.test(command)) return runCommand(process.execPath, [command, ...args], { timeoutMs });
  return runCommand(command, args, { timeoutMs });
}

// ---------- JSON-config apps (Claude Desktop, Cursor, VS Code, Antigravity) ----------

type JsonAppSpec = {
  id: ClientId;
  displayName: string;
  restartHint: string;
  configPath(options?: { vscodeProfile?: string }): string | null;
  keyPath: string[];
  allowComments: boolean;
  entry(launch: ServerLaunch): Record<string, unknown>;
  detect(): { hint: boolean; detail: string };
  extraNote?(): string | null;
};

function jsonAdapter(spec: JsonAppSpec): ClientAdapter {
  return {
    id: spec.id,
    displayName: spec.displayName,
    restartHint: spec.restartHint,
    supportsSkills: false,
    detect: spec.detect,
    location: (options) => spec.configPath(options),
    install(launch, options) {
      const configPath = spec.configPath({ vscodeProfile: options.vscodeProfile });
      if (!configPath) {
        return { client: spec.id, status: "unsupported", location: "", backup_path: null, detail: `${spec.displayName} automatic setup is not supported on this operating system. Use: dialogues mcp config ${spec.id}` };
      }
      const desired = spec.entry(launch);
      const desiredDigest = digestEntry(desired);
      const owned = (verified: boolean) => ({ adapter: "json", location: configPath, entry_name: ENTRY_NAME, entry_digest: desiredDigest, verified });
      try {
        const before = readJsonConfig(configPath, { allowComments: spec.allowComments });
        const existing = getAtPath(before.value, spec.keyPath);
        const container = getAtPath(before.value, spec.keyPath.slice(0, -1));
        if (container !== undefined && (typeof container !== "object" || container === null || Array.isArray(container))) {
          return { client: spec.id, status: "conflict", location: configPath, backup_path: null, detail: `${spec.keyPath.slice(0, -1).join(".")} in ${path.basename(configPath)} is not an object; it was left unchanged.` };
        }
        if (existing !== undefined) {
          const existingDigest = digestEntry(existing);
          if (existingDigest === desiredDigest) {
            return { client: spec.id, status: "unchanged", location: configPath, backup_path: null, detail: "Dialogues is already connected with these settings.", owned: owned(true) };
          }
          const ours = options.owned && options.owned.location === configPath && options.owned.entry_digest === existingDigest;
          if (!ours && !options.replace) {
            return {
              client: spec.id,
              status: "conflict",
              location: configPath,
              backup_path: null,
              detail: options.owned && options.owned.location === configPath
                ? `The "${ENTRY_NAME}" entry was edited after Dialogues set it up, so it was left alone. Re-run with --replace to overwrite it.`
                : `An existing "${ENTRY_NAME}" entry was not created by this Dialogues setup, so it was left alone. Re-run with --replace to overwrite it.`
            };
          }
        }
        const result = writeJsonConfigKey(configPath, before, spec.keyPath, desired, { dryRun: options.dryRun });
        const note = spec.extraNote?.();
        return {
          client: spec.id,
          status: existing === undefined ? "installed" : "updated",
          location: configPath,
          backup_path: result.backupPath,
          detail: [options.dryRun ? "Dry run: no file was written." : `Config written. ${spec.restartHint}`, note].filter(Boolean).join(" "),
          owned: options.dryRun ? undefined : owned(true)
        };
      } catch (error) {
        return { client: spec.id, status: error instanceof ConfigConflictError ? "conflict" : "failed", location: configPath, backup_path: null, detail: error instanceof Error ? error.message : String(error) };
      }
    },
    uninstall(options) {
      const configPath = spec.configPath({ vscodeProfile: options.vscodeProfile });
      if (!configPath) return { client: spec.id, status: "unsupported", location: "", backup_path: null, detail: "Not supported on this operating system." };
      try {
        const before = readJsonConfig(configPath, { allowComments: spec.allowComments });
        const existing = getAtPath(before.value, spec.keyPath);
        if (existing === undefined) return { client: spec.id, status: "absent", location: configPath, backup_path: null, detail: "No Dialogues entry found." };
        if (!options.owned || options.owned.location !== configPath) {
          return { client: spec.id, status: "not-owned", location: configPath, backup_path: null, detail: "This entry was not created by this Dialogues setup; it was left alone." };
        }
        if (options.owned.entry_digest !== digestEntry(existing)) {
          return { client: spec.id, status: "modified", location: configPath, backup_path: null, detail: "The entry was changed after setup, so it was left alone. Remove it in the app if you want." };
        }
        const result = writeJsonConfigKey(configPath, before, spec.keyPath, undefined, { dryRun: options.dryRun });
        return { client: spec.id, status: "removed", location: configPath, backup_path: result.backupPath, detail: options.dryRun ? "Dry run: would remove the entry." : `Removed. ${spec.restartHint}` };
      } catch (error) {
        return { client: spec.id, status: "failed", location: configPath, backup_path: null, detail: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}

export function claudeDesktopConfigPath(): string | null {
  if (process.env.DIALOGUES_CLAUDE_DESKTOP_CONFIG) return path.resolve(process.env.DIALOGUES_CLAUDE_DESKTOP_CONFIG);
  if (process.platform === "win32") return path.join(appData(), "Claude", "claude_desktop_config.json");
  if (process.platform === "darwin") return path.join(home(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return null;
}

function claudeDesktopStoreInstall(): boolean {
  if (process.platform !== "win32") return false;
  const packages = path.join(process.env.LOCALAPPDATA || path.join(home(), "AppData", "Local"), "Packages");
  try {
    return fs.readdirSync(packages).some((name) => /^Claude_/i.test(name));
  } catch {
    return false;
  }
}

export function cursorConfigPath(): string {
  return process.env.DIALOGUES_CURSOR_CONFIG ? path.resolve(process.env.DIALOGUES_CURSOR_CONFIG) : path.join(home(), ".cursor", "mcp.json");
}

export function vscodeUserDir(): string | null {
  if (process.env.DIALOGUES_VSCODE_USER_DIR) return path.resolve(process.env.DIALOGUES_VSCODE_USER_DIR);
  if (process.platform === "win32") return path.join(appData(), "Code", "User");
  if (process.platform === "darwin") return path.join(home(), "Library", "Application Support", "Code", "User");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home(), ".config"), "Code", "User");
}

/** VS Code: the default profile's user mcp.json, or a named profile folder. */
export function vscodeConfigPath(profile?: string): string | null {
  const userDir = vscodeUserDir();
  if (!userDir) return null;
  if (profile) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(profile)) throw new Error("VS Code profile IDs use letters, numbers, dashes, and underscores (the folder name under User/profiles).");
    return path.join(userDir, "profiles", profile, "mcp.json");
  }
  return path.join(userDir, "mcp.json");
}

const claudeDesktop = jsonAdapter({
  id: "claude-desktop",
  displayName: "Claude Desktop",
  restartHint: "Fully quit Claude Desktop (including from the system tray or menu bar) and open it again.",
  configPath: () => claudeDesktopConfigPath(),
  keyPath: ["mcpServers", ENTRY_NAME],
  allowComments: false,
  entry: (launch) => ({ command: launch.command, args: launch.args }),
  detect: () => {
    const configPath = claudeDesktopConfigPath();
    const hint = Boolean(configPath && fs.existsSync(path.dirname(configPath)));
    return { hint, detail: hint ? "Claude Desktop settings folder found (a hint, not proof it is installed)." : "Claude Desktop settings folder not found." };
  },
  extraNote: () => claudeDesktopStoreInstall()
    ? "Claude Desktop from the Microsoft Store may keep its own copy of this file; if Dialogues does not appear after restarting, add it from Claude Desktop's Settings > Developer > Edit Config."
    : null
});

const cursor = jsonAdapter({
  id: "cursor",
  displayName: "Cursor",
  restartHint: "Restart Cursor, or reload its MCP servers from Cursor Settings.",
  configPath: () => cursorConfigPath(),
  keyPath: ["mcpServers", ENTRY_NAME],
  allowComments: true,
  entry: (launch) => ({ type: "stdio", command: launch.command, args: launch.args }),
  detect: () => {
    const hint = fs.existsSync(path.dirname(cursorConfigPath()));
    return { hint, detail: hint ? "~/.cursor folder found (a hint)." : "~/.cursor folder not found." };
  }
});

const vscode = jsonAdapter({
  id: "vscode",
  displayName: "VS Code",
  restartHint: "Reload VS Code (Developer: Reload Window), then start the server from the MCP: List Servers command if it does not start on its own.",
  configPath: (options) => vscodeConfigPath(options?.vscodeProfile),
  keyPath: ["servers", ENTRY_NAME],
  allowComments: true,
  entry: (launch) => ({ type: "stdio", command: launch.command, args: launch.args }),
  detect: () => {
    const dir = vscodeUserDir();
    const hint = Boolean(dir && fs.existsSync(dir));
    return { hint, detail: hint ? "VS Code user settings folder found (a hint)." : "VS Code user settings folder not found." };
  }
});

/**
 * Antigravity reads ~/.gemini/config/mcp_config.json (Google's current docs, and
 * what current builds write). Early builds used ~/.gemini/antigravity/; that file
 * is used only when it is the one with content and the current one is absent.
 */
export function antigravityConfigPath(): string {
  if (process.env.DIALOGUES_ANTIGRAVITY_CONFIG) return path.resolve(process.env.DIALOGUES_ANTIGRAVITY_CONFIG);
  const current = path.join(home(), ".gemini", "config", "mcp_config.json");
  const legacy = path.join(home(), ".gemini", "antigravity", "mcp_config.json");
  try {
    if (!fs.existsSync(current) && fs.statSync(legacy).size > 0) return legacy;
  } catch {
    // No legacy file either.
  }
  return current;
}

function antigravityInstalled(): boolean {
  const candidates = [
    path.join(home(), ".gemini", "antigravity"),
    path.join(home(), ".gemini", "config"),
    process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || path.join(home(), "AppData", "Local"), "Programs", "Antigravity") : null,
    process.platform === "darwin" ? "/Applications/Antigravity.app" : null
  ];
  return candidates.some((candidate) => candidate !== null && fs.existsSync(candidate));
}

const antigravity = jsonAdapter({
  id: "antigravity",
  displayName: "Antigravity",
  restartHint: "Fully quit Antigravity and open it again (or refresh it under Manage MCP Servers in the agent panel).",
  configPath: () => antigravityConfigPath(),
  keyPath: ["mcpServers", ENTRY_NAME],
  allowComments: false,
  entry: (launch) => ({ command: launch.command, args: launch.args }),
  detect: () => {
    const hint = antigravityInstalled();
    return { hint, detail: hint ? "Antigravity folders found (a hint)." : "Antigravity not found." };
  }
});

// ---------- Claude Code (via its CLI) ----------

function claudeCli(): string | null {
  if (process.env.DIALOGUES_CLAUDE_CLI) return process.env.DIALOGUES_CLAUDE_CLI === "none" ? null : process.env.DIALOGUES_CLAUDE_CLI;
  return findOnPath("claude");
}

function claudeEntryJson(launch: ServerLaunch): string {
  return JSON.stringify({ type: "stdio", command: launch.command, args: launch.args });
}

const claudeCode: ClientAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  restartHint: "Start a new Claude Code session (exit and run claude again).",
  supportsSkills: true,
  detect: () => {
    const cli = claudeCli();
    return { hint: Boolean(cli), detail: cli ? "claude command found on PATH." : "claude command not found on PATH." };
  },
  location: () => "Claude Code user settings (claude mcp, --scope user)",
  install(launch, options) {
    const location = "Claude Code user settings (claude mcp, --scope user)";
    const cli = claudeCli();
    if (!cli) return { client: "claude-code", status: "failed", location, backup_path: null, detail: "The claude command was not found. Install Claude Code, open a new terminal, then retry." };
    const payload = claudeEntryJson(launch);
    const digest = digestEntry(JSON.parse(payload));
    const owned = { adapter: "claude-cli", location, entry_name: ENTRY_NAME, entry_digest: digest, verified: false };
    if (options.dryRun) return { client: "claude-code", status: "installed", location, backup_path: null, detail: "Dry run: would run claude mcp add-json --scope user." };
    const exists = runCli(cli, ["mcp", "get", ENTRY_NAME], 30_000).status === 0;
    if (!exists) {
      const added = runCli(cli, ["mcp", "add-json", ENTRY_NAME, payload, "--scope", "user"]);
      if (added.status !== 0) return { client: "claude-code", status: "failed", location, backup_path: null, detail: describeFailure("claude mcp add-json", added) };
      return { client: "claude-code", status: "installed", location, backup_path: null, detail: `Added. ${claudeCode.restartHint}`, owned };
    }
    // Claude Code does not print entries as JSON, so ownership comes from our record.
    const ours = options.owned?.adapter === "claude-cli";
    if (ours && options.owned?.entry_digest === digest) {
      return { client: "claude-code", status: "unchanged", location, backup_path: null, detail: "Dialogues is already connected with these settings.", owned };
    }
    if (!ours && !options.replace) {
      return { client: "claude-code", status: "conflict", location, backup_path: null, detail: `Claude Code already has an MCP server named "${ENTRY_NAME}" that this setup did not create. Re-run with --replace to overwrite it.` };
    }
    // Recoverable replacement: prove the new entry can be added first, under
    // a temporary name, before removing the old one.
    const tempName = `${ENTRY_NAME}-setup-new`;
    runCli(cli, ["mcp", "remove", tempName, "--scope", "user"], 30_000);
    const staged = runCli(cli, ["mcp", "add-json", tempName, payload, "--scope", "user"]);
    if (staged.status !== 0) {
      return { client: "claude-code", status: "failed", location, backup_path: null, detail: `${describeFailure("claude mcp add-json", staged)} The existing entry was not changed.` };
    }
    const removed = runCli(cli, ["mcp", "remove", ENTRY_NAME, "--scope", "user"], 30_000);
    if (removed.status !== 0) {
      runCli(cli, ["mcp", "remove", tempName, "--scope", "user"], 30_000);
      return { client: "claude-code", status: "failed", location, backup_path: null, detail: `${describeFailure("claude mcp remove", removed)} The existing entry was not changed.` };
    }
    const added = runCli(cli, ["mcp", "add-json", ENTRY_NAME, payload, "--scope", "user"]);
    if (added.status !== 0) {
      return {
        client: "claude-code",
        status: "failed",
        location,
        backup_path: null,
        detail: describeFailure("claude mcp add-json", added),
        recovery: `A working copy was kept as "${tempName}". To finish by hand: claude mcp remove ${tempName} --scope user, then re-run dialogues setup --client claude-code.`
      };
    }
    runCli(cli, ["mcp", "remove", tempName, "--scope", "user"], 30_000);
    return { client: "claude-code", status: "updated", location, backup_path: null, detail: `Updated. ${claudeCode.restartHint}`, owned };
  },
  uninstall(options) {
    const location = "Claude Code user settings (claude mcp, --scope user)";
    const cli = claudeCli();
    if (!cli) return { client: "claude-code", status: "failed", location, backup_path: null, detail: "The claude command was not found." };
    if (runCli(cli, ["mcp", "get", ENTRY_NAME], 30_000).status !== 0) return { client: "claude-code", status: "absent", location, backup_path: null, detail: "No Dialogues entry found." };
    if (options.owned?.adapter !== "claude-cli") return { client: "claude-code", status: "not-owned", location, backup_path: null, detail: "This entry was not created by this Dialogues setup; it was left alone." };
    if (options.dryRun) return { client: "claude-code", status: "removed", location, backup_path: null, detail: "Dry run: would run claude mcp remove." };
    const removed = runCli(cli, ["mcp", "remove", ENTRY_NAME, "--scope", "user"], 30_000);
    return removed.status === 0
      ? { client: "claude-code", status: "removed", location, backup_path: null, detail: "Removed." }
      : { client: "claude-code", status: "failed", location, backup_path: null, detail: describeFailure("claude mcp remove", removed) };
  }
};

// ---------- Codex (CLI preferred, TOML fallback) ----------

export function codexHome(): string {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(home(), ".codex");
}

function codexCli(): string | null {
  if (process.env.DIALOGUES_CODEX_CLI) return process.env.DIALOGUES_CODEX_CLI === "none" ? null : process.env.DIALOGUES_CODEX_CLI;
  return findOnPath("codex");
}

function codexEntryDigest(launch: ServerLaunch): string {
  return digestEntry({ command: launch.command, args: launch.args });
}

function codexGet(cli: string): { exists: boolean; command?: string; args?: string[] } {
  const result = runCli(cli, ["mcp", "get", ENTRY_NAME, "--json"], 30_000);
  if (result.status !== 0) return { exists: false };
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const transport = (parsed.transport ?? parsed) as Record<string, unknown>;
    return {
      exists: true,
      command: typeof transport.command === "string" ? transport.command : undefined,
      args: Array.isArray(transport.args) ? transport.args.map(String) : undefined
    };
  } catch {
    return { exists: true };
  }
}

function codexAdd(cli: string, command: string, args: string[]): RunResult {
  return runCli(cli, ["mcp", "add", ENTRY_NAME, "--", command, ...args]);
}

function codexTomlPath(): string {
  return path.join(codexHome(), "config.toml");
}

function codexTomlInstall(launch: ServerLaunch, options: InstallOptions): InstallOutcome {
  const configPath = codexTomlPath();
  const block = codexBlock(launch);
  const digest = sha256Text(codexBlockDigestInput(block));
  const owned = { adapter: "codex-toml", location: configPath, entry_name: ENTRY_NAME, entry_digest: digest, verified: true };
  const text = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "") : "";
  const scan = scanCodexToml(text);
  if (scan.inlineDefinition) {
    return { client: "codex", status: "conflict", location: configPath, backup_path: null, detail: "config.toml defines a dialogues server in a form Dialogues does not edit; it was left alone." };
  }
  const current = currentCodexBlock(scan);
  if (current !== null) {
    const currentDigest = sha256Text(codexBlockDigestInput(current));
    if (currentDigest === digest) return { client: "codex", status: "unchanged", location: configPath, backup_path: null, detail: "Dialogues is already connected with these settings.", owned };
    const ours = options.owned?.location === configPath && options.owned.entry_digest === currentDigest;
    if (!ours && !options.replace) {
      return { client: "codex", status: "conflict", location: configPath, backup_path: null, detail: "config.toml already has a dialogues server that this setup did not create (or it was edited). Re-run with --replace to overwrite it." };
    }
  }
  if (options.dryRun) return { client: "codex", status: current ? "updated" : "installed", location: configPath, backup_path: null, detail: "Dry run: no file was written." };
  const next = replaceCodexBlock(text, block);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let backup: string | null = null;
  if (fs.existsSync(configPath)) {
    backup = `${configPath}.dialogues-backup-${Date.now()}`;
    fs.copyFileSync(configPath, backup);
  }
  const temp = `${configPath}.dialogues-tmp-${process.pid}`;
  fs.writeFileSync(temp, next, "utf8");
  const latest = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "") : "";
  if (latest !== text) {
    fs.rmSync(temp, { force: true });
    return { client: "codex", status: "conflict", location: configPath, backup_path: backup, detail: "config.toml changed while Dialogues was editing it. Nothing was written; retry." };
  }
  renameWithRetry(temp, configPath);
  return { client: "codex", status: current ? "updated" : "installed", location: configPath, backup_path: backup, detail: `Config written. ${codexAdapter.restartHint}`, owned };
}

const codexAdapter: ClientAdapter = {
  id: "codex",
  displayName: "Codex",
  restartHint: "Restart Codex (start a new session or reopen the app).",
  supportsSkills: true,
  detect: () => {
    const cli = codexCli();
    const hint = Boolean(cli) || fs.existsSync(codexHome());
    return { hint, detail: cli ? "codex command found on PATH." : hint ? "Codex settings folder found (a hint)." : "Codex not found." };
  },
  location: () => {
    const cli = codexCli();
    return cli ? `Codex MCP settings (codex mcp, ${codexHome()})` : codexTomlPath();
  },
  install(launch, options) {
    const cli = codexCli();
    if (!cli) return codexTomlInstall(launch, options);
    const location = `Codex MCP settings (codex mcp, ${codexHome()})`;
    const digest = codexEntryDigest(launch);
    const owned = { adapter: "codex-cli", location, entry_name: ENTRY_NAME, entry_digest: digest, verified: true };
    if (options.dryRun) return { client: "codex", status: "installed", location, backup_path: null, detail: "Dry run: would run codex mcp add." };
    const existing = codexGet(cli);
    if (existing.exists) {
      const existingDigest = existing.command ? digestEntry({ command: existing.command, args: existing.args ?? [] }) : null;
      if (existingDigest === digest) return { client: "codex", status: "unchanged", location, backup_path: null, detail: "Dialogues is already connected with these settings.", owned };
      const ours = options.owned?.adapter === "codex-cli" && existingDigest !== null && options.owned.entry_digest === existingDigest;
      if (!ours && !options.replace) {
        return { client: "codex", status: "conflict", location, backup_path: null, detail: `Codex already has an MCP server named "${ENTRY_NAME}" that this setup did not create (or it was edited). Re-run with --replace to overwrite it.` };
      }
      // `codex mcp add` replaces an entry of the same name in one step.
      const added = codexAdd(cli, launch.command, launch.args);
      if (added.status !== 0) {
        // Put the previous entry back so Codex keeps working.
        const restored = existing.command ? codexAdd(cli, existing.command, existing.args ?? []) : null;
        return {
          client: "codex",
          status: "failed",
          location,
          backup_path: null,
          detail: `${describeFailure("codex mcp add", added)}${restored?.status === 0 ? " The previous entry was restored." : ""}`,
          recovery: restored?.status === 0 ? undefined : "Re-run dialogues setup --client codex, or add the server with codex mcp add."
        };
      }
      return { client: "codex", status: "updated", location, backup_path: null, detail: `Updated. ${codexAdapter.restartHint}`, owned };
    }
    const added = codexAdd(cli, launch.command, launch.args);
    if (added.status !== 0) return { client: "codex", status: "failed", location, backup_path: null, detail: describeFailure("codex mcp add", added) };
    return { client: "codex", status: "installed", location, backup_path: null, detail: `Added. ${codexAdapter.restartHint}`, owned };
  },
  uninstall(options) {
    const cli = codexCli();
    if (!cli || options.owned?.adapter === "codex-toml") {
      const configPath = codexTomlPath();
      const text = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
      const current = currentCodexBlock(scanCodexToml(text));
      if (current === null) return { client: "codex", status: "absent", location: configPath, backup_path: null, detail: "No Dialogues entry found." };
      if (options.owned?.adapter !== "codex-toml" || options.owned.location !== configPath) return { client: "codex", status: "not-owned", location: configPath, backup_path: null, detail: "This entry was not created by this Dialogues setup; it was left alone." };
      if (sha256Text(codexBlockDigestInput(current)) !== options.owned.entry_digest) return { client: "codex", status: "modified", location: configPath, backup_path: null, detail: "The entry was changed after setup, so it was left alone." };
      if (options.dryRun) return { client: "codex", status: "removed", location: configPath, backup_path: null, detail: "Dry run: would remove the entry." };
      const backup = `${configPath}.dialogues-backup-${Date.now()}`;
      fs.copyFileSync(configPath, backup);
      const temp = `${configPath}.dialogues-tmp-${process.pid}`;
      fs.writeFileSync(temp, replaceCodexBlock(text, null), "utf8");
      renameWithRetry(temp, configPath);
      return { client: "codex", status: "removed", location: configPath, backup_path: backup, detail: "Removed." };
    }
    const location = `Codex MCP settings (codex mcp, ${codexHome()})`;
    const existing = codexGet(cli);
    if (!existing.exists) return { client: "codex", status: "absent", location, backup_path: null, detail: "No Dialogues entry found." };
    if (options.owned?.adapter !== "codex-cli") return { client: "codex", status: "not-owned", location, backup_path: null, detail: "This entry was not created by this Dialogues setup; it was left alone." };
    const existingDigest = existing.command ? digestEntry({ command: existing.command, args: existing.args ?? [] }) : null;
    if (existingDigest !== options.owned.entry_digest) return { client: "codex", status: "modified", location, backup_path: null, detail: "The entry was changed after setup, so it was left alone." };
    if (options.dryRun) return { client: "codex", status: "removed", location, backup_path: null, detail: "Dry run: would run codex mcp remove." };
    const removed = runCli(cli, ["mcp", "remove", ENTRY_NAME]);
    return removed.status === 0
      ? { client: "codex", status: "removed", location, backup_path: null, detail: "Removed." }
      : { client: "codex", status: "failed", location, backup_path: null, detail: describeFailure("codex mcp remove", removed) };
  }
};

export const CLIENT_ADAPTERS: Record<ClientId, ClientAdapter> = {
  "claude-desktop": claudeDesktop,
  "claude-code": claudeCode,
  codex: codexAdapter,
  cursor,
  vscode,
  antigravity
};

export function isClientId(value: string): value is ClientId {
  return value in CLIENT_ADAPTERS;
}

// ---------- Snippets (any app) ----------

export type SnippetClient = ClientId;

export function generateSnippet(client: SnippetClient, launch: ServerLaunch): string {
  if (client === "codex") {
    return ["# Add to ~/.codex/config.toml (or run: codex mcp add dialogues -- <command> <args>)", codexBlock(launch)].join("\n");
  }
  if (client === "claude-code") {
    return JSON.stringify({ type: "stdio", command: launch.command, args: launch.args }, null, 2);
  }
  if (client === "vscode") {
    return JSON.stringify({ servers: { [ENTRY_NAME]: { type: "stdio", command: launch.command, args: launch.args } } }, null, 2);
  }
  return JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: launch.command, args: launch.args } } }, null, 2);
}

export function snippetFileName(client: SnippetClient): string {
  return client === "codex" ? "codex.toml" : `${client}.json`;
}
