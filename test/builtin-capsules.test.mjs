import "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getCorpusCapsule, listCorpusCapsules } from "../dist/core/corpus/loader.js";
import { listDownloadOptions } from "../dist/core/sources/download.js";
import { loadSourceManifest } from "../dist/core/sources/sourceManifest.js";
import { loadSampleProfile, resolveSelection } from "../dist/core/sources/selection.js";

const root = process.cwd();

const expected = [
  ["lincoln-papers", 7, 26],
  ["douglass-papers", 6, 13],
  ["darwin-correspondence", 7, 17],
  ["newton-papers", 6, 12],
  ["lovelace-babbage", 5, 9],
  ["faraday-papers", 6, 12],
  ["thoreau-writings", 6, 6],
  ["jane-austen-letters", 5, 1],
  ["beethoven-letters", 5, 2],
  ["mark-twain-letters", 6, 6]
];

test("new built-in corpus capsules load with manifests, paths, docs, and no bundled data", () => {
  const listed = listCorpusCapsules();
  const ids = new Set(listed.corpora.map((corpus) => corpus.id));

  for (const [corpusId, pathCount, itemCount] of expected) {
    assert.ok(ids.has(corpusId), `${corpusId} missing from list_corpora`);
    const capsule = getCorpusCapsule(corpusId);
    assert.equal(capsule.manifest.downloadable, true);
    assert.equal(Boolean(capsule.selectionRules?.trim()), true);
    assert.equal(fs.existsSync(path.join(root, "corpora", corpusId, "data")), false, `${corpusId} must not bundle data`);

    const manifest = loadSourceManifest(capsule);
    assert.equal(manifest.items.length, itemCount);
    assert.equal(Object.keys(manifest.paths).length, pathCount);

    const options = listDownloadOptions(corpusId);
    assert.equal(options.paths.length, pathCount);
    assert.equal(options.default_mode, "curated-core");
    if (corpusId === "lincoln-papers" || corpusId === "douglass-papers" || corpusId === "darwin-correspondence" || corpusId === "newton-papers" || corpusId === "lovelace-babbage" || corpusId === "faraday-papers" || corpusId === "thoreau-writings" || corpusId === "jane-austen-letters" || corpusId === "beethoven-letters" || corpusId === "mark-twain-letters") {
      assert.equal(options.paths.every((sourcePath) => sourcePath.items > 0), true);
    }
    if (corpusId === "lincoln-papers") {
      assert.equal(options.rights_summary.no_known_restrictions, 19);
    }
    if (corpusId === "douglass-papers") {
      assert.equal(options.rights_summary.no_known_restrictions, 12);
    }
    if (corpusId === "darwin-correspondence") {
      assert.equal(options.rights_summary.rights_confirmed_user_download, 12);
    }
    if (corpusId === "newton-papers") {
      assert.equal(options.rights_summary.noncommercial_open_license, 12);
    }
    if (corpusId === "lovelace-babbage") {
      assert.equal(options.rights_summary.rights_confirmed_user_download, 9);
    }
    if (corpusId === "faraday-papers") {
      assert.equal(options.rights_summary.public_domain, 3);
      assert.equal(options.rights_summary.catalog_only, 9);
    }
    if (corpusId === "thoreau-writings") {
      assert.equal(options.rights_summary.public_domain, 6);
    }
    if (corpusId === "jane-austen-letters") {
      assert.equal(options.rights_summary.public_domain, 1);
    }
    if (corpusId === "beethoven-letters") {
      assert.equal(options.rights_summary.public_domain, 2);
    }
    if (corpusId === "mark-twain-letters") {
      assert.equal(options.rights_summary.public_domain, 6);
    }
  }
});

test("every built-in capsule loads, ships a source list, and points at no obsolete paths files", () => {
  const { corpora, errors } = listCorpusCapsules();
  assert.deepEqual(errors, []);
  const builtIn = corpora.filter((capsule) => capsule.source === "built_in");
  assert.equal(builtIn.length, 34);
  for (const capsule of builtIn) {
    assert.ok(capsule.sourceManifestPath, `${capsule.id} has a source manifest`);
    assert.equal(fs.existsSync(path.join(capsule.rootPath, "paths")), false, `${capsule.id} has no obsolete paths/ folder`);
    assert.doesNotMatch(capsule.guide, /paths\/[a-z-]+\.yaml/, `${capsule.id} guide does not reference paths/*.yaml`);
  }
});

test("the six recommended samples are defined, bounded, and downloadable", () => {
  for (const id of ["pepys-diary", "vangogh-letters", "jesuit-relations", "darwin-correspondence", "lincoln-papers", "gandhi-collected-works"]) {
    const capsule = getCorpusCapsule(id);
    const manifest = loadSourceManifest(capsule);
    const profile = loadSampleProfile(capsule, manifest);
    assert.ok(profile, `${id} has a sample`);
    assert.ok(profile.items.length >= 1 && profile.items.length <= 10, `${id} sample is small`);
    assert.ok(Number.isInteger(profile.download_bytes) && profile.download_bytes < 12 * 1024 * 1024, `${id} sample download is bounded`);
    const selection = resolveSelection(capsule, manifest, { kind: "sample" });
    assert.equal(selection.coverage, "sample");
    assert.equal(selection.text_items, selection.items.length, `${id} sample items all have downloadable text`);
    assert.match(selection.notice, /from their original sources to this computer\. It never bypasses/);
  }
});
