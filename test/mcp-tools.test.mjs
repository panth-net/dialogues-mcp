import { mockFetch } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createDialoguesServer } from "../dist/mcp/server.js";

async function connect() {
  const server = createDialoguesServer();
  const client = new Client({ name: "dialogues-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function structured(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

const EXPECTED_TOOLS = [
  "list_corpora", "get_corpus_guide", "search", "fetch", "search_with_context", "suggest_searches",
  "import_folder", "list_download_options", "source_status", "download_builtin_corpus", "cancel_download",
  "reindex_corpus", "get_preferences", "set_preference", "ping"
];

test("tools have titles, object input schemas, output schemas where promised, and honest annotations", async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    for (const name of EXPECTED_TOOLS) {
      assert.ok(byName[name], `${name} missing`);
      assert.ok(byName[name].title, `${name} has a title`);
      assert.equal(byName[name].inputSchema.type, "object", `${name} input schema is an object`);
    }
    for (const name of ["list_corpora", "search", "fetch"]) assert.equal(byName[name].outputSchema?.type, "object", `${name} declares output`);

    for (const name of ["list_corpora", "get_corpus_guide", "search", "fetch", "search_with_context", "list_download_options", "source_status", "get_preferences", "ping"]) {
      assert.equal(byName[name].annotations.readOnlyHint, true, `${name} is read-only`);
    }
    assert.equal(byName.download_builtin_corpus.annotations.openWorldHint, true);
    assert.equal(byName.download_builtin_corpus.annotations.readOnlyHint, false);
    assert.equal(byName.download_builtin_corpus.annotations.destructiveHint, true, "a download can replace the search file");
    assert.equal(byName.import_folder.annotations.idempotentHint, false);
    assert.equal(byName.import_folder.annotations.destructiveHint, false, "import never overwrites");
    assert.equal(byName.reindex_corpus.annotations.destructiveHint, true);
    assert.equal(byName.set_preference.annotations.destructiveHint, true);
    // No blanket "nothing is destructive" claim.
    assert.ok(tools.some((tool) => tool.annotations?.destructiveHint === true));

    assert.match(byName.download_builtin_corpus.description, /Never call this silently/i);
    assert.match(byName.search.description, /get_corpus_guide/i);
    assert.match(byName.fetch.description, /Quote from passages you have read in full/i);
  } finally {
    await close();
  }
});

test("instructions, prompts, and guide resources are available through the protocol", async () => {
  const { client, close } = await connect();
  try {
    const instructions = client.getInstructions();
    assert.match(instructions, /show every collection, downloaded or not, as a short markdown table/i);
    assert.match(instructions, /not technical/i);
    assert.match(instructions, /ask which collections the user wants to download/i);
    assert.match(instructions, /full archive size/i);
    assert.match(instructions, /Pepys, Van Gogh, Jesuit Relations, Darwin, Lincoln, and Gandhi/);
    assert.match(instructions, /continuation/);

    const { prompts } = await client.listPrompts();
    const promptNames = prompts.map((prompt) => prompt.name);
    for (const name of ["dialogues", "setup_collections", "mind_in_motion", "recover_the_live_problem", "response_under_pressure", "show_the_working_system", "trace_concept_before_modern_name"]) {
      assert.ok(promptNames.includes(name), `${name} prompt missing`);
    }
    const setup = await client.getPrompt({ name: "setup_collections" });
    assert.match(setup.messages[0].content.text, /Do not download anything until I choose/);

    const { resources } = await client.listResources();
    const pepys = resources.find((resource) => resource.uri === "dialogues://corpora/pepys-diary/guide");
    assert.ok(pepys, "guide resources are listed");
    const read = await client.readResource({ uri: pepys.uri });
    assert.match(read.contents[0].text, /Pepys/);
  } finally {
    await close();
  }
});

test("list_corpora reports local size, status, and the sample separately from archive totals", async () => {
  const { client, close } = await connect();
  try {
    const response = structured(await client.callTool({ name: "list_corpora", arguments: {} }));
    assert.equal(response.ok, true);
    assert.equal(response.corpora.length, 34);
    const pepys = response.corpora.find((corpus) => corpus.id === "pepys-diary");
    assert.equal(pepys.state, "not_downloaded");
    assert.equal(pepys.index_bytes, 0);
    assert.equal(pepys.local_size, "not downloaded");
    assert.equal(pepys.full_download_estimate_bytes, null, "unknown download sizes are null");
    assert.equal(pepys.sample.download_bytes, 6800848);
    const teika = response.corpora.find((corpus) => corpus.id === "teika-diary");
    assert.equal(teika.state, "catalog_only");
    assert.equal(teika.downloadable, false);
    assert.deepEqual(response.recommended_sample, ["pepys-diary", "vangogh-letters", "jesuit-relations", "darwin-correspondence", "lincoln-papers", "gandhi-collected-works"]);
  } finally {
    await close();
  }
});

test("download without agreement returns the notice and fetches nothing", async () => {
  const network = mockFetch(() => new Response("should not be fetched", { status: 200 }));
  const { client, close } = await connect();
  try {
    const response = structured(await client.callTool({ name: "download_builtin_corpus", arguments: { corpusId: "darwin-correspondence", selection: "sample" } }));
    assert.equal(response.needs_confirmation, true);
    assert.equal(response.coverage, "sample");
    assert.equal(response.source_count, 6);
    assert.equal(response.download_bytes, 723433);
    assert.match(response.notice_sha256, /^[0-9a-f]{64}$/);
    assert.equal(network.calls.length, 0);
  } finally {
    network.restore();
    await close();
  }
});

test("invalid inputs and unknown collections return tool errors, not crashes", async () => {
  const { client, close } = await connect();
  try {
    const badId = await client.callTool({ name: "fetch", arguments: { id: "../../.env" } });
    assert.equal(badId.isError, true);
    assert.match(structured(badId).error, /Not a valid passage ID/);
    const unknown = await client.callTool({ name: "get_corpus_guide", arguments: { corpusId: "no-such-corpus" } });
    assert.equal(unknown.isError, true);
    const traversal = await client.callTool({ name: "get_corpus_guide", arguments: { corpusId: "../corpora" } });
    assert.equal(traversal.isError, true);
    const schemaViolation = await client.callTool({ name: "search", arguments: { query: "x", limit: 500 } }).catch((error) => ({ isError: true, error }));
    assert.equal(schemaViolation.isError, true, "out-of-range input is rejected");
    const noIndex = structured(await client.callTool({ name: "search", arguments: { query: "anything" } }));
    assert.equal(noIndex.ok, false);
    assert.match(noIndex.error, /No locally indexed corpora yet/);
    const ping = structured(await client.callTool({ name: "ping", arguments: {} }));
    assert.equal(ping.ok, true);
    assert.match(ping.version, /^\d+\.\d+\.\d+/);
  } finally {
    await close();
  }
});

test("preferences round-trip and reject oversized values", async () => {
  const { client, close } = await connect();
  try {
    const saved = structured(await client.callTool({ name: "set_preference", arguments: { key: "answer_format", value: "quotes first" } }));
    assert.equal(saved.preferences.answer_format, "quotes first");
    const read = structured(await client.callTool({ name: "get_preferences", arguments: {} }));
    assert.equal(read.preferences.answer_format, "quotes first");
    const bad = await client.callTool({ name: "set_preference", arguments: { key: "../x", value: "y" } });
    assert.equal(bad.isError, true);
  } finally {
    await close();
  }
});

test("agreed downloads run in the background, report progress, resume by continuation, and index in a worker", async () => {
  const network = mockFetch((href) => href.includes("archive.org")
    ? new Response(`RELATION of what occurred in New France. ${href.includes("jesuits34") ? "Brebeuf" : "Acadia"} winter canoe mission.`, { status: 200 })
    : new Response("missing", { status: 404 }));
  const { client, close } = await connect();
  try {
    const preview = structured(await client.callTool({ name: "download_builtin_corpus", arguments: { corpusId: "jesuit-relations", selection: "sample" } }));
    assert.equal(preview.needs_confirmation, true);
    let response = structured(await client.callTool({
      name: "download_builtin_corpus",
      arguments: { corpusId: "jesuit-relations", selection: "sample", confirmedRights: true, noticeSha256: preview.notice_sha256 }
    }));
    for (let attempt = 0; response.status === "in_progress" && attempt < 20; attempt += 1) {
      assert.ok(response.continuation);
      response = structured(await client.callTool({ name: "download_builtin_corpus", arguments: { corpusId: "jesuit-relations", continuation: response.continuation } }));
    }
    assert.equal(response.status, "complete", JSON.stringify(response));
    assert.equal(response.progress.text, 3);
    const search = structured(await client.callTool({ name: "search", arguments: { corpusIds: ["jesuit-relations"], query: "canoe" } }));
    assert.equal(search.results.length, 3);
    const list = structured(await client.callTool({ name: "list_corpora", arguments: {} }));
    assert.equal(list.corpora.find((corpus) => corpus.id === "jesuit-relations").state, "sample");
    assert.ok(network.calls.every((href) => href.startsWith("https://archive.org/")), "only the collection's own host was contacted");
  } finally {
    network.restore();
    await close();
  }
});

test("list_corpora offers the sample only where it is still useful", async () => {
  const { getCorpusCapsule } = await import("../dist/core/corpus/loader.js");
  const { reindexGenericCorpus } = await import("../dist/core/db/genericIndex.js");
  // A fuller search file from an earlier install, with no download record.
  reindexGenericCorpus(getCorpusCapsule("gandhi-collected-works"), [{ id: "vol-1", title: "Vol 1", sourcePath: "v1.txt", text: "truth and nonviolence" }]);
  const { client, close } = await connect();
  try {
    const response = structured(await client.callTool({ name: "list_corpora", arguments: {} }));
    const gandhi = response.corpora.find((corpus) => corpus.id === "gandhi-collected-works");
    assert.equal(gandhi.state, "partial_selection");
    assert.equal(gandhi.sample, null, "a sample offer is not shown as if it were the searchable content");
    assert.ok(response.corpora.find((corpus) => corpus.id === "pepys-diary").sample, "not-downloaded collections still offer it");
  } finally {
    await close();
  }
});
