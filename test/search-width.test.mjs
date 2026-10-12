import { dataDir, writeCapsule } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { getCorpusCapsule, invalidateCorpusCache, loadCorpusFromPath } from "../dist/core/corpus/loader.js";
import { reindexGenericCorpus } from "../dist/core/db/genericIndex.js";
import { queryTermCount, searchCorpus, searchCorpusWithContext } from "../dist/core/search/corpusTools.js";
import { ruleSuggestions } from "../dist/core/search/suggest.js";

test("a narrow search is told to widen the net; a wide one is not", () => {
  const dir = writeCapsule(path.join(dataDir, "user-corpora", "width-test"), { id: "width-test", title: "Width", chunking: { min_chars: 10, max_chars: 200, overlap_chars: 0 } });
  invalidateCorpusCache();
  const capsule = loadCorpusFromPath(dir, "user");
  reindexGenericCorpus(capsule, [{ id: "d", title: "D", sourcePath: "d.txt", text: "Genius is patience; talent is zeal and hard work, said the old naturalist." }]);

  assert.equal(queryTermCount('genius OR talent OR "hard work"'), 3, "a quoted phrase counts once and OR does not count");
  const narrow = searchCorpus(capsule, "genius", 5);
  assert.equal(narrow.count, 1);
  assert.match(narrow.next_steps.message, /wide net/);
  const wide = searchCorpus(capsule, "genius OR talent OR gift OR clever OR capacity OR zeal OR industry OR patience", 5);
  assert.doesNotMatch(wide.next_steps.message, /wide net/);
  const withContext = searchCorpusWithContext(capsule, "genius", 5, 1);
  assert.match(withContext.next_steps.message, /wide net/);
});

test("narrow searches on curated collections get the curator's wider queries, without generic filler", () => {
  const darwin = getCorpusCapsule("darwin-correspondence");
  const queries = ruleSuggestions(darwin, "illness").map((item) => item.query);
  assert.ok(queries.some((query) => /Caroline OR Father OR home/.test(query)), JSON.stringify(queries));
  assert.deepEqual(ruleSuggestions(darwin, "zzzz"), []);
});
