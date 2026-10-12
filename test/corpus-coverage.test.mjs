import "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { getCorpusCapsule, listCorpusCapsules } from "../dist/core/corpus/loader.js";
import { corpusCoverage } from "../dist/core/corpus/coverage.js";

test("curated built-in coverage distinguishes the selected source list from the full archive", () => {
  const coverage = corpusCoverage(getCorpusCapsule("mark-twain-letters"));
  assert.equal(coverage.state, "not_downloaded");
  assert.equal(coverage.selected_source_items, 6);
  assert.equal(coverage.manifest_items, 6);
  assert.equal(coverage.downloaded_source_items, 0);
  assert.equal(coverage.full_archive_total, null);
  assert.equal(coverage.full_archive_percent, null);
  assert.match(coverage.coverage_note, /Not downloaded yet/);
});

test("Van Gogh coverage does not pretend to know the archive before download", () => {
  const coverage = corpusCoverage(getCorpusCapsule("vangogh-letters"));
  assert.equal(coverage.state, "not_downloaded");
  assert.equal(coverage.selected_source_items, 1, "one archive file");
  assert.equal(coverage.full_archive_total, null);
  assert.equal(coverage.sample_available, true);
});

test("catalog-only collections are never described as downloadable text", () => {
  const states = Object.fromEntries(listCorpusCapsules().corpora.map((capsule) => [capsule.id, corpusCoverage(capsule).state]));
  assert.equal(states["teika-diary"], "catalog_only");
  for (const id of ["pepys-diary", "vangogh-letters", "jesuit-relations", "darwin-correspondence", "lincoln-papers", "gandhi-collected-works"]) {
    assert.equal(states[id], "not_downloaded");
    assert.equal(corpusCoverage(getCorpusCapsule(id)).sample_available, true, `${id} offers a sample`);
  }
});
