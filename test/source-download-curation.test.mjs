import { TEST_HTTP, dataDir, mockFetch, userCorpusDir, writeCapsule } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { invalidateCorpusCache, loadCorpusFromPath, getCorpusCapsule } from "../dist/core/corpus/loader.js";
import { reindexGenericCorpus, GenericIndex, getIndexGeneration } from "../dist/core/db/genericIndex.js";
import {
  cancelDownload,
  downloadFromSourceManifest,
  downloadStatus,
  listDownloadOptions,
  loadDownloadState,
  previewDownload,
  resumeDownload,
  sourceStatus,
  startDownload,
  waitForDownload
} from "../dist/core/sources/download.js";
import { readConsentRecords } from "../dist/core/sources/rights.js";
import { searchCorpus } from "../dist/core/search/corpusTools.js";
import { suggestSearches } from "../dist/core/search/suggest.js";
import { openCandidateDb, upsertCandidate } from "../dist/core/curation/candidateDb.js";
import { runCurationScore } from "../dist/core/curation/scoring.js";
import { exportCuratedManifest, exportReviewCsv, importReviewCsv } from "../dist/core/curation/review.js";

const EXTERNAL = { allowExternalManifest: true, http: { ...TEST_HTTP } };

function manifestCapsule(corpusId, manifest, extras = {}, files = {}) {
  const dir = userCorpusDir(corpusId);
  fs.rmSync(dir, { recursive: true, force: true });
  writeCapsule(dir, {
    id: corpusId,
    title: corpusId,
    data_policy: "manifest_only",
    chunking: { min_chars: 10, max_chars: 220, overlap_chars: 0 },
    source_manifest: "source-manifest.yaml",
    downloadable: true,
    download_policy: "curated_public_source",
    ...extras
  }, {
    "source-manifest.yaml": {
      version: 1,
      corpus_id: corpusId,
      source_policy: "user_downloaded_from_original_sources",
      default_mode: "curated-core",
      download_modes: { "curated-core": { visible_to_users: true, description: "Curated." } },
      paths: {},
      ...manifest
    },
    ...files
  });
  invalidateCorpusCache();
  return dir;
}

function textItems(count, extra = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `doc-${index + 1}`,
    source_type: "static_text_url",
    url: `https://example.test/doc-${index + 1}.txt`,
    title: `Document ${index + 1}`,
    rights_level: "public_domain",
    selected: true,
    ...extra
  }));
}

function textRoutes(handler) {
  return mockFetch((href) => {
    const match = href.match(/doc-(\d+)\.txt$/);
    if (!match) return new Response("missing", { status: 404 });
    return handler(Number(match[1]), href);
  });
}

test("manifest download lists options, downloads selected text, indexes it, and reports status", async () => {
  const corpusId = "test-manifest-download";
  const dir = manifestCapsule(corpusId, {
    paths: { "legal-mind": { title: "Legal Mind" } },
    items: [{ ...textItems(1)[0], title: "Lincoln legal letter", author: "Abraham Lincoln", document_type: "letter", paths: ["legal-mind"], signals: ["letter"] }]
  });
  const network = textRoutes(() => new Response("This letter discusses law, evidence, and constitutional limits.", { status: 200 }));
  try {
    const options = listDownloadOptions(corpusId);
    assert.equal(options.paths[0].items, 1);
    const before = sourceStatus(corpusId);
    assert.deepEqual(before.available_paths, ["legal-mind"]);
    assert.equal(before.collection_state, "not_downloaded");

    const response = await downloadFromSourceManifest(corpusId, { path: "legal-mind", confirmedRights: true, ...EXTERNAL });
    assert.equal(response.downloaded.length, 1);
    assert.equal(response.indexed, true);
    assert.equal(response.status, "complete");

    const capsule = loadCorpusFromPath(dir, "user");
    const index = new GenericIndex(capsule);
    try {
      const results = index.search("evidence", 5, { path: "legal-mind", documentType: "letter" });
      assert.equal(results.length, 1);
      assert.deepEqual(results[0].metadata.selection_paths, ["legal-mind"]);
      assert.deepEqual(results[0].metadata.document.signals, ["letter"]);
    } finally {
      index.close();
    }
    const status = sourceStatus(corpusId);
    assert.equal(status.downloaded_items, 1);
    assert.equal(status.approved_selections.length, 1);
    assert.ok(status.approved_selections[0].consented_at, "consent time recorded");
    assert.equal(status.search_file.coverage, "partial-selection");
  } finally {
    network.restore();
  }
});

test("built-in downloads refuse manifests that did not ship with Dialogues", async () => {
  const corpusId = "test-external-refused";
  manifestCapsule(corpusId, { items: textItems(1) });
  await assert.rejects(
    () => downloadFromSourceManifest(corpusId, { confirmedRights: true, http: TEST_HTTP }),
    /not a built-in collection/
  );
});

test("a sample is searchable, labeled, and kept when the full set is added later", async () => {
  const corpusId = "test-sample-expansion";
  manifestCapsule(corpusId, { items: textItems(4) }, { sample_profile: "sample.yaml" }, {
    "sample.yaml": {
      version: 1,
      profile_version: 1,
      title: "Two documents",
      summary: "A tiny sample.",
      download_bytes: 120,
      download_note: "Two small text files.",
      items: [{ id: "doc-1" }, { id: "doc-2", text_window: { start: "MIDDLE", end: "END" } }]
    }
  });
  const network = textRoutes((n) => new Response(n === 2 ? `beginning words alpha\n\nMIDDLE sampled lantern words\n\nEND trailing zebra words` : `document ${n} lantern text`, { status: 200 }));
  try {
    const preview = previewDownload(corpusId, { kind: "sample" });
    assert.equal(preview.coverage, "sample");
    assert.equal(preview.source_count, 2);
    assert.equal(preview.download_bytes, 120);

    const sample = await downloadFromSourceManifest(corpusId, { sample: true, confirmedRights: true, ...EXTERNAL });
    assert.equal(sample.status, "complete");
    assert.equal(sample.index_coverage, "sample");
    const capsule = getCorpusCapsule(corpusId);
    assert.equal(searchCorpus(capsule, "zebra", 5).count, 0, "text outside the sample window is not indexed");
    assert.equal(searchCorpus(capsule, "lantern", 10).results.length, 2);
    assert.equal(sourceStatus(corpusId).collection_state, "sample");

    const full = await downloadFromSourceManifest(corpusId, { confirmedRights: true, ...EXTERNAL });
    assert.equal(full.status, "complete");
    assert.equal(full.index_coverage, "selected-set");
    assert.equal(searchCorpus(capsule, "lantern", 10).results.length, 4, "earlier sample items are kept");
    assert.equal(searchCorpus(capsule, "zebra", 5).count, 1, "the full approval supersedes the sample window");
    // doc-1 and doc-2 were not downloaded twice.
    assert.equal(network.calls.filter((href) => href.endsWith("doc-1.txt")).length, 1);
    assert.equal(sourceStatus(corpusId).collection_state, "selected_set_complete");
  } finally {
    network.restore();
  }
});

test("an interrupted job resumes without repeating finished items, and cancel is not resumed", async () => {
  const corpusId = "test-resume";
  manifestCapsule(corpusId, { items: textItems(3) });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const network = textRoutes(async (n) => {
    if (n === 2) await gate;
    return new Response(`document ${n} resume text`, { status: 200 });
  });
  try {
    const started = startDownload(corpusId, { kind: "set" }, { confirmedRights: true, channel: "test", ...EXTERNAL });
    assert.equal(started.started, true);
    const early = await waitForDownload(corpusId, 200);
    assert.equal(early.status, "running", "returns before the job finishes");
    assert.ok(early.continuation);
    release();
    const done = await waitForDownload(corpusId, 10_000);
    assert.equal(done.status, "complete");

    // Simulate a crash mid-job: mark the job running with one item pending.
    const statePath = path.join(dataDir, "source-cache", corpusId, "download-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.job.status = "running";
    state.items["doc-3"].status = "pending";
    fs.writeFileSync(statePath, JSON.stringify(state));
    // The crash happened before doc-3's file was written.
    fs.rmSync(path.join(dataDir, "source-cache", corpusId, "raw", "doc-3.txt"), { force: true });
    const callsBefore = network.calls.length;
    assert.equal(downloadStatus(corpusId).status, "interrupted");
    resumeDownload(corpusId, done.continuation ?? early.continuation, EXTERNAL);
    const resumed = await waitForDownload(corpusId, 10_000);
    assert.equal(resumed.status, "complete");
    assert.deepEqual(network.calls.slice(callsBefore), ["https://example.test/doc-3.txt"], "only the unfinished item is fetched again");

    state.job.status = "running";
    fs.writeFileSync(statePath, JSON.stringify({ ...loadDownloadState(corpusId), job: { ...state.job } }));
    cancelDownload(corpusId);
    assert.equal(downloadStatus(corpusId).status, "canceled");
    assert.throws(() => resumeDownload(corpusId, early.continuation, EXTERNAL), /canceled/);
  } finally {
    release();
    network.restore();
  }
});

test("consent is bound to the notice that was shown", async () => {
  const corpusId = "test-notice-binding";
  manifestCapsule(corpusId, { items: textItems(1) });
  assert.throws(
    () => startDownload(corpusId, { kind: "set" }, { confirmedRights: true, expectedNoticeSha256: "0".repeat(64), ...EXTERNAL }),
    /notice changed/
  );
  const preview = previewDownload(corpusId, { kind: "set" });
  const network = textRoutes(() => new Response("bound text", { status: 200 }));
  try {
    startDownload(corpusId, { kind: "set" }, { confirmedRights: true, expectedNoticeSha256: preview.notice_sha256, channel: "test", ...EXTERNAL });
    await waitForDownload(corpusId, 10_000);
    const consents = readConsentRecords(corpusId);
    assert.equal(consents.length, 1);
    assert.equal(consents[0].notice_sha256, preview.notice_sha256);
    assert.equal(consents[0].selection_id, preview.selection_id);
    assert.equal(consents[0].channel, "test");
  } finally {
    network.restore();
  }
});

test("a failed forced refresh keeps the cached text and the previous search file", async () => {
  const corpusId = "test-refresh-failure";
  manifestCapsule(corpusId, { items: textItems(1) });
  let healthy = true;
  const network = textRoutes(() => (healthy ? new Response("original cached harbor text", { status: 200 }) : new Response("gone", { status: 404 })));
  try {
    const first = await downloadFromSourceManifest(corpusId, { confirmedRights: true, ...EXTERNAL });
    assert.equal(first.status, "complete");
    const capsule = getCorpusCapsule(corpusId);
    const generation = getIndexGeneration(capsule);
    healthy = false;
    const refresh = await downloadFromSourceManifest(corpusId, { confirmedRights: true, force: true, ...EXTERNAL });
    assert.equal(refresh.ok, false);
    const cached = fs.readFileSync(path.join(dataDir, "source-cache", corpusId, "raw", "doc-1.txt"), "utf8");
    assert.match(cached, /original cached harbor text/);
    assert.equal(searchCorpus(capsule, "harbor", 5).count, 1, "previous search file still works");
    assert.ok(getIndexGeneration(capsule).generation_id, "an index generation exists");
    assert.ok(generation.generation_id);
  } finally {
    network.restore();
  }
});

test("retryable statuses are retried with Retry-After, permanent ones are not", async () => {
  const corpusId = "test-retry";
  manifestCapsule(corpusId, { items: textItems(2) });
  const attempts = { 1: 0, 2: 0 };
  const network = textRoutes((n) => {
    attempts[n] += 1;
    if (n === 1 && attempts[1] === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    if (n === 2) return new Response("forbidden", { status: 403 });
    return new Response("retried text", { status: 200 });
  });
  try {
    const response = await downloadFromSourceManifest(corpusId, { confirmedRights: true, ...EXTERNAL });
    assert.equal(attempts[1], 2);
    assert.equal(attempts[2], 1);
    assert.equal(response.downloaded.length, 1);
    assert.equal(response.skipped.length, 1);
    assert.match(response.skipped[0].reason, /HTTP 403/);
    assert.equal(response.indexed, true, "the item that worked is still searchable");
  } finally {
    network.restore();
  }
});

test("redirects to a host outside the collection are refused", async () => {
  const corpusId = "test-redirect";
  manifestCapsule(corpusId, { items: textItems(1) });
  const network = mockFetch((href) => href.includes("example.test")
    ? new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid/secret" } })
    : new Response("should not be fetched", { status: 200 }));
  try {
    const response = await downloadFromSourceManifest(corpusId, { confirmedRights: true, ...EXTERNAL });
    assert.equal(response.downloaded.length, 0);
    assert.match(response.skipped[0].reason, /not one of this collection's sources/);
    assert.ok(!network.calls.some((href) => href.includes("elsewhere.invalid")));
  } finally {
    network.restore();
  }
});

test("curation scoring, review import, and manifest export keep source text out of source-manifest.yaml", () => {
  const corpusId = "lincoln-papers-test";
  const dir = userCorpusDir(corpusId);
  writeCapsule(dir, { id: corpusId, title: corpusId });
  invalidateCorpusCache();
  const harvestDir = path.join(dataDir, "harvests", corpusId);
  const textPath = path.join(harvestDir, "normalized", "doc-1.txt");
  fs.mkdirSync(path.dirname(textPath), { recursive: true });
  fs.writeFileSync(textPath, "Lincoln argues from law, court evidence, and constitutional constraint.", "utf8");
  const db = openCandidateDb(corpusId);
  try {
    upsertCandidate(db, corpusId, {
      id: "loc:doc-1",
      source_type: "static_text_url",
      url: "https://example.test/doc-1.txt",
      title: "Lincoln legal memorandum",
      author: "Abraham Lincoln",
      document_type: "letter",
      rights_level: "public_domain",
      selected: false,
      paths: ["legal-mind"],
      metadata: { catalog_note: "keep", full_text: "must not export" }
    }, { extractionStatus: "text", textPath });
  } finally {
    db.close();
  }

  const scored = runCurationScore(corpusId);
  assert.equal(scored.candidates, 1);
  const review = exportReviewCsv(corpusId, "legal-mind");
  const csv = [
    "id,title,date,author,recipient,document_type,source_url,score,signals,paths,selected,why_keep,why_skip,notes",
    "loc:doc-1,Lincoln legal memorandum,,Abraham Lincoln,,letter,https://example.test/doc-1.txt,9,letter;legal_reasoning,legal-mind,true,Shows legal reasoning under constraint,,"
  ].join("\n");
  fs.writeFileSync(review.review_path, `${csv}\n`, "utf8");
  assert.equal(importReviewCsv(corpusId, review.review_path).imported, 1);
  const exported = exportCuratedManifest(corpusId);
  assert.ok(exported.source_manifest_path.startsWith(path.join(dataDir, "exports")), "exports go to the data folder by default");
  const manifestText = fs.readFileSync(exported.source_manifest_path, "utf8");
  assert.match(manifestText, /loc:doc-1/);
  assert.match(manifestText, /legal_reasoning/);
  assert.doesNotMatch(manifestText, /must not export/);
  const parsed = YAML.parse(manifestText);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].selected, true);
});

test("generic index stores source provenance and path filters", () => {
  const corpusId = "test-provenance-index";
  const dir = writeCapsule(userCorpusDir(corpusId), { id: corpusId, title: corpusId });
  invalidateCorpusCache();
  const capsule = loadCorpusFromPath(dir, "user");
  reindexGenericCorpus(capsule, [{
    id: "doc",
    title: "Document",
    sourcePath: "doc.txt",
    text: "alpha legal evidence",
    documentType: "letter",
    sourceItemId: "source:doc",
    rightsLevel: "public_domain",
    selectionPaths: ["legal-mind"],
    curatorScore: 5,
    metadata: { signals: ["legal_reasoning"] }
  }]);
  const index = new GenericIndex(capsule);
  try {
    assert.equal(index.search("alpha", 5, { path: "missing" }).length, 0);
    const results = index.search("alpha", 5, { path: "legal-mind", minCuratorScore: 4 });
    assert.equal(results.length, 1);
    assert.equal(results[0].metadata.source_item_id, "source:doc");
    assert.equal(index.fetch(results[0].id, 0).metadata.source_item_id, "source:doc");
  } finally {
    index.close();
  }
  assert.throws(() => searchCorpus(capsule, "alpha", 5, { path: "missing-path" }), /Available paths: legal-mind/);
});

test("rights confirmation and blocked rights do not write source text to logs or indexes", async () => {
  const corpusId = "test-rights-boundaries";
  manifestCapsule(corpusId, {
    paths: { "rights-test": { title: "Rights Test" } },
    items: [
      { id: "unknown-doc", source_type: "static_text_url", url: "https://example.test/unknown.txt", title: "Unknown Rights", rights_level: "unknown", selected: true, paths: ["rights-test"] },
      { id: "borrow-doc", source_type: "static_text_url", url: "https://example.test/borrow.txt", title: "Borrow Only", rights_level: "borrow_only", selected: true, paths: ["rights-test"] },
      { id: "catalog-doc", source_type: "catalog_only", title: "Catalog Only", rights_level: "catalog_only", selected: true, paths: ["rights-test"], metadata: { import_instructions: "Catalog metadata only." } }
    ]
  });
  const secretText = "SOURCE TEXT SHOULD NOT APPEAR IN LOGS";
  const network = mockFetch(() => new Response(secretText, { status: 200 }));
  try {
    const needsConfirmation = await downloadFromSourceManifest(corpusId, { path: "rights-test", ...EXTERNAL });
    assert.equal(needsConfirmation.needs_confirmation, true);
    assert.equal(network.calls.length, 0, "nothing is fetched without agreement");

    const response = await downloadFromSourceManifest(corpusId, { path: "rights-test", confirmedRights: true, ...EXTERNAL });
    assert.equal(response.downloaded.length, 1);
    assert.equal(response.no_text.length, 2);
    assert.equal(response.rights_summary.unknown, 1);
    assert.equal(response.rights_summary.borrow_only, 1);
    assert.equal(response.rights_summary.catalog_only, 1);
    assert.ok(!network.calls.some((href) => href.includes("borrow")), "borrow-only text is never requested");

    for (const file of fs.readdirSync(path.join(dataDir, "logs"))) {
      assert.doesNotMatch(fs.readFileSync(path.join(dataDir, "logs", file), "utf8"), /SOURCE TEXT SHOULD NOT APPEAR/);
    }
    assert.doesNotMatch(fs.readFileSync(path.join(dataDir, "consents.jsonl"), "utf8"), /SOURCE TEXT SHOULD NOT APPEAR/);
  } finally {
    network.restore();
  }
});

test("catalog-only manifests complete without pretending to build an index", async () => {
  const corpusId = "test-catalog-only-corpus";
  manifestCapsule(corpusId, {
    paths: { "catalog-path": { title: "Catalog Path" } },
    items: [{ id: "catalog-doc", source_type: "catalog_only", url: "https://example.test/catalog", title: "Catalog Only", rights_level: "catalog_only", selected: true, paths: ["catalog-path"] }]
  }, { download_policy: "catalog_only" });
  const response = await downloadFromSourceManifest(corpusId, { path: "catalog-path", confirmedRights: true, ...EXTERNAL });
  assert.equal(response.downloaded.length, 0);
  assert.equal(response.no_text.length, 1);
  assert.equal(response.skipped.length, 0);
  assert.equal(response.indexed, false);
  assert.equal(sourceStatus(corpusId).collection_state, "catalog_only");
});

test("search explains catalog-only corpus and path selections without pretending reindex will help", () => {
  const corpusId = "test-search-catalog-only";
  const dir = manifestCapsule(corpusId, {
    paths: { "catalog-path": { title: "Catalog Path", point: "Metadata only." } },
    items: [{ id: "catalog-doc", source_type: "catalog_only", url: "https://example.test/catalog", title: "Catalog Only", rights_level: "catalog_only", selected: true, paths: ["catalog-path"] }]
  }, { download_policy: "catalog_only" });
  const capsule = loadCorpusFromPath(dir, "user");
  const response = searchCorpus(capsule, "NAACP OR letter", 5, { path: "catalog-path" });
  assert.equal(response.ok, true);
  assert.equal(response.count, 0);
  assert.equal(response.source_status, "no_searchable_text");
  assert.match(response.warning, /no readable text installed/i);
  assert.match(response.warning, /point at archives/);
  assert.match(response.next_steps.message, /import a permitted copy/);
});

test("search distinguishes not-yet-indexed paths from no-text paths", () => {
  const corpusId = "test-path-posture";
  const dir = manifestCapsule(corpusId, {
    paths: { installed: { title: "Installed Path" }, pending: { title: "Pending Path" }, catalog: { title: "Catalog Path" } },
    items: [
      { id: "installed-doc", source_type: "static_text_url", url: "https://example.test/installed.txt", title: "Installed", rights_level: "public_domain", selected: true, paths: ["installed"] },
      { id: "pending-doc", source_type: "static_text_url", url: "https://example.test/pending.txt", title: "Pending", rights_level: "public_domain", selected: true, paths: ["pending"] },
      { id: "catalog-doc", source_type: "catalog_only", url: "https://example.test/catalog", title: "Catalog", rights_level: "catalog_only", selected: true, paths: ["catalog"] }
    ]
  });
  const capsule = loadCorpusFromPath(dir, "user");
  reindexGenericCorpus(capsule, [{ id: "installed-doc", title: "Installed", sourcePath: "installed.txt", text: "alpha evidence", selectionPaths: ["installed"], rightsLevel: "public_domain" }]);

  const pending = searchCorpus(capsule, "evidence", 5, { path: "pending" });
  assert.equal(pending.source_status, "path_not_indexed");
  assert.match(pending.warning, /download test-path-posture --path pending/);

  const catalog = searchCorpus(capsule, "evidence", 5, { path: "catalog" });
  assert.equal(catalog.source_status, "no_searchable_text");
  assert.match(catalog.warning, /Catalog/);
});

test("path-specific suggestions use source vocabulary for weak audit paths", () => {
  const darwin = getCorpusCapsule("darwin-correspondence");
  const darwinSuggestion = suggestSearches(darwin, "Can I see Darwin as a working person with family or health constraints?", { path: "illness-work-and-family" });
  assert.match(darwinSuggestion.suggested_queries[0].query, /Caroline OR Father OR home OR Cambridge OR specimens OR work/);

  const lovelace = getCorpusCapsule("lovelace-babbage");
  const creditSuggestion = suggestSearches(lovelace, "Was Ada Lovelace really doing intellectual work, or is that a myth?", { path: "collaboration-and-credit" });
  assert.match(creditSuggestion.suggested_queries[0].query, /folios OR De Morgan OR correction OR lesson OR Lovelace/);

  const programSuggestion = suggestSearches(lovelace, "Can someone inspect early computing as machine design and notation, not just biography?", { path: "program-traces-and-engine-design" });
  assert.match(programSuggestion.suggested_queries[0].query, /operation OR variable OR cards OR notation/);
});

test("a download never shrinks an existing fuller search file", async () => {
  const corpusId = "test-keep-fuller";
  manifestCapsule(corpusId, { items: textItems(2) });
  const capsule = getCorpusCapsule(corpusId);
  // An earlier install indexed a document whose source text is not on this computer.
  reindexGenericCorpus(capsule, [{ id: "old-volume", title: "Old Volume", sourcePath: "old.txt", text: "glacier expedition journal" }]);
  const oldId = searchCorpus(capsule, "glacier", 5).results[0].id;
  const network = textRoutes((n) => new Response(`new document ${n} about rivers`, { status: 200 }));
  try {
    const response = await downloadFromSourceManifest(corpusId, { confirmedRights: true, ...EXTERNAL });
    assert.equal(response.status, "complete");
    assert.equal(response.index.documents, 3, "two new documents plus the kept one");
    const kept = searchCorpus(capsule, "glacier", 5);
    assert.equal(kept.results[0].id, oldId, "the kept document keeps its passage IDs");
    assert.equal(searchCorpus(capsule, "rivers", 5).count, 2);
  } finally {
    network.restore();
  }
});
