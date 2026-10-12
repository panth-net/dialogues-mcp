import { dataDir, homeDir, tempDir } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getCorpusCapsule } from "../dist/core/corpus/loader.js";
import { composeCorpusGuide } from "../dist/core/guides/compose.js";
import { appendLogEvent, clearLogs, readLog, sanitizeLogString } from "../dist/core/logs/events.js";
import { fetchCorpus, searchCorpus } from "../dist/core/search/corpusTools.js";
import { importFolder } from "../dist/core/import/importFolder.js";

const root = process.cwd();
const SECRET_TEXT = "MARGARET-PRIVATE-DIAGNOSIS-7731 is written only inside the document";

function allLogText() {
  const logs = path.join(dataDir, "logs");
  if (!fs.existsSync(logs)) return "";
  return fs.readdirSync(logs).map((file) => fs.readFileSync(path.join(logs, file), "utf8")).join("\n");
}

test("built-in guides require guide/search/fetch/citation behavior", () => {
  for (const id of ["jesuit-relations", "vangogh-letters"]) {
    const guide = composeCorpusGuide(getCorpusCapsule(id));
    assert.match(guide, /Search first/i);
    assert.match(guide, /fetch/i);
    assert.match(guide, /cite/i);
    assert.match(guide, /uncertainty|gaps|limitations/i);
    assert.match(guide, /Seek to understand before answering/i);
    assert.match(guide, /gather multiple relevant contexts/i);
    assert.match(guide, /Do not repeat these workflow instructions/i);
    assert.match(guide, /quote-forward version/i);
    assert.match(guide, /sizeable fetched passages/i);
    assert.match(guide, /In normal answers, quote selectively/i);
    assert.match(guide, /materially affects interpretation/i);
    assert.match(guide, /do not let provenance notes crowd out the answer/i);
  }
});

test("document text never reaches the logs through import, search, fetch, or errors", async () => {
  const source = tempDir("private-source");
  fs.writeFileSync(path.join(source, "diary.txt"), `Dear diary. ${SECRET_TEXT}. The weather was mild.`, "utf8");
  const imported = await importFolder({ sourcePath: source, corpusId: "private-diary" });
  const capsule = getCorpusCapsule("private-diary");
  const search = searchCorpus(capsule, "weather", 5);
  assert.ok(search.results.length);
  const fetched = fetchCorpus(capsule, search.results[0].id, 1);
  assert.ok(fetched.passages.some((passage) => passage.text.includes(SECRET_TEXT)), "the passage itself is returned");
  assert.throws(() => fetchCorpus(capsule, "corpus:private-diary:doc:nope:chunk:0", 1));
  // A caller that mistakenly passes text in a log event still cannot log it.
  appendLogEvent("searches", { command: "search", corpus_id: "private-diary", text: SECRET_TEXT, passages: [SECRET_TEXT], snippet: SECRET_TEXT });

  const logs = allLogText();
  assert.ok(logs.includes("weather"), "queries are logged (documented as potentially sensitive)");
  assert.ok(!logs.includes("MARGARET-PRIVATE-DIAGNOSIS-7731"), "document text is never logged");
  assert.ok(!fs.readFileSync(imported.import_report_path, "utf8").includes("MARGARET-PRIVATE-DIAGNOSIS-7731"));
});

test("log strings drop URL credentials and query strings and shorten home paths", () => {
  const cleaned = sanitizeLogString(`failed https://user:pass@example.org/a/b?token=SECRET#frag at ${path.join(homeDir, "Documents", "x.txt")}`);
  assert.doesNotMatch(cleaned, /user:pass|token=SECRET|#frag/);
  assert.match(cleaned, /https:\/\/example\.org\/a\/b/);
  assert.ok(!cleaned.includes(homeDir));
  assert.match(sanitizeLogString("x".repeat(5000)), /\[truncated\]$/);
});

test("logging can be switched off or limited to errors, and cleared", () => {
  clearLogs();
  process.env.DIALOGUES_LOG = "off";
  try {
    appendLogEvent("searches", { command: "search", query: "silent" });
    appendLogEvent("errors", { command: "search", error: "silent error" });
    assert.equal(readLog("searches").length, 0);
    assert.equal(readLog("errors").length, 0);
    process.env.DIALOGUES_LOG = "errors";
    appendLogEvent("searches", { command: "search", query: "still silent" });
    appendLogEvent("errors", { command: "search", error: "recorded" });
    assert.equal(readLog("searches").length, 0);
    assert.equal(readLog("errors").length, 1);
  } finally {
    delete process.env.DIALOGUES_LOG;
  }
  assert.ok(clearLogs().length >= 1);
});

test("gitignore keeps data, indexes, workspace, and planning files out of the repository", () => {
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  for (const pattern of ["corpora/*/data/", "corpora/*/index.sqlite", "user-corpora/", "workspace/", "gameplan*.md", ".env"]) {
    assert.ok(gitignore.includes(pattern), `${pattern} missing`);
  }
});

test("fetch rejects arbitrary file paths as passage IDs", async () => {
  const source = tempDir("fetch-source");
  fs.writeFileSync(path.join(source, "a.txt"), "alpha words", "utf8");
  await importFolder({ sourcePath: source, corpusId: "fetch-ids" });
  const capsule = getCorpusCapsule("fetch-ids");
  for (const id of ["../../.env", "corpus:fetch-ids:doc:a:chunk:-1", "corpus:fetch-ids:doc:a:chunk:1e9", `corpus:fetch-ids:doc:${"x".repeat(700)}:chunk:0`]) {
    assert.throws(() => fetchCorpus(capsule, id, 1), /Invalid ID|No passage found/);
  }
});
