import { userCorpusDir, writeCapsule } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { invalidateCorpusCache, loadCorpusFromPath } from "../dist/core/corpus/loader.js";
import { reindexGenericCorpus } from "../dist/core/db/genericIndex.js";
import { corpusSize, listCorpusSizes } from "../dist/core/corpus/size.js";

test("sizes come from file stats and build-time metadata, not a scan of every passage", () => {
  const dir = writeCapsule(userCorpusDir("test-size"), { id: "test-size", title: "Size Test" });
  invalidateCorpusCache();
  const capsule = loadCorpusFromPath(dir, "user");
  const before = corpusSize(capsule);
  assert.equal(before.indexed, false);
  assert.equal(before.index_bytes, 0);

  reindexGenericCorpus(capsule, [{ id: "doc", title: "Doc", sourcePath: "doc.txt", text: "one two three four five" }]);
  const after = corpusSize(capsule);
  assert.equal(after.indexed, true);
  assert.equal(after.documents, 1);
  assert.equal(after.words, 5, "word count recorded when the index was built");
  assert.ok(after.index_bytes > 0);
  assert.match(after.index_size, /KB|MB|B/);

  const listed = listCorpusSizes("test-size");
  assert.equal(listed.sizes[0].words, 5);
});
