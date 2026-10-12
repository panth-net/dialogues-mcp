// Release artifact check:
//   1. pack once (prepack builds), 2. check the file inventory, 3. privacy-scan the
//   extracted package, 4. install that exact tarball into isolated npm prefixes
//   (production-only, and without optional dependencies) under a path with spaces and
//   non-ASCII characters, 5. run the installed CLI and MCP server from outside the
//   checkout with an isolated home, 6. confirm the installed package tree is unchanged.
// Usage: node scripts/pack-check.mjs [--tarball <file>] [--keep]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const tarballArg = args.includes("--tarball") ? path.resolve(args[args.indexOf("--tarball") + 1]) : null;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "dialogues pack ü "));
const results = [];
let failed = false;

function step(name, fn) {
  try {
    const detail = fn();
    results.push({ step: name, ok: true, detail });
    console.log(`ok   ${name}${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    failed = true;
    results.push({ step: name, ok: false, detail: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

function run(command, commandArgs, options = {}) {
  const isWinShim = process.platform === "win32" && /\.cmd$/i.test(command);
  const result = spawnSync(command, commandArgs, { encoding: "utf8", shell: isWinShim, timeout: 10 * 60_000, ...options });
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} ${commandArgs.slice(0, 3).join(" ")} exited ${result.status}: ${(result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" | ")}`);
  }
  return result.stdout;
}

function quoteWin(value) {
  return `"${value}"`;
}

/** Minimal .tgz reader for npm pack output (ustar + pax path headers); refuses unsafe names. */
function extractTgz(file, destination) {
  const data = zlib.gunzipSync(fs.readFileSync(file));
  let offset = 0;
  let paxPath = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(text(124, 12).trim() || "0", 8);
    const type = text(156, 1);
    const prefix = text(345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const match = body.toString("utf8").match(/\d+ path=([^\n]+)\n/);
      paxPath = match ? match[1] : null;
      continue;
    }
    paxPath = null;
    if (type !== "0" && type !== "" && type !== "5") continue;
    if (name.split("/").includes("..") || path.isAbsolute(name)) throw new Error(`unsafe entry in package: ${name}`);
    const target = path.join(destination, name);
    if (type === "5") fs.mkdirSync(target, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }
  }
}

let tarball = tarballArg;
step("pack", () => {
  if (tarball) return `using ${path.basename(tarball)}`;
  const out = run(npm, ["pack", "--json", "--pack-destination", quoteWin(work)], { cwd: root });
  const info = JSON.parse(out.slice(out.indexOf("[")))[0];
  tarball = path.join(work, info.filename);
  fs.writeFileSync(path.join(work, "pack.json"), JSON.stringify(info, null, 2));
  return `${info.filename}, ${info.entryCount} files, ${info.size} bytes packed, ${info.unpackedSize} unpacked, sha512 ${info.integrity.slice(0, 20)}...`;
});

const extracted = path.join(work, "extracted");
step("inventory", () => {
  fs.mkdirSync(extracted, { recursive: true });
  extractTgz(tarball, extracted);
  const pkg = path.join(extracted, "package");
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.push(path.relative(pkg, full).split(path.sep).join("/"));
    }
  };
  visit(pkg);
  const required = [
    "package.json", "README.md", "LICENSE", "PRIVACY.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md",
    "dist/cli/index.js", "dist/cli/main.js", "dist/mcp/server.js", "dist/core/sources/indexWorker.js", "dist/builtin-catalog.json",
    "integrations/skills/dialogues/SKILL.md", "resources/install-prompts.json", "templates/corpus/guide.md"
  ];
  const missing = required.filter((file) => !files.includes(file));
  const corpora = files.filter((file) => /^corpora\/[^/]+\/corpus\.yaml$/.test(file)).length;
  const samples = files.filter((file) => /^corpora\/[^/]+\/sample\.yaml$/.test(file)).length;
  const forbidden = files.filter((file) => /(\.sqlite|\.jsonl|\.tgz|\.map)$|^(src|test|scripts|workspace|user-corpora|node_modules)\/|gameplan|repomix|\/data\//.test(file));
  if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
  if (corpora !== 34) throw new Error(`expected 34 capsules, found ${corpora}`);
  if (samples !== 6) throw new Error(`expected 6 sample profiles, found ${samples}`);
  if (forbidden.length) throw new Error(`unexpected files: ${forbidden.slice(0, 10).join(", ")}`);
  return `${files.length} files, 34 capsules, 6 samples`;
});

step("privacy scan of the package", () => run(process.execPath, [path.join(root, "scripts", "privacy-scan.mjs"), "--dir", path.join(extracted, "package")]).trim());

function hashTree(dir) {
  const hash = crypto.createHash("sha256");
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        visit(full);
      } else {
        hash.update(path.relative(dir, full));
        hash.update(fs.readFileSync(full));
      }
    }
  };
  visit(dir);
  return hash.digest("hex");
}

// npm ignores --omit=optional for global installs, so the no-optional variant
// installs into a local project, which honors it.
for (const variant of [{ name: "production", omit: ["dev"], global: true }, { name: "no-optional", omit: ["dev", "optional"], global: false }]) {
  const prefix = path.join(work, `prefix ${variant.name}`);
  const home = path.join(work, `home ${variant.name}`);
  const dataDir = path.join(home, "Dialögues data");
  const outside = path.join(work, `cwd ${variant.name}`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DIALOGUES_HOME: "",
    DIALOGUES_WORKSPACE: "",
    DIALOGUES_WORKSPACE_MODE: "",
    DIALOGUES_CURSOR_CONFIG: path.join(home, ".cursor", "mcp.json"),
    DIALOGUES_CLAUDE_DESKTOP_CONFIG: path.join(home, "claude", "claude_desktop_config.json"),
    DIALOGUES_CLAUDE_CLI: "none",
    DIALOGUES_CODEX_CLI: "none",
    CODEX_HOME: path.join(home, ".codex")
  };
  for (const key of ["DIALOGUES_HOME", "DIALOGUES_WORKSPACE", "DIALOGUES_WORKSPACE_MODE"]) delete env[key];
  let packageDir = "";
  let cli = "";
  step(`install (${variant.name})`, () => {
    if (variant.global) {
      run(npm, ["install", "-g", "--prefix", quoteWin(prefix), ...variant.omit.map((omit) => `--omit=${omit}`), "--no-audit", "--no-fund", quoteWin(tarball)], { cwd: outside, env });
      packageDir = process.platform === "win32"
        ? path.join(prefix, "node_modules", "dialogues-mcp")
        : path.join(prefix, "lib", "node_modules", "dialogues-mcp");
    } else {
      fs.mkdirSync(prefix, { recursive: true });
      fs.writeFileSync(path.join(prefix, "package.json"), JSON.stringify({ name: "pack-check-project", private: true }));
      run(npm, ["install", ...variant.omit.map((omit) => `--omit=${omit}`), "--no-audit", "--no-fund", quoteWin(tarball)], { cwd: prefix, env });
      packageDir = path.join(prefix, "node_modules", "dialogues-mcp");
    }
    cli = path.join(packageDir, "dist", "cli", "index.js");
    if (!fs.existsSync(cli)) throw new Error("installed CLI script missing");
    const hasCanvas = [path.join(packageDir, "node_modules", "@napi-rs", "canvas"), path.join(path.dirname(packageDir), "@napi-rs", "canvas"), path.join(packageDir, "node_modules", "pdfjs-dist", "node_modules", "@napi-rs", "canvas")].some((dir) => fs.existsSync(dir));
    if (!variant.global && hasCanvas) throw new Error("optional canvas was installed despite --omit=optional");
    if (fs.existsSync(path.join(packageDir, "node_modules", "better-sqlite3"))) throw new Error("better-sqlite3 should not be installed");
    return `installed; optional canvas ${hasCanvas ? "present" : "absent"}`;
  });
  if (!cli) continue;
  const before = hashTree(packageDir);
  const node = (cliArgs) => run(process.execPath, [cli, ...cliArgs], { cwd: outside, env });
  step(`cli version (${variant.name})`, () => node(["--version"]).trim());
  step(`setup one app (${variant.name})`, () => {
    const result = JSON.parse(node(["setup", "--client", "cursor", "--data-dir", dataDir, "--json"]));
    if (result.status !== "connected") throw new Error(`status ${result.status}: ${result.server_check?.detail}`);
    if (fs.existsSync(env.DIALOGUES_CLAUDE_DESKTOP_CONFIG)) throw new Error("an app that was not selected was changed");
    return `${result.clients[0].status}; server check: ${result.server_check.detail}`;
  });
  step(`ready (${variant.name})`, () => {
    const ready = JSON.parse(node(["ready", "--json"]));
    if (ready.data_dir !== dataDir) throw new Error(`data folder ${ready.data_dir}`);
    return `pdf ${ready.pdf_support.available ? "available" : "unavailable"}; collections ${ready.collections.total}`;
  });
  step(`import, search, fetch (${variant.name})`, () => {
    const source = path.join(work, `docs ${variant.name}`);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "letter.txt"), "A letter about the copper mines and the river crossing.");
    const imported = JSON.parse(node(["import-folder", source, "--corpus-id", "pack-check", "--json"]));
    const search = JSON.parse(node(["search", "pack-check", "copper", "--json"]));
    const fetched = JSON.parse(node(["fetch", search.results[0].id, "--json"]));
    if (!fetched.passages.some((passage) => passage.is_target)) throw new Error("fetch failed");
    return `${imported.documents} document, ${search.count} hit`;
  });
  step(`mcp stdio both eras (${variant.name})`, () => {
    const probe = path.join(root, "scripts", "measure-startup.mjs");
    const out = run(process.execPath, [probe, "--cli", cli, "--data-dir", dataDir, "--runs", "1"], { cwd: root, env });
    const report = JSON.parse(out);
    const eras = report.results.map((result) => `${result.era} ${result.ready_ms}ms`).join(", ");
    if (!report.results.some((result) => result.era === "legacy") || !report.results.some((result) => result.era === "modern")) throw new Error(eras);
    return eras;
  });
  step(`package tree unchanged (${variant.name})`, () => {
    if (hashTree(packageDir) !== before) throw new Error("files inside the installed package changed");
    return "unchanged";
  });
}

fs.writeFileSync(path.join(work, "results.json"), JSON.stringify(results, null, 2));
if (!keep) fs.rmSync(work, { recursive: true, force: true });
else console.log(`kept: ${work}`);
if (failed) {
  console.error("\npack check failed");
  process.exit(1);
}
console.log("\npack check passed");
