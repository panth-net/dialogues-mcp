import { dataDir, homeDir, tempDir, writeCapsule } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { resolveDataDir, defaultDataDir, ensureDataDirectories } from "../dist/core/paths.js";
import { getCorpusCapsule, invalidateCorpusCache, loadCorpusFromPath } from "../dist/core/corpus/loader.js";
import { GenericIndex, reindexGenericCorpus } from "../dist/core/db/genericIndex.js";
import { withCorpusWriter, corpusLockPath } from "../dist/core/state/corpusLock.js";
import { LockBusyError } from "../dist/core/state/files.js";
import { applyMigration, legacyDataDetected, planMigration } from "../dist/core/state/migration.js";
import { buildIndexFromDownloads, loadDownloadState, sourceStatus } from "../dist/core/sources/download.js";
import { runReady } from "../dist/setup/lifecycle.js";
import { searchCorpus } from "../dist/core/search/corpusTools.js";
import { getPreferences } from "../dist/core/preferences.js";
import { assertUrlAllowed, fetchBytes, hostAllowed, isPrivateAddress, registrableDomain } from "../dist/core/sources/http.js";

function withEnv(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("data folder precedence: flag, then DIALOGUES_HOME, then legacy names, then saved pointer, then ~/Dialogues", () => {
  const flag = path.join(homeDir, "flag");
  const env = path.join(homeDir, "env");
  const legacy = path.join(homeDir, "legacy");
  assert.deepEqual(withEnv({ DIALOGUES_HOME: env }, () => resolveDataDir({ dataDir: flag })).origin, "flag");
  assert.equal(withEnv({ DIALOGUES_HOME: env }, () => resolveDataDir({ legacyWorkspace: legacy })).origin, "legacy-flag");
  const both = withEnv({ DIALOGUES_HOME: env, DIALOGUES_WORKSPACE: legacy }, () => resolveDataDir());
  assert.equal(both.dataDir, path.resolve(env));
  assert.match(both.warnings.join(" "), /using DIALOGUES_HOME/);
  assert.equal(withEnv({ DIALOGUES_HOME: undefined, DIALOGUES_WORKSPACE: legacy }, () => resolveDataDir()).origin, "legacy-env");

  const pointerDir = path.join(homeDir, ".dialogues");
  fs.mkdirSync(pointerDir, { recursive: true });
  fs.writeFileSync(path.join(pointerDir, "config.json"), JSON.stringify({ dialogues_pointer_version: 1, data_dir: path.join(homeDir, "Saved"), saved_at: "x" }));
  const saved = withEnv({ DIALOGUES_HOME: undefined, DIALOGUES_WORKSPACE: undefined }, () => resolveDataDir());
  assert.equal(saved.origin, "saved");
  assert.equal(saved.dataDir, path.join(homeDir, "Saved"));
  fs.rmSync(path.join(pointerDir, "config.json"));
  const fallback = withEnv({ DIALOGUES_HOME: undefined, DIALOGUES_WORKSPACE: undefined }, () => resolveDataDir());
  assert.equal(fallback.origin, "default");
  assert.equal(fallback.dataDir, defaultDataDir());
});

test("the working directory never selects the data folder", () => {
  const original = process.cwd();
  process.chdir(path.resolve("."));
  try {
    const result = withEnv({ DIALOGUES_HOME: undefined, DIALOGUES_WORKSPACE: undefined, DIALOGUES_WORKSPACE_MODE: undefined }, () => resolveDataDir());
    assert.equal(result.origin, "default", "running inside the checkout does not switch to the repo workspace");
  } finally {
    process.chdir(original);
  }
});

function indexCapsule(id) {
  const dir = writeCapsule(path.join(dataDir, "user-corpora", id), { id, title: id, chunking: { min_chars: 10, max_chars: 200, overlap_chars: 0 } });
  invalidateCorpusCache();
  return loadCorpusFromPath(dir, "user");
}

test("a failed rebuild leaves the previous search file searchable and no leftovers", () => {
  const capsule = indexCapsule("integrity-test");
  reindexGenericCorpus(capsule, [{ id: "doc", title: "Doc", sourcePath: "doc.txt", text: "original meadow text" }]);
  assert.throws(() => reindexGenericCorpus(capsule, [
    { id: "dup", title: "A", sourcePath: "a.txt", text: "new words" },
    { id: "dup", title: "B", sourcePath: "b.txt", text: "duplicate id breaks the build" }
  ]));
  assert.throws(() => reindexGenericCorpus(capsule, []), /previous index was kept/);
  assert.equal(searchCorpus(capsule, "meadow", 5).count, 1);
  const leftovers = fs.readdirSync(path.dirname(capsule.indexPath)).filter((name) => /building|previous|tmp/.test(name));
  assert.deepEqual(leftovers, []);
});

test("an open reader does not corrupt a rebuild", (t) => {
  const capsule = indexCapsule("reader-test");
  reindexGenericCorpus(capsule, [{ id: "doc", title: "Doc", sourcePath: "doc.txt", text: "first generation words" }]);
  const reader = new GenericIndex(capsule);
  try {
    let replaced = false;
    try {
      reindexGenericCorpus(capsule, [{ id: "doc", title: "Doc", sourcePath: "doc.txt", text: "second generation words" }]);
      replaced = true;
    } catch (error) {
      // Windows refuses to replace a file another handle holds open.
      if (process.platform !== "win32") throw error;
    }
    assert.equal(reader.search("generation", 5).length, 1, "the open reader keeps working");
    if (!replaced) t.diagnostic("replacement deferred while a reader was open (Windows file locking)");
  } finally {
    reader.close();
  }
  assert.equal(searchCorpus(capsule, "generation", 5).count, 1, "a complete generation is searchable afterwards");
});

test("one writer per collection: a live lock blocks, a dead one is taken over", () => {
  const capsule = indexCapsule("lock-test");
  const lock = corpusLockPath("lock-test");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid || 1, acquired_at: new Date().toISOString(), purpose: "testing" }));
  assert.throws(() => withCorpusWriter("lock-test", "rebuild", () => 1), LockBusyError);
  fs.writeFileSync(lock, JSON.stringify({ pid: 999_999_9, acquired_at: new Date().toISOString(), purpose: "crashed" }));
  assert.equal(withCorpusWriter("lock-test", "rebuild", () => 2), 2);
  assert.equal(fs.existsSync(lock), false, "lock released");
  assert.ok(capsule);
});

test("migration copies and verifies earlier data, keeps originals, preserves IDs, and never overwrites", async () => {
  ensureDataDirectories();
  const old = tempDir("old-checkout");
  // An earlier user corpus with its index inside the capsule folder.
  const notesRoot = path.join(old, "user-corpora", "my-notes");
  writeCapsule(notesRoot, { id: "my-notes", title: "My Notes", chunking: { min_chars: 10, max_chars: 200, overlap_chars: 0 } });
  fs.mkdirSync(path.join(notesRoot, "documents"), { recursive: true });
  fs.writeFileSync(path.join(notesRoot, "documents", "a.txt"), "notes about lighthouses", "utf8");
  const oldCapsule = loadCorpusFromPath(notesRoot, "user");
  const built = reindexGenericCorpus({ ...oldCapsule, indexPath: path.join(notesRoot, "index.sqlite") }, [{ id: "a", title: "A", sourcePath: "a.txt", text: "notes about lighthouses" }]);
  assert.equal(built.documents, 1);
  // Earlier Jesuit text kept inside the checkout.
  const jesuitRaw = path.join(old, "corpora", "jesuit-relations", "data", "raw");
  fs.mkdirSync(jesuitRaw, { recursive: true });
  fs.writeFileSync(path.join(jesuitRaw, "jesuits01jesuuoft_djvu.txt"), "RELATIONS of the mission at Port Royal in Acadia, 1611.", "utf8");
  // Earlier workspace state.
  const ws = path.join(old, "workspace");
  fs.mkdirSync(path.join(ws, "source-cache", "pepys-diary"), { recursive: true });
  fs.mkdirSync(path.join(ws, "source-cache", "pepys-diary", "raw"), { recursive: true });
  fs.writeFileSync(path.join(ws, "source-cache", "pepys-diary", "raw", "pg-pepys-diary-complete.txt"), "Up betimes and to the Navy Office, where the shipwrights waited.", "utf8");
  fs.writeFileSync(path.join(ws, "preferences.json"), JSON.stringify({ answer_format: "quotes first" }));
  fs.writeFileSync(path.join(ws, "installed-corpora.json"), JSON.stringify({ corpora: [{ path: "elsewhere/capsule" }] }));
  fs.writeFileSync(path.join(ws, "source-cache", "pepys-diary", "download-state.json"), JSON.stringify({
    corpus_id: "pepys-diary",
    generated_at: "2026-07-18T01:19:26.177Z",
    selection: { mode: "curated-core" },
    downloaded: [{ id: "pg:pepys-diary-complete", text_path: "C:\\old\\workspace\\source-cache\\pepys-diary\\normalized\\pg.txt", status: "text" }],
    skipped: [],
    no_text: []
  }));
  // A conflicting file already in the new folder.
  fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "logs", "imports.jsonl"), "new\n");
  fs.mkdirSync(path.join(ws, "logs"), { recursive: true });
  fs.writeFileSync(path.join(ws, "logs", "imports.jsonl"), "old\n");

  const plan = planMigration({ from: [old], onlyFrom: true });
  assert.ok(plan.totals.copy >= 6);
  assert.equal(plan.totals.conflict, 1);
  const result = applyMigration(plan);
  assert.equal(result.ok, true, JSON.stringify(result.error_items));
  assert.equal(fs.readFileSync(path.join(dataDir, "logs", "imports.jsonl"), "utf8"), "new\n", "conflicts are not overwritten");
  assert.ok(fs.existsSync(path.join(notesRoot, "index.sqlite")), "originals are kept");

  invalidateCorpusCache();
  const migrated = getCorpusCapsule("my-notes");
  const hit = searchCorpus(migrated, "lighthouses", 5).results[0];
  assert.equal(hit.id, "corpus:my-notes:doc:a:chunk:0", "passage IDs are preserved");
  assert.equal(getPreferences().answer_format, "quotes first");
  const installed = JSON.parse(fs.readFileSync(path.join(dataDir, "installed-corpora.json"), "utf8"));
  assert.ok(path.isAbsolute(installed.corpora[0].path), "relative registrations become absolute");
  const pepys = loadDownloadState("pepys-diary");
  assert.equal(pepys.approvals[0].consented_at, null, "old report times are not presented as consent");
  assert.equal(pepys.items["pg:pepys-diary-complete"].status, "text");

  const rebuilt = await buildIndexFromDownloads("jesuit-relations");
  assert.equal(rebuilt.documents, 1, "migrated Jesuit text can be reindexed offline");
  assert.equal(searchCorpus(getCorpusCapsule("jesuit-relations"), "Acadia", 5).count, 1);

  const pepysRebuilt = await buildIndexFromDownloads("pepys-diary");
  assert.equal(pepysRebuilt.documents, 1, "a download migrated from an old workspace rebuilds offline");
  assert.equal(searchCorpus(getCorpusCapsule("pepys-diary"), "shipwrights", 5).count, 1);

  const again = planMigration({ from: [old], onlyFrom: true });
  assert.equal(again.totals.copy, 0, "a second run copies nothing");
});

test("a cleanly migrated folder is not offered for migration again", () => {
  const legacyHome = path.join(homeDir, ".dialogues");
  fs.mkdirSync(path.join(legacyHome, "logs"), { recursive: true });
  fs.writeFileSync(path.join(legacyHome, "logs", "old-events.jsonl"), "{}\n");
  assert.ok(legacyDataDetected().sources.includes(legacyHome));
  const result = applyMigration(planMigration({ from: [legacyHome], onlyFrom: true }));
  assert.equal(result.ok, true, JSON.stringify(result.error_items));
  assert.equal(result.conflicts, 0);
  assert.equal(fs.existsSync(path.join(legacyHome, "logs", "old-events.jsonl")), true, "originals are kept");
  assert.ok(!legacyDataDetected().sources.includes(legacyHome));
});

test("a search file with no download record is reported as searchable, not as not downloaded", async () => {
  const capsule = getCorpusCapsule("lincoln-papers");
  reindexGenericCorpus(capsule, [{ id: "old", title: "Old", sourcePath: "old.txt", text: "a house divided against itself" }]);
  assert.equal(sourceStatus("lincoln-papers").collection_state, "partial_selection");
  const report = await runReady();
  assert.ok(report.collections.by_state.partial_selection >= 1);
});

test("network boundary: private, local, credentialed, and off-list destinations are refused", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.1.1", "169.254.1.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "140.82.112.3", "2606:4700::1111"]) assert.equal(isPrivateAddress(address), false, address);
  assert.equal(registrableDomain("tile.loc.gov"), "loc.gov");
  assert.equal(registrableDomain("www.darwinproject.ac.uk"), "darwinproject.ac.uk");
  assert.equal(hostAllowed("ia800.us.archive.org", ["archive.org"]), true);
  assert.equal(hostAllowed("archive.org.evil.com", ["archive.org"]), false);
  const ctx = { allowedDomains: ["example.org"], skipDnsCheck: true };
  for (const url of ["ftp://example.org/x", "file:///etc/passwd", "https://user:pw@example.org/", "https://127.0.0.1/", "https://localhost/", "https://printer.local/", "https://other.org/"]) {
    await assert.rejects(() => assertUrlAllowed(url, ctx), undefined, url);
  }
  await assertUrlAllowed("https://www.example.org/a", ctx);
});

test("downloads are bounded by size and time", async () => {
  const big = new Uint8Array(2048);
  const sized = await fetchBytes("https://example.org/big", {
    allowedDomains: ["example.org"], minIntervalMs: 0, maxBytes: 1024, maxAttempts: 1,
    fetchImpl: async () => new Response(big, { status: 200 })
  }).catch((error) => error);
  assert.match(String(sized.message), /larger than/);
  const slow = await fetchBytes("https://example.org/slow", {
    allowedDomains: ["example.org"], minIntervalMs: 0, connectTimeoutMs: 100, maxAttempts: 1,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))
  }).catch((error) => error);
  assert.match(String(slow.message), /Timed out/);
  const yamlOk = YAML.parse("a: 1");
  assert.equal(yamlOk.a, 1);
});
