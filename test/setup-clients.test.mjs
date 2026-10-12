import { dataDir, homeDir, tempDir } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runSetup, runUninstall, runReady } from "../dist/setup/lifecycle.js";
import { readInstallState } from "../dist/setup/ownership.js";
import { replaceCodexBlock, scanCodexToml } from "../dist/setup/codexToml.js";
import { pointerPath } from "../dist/core/paths.js";

const desktopConfig = process.env.DIALOGUES_CLAUDE_DESKTOP_CONFIG;
const vscodeConfig = path.join(process.env.DIALOGUES_VSCODE_USER_DIR, "mcp.json");
const codexToml = path.join(process.env.CODEX_HOME, "config.toml");

function forgetOwnership() {
  fs.rmSync(path.join(dataDir, "install-state.json"), { force: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function setup(clients, extra = {}) {
  return runSetup({ clients, probe: false, ...extra });
}

test("setup asks which app when none is named and changes nothing", async () => {
  const result = await runSetup({ clients: [] });
  assert.equal(result.status, "needs-selection");
  assert.equal(result.exit_code, 3);
  assert.equal(fs.existsSync(desktopConfig), false);
});

test("Claude Desktop: merges one entry, keeps everything else, and is ownership-aware", async () => {
  fs.mkdirSync(path.dirname(desktopConfig), { recursive: true });
  const original = { globalShortcut: "Ctrl+Space", mcpServers: { other: { command: "other-server", env: { API_TOKEN: "do-not-print" } } } };
  fs.writeFileSync(desktopConfig, JSON.stringify(original, null, 2));

  const first = await setup(["claude-desktop"]);
  assert.equal(first.exit_code, 0, JSON.stringify(first.clients));
  assert.equal(first.clients[0].status, "installed");
  assert.ok(first.clients[0].backup_path && fs.existsSync(first.clients[0].backup_path));
  assert.ok(!JSON.stringify(first).includes("do-not-print"), "other entries' values are never echoed");
  const written = readJson(desktopConfig);
  assert.deepEqual(written.mcpServers.other, original.mcpServers.other);
  assert.equal(written.globalShortcut, "Ctrl+Space");
  assert.equal(written.mcpServers.dialogues.command, process.execPath);
  assert.deepEqual(written.mcpServers.dialogues.args.slice(-3), ["serve", "--data-dir", dataDir]);
  assert.ok(!JSON.stringify(readInstallState()).includes("do-not-print"), "ownership records hold no unrelated settings");

  const again = await setup(["claude-desktop"]);
  assert.equal(again.clients[0].status, "unchanged");

  // The user edits the entry: setup leaves it alone unless --replace.
  const edited = readJson(desktopConfig);
  edited.mcpServers.dialogues.args.push("--custom");
  fs.writeFileSync(desktopConfig, JSON.stringify(edited, null, 2));
  const conflict = await setup(["claude-desktop"]);
  assert.equal(conflict.clients[0].status, "conflict");
  assert.equal(conflict.exit_code, 4);
  assert.ok(readJson(desktopConfig).mcpServers.dialogues.args.includes("--custom"));

  const uninstallModified = runUninstall({ clients: ["claude-desktop"] });
  assert.equal(uninstallModified.clients[0].status, "modified", "edited entries are not removed");

  const replaced = await setup(["claude-desktop"], { replace: true });
  assert.equal(replaced.clients[0].status, "updated");
  const removed = runUninstall({ clients: ["claude-desktop"] });
  assert.equal(removed.clients[0].status, "removed");
  const after = readJson(desktopConfig);
  assert.equal(after.mcpServers.dialogues, undefined);
  assert.deepEqual(after.mcpServers.other, original.mcpServers.other, "unrelated entries survive uninstall");
});

test("Antigravity: writes mcp_config.json under ~/.gemini/config, keeps other servers, and uninstalls only its own entry", async () => {
  const { antigravityConfigPath } = await import("../dist/setup/clients.js");
  const current = path.join(homeDir, ".gemini", "config", "mcp_config.json");
  const legacy = path.join(homeDir, ".gemini", "antigravity", "mcp_config.json");
  assert.equal(antigravityConfigPath(), current, "the current location is the default");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, "");
  assert.equal(antigravityConfigPath(), current, "an empty early-build file is ignored");
  fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { old: { command: "old" } } }));
  assert.equal(antigravityConfigPath(), legacy, "an early build's file is used when it is the only one");
  fs.rmSync(legacy);

  fs.mkdirSync(path.dirname(current), { recursive: true });
  fs.writeFileSync(current, JSON.stringify({ mcpServers: { github: { serverUrl: "https://example.test/mcp", headers: { Authorization: "do-not-print" } } } }, null, 2));
  const first = await setup(["antigravity"]);
  assert.equal(first.exit_code, 0, JSON.stringify(first.clients));
  assert.equal(first.clients[0].status, "installed");
  assert.ok(!JSON.stringify(first).includes("do-not-print"));
  const written = readJson(current);
  assert.equal(written.mcpServers.github.serverUrl, "https://example.test/mcp");
  assert.equal(written.mcpServers.dialogues.command, process.execPath);
  assert.deepEqual(written.mcpServers.dialogues.args.slice(-3), ["serve", "--data-dir", dataDir]);
  assert.equal((await setup(["antigravity"])).clients[0].status, "unchanged");
  const removed = runUninstall({ clients: ["antigravity"] });
  assert.equal(removed.clients[0].status, "removed");
  assert.equal(readJson(current).mcpServers.dialogues, undefined);
  assert.equal(readJson(current).mcpServers.github.serverUrl, "https://example.test/mcp");
});

test("a corrupt app config fails safely and is not reset", async () => {
  fs.mkdirSync(path.dirname(desktopConfig), { recursive: true });
  fs.writeFileSync(desktopConfig, "{ not json");
  const result = await setup(["claude-desktop"]);
  assert.equal(result.clients[0].status, "conflict");
  assert.equal(fs.readFileSync(desktopConfig, "utf8"), "{ not json");
  fs.rmSync(desktopConfig);
});

test("VS Code: JSONC comments and other servers are preserved", async () => {
  fs.mkdirSync(path.dirname(vscodeConfig), { recursive: true });
  fs.writeFileSync(vscodeConfig, `{\n  // my servers\n  "servers": {\n    "github": { "type": "http", "url": "https://example.invalid/mcp" }, // keep me\n  },\n}\n`);
  const result = await setup(["vscode"]);
  assert.equal(result.clients[0].status, "installed", JSON.stringify(result.clients));
  const text = fs.readFileSync(vscodeConfig, "utf8");
  assert.match(text, /\/\/ my servers/);
  assert.match(text, /\/\/ keep me/);
  assert.match(text, /"dialogues"/);
  assert.match(text, /"type": "stdio"/);
  assert.equal(fs.existsSync(desktopConfig), false, "only the selected app was changed");
});

test("Codex config.toml fallback replaces only Dialogues tables, including subtables", async () => {
  fs.mkdirSync(path.dirname(codexToml), { recursive: true });
  const original = [
    "# my codex settings",
    "model = \"gpt-5\"",
    "",
    "[mcp_servers.other]",
    "command = \"other\"",
    "",
    "[mcp_servers.dialogues]",
    "command = \"old\"",
    "args = [\"old\"]",
    "",
    "[mcp_servers.dialogues.env]",
    "OLD = \"1\"",
    "",
    "[tools]",
    "enabled = true # trailing comment",
    ""
  ].join("\n");
  fs.writeFileSync(codexToml, original);
  const conflict = await setup(["codex"]);
  assert.equal(conflict.clients[0].status, "conflict", "an entry this setup did not create is left alone");
  const replaced = await setup(["codex"], { replace: true });
  assert.equal(replaced.clients[0].status, "updated");
  const next = fs.readFileSync(codexToml, "utf8");
  assert.match(next, /# my codex settings/);
  assert.match(next, /\[mcp_servers\.other\]/);
  assert.match(next, /enabled = true # trailing comment/);
  assert.doesNotMatch(next, /command = "old"|OLD = "1"|mcp_servers\.dialogues\.env/);
  assert.equal((next.match(/\[mcp_servers\.dialogues\]/g) ?? []).length, 1);
  assert.equal(scanCodexToml(next).ranges.length, 1);
  assert.equal(replaceCodexBlock("a = 1\n", null), "a = 1\n");
  const removed = runUninstall({ clients: ["codex"] });
  assert.equal(removed.clients[0].status, "removed");
  assert.doesNotMatch(fs.readFileSync(codexToml, "utf8"), /mcp_servers\.dialogues/);
});

function fakeCli(name, behavior = {}) {
  const dir = tempDir(`fake-${name}`);
  const statePath = path.join(dir, "state.json");
  const script = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(statePath, JSON.stringify({ servers: behavior.initial ?? {}, calls: [], failAddCount: behavior.failAddAfter ?? null }));
  fs.writeFileSync(script, `
import fs from "node:fs";
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const [, verb, name] = args;
let code = 0;
if (verb === "get") {
  if (!state.servers[name]) { code = 1; }
  else if (args.includes("--json")) process.stdout.write(JSON.stringify({ name, transport: state.servers[name] }));
  else process.stdout.write(name);
} else if (verb === "remove") {
  if (!state.servers[name]) code = 1; else delete state.servers[name];
} else if (verb === "add-json" || verb === "add") {
  const adds = state.calls.filter((call) => call[1] === "add-json" || call[1] === "add").length;
  if (state.failAddCount !== null && adds > state.failAddCount) { code = 1; process.stderr.write("simulated failure"); }
  else if (verb === "add-json") { state.servers[name] = JSON.parse(args[3]); }
  else { const sep = args.indexOf("--"); state.servers[name] = { type: "stdio", command: args[sep + 1], args: args.slice(sep + 2) }; }
}
save();
process.exit(code);
`);
  return {
    script,
    state: () => JSON.parse(fs.readFileSync(statePath, "utf8"))
  };
}

test("Claude Code: adds through its CLI, and replaces recoverably", async () => {
  const fake = fakeCli("claude", { initial: { dialogues: { type: "stdio", command: "someone-else" } } });
  process.env.DIALOGUES_CLAUDE_CLI = fake.script;
  try {
    const conflict = await setup(["claude-code"]);
    assert.equal(conflict.clients[0].status, "conflict");
    assert.equal(fake.state().servers.dialogues.command, "someone-else");

    const replaced = await setup(["claude-code"], { replace: true });
    assert.equal(replaced.clients[0].status, "updated", JSON.stringify(replaced.clients));
    const state = fake.state();
    assert.equal(state.servers.dialogues.command, process.execPath);
    assert.equal(state.servers["dialogues-setup-new"], undefined, "temporary entry cleaned up");
    assert.ok(state.calls.every((call) => call.includes("--scope") ? call.includes("user") : true));
    assert.equal(replaced.clients[0].skill.status, "installed");
    assert.ok(fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, "skills", "dialogues", "SKILL.md")));
  } finally {
    process.env.DIALOGUES_CLAUDE_CLI = "none";
  }
});

test("Claude Code: a failed final add keeps a working copy and explains recovery", async () => {
  forgetOwnership();
  const fake = fakeCli("claude-fail", { initial: { dialogues: { type: "stdio", command: "old" } }, failAddAfter: 1 });
  process.env.DIALOGUES_CLAUDE_CLI = fake.script;
  try {
    const result = await setup(["claude-code"], { replace: true });
    assert.equal(result.clients[0].status, "failed");
    assert.match(result.clients[0].recovery, /dialogues-setup-new/);
    assert.ok(fake.state().servers["dialogues-setup-new"], "a working entry remains");
  } finally {
    process.env.DIALOGUES_CLAUDE_CLI = "none";
  }
});

test("Codex CLI: ownership is checked from codex mcp get --json", async () => {
  const fake = fakeCli("codex");
  process.env.DIALOGUES_CODEX_CLI = fake.script;
  try {
    const installed = await setup(["codex"]);
    assert.equal(installed.clients[0].status, "installed", JSON.stringify(installed.clients));
    assert.deepEqual(fake.state().servers.dialogues.args.slice(-2), ["--data-dir", dataDir]);
    assert.equal((await setup(["codex"])).clients[0].status, "unchanged");
    const skill = path.join(homeDir, ".agents", "skills", "dialogues", "SKILL.md");
    assert.ok(fs.existsSync(skill));
    fs.appendFileSync(skill, "\nMy own note.\n");
    const removed = runUninstall({ clients: ["codex"] });
    assert.equal(removed.clients[0].status, "removed");
    assert.equal(removed.clients[0].skill.status, "kept-user-version", "an edited skill is kept");
    assert.ok(fs.existsSync(skill));
  } finally {
    process.env.DIALOGUES_CODEX_CLI = "none";
  }
});

test("ready is read-only and reports connected apps; uninstall can delete data only with exact confirmation", async () => {
  forgetOwnership();
  await setup(["cursor"]);
  const cursorConfig = process.env.DIALOGUES_CURSOR_CONFIG;
  assert.equal(readJson(cursorConfig).mcpServers.dialogues.type, "stdio");
  const before = fs.readdirSync(dataDir).sort();
  const ready = await runReady();
  assert.ok(ready.connected_apps.some((app) => app.client === "cursor"));
  assert.deepEqual(fs.readdirSync(dataDir).sort(), before, "ready wrote nothing");
  assert.ok(fs.existsSync(pointerPath()), "data folder remembered");

  const refused = runUninstall({ all: true, deleteData: true, confirmDataDir: path.join(dataDir, "..") });
  assert.equal(refused.data.deleted, false);
  assert.ok(fs.existsSync(dataDir));
  const deleted = runUninstall({ all: true, deleteData: true, confirmDataDir: dataDir });
  assert.equal(deleted.data.deleted, true);
  assert.equal(fs.existsSync(dataDir), false);
  assert.equal(fs.existsSync(pointerPath()), false, "pointer removed when nothing else is connected");
});

test("setup refuses dangerous data folders", async () => {
  const { assertUsableDataDir } = await import("../dist/setup/lifecycle.js");
  assert.throws(() => assertUsableDataDir(homeDir), /home folder/);
  assert.throws(() => assertUsableDataDir(path.parse(homeDir).root), /root of a drive/);
});

test("setup's server check starts the installed server and calls ping", async () => {
  const result = await runSetup({ clients: ["vscode"], probe: true, replace: true });
  assert.equal(result.server_check.ok, true, result.server_check.detail);
  assert.ok(result.server_check.tools >= 15);
});
