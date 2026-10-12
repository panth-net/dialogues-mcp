import { testBase, userCorpusDir } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { loadCorpusFromPath } from "../dist/core/corpus/loader.js";
import { loadSourceManifest, validateSourceManifest } from "../dist/core/sources/sourceManifest.js";

const root = process.cwd();

function writeCapsule(dir, manifestOverrides = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id: path.basename(dir),
    title: "Source Manifest Test",
    description: "A test corpus.",
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
    selection_rules: "selection-rules.md",
    downloadable: true,
    download_policy: "curated_public_source",
    fields: ["doc_id", "chunk_index"],
    license: {
      data_included: false,
      user_must_confirm_rights: true,
      notes: "Test source terms."
    },
    ...manifestOverrides
  };
  fs.writeFileSync(path.join(dir, "corpus.yaml"), YAML.stringify(manifest), "utf8");
  for (const file of ["guide.md", "search-rules.md", "source-notes.md", "citation-rules.md", "selection-rules.md"]) {
    fs.writeFileSync(path.join(dir, file), `${file}\n`, "utf8");
  }
}

function sourceManifest(overrides = {}) {
  return {
    version: 1,
    corpus_id: "valid-source-test",
    source_policy: "user_downloaded_from_original_sources",
    default_mode: "curated-core",
    download_modes: {
      "curated-core": { visible_to_users: true, description: "Curated." },
      "full-dev": { visible_to_users: false, description: "Curator only." }
    },
    paths: {
      "legal-mind": { title: "Legal Mind", point: "Reasoning under legal constraint." }
    },
    items: [{
      id: "loc:test",
      source_type: "static_text_url",
      url: "https://example.test/letter.txt",
      title: "A test letter",
      rights_level: "public_domain",
      selected: true,
      paths: ["legal-mind"]
    }],
    ...overrides
  };
}

test("source manifest loads and validates optional capsule files", () => {
  const base = path.join(testBase, "test-source-manifest");
  fs.rmSync(base, { recursive: true, force: true });
  try {
    const dir = path.join(base, "valid-source-test");
    writeCapsule(dir);
    fs.writeFileSync(path.join(dir, "source-manifest.yaml"), YAML.stringify(sourceManifest()), "utf8");
    const capsule = loadCorpusFromPath(dir, "user");
    const manifest = loadSourceManifest(capsule);
    assert.equal(manifest.corpus_id, "valid-source-test");
    assert.equal(manifest.items[0].id, "loc:test");
    assert.equal(capsule.selectionRules.trim(), "selection-rules.md");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("source manifest validation catches duplicate ids, bad paths, rights, source types, and missing selected URLs", () => {
  assert.throws(() => validateSourceManifest(sourceManifest({
    items: [
      sourceManifest().items[0],
      { ...sourceManifest().items[0] }
    ]
  })), /duplicate item id/);

  assert.throws(() => validateSourceManifest(sourceManifest({
    items: [{ ...sourceManifest().items[0], id: "bad-path", paths: ["missing"] }]
  })), /unknown path/);

  assert.throws(() => validateSourceManifest(sourceManifest({
    items: [{ ...sourceManifest().items[0], id: "bad-rights", rights_level: "freeish" }]
  })), /unknown rights_level/);

  assert.throws(() => validateSourceManifest(sourceManifest({
    items: [{ ...sourceManifest().items[0], id: "bad-source", source_type: "vector_db" }]
  })), /unknown source_type/);

  assert.throws(() => validateSourceManifest(sourceManifest({
    items: [{ id: "missing-url", source_type: "static_text_url", selected: true, paths: ["legal-mind"] }]
  })), /needs url/);
});

test("package and git protections include source manifests but exclude private source data", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("corpora/*/source-manifest.yaml"));
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  for (const pattern of [
    "workspace/harvests/",
    "workspace/curation/",
    "workspace/selection/",
    "workspace/source-cache/",
    "corpora/*/source-cache/"
  ]) {
    assert.match(gitignore, new RegExp(pattern.replace(/[/*]/g, "\\$&")));
  }
});
