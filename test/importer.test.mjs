import { dataDir, tempDir, userCorpusDir } from "./helpers/isolated-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import PDFDocument from "pdfkit";
import AdmZip from "adm-zip";
import { importFolder } from "../dist/core/import/importFolder.js";
import { getCorpusCapsule, listCorpusCapsules } from "../dist/core/corpus/loader.js";
import { searchCorpus } from "../dist/core/search/corpusTools.js";
import { pdfSupportStatus } from "../dist/core/import/pdf.js";

function writePdf(filePath, text) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument();
    const stream = fs.createWriteStream(filePath);
    stream.on("finish", resolve);
    stream.on("error", reject);
    document.pipe(stream);
    document.text(text);
    document.end();
  });
}

test("folder importer handles TXT, Markdown, PDF, empty files, unsupported, hidden, and credential files", async () => {
  const source = tempDir("import-source");
  fs.writeFileSync(path.join(source, "plain.txt"), "plain text alpha beta", "utf8");
  fs.writeFileSync(path.join(source, "note.md"), "# Note\n\nmarkdown gamma delta", "utf8");
  fs.writeFileSync(path.join(source, "empty.txt"), "", "utf8");
  fs.writeFileSync(path.join(source, "unsupported.bin"), "nope", "utf8");
  fs.writeFileSync(path.join(source, ".env"), "SHOULD_NOT_BE_IMPORTED=1", "utf8");
  fs.writeFileSync(path.join(source, "id_rsa"), "PRIVATE KEY MATERIAL", "utf8");
  fs.mkdirSync(path.join(source, ".git"));
  fs.writeFileSync(path.join(source, ".git", "config.txt"), "hidden folder text", "utf8");
  await writePdf(path.join(source, "layered.pdf"), "pdf layered epsilon zeta");

  const result = await importFolder({ sourcePath: source, name: "Test Importer", corpusId: "../test-importer" });
  assert.equal(result.ok, true);
  assert.equal(result.corpus_id, "test-importer");
  assert.ok(result.corpus_path.startsWith(dataDir), "imported collections live in the data folder");
  assert.ok(result.skipped.some((item) => item.path === "unsupported.bin"));
  assert.ok(result.skipped.some((item) => item.path === ".env" && /credential/.test(item.reason)));
  assert.ok(result.skipped.some((item) => item.path === "id_rsa" && /credential/.test(item.reason)));
  assert.ok(result.skipped.some((item) => item.path === ".git" && /hidden/.test(item.reason)));
  assert.ok(result.skipped.some((item) => item.path === "empty.txt"));
  const copied = fs.readdirSync(path.join(result.corpus_path, "documents"));
  assert.ok(!copied.includes(".env") && !copied.includes("id_rsa") && !copied.includes(".git"), "secrets are never copied");
  const report = fs.readFileSync(result.import_report_path, "utf8");
  assert.doesNotMatch(report, /SHOULD_NOT_BE_IMPORTED|PRIVATE KEY MATERIAL/, "reports name skipped files without their contents");

  const pdf = await pdfSupportStatus();
  const pdfSkip = result.skipped.find((item) => item.path === "layered.pdf");
  if (pdf.available) {
    assert.equal(pdfSkip, undefined);
    assert.equal(searchCorpus(getCorpusCapsule("test-importer"), "epsilon", 5).count, 1);
  } else {
    assert.match(pdfSkip.reason, /PDF support unavailable/);
  }
});

test("PDF problems affect only PDFs when PDF support is unavailable", async () => {
  const source = tempDir("import-no-pdf");
  fs.writeFileSync(path.join(source, "letter.txt"), "a plain letter about harvests", "utf8");
  await writePdf(path.join(source, "scan.pdf"), "pdf text");
  process.env.DIALOGUES_DISABLE_PDF = "1";
  try {
    const result = await importFolder({ sourcePath: source, corpusId: "test-no-pdf" });
    assert.equal(result.documents, 1);
    assert.match(result.skipped.find((item) => item.path === "scan.pdf").reason, /PDF support unavailable/);
  } finally {
    delete process.env.DIALOGUES_DISABLE_PDF;
  }
});

test("symbolic links and junctions that lead outside the folder are not followed", async (t) => {
  const base = tempDir("import-links");
  const outside = path.join(base, "outside");
  const source = path.join(base, "source");
  fs.mkdirSync(outside);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(outside, "private.txt"), "outside private words", "utf8");
  fs.writeFileSync(path.join(source, "inside.txt"), "inside words", "utf8");
  try {
    fs.symlinkSync(outside, path.join(source, "linked-folder"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("cannot create links here");
    return;
  }
  const result = await importFolder({ sourcePath: source, corpusId: "test-links" });
  assert.equal(result.documents, 1);
  assert.ok(result.skipped.some((item) => item.path === "linked-folder" && /symbolic link or junction/.test(item.reason)));
  assert.equal(searchCorpus(getCorpusCapsule("test-links"), "private", 5).count, 0);
});

test("imports are bounded by file count and size, and URLs are rejected", async () => {
  const source = tempDir("import-limits");
  for (let index = 0; index < 5; index += 1) fs.writeFileSync(path.join(source, `f${index}.txt`), `file ${index} words`, "utf8");
  await assert.rejects(() => importFolder({ sourcePath: source, corpusId: "test-too-many", limits: { maxFiles: 3 } }), /more than 3 files/);
  assert.equal(fs.existsSync(userCorpusDir("test-too-many")), false);

  fs.writeFileSync(path.join(source, "big.txt"), "x".repeat(4096), "utf8");
  const big = await importFolder({ sourcePath: source, corpusId: "test-file-size", limits: { maxFileBytes: 1024 } });
  assert.equal(big.documents, 5);
  assert.ok(big.skipped.some((item) => item.path === "big.txt" && /larger than/.test(item.reason)));
  await assert.rejects(() => importFolder({ sourcePath: "https://example.com/folder" }), /not URLs/);
  await assert.rejects(() => importFolder({ sourcePath: "file:///etc" }), /not URLs/);
});

test("EPUB archives with unsafe entry names are skipped", async () => {
  const source = tempDir("import-epub");
  const zip = new AdmZip();
  zip.addFile("META-INF/container.xml", Buffer.from("<container/>"));
  zip.addFile("xx/xx/escape.xhtml", Buffer.from("<html><body>escape</body></html>"));
  // adm-zip cleans names it writes, so patch the stored name to a real traversal.
  const bytes = zip.toBuffer();
  const from = Buffer.from("xx/xx/escape.xhtml");
  const to = Buffer.from("../../escape.xhtml");
  for (let index = bytes.indexOf(from); index >= 0; index = bytes.indexOf(from, index + 1)) to.copy(bytes, index);
  fs.writeFileSync(path.join(source, "book.epub"), bytes);
  fs.writeFileSync(path.join(source, "ok.txt"), "ok words", "utf8");
  const result = await importFolder({ sourcePath: source, corpusId: "test-epub" });
  assert.ok(result.skipped.some((item) => item.path === "book.epub" && /unsafe entry paths/.test(item.reason)));
});

test("a failed import leaves no half-ready collection behind", async () => {
  const source = tempDir("import-fail");
  fs.writeFileSync(path.join(source, "empty.txt"), "   ", "utf8");
  await assert.rejects(() => importFolder({ sourcePath: source, corpusId: "test-failed-import" }), /No extractable text/);
  assert.equal(fs.existsSync(userCorpusDir("test-failed-import")), false);
  assert.ok(!listCorpusCapsules().corpora.some((capsule) => capsule.id === "test-failed-import"));
  assert.ok(!fs.readdirSync(path.join(dataDir, "user-corpora")).some((name) => name.startsWith(".staging")), "staging folder removed");
  assert.ok(fs.readdirSync(path.join(dataDir, "imports")).some((name) => name.startsWith("test-failed-import")), "a failure report is kept");
});

test("the data folder itself cannot be imported", async () => {
  await assert.rejects(() => importFolder({ sourcePath: dataDir, corpusId: "test-self" }), /Dialogues data folder/);
});
