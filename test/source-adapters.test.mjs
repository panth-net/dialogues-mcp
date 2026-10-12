import { TEST_HTTP, tempDir } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import PDFDocument from "pdfkit";
import { getSourceAdapter, listSourceAdapters } from "../dist/core/sources/adapters.js";


function tempRoots(name) {
  const base = tempDir(path.join("adapters", name));
  const rawRoot = path.join(base, "raw");
  const normalizedRoot = path.join(base, "normalized");
  fs.mkdirSync(rawRoot, { recursive: true });
  fs.mkdirSync(normalizedRoot, { recursive: true });
  return { base, rawRoot, normalizedRoot, http: { ...TEST_HTTP, allowedDomains: ["example.test", "newtonproject.ox.ac.uk", "loc.gov"] } };
}

function mockFetch(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = typeof url === "string" ? url : url.url;
    const body = routes[href];
    if (body === undefined) return new Response("missing", { status: 404 });
    return new Response(body, { status: 200 });
  };
  return () => {
    globalThis.fetch = original;
  };
}

function pdfBuffer(text) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 48 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.info.Title = "Mock Lovelace PDF";
    doc.text(text);
    doc.end();
  });
}

test("adapter registry exposes every planned source type", () => {
  for (const sourceType of [
    "loc_item",
    "loc_collection_search",
    "static_text_url",
    "static_html_url",
    "static_json_url",
    "tei_xml_url",
    "darwin_correspondence",
    "darwin_online",
    "umass_credo_item",
    "newton_project_item",
    "science_museum_item",
    "clay_lovelace_item",
    "catalog_only",
    "user_supplied_only"
  ]) {
    assert.ok(listSourceAdapters().includes(sourceType), `${sourceType} missing`);
    assert.equal(getSourceAdapter(sourceType).sourceType, sourceType);
  }
  assert.throws(() => getSourceAdapter("vector_db"), /Unknown source type/);
});

test("LOC adapter extracts transcription text and preserves item provenance", async () => {
  const roots = tempRoots("loc");
  const transcript = "Lincoln writes a long legal explanation about evidence, law, court pressure, and constitutional limits. ".repeat(3);
  const restore = mockFetch({
    "https://example.test/loc.json": JSON.stringify({
      item: {
        title: "Abraham Lincoln legal paper",
        date: "1862",
        contributor_names: ["Abraham Lincoln"],
        partof: ["Abraham Lincoln Papers"],
        rights_information: "No known restrictions",
        item_id: "mal000001",
        image_url: ["https://example.test/image.jpg"]
      },
      resources: [{ files: [{ url: "https://example.test/image.jpg" }] }],
      transcription: transcript
    })
  });
  try {
    const adapter = getSourceAdapter("loc_item");
    const fetched = await adapter.fetchItem({
      id: "loc:mal000001",
      source_type: "loc_item",
      api_url: "https://example.test/loc.json",
      rights_level: "public_domain",
      selected: true,
      paths: ["legal-mind"]
    }, roots);
    assert.equal(fetched.status, "text");
    assert.equal(fetched.metadata.loc_item_id, "mal000001");
    assert.deepEqual(fetched.metadata.image_urls, ["https://example.test/image.jpg"]);
    const docs = adapter.normalize(fetched);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].sourceCollection, "Abraham Lincoln Papers");
    assert.equal(docs[0].sourceItemId, "loc:mal000001");
    assert.deepEqual(docs[0].selectionPaths, ["legal-mind"]);
  } finally {
    restore();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test("LOC adapter follows fulltext_file XML and keeps fetched metadata concise", async () => {
  const roots = tempRoots("loc-fulltext-xml");
  const xml = `
    <?xml version="1.0" encoding="utf-8"?>
    <tei2>
      <teiheader><filedesc><titlestmt><title>Header title should not be indexed</title></titlestmt></filedesc></teiheader>
      <body>
        <div>
          <p><anchor>1</anchor>Lincoln writes about public safety and habeas corpus in ordered XML text.</p>
          <note><p>Editorial note should not become source text.</p></note>
          <p>The second paragraph preserves the order of the original text.</p>
        </div>
      </body>
    </tei2>
  `;
  const restore = mockFetch({
    "https://example.test/loc.json": JSON.stringify({
      item: {
        title: "Abraham Lincoln legal paper",
        date: "1863",
        contributor_names: ["Abraham Lincoln"],
        partof: [{ title: "Abraham Lincoln Papers" }, { title: "Manuscript Division" }],
        rights_information: "No known restrictions",
        id: "http://www.loc.gov/item/mal9999999/",
        image_url: [
          "https://example.test/001.jpg",
          "https://example.test/002.jpg",
          "https://example.test/003.jpg",
          "https://example.test/004.jpg",
          "https://example.test/005.jpg",
          "https://example.test/006.jpg"
        ],
        resources: [{
          fulltext_file: "https://example.test/fulltext.xml",
          files: [[{ url: "https://example.test/001.jpg" }]]
        }]
      },
      fulltext: "<xml>inline JSON text should lose to fulltext_file</xml>"
    }),
    "https://example.test/fulltext.xml": xml
  });
  try {
    const adapter = getSourceAdapter("loc_item");
    const fetched = await adapter.fetchItem({
      id: "loc:mal9999999",
      source_type: "loc_item",
      api_url: "https://example.test/loc.json",
      rights_level: "public_domain",
      selected: true,
      paths: ["legal-mind"]
    }, roots);
    assert.equal(fetched.status, "text");
    assert.equal(fetched.metadata.loc_item_id, "mal9999999");
    assert.equal(fetched.metadata.source_collection, "Abraham Lincoln Papers; Manuscript Division");
    assert.equal(fetched.metadata.text_url, "https://example.test/fulltext.xml");
    assert.equal(fetched.metadata.image_url_count, 6);
    assert.equal(fetched.metadata.image_urls.length, 5);
    assert.equal(fetched.metadata.raw_metadata, undefined);
    assert.match(fetched.text, /public safety and habeas corpus.*second paragraph/s);
    assert.doesNotMatch(fetched.text, /Header title|Editorial note|<p>|inline JSON/);
  } finally {
    restore();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test("LOC adapter reads newspaper full text from LOC text-service JSON", async () => {
  const roots = tempRoots("loc-text-service");
  const textServiceUrl = "https://tile.loc.gov/text-services/word-coordinates-service?segment=/service/newspaper/page.xml&format=alto_xml&full_text=1";
  const restore = mockFetch({
    "https://example.test/newspaper.json": JSON.stringify({
      item: {
        title: "Frederick Douglass newspaper page",
        date: "1851-06-26",
        partof: [{ title: "Frederick Douglass Newspapers" }],
        resources: [{ fulltext_file: textServiceUrl }]
      },
      fulltext_service: textServiceUrl
    }),
    [textServiceUrl]: JSON.stringify({
      "/service/newspaper/page.xml": {
        full_text: "Frederick Douglass edits a public platform about citizenship, rights, and abolition strategy. ".repeat(2)
      }
    })
  });
  try {
    const adapter = getSourceAdapter("loc_item");
    const fetched = await adapter.fetchItem({
      id: "loc:sn-test-p2",
      source_type: "loc_item",
      api_url: "https://example.test/newspaper.json",
      rights_level: "public_domain",
      selected: true,
      paths: ["douglass-as-editor"],
      metadata: { loc_item_id: "sn-test-p2" }
    }, roots);
    assert.equal(fetched.status, "text");
    assert.equal(fetched.metadata.loc_item_id, "sn-test-p2");
    assert.equal(fetched.metadata.text_url, textServiceUrl);
    assert.match(fetched.text, /public platform about citizenship/);
    assert.doesNotMatch(fetched.text, /full_text/);
  } finally {
    restore();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test("LOC adapter keeps image-only items metadata-only", async () => {
  const roots = tempRoots("loc-image-only");
  const restore = mockFetch({
    "https://example.test/loc-image.json": JSON.stringify({
      item: {
        title: "Image only",
        image_url: ["https://example.test/image.jpg"],
        item_id: "mal-image"
      }
    })
  });
  try {
    const adapter = getSourceAdapter("loc_item");
    const fetched = await adapter.fetchItem({
      id: "loc:mal-image",
      source_type: "loc_item",
      api_url: "https://example.test/loc-image.json",
      rights_level: "public_domain",
      selected: true
    }, roots);
    assert.equal(fetched.status, "metadata_only");
    assert.match(fetched.warnings[0], /without transcription or OCR/);
    assert.equal(adapter.normalize(fetched).length, 0);
  } finally {
    restore();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test("Darwin adapter extracts only letter body from Darwin Correspondence pages", async () => {
  const roots = tempRoots("darwin-letter-page");
  const html = `
    <html><head><title>To J. D. Hooker [11 January 1844] | Darwin Correspondence Project</title></head>
    <body>
      <script>window.cookieconsent = true;</script>
      <div class="body-content">
        <p class="salute">My dear Hooker</p>
        <p>Species are not immutable and this private letter shows thought before theory.<sup>1</sup></p>
      </div></div><div class="footnotes"><p>Editorial note should not be indexed.</p></div>
      <div id="letter_details"><dl>
        <dt>Letter no. </dt><dd>DCP-LETT-729</dd>
        <dt>From</dt><dd><a href="/person/darwin">Charles Robert Darwin</a></dd>
        <dt>To</dt><dd><a href="/person/hooker">Joseph Dalton Hooker</a></dd>
      </dl></div>
    </body></html>
  `;
  const restore = mockFetch({ "https://example.test/letter?docId=letters/DCP-LETT-729.xml": html });
  try {
    const adapter = getSourceAdapter("darwin_correspondence");
    const fetched = await adapter.fetchItem({
      id: "darwin:729",
      source_type: "darwin_correspondence",
      url: "https://example.test/letter?docId=letters/DCP-LETT-729.xml",
      rights_level: "rights_confirmed_user_download",
      selected: true,
      paths: ["thought-before-theory"]
    }, roots);
    assert.equal(fetched.status, "text");
    assert.equal(fetched.metadata.letter_number, "DCP-LETT-729");
    assert.equal(fetched.metadata.sender, "Charles Robert Darwin");
    assert.equal(fetched.metadata.recipient, "Joseph Dalton Hooker");
    assert.equal(fetched.metadata.title, "To J. D. Hooker [11 January 1844]");
    assert.match(fetched.text, /^My dear Hooker/);
    assert.doesNotMatch(fetched.text, /cookieconsent|Editorial note/);
  } finally {
    restore();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test("Darwin adapter preserves letter metadata from HTML", async () => {
  const roots = tempRoots("darwin");
  const html = `
    <html><head>
      <title>Letter 1234 - Darwin to Hooker</title>
      <meta name="sender" content="Charles Darwin">
      <meta name="recipient" content="J. D. Hooker">
      <meta name="date" content="1858-06-18">
    </head>
    <body><h1>Letter 1234</h1><p>My observations on species and variation led to another experiment. ${"Further scientific reasoning. ".repeat(8)}</p></body></html>
  `;
  const restore = mockFetch({ "https://example.test/darwin-letter.html": html });
  try {
    const adapter = getSourceAdapter("darwin_correspondence");
    const fetched = await adapter.fetchItem({
      id: "darwin:1234",
      source_type: "darwin_correspondence",
      url: "https://example.test/darwin-letter.html",
      rights_level: "public_domain",
      selected: true,
      paths: ["thought-before-theory"]
    }, roots);
    const doc = adapter.normalize(fetched)[0];
    assert.equal(doc.author, "Charles Darwin");
    assert.equal(doc.date, "1858-06-18");
    assert.equal(doc.metadata.fetched_metadata.recipient, "J. D. Hooker");
    assert.equal(doc.metadata.fetched_metadata.letter_number, "1234");
  } finally {
    restore();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test("UMass Credo adapter does not pretend metadata-only records are searchable text", async () => {
  const roots = tempRoots("umass");
  const restore = mockFetch({
    "https://example.test/umass.json": JSON.stringify({
      title: "UMass correspondence record",
      collection: "UMass Special Collections",
      series: "Correspondence",
      correspondent: "NAACP",
      date: "1919"
    }),
    "https://example.test/umass-public.json": JSON.stringify({
      title: "UMass research record",
      collection: "UMass Special Collections",
      series: "Research",
      date: "1903"
    })
  });
  try {
    const adapter = getSourceAdapter("umass_credo_item");
    const fetched = await adapter.fetchItem({
      id: "umass:mums312-b001",
      source_type: "umass_credo_item",
      api_url: "https://example.test/umass.json",
      rights_level: "catalog_only",
      selected: true
    }, roots);
    assert.equal(fetched.status, "catalog_only");
    assert.equal(adapter.normalize(fetched).length, 0);

    const metadataOnly = await adapter.fetchItem({
      id: "umass:mums312-research",
      source_type: "umass_credo_item",
      api_url: "https://example.test/umass-public.json",
      rights_level: "public_domain",
      selected: true
    }, roots);
    assert.equal(metadataOnly.status, "metadata_only");
    assert.equal(metadataOnly.metadata.source_collection, "UMass Special Collections");
    assert.equal(metadataOnly.metadata.series, "Research");
    assert.equal(adapter.normalize(metadataOnly).length, 0);
  } finally {
    restore();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test("Newton TEI adapter preserves diplomatic manuscript metadata", async () => {
  const roots = tempRoots("newton");
  const xml = `
    <TEI><teiHeader><fileDesc><titleStmt><title>Optics draft</title><author>Isaac Newton</author></titleStmt></fileDesc></teiHeader>
    <text type="diplomatic"><body><p>Newton writes about prism light colour experiment and correction. ${"Observation follows. ".repeat(8)}</p></body></text></TEI>
  `;
  const restore = mockFetch({ "https://example.test/newton.xml": xml });
  try {
    const adapter = getSourceAdapter("newton_project_item");
    const fetched = await adapter.fetchItem({
      id: "newton:optics",
      source_type: "newton_project_item",
      url: "https://example.test/newton.xml",
      rights_level: "public_domain",
      selected: true,
      paths: ["optics-and-experiment"]
    }, roots);
    const doc = adapter.normalize(fetched)[0];
    assert.equal(doc.sourceCollection, "Newton Project");
    assert.equal(doc.metadata.fetched_metadata.transcription_type, "diplomatic");
    assert.match(doc.text, /prism light colour experiment/);
  } finally {
    restore();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test("Newton adapter treats Newton Project XML routes as TEI and ignores headers", async () => {
  const roots = tempRoots("newton-route");
  const xml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <TEI xml:id="NATP00126" type="transcription">
      <teiHeader>
        <fileDesc>
          <titleStmt><title>Draft of the Discourse Concerning Light and Colors</title><author>Isaac Newton</author></titleStmt>
          <publicationStmt><date>2014</date><availability><licence target="http://creativecommons.org/licenses/by-nc-nd/3.0/" /></availability></publicationStmt>
        </fileDesc>
        <profileDesc><creation><origDate when="1675-01-01">early 1675</origDate></creation></profileDesc>
      </teiHeader>
      <text type="diplomatic"><body><p>Prism colour rings and light experiment. ${"Observation follows. ".repeat(8)}</p></body></text>
    </TEI>
  `;
  const restore = mockFetch({ "https://www.newtonproject.ox.ac.uk/view/texts/xml/NATP00126": xml });
  try {
    const adapter = getSourceAdapter("newton_project_item");
    const fetched = await adapter.fetchItem({
      id: "newton:NATP00126",
      source_type: "newton_project_item",
      url: "https://www.newtonproject.ox.ac.uk/view/texts/xml/NATP00126",
      rights_level: "noncommercial_open_license",
      selected: true,
      paths: ["optics-and-experiment"]
    }, roots);
    const doc = adapter.normalize(fetched)[0];
    assert.equal(fetched.rawPath?.endsWith(".xml"), true);
    assert.equal(doc.date, "1675-01-01");
    assert.equal(doc.metadata.fetched_metadata.catalogue_id, "NATP00126");
    assert.equal(doc.metadata.fetched_metadata.license_url, "http://creativecommons.org/licenses/by-nc-nd/3.0/");
    assert.match(doc.text, /^Prism colour rings/);
    assert.doesNotMatch(doc.text, /publicationStmt|teiHeader|2014/);
  } finally {
    restore();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test("Clay Lovelace and Science Museum adapters preserve source posture", async () => {
  const roots = tempRoots("lovelace-science");
  const html = `<html><head><meta name="date" content="1843"></head><body><h1>Ada Lovelace letter</h1><p>${"Mathematical learning and calculation with Babbage. ".repeat(6)}</p></body></html>`;
  const restore = mockFetch({
    "https://example.test/lovelace.html": html,
    "https://example.test/science.json": JSON.stringify({
      title: "Babbage engine drawing",
      object_id: "SCM-123",
      collection: "Science Museum",
      image: "https://example.test/drawing.jpg"
    })
  });
  try {
    const clay = getSourceAdapter("clay_lovelace_item");
    const clayFetched = await clay.fetchItem({
      id: "clay:ada-letter",
      source_type: "clay_lovelace_item",
      url: "https://example.test/lovelace.html",
      rights_level: "public_domain",
      selected: true,
      paths: ["lovelace-learning-math"]
    }, roots);
    assert.equal(clay.normalize(clayFetched)[0].sourceCollection, "Clay Lovelace");

    const science = getSourceAdapter("science_museum_item");
    const scienceFetched = await science.fetchItem({
      id: "science:babbage-drawing",
      source_type: "science_museum_item",
      api_url: "https://example.test/science.json",
      rights_level: "catalog_only",
      selected: true
    }, roots);
    assert.equal(scienceFetched.status, "catalog_only");
    assert.equal(science.normalize(scienceFetched).length, 0);
  } finally {
    restore();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test("Clay Lovelace adapter extracts text from PDF sources", async () => {
  const roots = tempRoots("lovelace-pdf");
  const pdf = await pdfBuffer("Ada Lovelace works through differential calculus, symbols, limits, and mathematical reasoning with De Morgan. ".repeat(6));
  const restore = mockFetch({
    "https://example.test/lovelace.pdf": pdf
  });
  try {
    const adapter = getSourceAdapter("clay_lovelace_item");
    const fetched = await adapter.fetchItem({
      id: "clay:mock-lovelace-pdf",
      source_type: "clay_lovelace_item",
      url: "https://example.test/lovelace.pdf",
      rights_level: "rights_confirmed_user_download",
      selected: true,
      paths: ["lovelace-learning-math"]
    }, roots);
    assert.equal(fetched.status, "text");
    assert.equal(fetched.rawPath.endsWith(".pdf"), true);
    assert.equal(fetched.metadata.source_collection, "Clay Lovelace");
    assert.equal(fetched.metadata.title, "Mock Lovelace PDF");
    assert.match(fetched.text, /differential calculus/);
    assert.equal(adapter.normalize(fetched)[0].sourceCollection, "Clay Lovelace");
  } finally {
    restore();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test("Science Museum adapter extracts public record body and JSON-LD metadata", async () => {
  const roots = tempRoots("science-html");
  const html = `
    <html><head>
      <script type="application/ld+json">
        {
          "@type": "CreativeWork",
          "name": "Notation of cards for algebraic addition",
          "identifier": "BAB/F/114",
          "dateCreated": "1843",
          "description": "A Babbage Papers record for cards and algebraic addition."
        }
      </script>
    </head><body>
      <nav>Search Collection About Visit us</nav>
      <main id="main-content">
        <h1>Notation of cards for algebraic addition</h1>
        <p>${"Operation cards, variable cards, notation, algebraic addition, and Analytical Engine design. ".repeat(5)}</p>
      </main>
    </body></html>
  `;
  const restore = mockFetch({ "https://example.test/science-record.html": html });
  try {
    const adapter = getSourceAdapter("science_museum_item");
    const fetched = await adapter.fetchItem({
      id: "science:cards",
      source_type: "science_museum_item",
      url: "https://example.test/science-record.html",
      rights_level: "rights_confirmed_user_download",
      selected: true,
      paths: ["program-traces-and-engine-design"]
    }, roots);
    assert.equal(fetched.status, "text");
    assert.equal(fetched.metadata.title, "Notation of cards for algebraic addition");
    assert.equal(fetched.metadata.date, "1843");
    assert.equal(fetched.metadata.object_id, "BAB/F/114");
    assert.match(fetched.text, /Operation cards/);
    assert.doesNotMatch(fetched.text, /Search Collection About/);
  } finally {
    restore();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test("Science Museum adapter summarizes structured JSON returned from record URLs", async () => {
  const roots = tempRoots("science-json-route");
  const restore = mockFetch({
    "https://example.test/science-record": JSON.stringify({
      data: {
        attributes: {
          summary: { title: "Elevation of parts of the card counting apparatus for operation and variable cards." },
          identifier: [{ type: "object number", value: "BAB/A/133", primary: true }],
          creation: {
            date: [{ value: "1845-02" }],
            maker: [{ summary: { title: "Babbage, Charles" } }]
          },
          description: [{ type: "physical description", value: "Dimensions: 61 cm x 96 cm" }],
          parent: [{ summary: { title: "Drawings of the Analytical Engine" } }]
        }
      }
    })
  });
  try {
    const adapter = getSourceAdapter("science_museum_item");
    const fetched = await adapter.fetchItem({
      id: "science:json-cards",
      source_type: "science_museum_item",
      url: "https://example.test/science-record",
      rights_level: "rights_confirmed_user_download",
      selected: true,
      paths: ["program-traces-and-engine-design"]
    }, roots);
    assert.equal(fetched.status, "text");
    assert.equal(fetched.metadata.object_id, "BAB/A/133");
    assert.equal(fetched.metadata.maker, "Babbage, Charles");
    assert.match(fetched.text, /^Title: Elevation of parts/);
    assert.match(fetched.text, /Identifier: BAB\/A\/133/);
    assert.doesNotMatch(fetched.text, /"data"|"attributes"/);
  } finally {
    restore();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test("adapter errors include source item ID and URL", async () => {
  const roots = tempRoots("adapter-error");
  const restore = mockFetch({});
  try {
    const adapter = getSourceAdapter("static_text_url");
    await assert.rejects(() => adapter.fetchItem({
      id: "missing-source",
      source_type: "static_text_url",
      url: "https://example.test/missing.txt",
      rights_level: "public_domain",
      selected: true
    }, roots), /Source item missing-source \(https:\/\/example\.test\/missing\.txt\) failed: HTTP 404/);
  } finally {
    restore();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test("discovered text links outside the collection's hosts are refused", async () => {
  const roots = tempRoots("discovered-link");
  const restore = mockFetch({
    "https://example.test/item.json": JSON.stringify({ item: { title: "Item", fulltext_file: "https://evil.example.com/steal.txt" } }),
    "https://evil.example.com/steal.txt": "should never be fetched"
  });
  try {
    const adapter = getSourceAdapter("loc_item");
    await assert.rejects(() => adapter.fetchItem({
      id: "loc:link-test",
      source_type: "loc_item",
      url: "https://example.test/item.json",
      rights_level: "no_known_restrictions",
      selected: true
    }, { ...roots, http: { ...roots.http, allowedDomains: ["example.test"] } }), /not one of this collection's sources/);
  } finally {
    restore();
  }
});
