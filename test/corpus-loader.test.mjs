import { tempDir, userCorpusDir, writeCapsule } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getCorpusCapsule, invalidateCorpusCache, listCorpusCapsules, loadCorpusFromPath } from "../dist/core/corpus/loader.js";

test("valid corpus loads and missing guide fails", () => {
  const base = tempDir("loader");
  const valid = writeCapsule(path.join(base, "valid-loader-test"), { id: "valid-loader-test", title: "Loader Test" });
  assert.equal(loadCorpusFromPath(valid, "user").id, "valid-loader-test");

  const missing = writeCapsule(path.join(base, "missing-guide-test"), { id: "missing-guide-test", title: "Loader Test" });
  fs.rmSync(path.join(missing, "guide.md"));
  assert.throws(() => loadCorpusFromPath(missing, "user"), /missing guide file/);
});

test("missing license policy fails", () => {
  const dir = writeCapsule(path.join(tempDir("loader-license"), "no-license"), { id: "no-license", title: "x", license: undefined });
  assert.throws(() => loadCorpusFromPath(dir, "user"), /missing required field: license/);
});

test("duplicate corpus IDs are reported by list loader", () => {
  writeCapsule(userCorpusDir("duplicate-jesuit-test"), { id: "jesuit-relations", title: "Duplicate Jesuit" });
  invalidateCorpusCache();
  const result = listCorpusCapsules();
  assert.ok(result.errors.some((error) => /duplicate corpus id/.test(error.message)));
  fs.rmSync(userCorpusDir("duplicate-jesuit-test"), { recursive: true, force: true });
});

test("built-in indexes live in the data folder, never inside the package", () => {
  const capsule = getCorpusCapsule("pepys-diary");
  assert.ok(capsule.indexPath.startsWith(process.env.DIALOGUES_HOME), capsule.indexPath);
  assert.ok(!capsule.indexPath.startsWith(capsule.rootPath));
});

test("guide files that escape the capsule through a link are rejected", (t) => {
  const base = tempDir("loader-links");
  const outside = path.join(base, "outside.md");
  fs.writeFileSync(outside, "secret outside the capsule", "utf8");
  const dir = writeCapsule(path.join(base, "linked"), { id: "linked", title: "Linked" });
  fs.rmSync(path.join(dir, "guide.md"));
  try {
    fs.symlinkSync(outside, path.join(dir, "guide.md"), "file");
  } catch {
    t.skip("creating symbolic links is not permitted here");
    return;
  }
  assert.throws(() => loadCorpusFromPath(dir, "user"), /must stay inside the corpus folder/);
});

test("corpus IDs are validated before any lookup", () => {
  for (const bad of ["../etc", "Jesuit", "a/b", "", "x".repeat(200)]) {
    assert.throws(() => getCorpusCapsule(bad), /Unknown corpus/);
  }
});
