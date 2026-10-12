import { testBase, userCorpusDir } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { loadCorpusFromPath } from "../dist/core/corpus/loader.js";
import { reindexGenericCorpus, GenericIndex } from "../dist/core/db/genericIndex.js";
import { makeStableId, parseStableId } from "../dist/core/ids.js";
import { searchCorpus } from "../dist/core/search/corpusTools.js";

const root = process.cwd();

function writeIndexCapsule(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id: "test-sqlite-index",
    title: "SQLite Index Test",
    description: "Test corpus.",
    languages: ["en"],
    type: "test",
    status: "test",
    data_policy: "test",
    default_search_mode: "fts",
    guide: "guide.md",
    search_rules: "search-rules.md",
    source_notes: "source-notes.md",
    citation_rules: "citation-rules.md",
    fields: ["doc_id", "chunk_index"],
    chunking: { min_chars: 10, max_chars: 220, overlap_chars: 0 },
    license: { data_included: false, user_must_confirm_rights: true, notes: "Test." }
  };
  fs.writeFileSync(path.join(dir, "corpus.yaml"), YAML.stringify(manifest), "utf8");
  for (const file of ["guide.md", "search-rules.md", "source-notes.md", "citation-rules.md"]) {
    fs.writeFileSync(path.join(dir, file), `${file}\n`, "utf8");
  }
}

test("generic SQLite index searches, fetches neighbors, parses IDs, and rebuilds", () => {
  const dir = path.join(testBase, "test-sqlite-index");
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    writeIndexCapsule(dir);
    const capsule = loadCorpusFromPath(dir, "user");
    let stats = reindexGenericCorpus(capsule, [
      {
        id: "doc-one",
        title: "Document One",
        sourcePath: "doc-one.txt",
        text: "alpha beta gamma\n\nneighbor context delta"
      }
    ]);
    assert.equal(stats.documents, 1);
    assert.ok(stats.chunks >= 1);

    const index = new GenericIndex(capsule);
    try {
      const results = index.search("alpha", 5);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, makeStableId(capsule.id, "doc-one", 0));
      assert.deepEqual(parseStableId(results[0].id), {
        corpusId: capsule.id,
        documentId: "doc-one",
        chunkIndex: 0
      });
      const fetched = index.fetch(results[0].id, 1);
      assert.ok(fetched.passages.some((passage) => passage.is_target));
    } finally {
      index.close();
    }

    stats = reindexGenericCorpus(capsule, [
      { id: "doc-two", title: "Document Two", sourcePath: "doc-two.txt", text: "rebuilt epsilon" }
    ]);
    assert.equal(stats.documents, 1);
    const rebuilt = new GenericIndex(capsule);
    try {
      assert.equal(rebuilt.search("alpha", 5).length, 0);
      assert.equal(rebuilt.search("epsilon", 5).length, 1);
    } finally {
      rebuilt.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("generic SQLite index can search Han source terms while fetch preserves exact text", () => {
  const dir = path.join(testBase, "test-sqlite-index-cjk");
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    writeIndexCapsule(dir);
    const capsule = loadCorpusFromPath(dir, "user");
    const sourceText = "國無常強，無常弱。奉法者強則國強。";
    reindexGenericCorpus(capsule, [
      {
        id: "doc-cjk",
        title: "CJK Document",
        sourcePath: "doc-cjk.txt",
        text: sourceText,
        selectionPaths: ["legalist-institutional-machinery"]
      }
    ]);

    const index = new GenericIndex(capsule);
    try {
      const results = index.search("法", 5, { path: "legalist-institutional-machinery" });
      assert.equal(results.length, 1);
      const fetched = index.fetch(results[0].id, 0);
      assert.equal(fetched.passages[0].text, sourceText);
      // Unspaced multi-character Han queries must match the per-character index.
      assert.equal(index.search("奉法者", 5).length, 1);
      assert.equal(index.search("國強", 5).length, 1);
      assert.equal(index.search("plague OR 常強", 5).length, 1);
      const stats = index.matchStats("法");
      assert.equal(stats.total_matches, 1);
      assert.equal(stats.documents[0].document_id, "doc-cjk");
    } finally {
      index.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("generic SQLite index skips obvious public-text boilerplate and contents chunks", () => {
  const dir = path.join(testBase, "test-sqlite-index-boilerplate");
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    writeIndexCapsule(dir);
    const capsule = loadCorpusFromPath(dir, "user");
    reindexGenericCorpus(capsule, [
      {
        id: "doc-boilerplate",
        title: "Public Text",
        sourcePath: "public.txt",
        chunks: [
          { chunkIndex: 0, text: "The Project Gutenberg eBook of Public Text. Produced by volunteers and transcribers." },
          { chunkIndex: 1, text: "CONTENTS Chapter I—Walking—The Woods—The Pond—The Field—The Morning—Spring—Winter—Ice—Beans—Labor—Economy" },
          { chunkIndex: 2, text: "In the morning the writer walks beside the pond, observes the field carefully, and turns that observation into a practical question about how to live." }
        ]
      }
    ]);

    const index = new GenericIndex(capsule);
    try {
      assert.equal(index.search("gutenberg", 5).length, 0);
      assert.equal(index.search("contents", 5).length, 0);
      const results = index.search("observes OR practical", 5);
      assert.equal(results.length, 1);
      const fetched = index.fetch(results[0].id, 0);
      assert.match(fetched.passages[0].text, /turns that observation into a practical question/);
    } finally {
      index.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corpus search tolerates natural-language fragments", () => {
  const dir = path.join(testBase, "test-sqlite-index-fragments");
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    writeIndexCapsule(dir);
    const capsule = loadCorpusFromPath(dir, "user");
    reindexGenericCorpus(capsule, [
      {
        id: "doc-fragment",
        title: "Fragment Search",
        sourcePath: "fragment.txt",
        text: "The passage describes government, prison, conscience, and a practical question about public duty."
      }
    ]);

    const result = searchCorpus(capsule, "government bad?? jail thing? why", 5);
    assert.equal(result.count, 1);
    assert.match(result.results[0].citation, /Fragment Search/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
