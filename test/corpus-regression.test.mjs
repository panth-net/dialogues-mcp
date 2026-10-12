import { testBase, userCorpusDir } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { loadCorpusFromPath } from "../dist/core/corpus/loader.js";
import { runCorpusRegression } from "../dist/core/corpus/regression.js";
import { reindexGenericCorpus } from "../dist/core/db/genericIndex.js";

const root = process.cwd();

function writeCapsule(corpusId, sourceManifest) {
  const dir = userCorpusDir(corpusId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "corpus.yaml"), YAML.stringify({
    id: corpusId,
    title: corpusId,
    description: "A regression test corpus.",
    languages: ["en"],
    type: "test",
    status: "test",
    data_policy: "manifest_only",
    default_search_mode: "fts",
    guide: "guide.md",
    search_rules: "search-rules.md",
    source_notes: "source-notes.md",
    citation_rules: "citation-rules.md",
    source_manifest: "source-manifest.yaml",
    fields: ["doc_id", "chunk_index"],
    chunking: { min_chars: 20, max_chars: 220, overlap_chars: 0 },
    license: { data_included: false, user_must_confirm_rights: true, notes: "Test rights." }
  }), "utf8");
  fs.writeFileSync(path.join(dir, "guide.md"), "Guide: search, fetch, cite, and state limits.\n", "utf8");
  fs.writeFileSync(path.join(dir, "search-rules.md"), [
    "# Search Rules",
    "",
    "| Path | Search vocabulary |",
    "| --- | --- |",
    "| legal-mind | `law OR evidence` |",
    "| catalog-path | `catalog OR metadata` |"
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(dir, "source-notes.md"), "Source notes.\n", "utf8");
  fs.writeFileSync(path.join(dir, "citation-rules.md"), "Cite fetched chunks.\n", "utf8");
  fs.writeFileSync(path.join(dir, "source-manifest.yaml"), YAML.stringify(sourceManifest), "utf8");
  return dir;
}

test("manifest regression searches and fetches installed text paths", () => {
  const corpusId = "test-regression-text";
  const dir = writeCapsule(corpusId, {
    version: 1,
    corpus_id: corpusId,
    source_policy: "test",
    default_mode: "curated-core",
    download_modes: { "curated-core": { visible_to_users: true } },
    paths: { "legal-mind": { title: "Legal Mind", point: "Recover law and evidence." } },
    items: [{
      id: "source:doc-1",
      source_type: "static_text_url",
      url: "https://example.test/doc-1.txt",
      title: "Legal evidence document",
      rights_level: "public_domain",
      selected: true,
      paths: ["legal-mind"],
      signals: ["legal_reasoning"]
    }]
  });

  try {
    const capsule = loadCorpusFromPath(dir, "user");
    reindexGenericCorpus(capsule, [{
      id: "doc-1",
      title: "Legal evidence document",
      sourcePath: "doc-1.txt",
      text: "This legal document weighs law, evidence, argument, and practical pressure.",
      sourceItemId: "source:doc-1",
      rightsLevel: "public_domain",
      selectionPaths: ["legal-mind"],
      metadata: { signals: ["legal_reasoning"] }
    }]);
    const response = runCorpusRegression(capsule);
    assert.equal(response.ok, true);
    assert.equal(response.status, "passed");
    assert.equal(response.prompts[0].path, "legal-mind");
    assert.equal(response.prompts[0].passes_workflow_smoke_test, true);
    assert.match(response.prompts[0].fetched_id, /^corpus:test-regression-text:doc:doc-1:chunk:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest regression treats catalog-only paths as explicit no-text limitations", () => {
  const corpusId = "test-regression-catalog";
  const dir = writeCapsule(corpusId, {
    version: 1,
    corpus_id: corpusId,
    source_policy: "test",
    default_mode: "curated-core",
    download_modes: { "curated-core": { visible_to_users: true } },
    paths: { "catalog-path": { title: "Catalog Path", point: "Metadata only." } },
    items: [{
      id: "catalog:doc-1",
      source_type: "catalog_only",
      url: "https://example.test/catalog",
      title: "Catalog record",
      rights_level: "catalog_only",
      selected: true,
      paths: ["catalog-path"]
    }]
  });

  try {
    const capsule = loadCorpusFromPath(dir, "user");
    const response = runCorpusRegression(capsule);
    assert.equal(response.ok, true);
    assert.equal(response.status, "catalog_or_user_supplied_only");
    assert.equal(response.prompts[0].expected_no_text, true);
    assert.match(response.prompts[0].note, /catalog_only:1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest regression reports missing index for searchable paths", () => {
  const corpusId = "test-regression-missing-index";
  const dir = writeCapsule(corpusId, {
    version: 1,
    corpus_id: corpusId,
    source_policy: "test",
    default_mode: "curated-core",
    download_modes: { "curated-core": { visible_to_users: true } },
    paths: { "legal-mind": { title: "Legal Mind", point: "Recover law and evidence." } },
    items: [{
      id: "source:doc-1",
      source_type: "static_text_url",
      url: "https://example.test/doc-1.txt",
      title: "Legal evidence document",
      rights_level: "public_domain",
      selected: true,
      paths: ["legal-mind"]
    }]
  });

  try {
    const capsule = loadCorpusFromPath(dir, "user");
    const response = runCorpusRegression(capsule);
    assert.equal(response.ok, false);
    assert.equal(response.status, "missing_index");
    assert.match(response.next_step, /download test-regression-missing-index --yes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
