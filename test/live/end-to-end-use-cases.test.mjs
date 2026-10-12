// Opt-in checks against collections you have already downloaded.
// Run with: DIALOGUES_LIVE_DATA_DIR=<your data folder> npm run test:live
// Nothing is downloaded; tests skip when the collections are not present.
if (process.env.DIALOGUES_LIVE_DATA_DIR) process.env.DIALOGUES_HOME = process.env.DIALOGUES_LIVE_DATA_DIR;
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { getCorpusCapsule } from "../../dist/core/corpus/loader.js";
import { fetchCorpus, searchCorpus } from "../../dist/core/search/corpusTools.js";
import { suggestSearches } from "../../dist/core/search/suggest.js";

const SEARCHABLE_CORPORA = [
  "lincoln-papers",
  "douglass-papers",
  "darwin-correspondence",
  "newton-papers",
  "lovelace-babbage",
  "faraday-papers"
];

const NEW_PERSON_CORPORA = [
  "thoreau-writings",
  "jane-austen-letters",
  "beethoven-letters",
  "mark-twain-letters"
];

function capsule(corpusId) {
  return getCorpusCapsule(corpusId);
}

function requireLocalIndexes(t) {
  if (!process.env.DIALOGUES_LIVE_DATA_DIR) {
    t.skip("set DIALOGUES_LIVE_DATA_DIR to run checks against downloaded collections");
    return false;
  }
  const missing = SEARCHABLE_CORPORA
    .map(capsule)
    .filter((item) => !fs.existsSync(item.indexPath))
    .map((item) => item.id);
  if (missing.length) {
    t.skip(`Built-in source indexes not installed: ${missing.join(", ")}`);
    return false;
  }
  return true;
}

function requireIndexes(t, corpusIds) {
  if (!process.env.DIALOGUES_LIVE_DATA_DIR) {
    t.skip("set DIALOGUES_LIVE_DATA_DIR to run checks against downloaded collections");
    return false;
  }
  const missing = corpusIds
    .map(capsule)
    .filter((item) => !fs.existsSync(item.indexPath))
    .map((item) => item.id);
  if (missing.length) {
    t.skip(`Built-in source indexes not installed: ${missing.join(", ")}`);
    return false;
  }
  return true;
}

function firstFetched(corpusId, query, path, expectedCitation) {
  const item = capsule(corpusId);
  const search = searchCorpus(item, query, 5, path ? { path } : {});
  assert.ok(search.count > 0, `${corpusId}/${path ?? "all"} should return hits for ${query}`);
  const result = expectedCitation
    ? search.results.find((candidate) => expectedCitation.test(candidate.citation))
    : search.results[0];
  assert.ok(result, `${corpusId}/${path ?? "all"} should include citation ${expectedCitation}`);
  const fetched = fetchCorpus(item, result.id, 1);
  assert.ok(fetched.passages.some((passage) => passage.is_target), `${result.id} should fetch target context`);
  return { search, fetched };
}

function firstSuggestedQuery(corpusId, question, path) {
  const response = suggestSearches(capsule(corpusId), question, path ? { path } : {});
  assert.ok(response.suggested_queries.length > 0, `${corpusId} should suggest at least one query`);
  return response.suggested_queries[0].query;
}

test("12 real use cases keep guide-search-fetch behavior honest", (t) => {
  if (!requireLocalIndexes(t)) return;

  firstFetched(
    "lincoln-papers",
    "emancipation OR proclamation OR slavery OR colonization",
    "emancipation-in-motion",
    /Emancipation Proclamation|Volume 6: 1862-1863/i
  );

  firstFetched(
    "lincoln-papers",
    firstSuggestedQuery("lincoln-papers", "Can you show Lincoln as a person, not just a monument? Any jokes or anecdotes?", "humor-human-lincoln"),
    "humor-human-lincoln",
    /Autobiographical Notes|Davy Crockett Anecdote|Papers and Writings of Abraham Lincoln/i
  );

  firstFetched(
    "douglass-papers",
    "editor OR newspaper OR paper OR speech",
    "douglass-as-editor",
    /Frederick Douglass' Paper/i
  );

  firstFetched(
    "douglass-papers",
    firstSuggestedQuery("douglass-papers", "Why is early Douglass hard to recover? Can the corpus show the gap honestly?", "lost-early-douglass"),
    "lost-early-douglass",
    /General Correspondence|North Star/i
  );

  firstFetched(
    "darwin-correspondence",
    "species OR immutable OR doubt OR hypothesis",
    "thought-before-theory",
    /Asa Gray|Hooker/i
  );

  firstFetched(
    "darwin-correspondence",
    firstSuggestedQuery("darwin-correspondence", "Can I see Darwin as a working person with family or health constraints?", "illness-work-and-family"),
    "illness-work-and-family",
    /Caroline Darwin/i
  );

  firstFetched(
    "newton-papers",
    "practica OR alchemicam OR materia OR preparation",
    "alchemy-and-chymistry",
    /Practica Mariae/i
  );

  firstFetched(
    "newton-papers",
    "scholium OR theological OR draft OR chronology",
    "theology-and-chronology",
    /Scholium Generale/i
  );

  firstFetched(
    "lovelace-babbage",
    firstSuggestedQuery("lovelace-babbage", "Was Ada Lovelace really doing intellectual work, or is that a myth?", "collaboration-and-credit"),
    "collaboration-and-credit",
    /Transcripts of Folios/i
  );

  firstFetched(
    "lovelace-babbage",
    firstSuggestedQuery("lovelace-babbage", "Can someone inspect early computing as machine design and notation, not just biography?", "program-traces-and-engine-design"),
    "program-traces-and-engine-design",
    /card counting apparatus|Notation of cards/i
  );

  firstFetched(
    "faraday-papers",
    "experiment OR electricity OR instrument OR induction",
    "experimental-thinking",
    /Experimental Researches in Electricity/i
  );

  const faradayLetters = searchCorpus(
    capsule("faraday-papers"),
    firstSuggestedQuery("faraday-papers", "Can you quote Faraday letters and demonstrations?", "letters-and-demonstration"),
    5,
    { path: "letters-and-demonstration" }
  );
  assert.equal(faradayLetters.source_status, "no_searchable_text");
  assert.match(faradayLetters.warning, /no readable text installed/i);

});

test("16 new person-centered use cases handle real and messy prompts", (t) => {
  if (!requireIndexes(t, NEW_PERSON_CORPORA)) return;

  for (const [corpusId, path, question, expectedCitation] of [
    ["thoreau-writings", "nature-as-method", "Did Thoreau actually observe first and then philosophize, or is he just preaching about nature?", /Journal 02/i],
    ["thoreau-writings", "work-solitude-and-economy", "was he a minimalist?? like was walden just tiny house influencer stuff", /Walden/i],
    ["thoreau-writings", "conscience-and-public-duty", "government bad?? jail thing? why", /Walden/i],
    ["thoreau-writings", "letters-and-relationships", "show me him as a friend/person, not the pond guy", /Familiar Letters/i],
    ["jane-austen-letters", "cassandra-and-family", "Can you show Austen thinking through family obligations rather than just being witty?", /Letters of Jane Austen/i],
    ["jane-austen-letters", "wit-and-social-judgment", "is she just snarky lol", /Letters of Jane Austen/i],
    ["jane-austen-letters", "writing-publication-and-money", "did she care about getting paid \/ publishing or was it genteel hobby", /Letters of Jane Austen/i],
    ["jane-austen-letters", "selection-and-silence", "what is missing? do these letters prove her whole private self?", /Letters of Jane Austen/i],
    ["beethoven-letters", "composition-and-publishers", "How much was composing also business logistics, not pure inspiration?", /Beethoven's Letters/i],
    ["beethoven-letters", "illness-deafness-and-isolation", "deaf sad genius??", /Beethoven's Letters/i],
    ["beethoven-letters", "patrons-money-and-obligation", "who paid him \/ patrons?", /Beethoven's Letters/i],
    ["beethoven-letters", "family-guardianship-and-conflict", "family mess nephew karl what happened", /Beethoven's Letters/i],
    ["mark-twain-letters", "travel-lecture-and-public-persona", "How did Sam Clemens turn into Mark Twain as a public act?", /Mark Twain's Letters/i],
    ["mark-twain-letters", "humor-private-public-gap", "funny guy or actually bitter?", /Mark Twain's Letters/i],
    ["mark-twain-letters", "family-money-and-business-risk", "did business screw up his writing life?", /Mark Twain's Letters/i],
    ["mark-twain-letters", "grief-age-and-late-darkness", "late years dark why", /Mark Twain's Letters/i]
  ]) {
    firstFetched(
      corpusId,
      firstSuggestedQuery(corpusId, question, path),
      path,
      expectedCitation
    );
  }
});
