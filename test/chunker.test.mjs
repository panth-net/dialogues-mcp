import { testBase, userCorpusDir } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { chunkText, normalizeChunkText, normalizeImportedText } from "../dist/core/import/chunk.js";

test("chunkText merges tiny paragraphs deterministically", () => {
  const chunks = chunkText("One short paragraph.\n\nTwo short paragraph.", {
    min_chars: 80,
    max_chars: 200,
    overlap_chars: 20
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].chunk_index, 0);
  assert.match(chunks[0].text_raw, /One short paragraph/);
  assert.match(chunks[0].text_raw, /Two short paragraph/);
});

test("chunkText splits giant paragraphs within max bounds", () => {
  const text = Array.from({ length: 90 }, (_, index) => `Sentence ${index} has enough words to split safely.`).join(" ");
  const chunks = chunkText(text, {
    min_chars: 120,
    max_chars: 320,
    overlap_chars: 40
  });

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text_raw.length <= 340, `chunk too large: ${chunk.text_raw.length}`);
    assert.equal(chunk.text_norm, chunk.text_raw.replace(/\s+/g, " ").trim());
  }
  assert.deepEqual(chunks.map((chunk) => chunk.chunk_index), chunks.map((_, index) => index));
});

test("normalizeImportedText handles OCR-like whitespace and line hyphenation", () => {
  const normalized = normalizeImportedText("mis-\nspelled   word\r\n\r\n\r\nNext\t line  \n");

  assert.equal(normalized, "misspelled   word\n\nNext\t line");
  const chunks = chunkText(normalized, {
    min_chars: 1,
    max_chars: 100,
    overlap_chars: 0
  });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text_norm, "misspelled word");
});

test("normalizeChunkText spaces Han characters for SQLite FTS searchability", () => {
  assert.equal(normalizeChunkText("奉法者強則國強"), "奉 法 者 強 則 國 強");
  assert.equal(normalizeChunkText("alpha beta"), "alpha beta");
});
