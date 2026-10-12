import { TEST_HTTP, dataDir, mockFetch, tempDir } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import { getCorpusCapsule } from "../dist/core/corpus/loader.js";
import { fetchCorpus, searchCorpus } from "../dist/core/search/corpusTools.js";
import { importVanGoghLetters } from "../dist/core/vangogh/import.js";
import { downloadFromSourceManifest } from "../dist/core/sources/download.js";

const ARCHIVE_URL = "https://vangoghletters.org/vg/vangoghxml.zip";

function letterXml(number, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns:vg="http://www.vangoghletters.org/ns/" xmlns="http://www.tei-c.org/ns/1.0">
<teiHeader xml:lang="en"><fileDesc>
<titleStmt><title>To Theo van Gogh. Arles, letter ${number}.</title></titleStmt>
<publicationStmt><ptr target="http://vangoghletters.org/orig/let${number}"/></publicationStmt>
<sourceDesc><vg:letDesc><vg:letIdentifier><idno type="jlb">${number}</idno></vg:letIdentifier>
<vg:letHeading><author>Vincent van Gogh</author><vg:addressee>Theo van Gogh</vg:addressee><vg:placeLet>Arles</vg:placeLet><vg:dateLet>1888-09-23</vg:dateLet></vg:letHeading>
</vg:letDesc></sourceDesc></fileDesc></teiHeader>
<text xml:lang="en"><body><div type="original"><ab>Origineel.</ab></div><div type="translation">
<pb f="1r" n="1" xml:id="pb-trans-1r-1"/>
<ab>${body}<anchor n="1" xml:id="note-t-1"/></ab>
<div type="notes"><note n="1">This note should not be indexed.</note></div></div></body></text>
</TEI>`;
}

function archive(letters) {
  const zip = new AdmZip();
  for (const [number, body] of letters) zip.addFile(`let${String(number).padStart(3, "0")}.xml`, Buffer.from(letterXml(number, body), "utf8"));
  zip.addFile("vgodd.xml", Buffer.from("<schema>This should not be indexed.</schema>", "utf8"));
  zip.addFile("../escape.xml", Buffer.from("<x/>", "utf8"));
  return zip.toBuffer();
}

test("missing Van Gogh index gives a friendly next step", () => {
  assert.throws(() => searchCorpus(getCorpusCapsule("vangogh-letters"), "Gauguin", 1), /not downloaded yet/);
});

test("Van Gogh download parses the archive in memory, honors the sample, and keeps metadata", async () => {
  const letters = Array.from({ length: 61 }, (_, index) => [index + 1, `Letter ${index + 1}: Gauguin and yellow light belong in this test letter.`]);
  const zip = archive(letters);
  const network = mockFetch((href) => href === ARCHIVE_URL ? new Response(zip, { status: 200 }) : new Response("missing", { status: 404 }));
  try {
    const sample = await downloadFromSourceManifest("vangogh-letters", { sample: true, confirmedRights: true, http: TEST_HTTP });
    assert.equal(sample.status, "complete");
    assert.equal(sample.index_coverage, "sample");
    // Every 30th of 61 letters: letters 1, 31, 61.
    assert.equal(sample.index.documents, 3);
    const search = searchCorpus(getCorpusCapsule("vangogh-letters"), "Gauguin OR yellow", 10);
    assert.equal(search.count, 3);
    const first = search.results[0];
    assert.equal(first.metadata.document.recipient, "Theo van Gogh");
    assert.equal(first.metadata.document.date, "1888-09-23");
    const fetched = fetchCorpus(getCorpusCapsule("vangogh-letters"), first.id, 0);
    assert.match(fetched.passages[0].text, /Gauguin and yellow light belong/);
    assert.doesNotMatch(fetched.passages[0].text, /anchor|note-t|This note should not be indexed|pb-trans/);

    const full = await downloadFromSourceManifest("vangogh-letters", { confirmedRights: true, http: TEST_HTTP });
    assert.equal(full.index.documents, 61);
    assert.equal(network.calls.filter((href) => href === ARCHIVE_URL).length, 1, "the archive is downloaded once and reused");
    assert.ok(!fs.existsSync(path.join(dataDir, "source-cache", "escape.xml")), "archive entry names are never used as paths");
  } finally {
    network.restore();
  }
});

test("Van Gogh local import handles BOM JSON from the user's own folder", async () => {
  const source = tempDir("vangogh-bom");
  const exportJson = {
    letters: [{
      id: "letter-bom-json",
      title: "BOM JSON Letter",
      author: "Vincent van Gogh",
      recipient: "Theo van Gogh",
      date: "1888-10-01",
      place: "Arles",
      language: "en",
      text: "Sunflowers and a local JSON export."
    }]
  };
  fs.writeFileSync(path.join(source, "letters.json"), `${String.fromCharCode(0xfeff)}${JSON.stringify(exportJson, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(source, ".env"), "SECRET=1", "utf8");

  const imported = await importVanGoghLetters({ from: source, yes: true, force: true });
  assert.equal(imported.documents, 1);
  assert.ok(imported.skipped.some((item) => item.path === ".env" && /credential/.test(item.reason)));
  const search = searchCorpus(getCorpusCapsule("vangogh-letters"), "Sunflowers", 5);
  assert.equal(search.count, 1);
  assert.equal(search.results[0].metadata.document.recipient, "Theo van Gogh");
});
