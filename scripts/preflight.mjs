// Release preflight. Checks that every version source agrees, the tree is clean,
// the audit and scans pass, then packs ONCE into .release/ and test-installs that
// exact file. The publish workflow publishes this same artifact; it never rebuilds.
// Usage: node scripts/preflight.mjs --tag v0.2.0 [--allow-dirty]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const tag = args.includes("--tag") ? args[args.indexOf("--tag") + 1] : null;
const allowDirty = args.includes("--allow-dirty");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const problems = [];

function sh(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8", shell: process.platform === "win32" && /\.cmd$/i.test(command), ...options });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) problems.push(name);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const server = JSON.parse(fs.readFileSync(path.join(root, "server.json"), "utf8"));
const version = pkg.version;

check("tag given", Boolean(tag), "pass --tag vX.Y.Z");
if (tag) check("tag matches package.json", tag === `v${version}`, `${tag} vs v${version}`);
check("lockfile root version", lock.version === version && lock.packages?.[""]?.version === version);
check("server.json versions", server.version === version && server.packages?.[0]?.version === version);
check("changelog has this version", new RegExp(`^## \\[?${version.replace(/\./g, "\\.")}\\]?`, "m").test(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")), `add a "## ${version}" section`);
const status = sh("git", ["status", "--porcelain"]);
check("clean working tree", allowDirty || (status.ok && status.out === ""), allowDirty ? "skipped (--allow-dirty)" : "commit or stash changes");
check("server.json schema", sh(process.execPath, ["scripts/validate-server-json.mjs"]).ok);
check("prompts in sync", sh(process.execPath, ["scripts/sync-prompts.mjs", "--check"]).ok);
check("privacy scan", sh(process.execPath, ["scripts/privacy-scan.mjs"]).ok);
check("production audit (high/critical)", sh(npm, ["audit", "--omit=dev", "--audit-level=high"]).ok);
check("typecheck", sh(npm, ["run", "typecheck"]).ok);
check("tests", sh(npm, ["test"]).ok);

const built = sh(process.execPath, ["dist/cli/index.js", "--version"]);
check("CLI reports the package version", built.ok && built.out.split(/\r?\n/).pop() === version, built.out.split(/\r?\n/).pop());

if (problems.length) {
  console.error(`\npreflight failed: ${problems.join(", ")}`);
  process.exit(1);
}

const releaseDir = path.join(root, ".release");
fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir);
const packed = sh(npm, ["pack", "--json", "--pack-destination", ".release"]);
if (!packed.ok) {
  console.error(packed.out);
  process.exit(1);
}
const info = JSON.parse(packed.out.slice(packed.out.indexOf("[")))[0];
const tarball = path.join(releaseDir, info.filename);
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
const verify = sh(process.execPath, ["scripts/pack-check.mjs", "--tarball", tarball]);
check("installed-tarball check", verify.ok, verify.ok ? "" : verify.out.split(/\r?\n/).filter((line) => line.startsWith("FAIL")).join("; "));
if (!verify.ok) process.exit(1);
const manifest = { name: pkg.name, version, tag, filename: info.filename, integrity: info.integrity, sha256, files: info.entryCount, created_at: new Date().toISOString() };
fs.writeFileSync(path.join(releaseDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\npreflight passed. Artifact: .release/${info.filename}\n${info.integrity}`);
