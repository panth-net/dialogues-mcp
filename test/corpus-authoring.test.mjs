import { testBase, userCorpusDir } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createCorpus, guidePathForCorpus, lintCorpus, profileCorpus } from "../dist/core/corpus/authoring.js";
import { listCorpusCapsules } from "../dist/core/corpus/loader.js";

const root = process.cwd();

function userCorpusPath(id) {
  return userCorpusDir(id);
}

function cleanup(id) {
  fs.rmSync(userCorpusPath(id), { recursive: true, force: true });
}

test("corpus create writes editable capsule files and appears in list", () => {
  const id = "test-create-corpus";
  cleanup(id);
  try {
    const created = createCorpus({ name: "Test Create Corpus", corpusId: id });
    assert.equal(created.corpus_id, id);
    assert.ok(fs.existsSync(path.join(created.corpus_path, "corpus.yaml")));
    assert.ok(fs.existsSync(path.join(created.corpus_path, "documents")));
    const guide = fs.readFileSync(created.guide_path, "utf8");
    const citationRules = fs.readFileSync(path.join(created.corpus_path, "citation-rules.md"), "utf8");
    assert.ok(guide.includes("How to bring this corpus to life"));
    assert.match(guide, /Seek to understand before answering/);
    assert.match(guide, /Do not echo the guide or workflow language/);
    assert.match(guide, /quote-forward version/);
    assert.match(guide, /substantial fetched block quotes/);
    assert.match(guide, /sizeable fetched passages/);
    assert.match(guide, /In normal answers, quote selectively/);
    assert.match(guide, /materially affects interpretation/);
    assert.match(citationRules, /citation clarity/);

    const listed = listCorpusCapsules().corpora.map((corpus) => corpus.id);
    assert.ok(listed.includes(id));
  } finally {
    cleanup(id);
  }
});

test("corpus profile rewrites guide/source notes and creates privacy notes when needed", () => {
  const id = "test-profile-corpus";
  cleanup(id);
  try {
    createCorpus({ name: "Test Profile Corpus", corpusId: id });
    const result = profileCorpus(id, {
      documents: "Letters from a family archive.",
      authors: "Several relatives.",
      audience: "Other relatives.",
      dates: "1940s.",
      importance: "They show daily wartime logistics.",
      payAttention: "money, illness, school, and silence.",
      avoid: "inventing family motives.",
      citation: "Use fetched document title and chunk.",
      sensitive: "Names of living people may appear."
    });
    assert.ok(fs.readFileSync(result.guide_path, "utf8").includes("Letters from a family archive."));
    assert.ok(fs.existsSync(result.privacy_notes_path));
  } finally {
    cleanup(id);
  }
});

test("corpus lint returns actionable suggestions and does not block indexing", () => {
  const id = "test-lint-corpus";
  cleanup(id);
  try {
    createCorpus({ name: "Test Lint Corpus", corpusId: id });
    fs.writeFileSync(guidePathForCorpus(id), "Too short.\n", "utf8");
    const lint = lintCorpus(id);
    assert.equal(lint.ok, false);
    assert.ok(lint.suggestions.length > 0);
    assert.match(lint.note, /advisory/i);
  } finally {
    cleanup(id);
  }
});
