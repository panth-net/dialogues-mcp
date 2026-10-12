import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";
import * as mammoth from "mammoth";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { convert as htmlToText } from "html-to-text";
import { getCorpusCapsule, invalidateCorpusCache, loadCorpusFromPath } from "../corpus/loader.js";
import type { CorpusCapsule } from "../corpus/types.js";
import {
  dataDir,
  dataPath,
  indexPathFor,
  isInside,
  isSafeId,
  logsRoot,
  resolveFromPackage,
  userCorporaRoot
} from "../paths.js";
import { extractPdfText, PdfSupportUnavailableError } from "./pdf.js";
import {
  assertLocalPathInput,
  DEFAULT_IMPORT_LIMITS,
  isSafeArchiveEntryName,
  walkFolder,
  type ImportLimits
} from "./safeWalk.js";
import { withCorpusWriter } from "../state/corpusLock.js";
import { renameWithRetry, writeFileAtomic } from "../state/files.js";
import {
  reindexGenericCorpus,
  type GenericChunkInput,
  type GenericDocumentInput,
  type GenericIndexStats
} from "../db/genericIndex.js";
import { DEFAULT_CHUNKING, chunkText, normalizeImportedText } from "./chunk.js";
import { appendLogEvent } from "../logs/events.js";

const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".pdf", ".epub", ".docx"]);

export type ImportSkippedFile = {
  path: string;
  reason: string;
};

export type CorpusExtraction = {
  documents: GenericDocumentInput[];
  skipped: ImportSkippedFile[];
  warnings: string[];
  files_found: number;
  files_imported: number;
};

export type ImportReport = {
  ok: boolean;
  corpus_id: string;
  title: string;
  source_path?: string;
  corpus_path: string;
  generated_at: string;
  files_found: number;
  files_copied?: number;
  files_imported: number;
  files_skipped: number;
  documents: number;
  chunks: number;
  skipped: ImportSkippedFile[];
  warnings: string[];
  rights_notice: string;
  import_report_path: string;
  error?: string;
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "imported-corpus";
}

function renderTemplate(fileName: string, values: Record<string, string>): string {
  const templatePath = resolveFromPackage("templates", "corpus", fileName);
  const template = fs.readFileSync(templatePath, "utf8");
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => values[key] ?? "");
}

function writeCapsuleFiles(root: string, corpusId: string, title: string): void {
  const templateValues = {
    corpusId,
    title,
    primaryQuery: title
      .split(/\s+/)
      .filter((word) => word.length > 2)
      .slice(0, 3)
      .join(" OR ") || "topic OR name OR place"
  };
  const manifest = {
    id: corpusId,
    title,
    description: `Local user-imported corpus: ${title}`,
    languages: ["unknown"],
    type: "user_folder",
    status: "user",
    data_policy: "user_provided_local",
    default_search_mode: "fts",
    guide: "guide.md",
    search_rules: "search-rules.md",
    source_notes: "source-notes.md",
    citation_rules: "citation-rules.md",
    fields: ["doc_id", "title", "source_path", "chunk_index", "page", "chapter"],
    chunking: DEFAULT_CHUNKING,
    license: {
      data_included: false,
      user_must_confirm_rights: true,
      notes: "User imported these local files and is responsible for confirming rights."
    }
  };
  fs.writeFileSync(path.join(root, "corpus.yaml"), YAML.stringify(manifest), "utf8");
  fs.writeFileSync(path.join(root, "guide.md"), renderTemplate("guide.md", templateValues), "utf8");
  fs.writeFileSync(path.join(root, "search-rules.md"), renderTemplate("search-rules.md", templateValues), "utf8");
  fs.writeFileSync(path.join(root, "source-notes.md"), renderTemplate("source-notes.md", templateValues), "utf8");
  fs.writeFileSync(path.join(root, "citation-rules.md"), renderTemplate("citation-rules.md", templateValues), "utf8");
}

function chunkWithCitation(
  text: string,
  citationBase: string,
  metadata: Record<string, unknown>,
  config: CorpusCapsule["manifest"]["chunking"],
  startIndex = 0
): GenericChunkInput[] {
  return chunkText(text, config).map((chunk, offset) => {
    const chunkIndex = startIndex + offset;
    return {
      chunkIndex,
      text: chunk.text_raw,
      citation: `${citationBase}, chunk ${offset}`,
      metadata: {
        ...metadata,
        source_chunk_index: offset
      }
    };
  });
}

function xmlParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    textNodeName: "#text",
    removeNSPrefix: false
  });
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function xmlNodeText(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = xmlNodeText(item);
      if (text) return text;
    }
  }
  if (value && typeof value === "object") {
    const node = value as Record<string, unknown>;
    return xmlNodeText(node["#text"] ?? node._ ?? node.value);
  }
  return undefined;
}

function zipText(zip: AdmZip, zipPath: string): string | undefined {
  const normalized = zipPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const entry = zip.getEntry(normalized);
  if (!entry || entry.isDirectory) return undefined;
  return entry.getData().toString("utf8").replace(/^\uFEFF/, "");
}

function zipJoin(base: string, href: string): string {
  return path.posix.normalize(path.posix.join(base, href)).replace(/^(\.\.\/)+/, "");
}

function htmlTitle(html: string): string | undefined {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    ?? html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1];
  if (!title) return undefined;
  const text = htmlToText(title, { wordwrap: false }).trim();
  return text || undefined;
}

function markdownHeadings(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function htmlHeadings(html: string): string[] {
  const headings: string[] = [];
  for (const match of html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)) {
    const heading = htmlToText(match[1], { wordwrap: false }).trim();
    if (heading) headings.push(heading);
  }
  return headings;
}

function plainDocument(
  filePath: string,
  relative: string,
  ext: string,
  capsule: CorpusCapsule
): GenericDocumentInput | ImportSkippedFile {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const text = normalizeImportedText(raw);
  if (!text) return { path: relative, reason: "empty file" };
  const title = path.basename(filePath, ext);
  const chunks = chunkWithCitation(
    text,
    path.basename(relative),
    { imported_from: relative, file_type: ext.slice(1) || "text" },
    capsule.manifest.chunking
  );
  return {
    id: slugify(relative.replace(/\.[^.]+$/, "")),
    title,
    sourcePath: relative,
    text,
    chunks,
    metadata: { imported_from: relative, file_type: ext.slice(1) || "text" }
  };
}

async function pdfDocument(
  filePath: string,
  relative: string,
  capsule: CorpusCapsule,
  limits: ImportLimits
): Promise<{ document?: GenericDocumentInput; skipped?: ImportSkippedFile; warnings: string[] }> {
  try {
    const pdf = await extractPdfText(fs.readFileSync(filePath), {
      maxPages: limits.maxPdfPages,
      timeoutMs: Math.min(limits.maxProcessingMs, 5 * 60 * 1000)
    });
    const title = pdf.title || path.basename(filePath, ".pdf");
    const chunks: GenericChunkInput[] = [];
    const pageTexts: string[] = [];
    for (const page of pdf.pages) {
      pageTexts.push(`[Page ${page.pageNumber}]\n${page.text}`);
      for (const pageChunk of chunkText(page.text, capsule.manifest.chunking)) {
        chunks.push({
          chunkIndex: chunks.length,
          text: pageChunk.text_raw,
          citation: `${path.basename(relative)}, page ${page.pageNumber}, chunk ${pageChunk.chunk_index}`,
          metadata: {
            imported_from: relative,
            file_type: "pdf",
            page: page.pageNumber,
            page_chunk_index: pageChunk.chunk_index
          }
        });
      }
    }
    const warnings = pdf.warnings.map((warning) => `${relative}: ${warning}`);
    if (chunks.length === 0) {
      return {
        skipped: { path: relative, reason: "OCR not supported yet: no text layer detected" },
        warnings: [`${relative}: OCR not supported yet; no text layer detected`]
      };
    }
    return {
      document: {
        id: slugify(relative.replace(/\.[^.]+$/, "")),
        title,
        sourcePath: relative,
        text: pageTexts.join("\n\n"),
        chunks,
        author: pdf.author,
        metadata: {
          imported_from: relative,
          file_type: "pdf",
          pages: pdf.numPages,
          pages_read: pdf.truncated ? limits.maxPdfPages : pdf.numPages,
          pdf_title: title
        }
      },
      warnings
    };
  } catch (error) {
    return {
      skipped: {
        path: relative,
        reason: error instanceof PdfSupportUnavailableError
          ? "PDF support unavailable on this computer; convert this PDF to text to import it"
          : `PDF extraction failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`
      },
      warnings: []
    };
  }
}

function epubDocuments(
  filePath: string,
  relative: string,
  capsule: CorpusCapsule,
  limits: ImportLimits
): { documents: GenericDocumentInput[]; skipped?: ImportSkippedFile; warnings: string[] } {
  try {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    if (entries.length > limits.maxArchiveEntries) {
      return { documents: [], skipped: { path: relative, reason: `EPUB has more than ${limits.maxArchiveEntries} entries` }, warnings: [] };
    }
    const declaredBytes = entries.reduce((sum, entry) => sum + Number(entry.header.size ?? 0), 0);
    if (declaredBytes > limits.maxArchiveBytes) {
      return { documents: [], skipped: { path: relative, reason: `EPUB expands to more than ${Math.round(limits.maxArchiveBytes / 1024 / 1024)} MB` }, warnings: [] };
    }
    if (entries.some((entry) => !isSafeArchiveEntryName(entry.entryName))) {
      return { documents: [], skipped: { path: relative, reason: "EPUB contains unsafe entry paths" }, warnings: [] };
    }
    const parser = xmlParser();
    const containerXml = zipText(zip, "META-INF/container.xml");
    if (!containerXml) return { documents: [], skipped: { path: relative, reason: "EPUB missing META-INF/container.xml" }, warnings: [] };
    const container = parser.parse(containerXml) as Record<string, unknown>;
    const rootfiles = asArray(((container.container as Record<string, unknown> | undefined)?.rootfiles as Record<string, unknown> | undefined)?.rootfile as Record<string, unknown> | undefined);
    const firstRootfile = rootfiles[0] as Record<string, unknown> | undefined;
    const opfPath = String(firstRootfile?.["full-path"] ?? "");
    if (!opfPath) return { documents: [], skipped: { path: relative, reason: "EPUB missing OPF rootfile path" }, warnings: [] };
    const opfXml = zipText(zip, opfPath);
    if (!opfXml) return { documents: [], skipped: { path: relative, reason: `EPUB OPF not found: ${opfPath}` }, warnings: [] };
    const opf = parser.parse(opfXml) as Record<string, unknown>;
    const pkg = opf.package as Record<string, unknown> | undefined;
    const metadata = pkg?.metadata as Record<string, unknown> | undefined;
    const manifest = pkg?.manifest as Record<string, unknown> | undefined;
    const spine = pkg?.spine as Record<string, unknown> | undefined;
    const bookTitle = xmlNodeText(metadata?.["dc:title"] ?? metadata?.title) || path.basename(filePath, ".epub");
    const creator = xmlNodeText(metadata?.["dc:creator"] ?? metadata?.creator) ?? null;
    const opfDir = path.posix.dirname(opfPath);
    const items = asArray(manifest?.item as Record<string, unknown> | Record<string, unknown>[] | undefined);
    const itemById = new Map(items.map((item) => [String(item.id ?? ""), item]));
    const spineRefs = asArray(spine?.itemref as Record<string, unknown> | Record<string, unknown>[] | undefined);
    const documents: GenericDocumentInput[] = [];
    const warnings: string[] = [];

    for (const [index, ref] of spineRefs.entries()) {
      const item = itemById.get(String(ref.idref ?? ""));
      if (!item) continue;
      const mediaType = String(item["media-type"] ?? "");
      if (!/x?html/i.test(mediaType)) continue;
      const href = String(item.href ?? "");
      if (!href) continue;
      const chapterPath = zipJoin(opfDir === "." ? "" : opfDir, href);
      const html = zipText(zip, chapterPath);
      if (!html) {
        warnings.push(`${relative}: missing EPUB chapter ${chapterPath}`);
        continue;
      }
      const text = normalizeImportedText(htmlToText(html, {
        wordwrap: false,
        selectors: [
          { selector: "a", options: { ignoreHref: true } },
          { selector: "img", format: "skip" }
        ]
      }));
      if (!text) {
        warnings.push(`${relative}: empty EPUB chapter ${chapterPath}`);
        continue;
      }
      const chapterTitle = htmlTitle(html) || `Chapter ${index + 1}`;
      const title = `${bookTitle} - ${chapterTitle}`;
      const chunks = chunkWithCitation(
        text,
        `${bookTitle}, ${chapterTitle}`,
        {
          imported_from: relative,
          file_type: "epub",
          chapter_title: chapterTitle,
          chapter_index: index + 1,
          chapter_href: chapterPath,
          book_title: bookTitle
        },
        capsule.manifest.chunking
      );
      documents.push({
        id: slugify(`${relative.replace(/\.[^.]+$/, "")}-${index + 1}-${chapterTitle}`),
        title,
        sourcePath: `${relative}#${chapterPath}`,
        text,
        chunks,
        author: creator,
        metadata: {
          imported_from: relative,
          file_type: "epub",
          chapter_title: chapterTitle,
          chapter_index: index + 1,
          chapter_href: chapterPath,
          book_title: bookTitle
        }
      });
    }

    if (documents.length === 0) {
      return { documents, skipped: { path: relative, reason: "EPUB contained no readable spine chapters" }, warnings };
    }
    return { documents, warnings };
  } catch (error) {
    return {
      documents: [],
      skipped: { path: relative, reason: `EPUB extraction failed: ${error instanceof Error ? error.message : String(error)}` },
      warnings: []
    };
  }
}

async function docxDocument(
  filePath: string,
  relative: string,
  capsule: CorpusCapsule
): Promise<{ document?: GenericDocumentInput; skipped?: ImportSkippedFile; warnings: string[] }> {
  try {
    const result = await mammoth.convertToHtml({ path: filePath });
    const text = normalizeImportedText(htmlToText(result.value, { wordwrap: false }));
    const warnings = result.messages.map((message: { message: string }) => `${relative}: ${message.message}`);
    if (!text) return { skipped: { path: relative, reason: "empty DOCX document" }, warnings };
    const title = path.basename(filePath, ".docx");
    const headings = htmlHeadings(result.value);
    const chunks = chunkWithCitation(
      text,
      path.basename(relative),
      {
        imported_from: relative,
        file_type: "docx",
        headings
      },
      capsule.manifest.chunking
    );
    return {
      document: {
        id: slugify(relative.replace(/\.[^.]+$/, "")),
        title,
        sourcePath: relative,
        text,
        chunks,
        metadata: {
          imported_from: relative,
          file_type: "docx",
          headings
        }
      },
      warnings
    };
  } catch (error) {
    return {
      skipped: { path: relative, reason: `DOCX extraction failed: ${error instanceof Error ? error.message : String(error)}` },
      warnings: []
    };
  }
}

function ensureUniqueDocumentIds(documents: GenericDocumentInput[]): GenericDocumentInput[] {
  const seen = new Map<string, number>();
  return documents.map((document) => {
    const count = seen.get(document.id) ?? 0;
    seen.set(document.id, count + 1);
    if (count === 0) return document;
    return { ...document, id: `${document.id}-${count + 1}` };
  });
}

export async function documentsFromCorpus(capsule: CorpusCapsule, limits: ImportLimits = DEFAULT_IMPORT_LIMITS): Promise<CorpusExtraction> {
  const docsRoot = path.join(capsule.rootPath, "documents");
  if (!fs.existsSync(docsRoot)) {
    return {
      documents: [],
      skipped: [{ path: "documents", reason: "documents folder missing" }],
      warnings: [],
      files_found: 0,
      files_imported: 0
    };
  }

  const documents: GenericDocumentInput[] = [];
  const skipped: ImportSkippedFile[] = [];
  const warnings: string[] = [];
  const walk = walkFolder(docsRoot, limits);
  skipped.push(...walk.skipped);
  if (walk.limitReached) warnings.push(`Import stopped early: the folder has ${walk.limitReached}.`);
  const started = Date.now();
  for (const file of walk.files) {
    const { absolute: filePath, relative } = file;
    if (Date.now() - started > limits.maxProcessingMs) {
      warnings.push(`Import stopped after ${Math.round(limits.maxProcessingMs / 60000)} minutes; remaining files were not processed.`);
      skipped.push({ path: relative, reason: "not processed: time limit reached" });
      continue;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      skipped.push({ path: relative, reason: "unsupported file type" });
      continue;
    }

    if ([".txt", ".md", ".markdown"].includes(ext)) {
      const result = plainDocument(filePath, relative, ext, capsule);
      if ("reason" in result) skipped.push(result);
      else documents.push(result);
      continue;
    }

    if (ext === ".pdf") {
      const result = await pdfDocument(filePath, relative, capsule, limits);
      warnings.push(...result.warnings);
      if (result.document) documents.push(result.document);
      if (result.skipped) skipped.push(result.skipped);
      continue;
    }

    if (ext === ".epub") {
      const result = epubDocuments(filePath, relative, capsule, limits);
      warnings.push(...result.warnings);
      documents.push(...result.documents);
      if (result.skipped) skipped.push(result.skipped);
      continue;
    }

    if (ext === ".docx") {
      const result = await docxDocument(filePath, relative, capsule);
      warnings.push(...result.warnings);
      if (result.document) documents.push(result.document);
      if (result.skipped) skipped.push(result.skipped);
    }
  }

  return {
    documents: ensureUniqueDocumentIds(documents),
    skipped,
    warnings,
    files_found: walk.files.length + walk.skipped.length,
    files_imported: new Set(documents.map((document) => document.sourcePath.split("#")[0])).size
  };
}

export async function reindexUserCorpus(capsule: CorpusCapsule) {
  return withCorpusWriter(capsule.id, "rebuilding the search file", async () => {
    const extraction = await documentsFromCorpus(capsule);
    if (extraction.documents.length === 0) {
      const reasons = extraction.skipped.slice(0, 20).map((item) => `${item.path}: ${item.reason}`).join("; ");
      throw new Error(`No extractable text found for ${capsule.id}; the previous search file was kept.${reasons ? ` ${reasons}` : ""}`);
    }
    const stats = reindexGenericCorpus(capsule, extraction.documents, { coverage: "local-documents" });
    return {
      ok: true,
      corpus_id: capsule.id,
      indexed_documents: extraction.documents.length,
      skipped: extraction.skipped,
      warnings: extraction.warnings,
      files_found: extraction.files_found,
      files_imported: extraction.files_imported,
      ...stats
    };
  });
}

function importLogPath(): string {
  return path.join(logsRoot(), "imports.jsonl");
}

function appendImportLog(report: ImportReport): void {
  appendLogEvent("imports", {
    command: "import_folder_report",
    corpus_id: report.corpus_id,
    ok: report.ok,
    files_found: report.files_found,
    files_imported: report.files_imported,
    files_skipped: report.files_skipped,
    documents: report.documents,
    chunks: report.chunks,
    error: report.error
  });
}

function writeImportReport(report: ImportReport): void {
  const lines = [
    `# Import Report: ${report.title}`,
    "",
    `Generated: ${report.generated_at}`,
    `Status: ${report.ok ? "ok" : "failed"}`,
    `Corpus ID: ${report.corpus_id}`,
    report.source_path ? `Source path: ${report.source_path}` : "",
    `Corpus path: ${report.corpus_path}`,
    "",
    "## Summary",
    "",
    `- Files found: ${report.files_found}`,
    `- Files copied: ${report.files_copied ?? "n/a"}`,
    `- Files imported: ${report.files_imported}`,
    `- Files skipped: ${report.files_skipped}`,
    `- Documents indexed: ${report.documents}`,
    `- Chunks indexed: ${report.chunks}`,
    "",
    "## Skipped Files",
    "",
    ...(report.skipped.length
      ? report.skipped.map((item) => `- ${item.path}: ${item.reason}`)
      : ["- None"]),
    "",
    "## Warnings",
    "",
    ...(report.warnings.length ? report.warnings.map((warning) => `- ${warning}`) : ["- None"]),
    "",
    "## Source And License Notice",
    "",
    report.rights_notice,
    "",
    "## Next Suggested Prompt",
    "",
    `Use get_corpus_guide for \`${report.corpus_id}\`, then ask: "What patterns and surprises appear in this corpus?"`,
    report.error ? "" : "",
    report.error ? "## Error" : "",
    report.error ? "" : "",
    report.error ?? ""
  ].filter((line) => line !== "");
  writeFileAtomic(report.import_report_path, `${lines.join("\n")}\n`);
}

function buildReport(input: {
  ok: boolean;
  corpusId: string;
  title: string;
  sourcePath?: string;
  corpusPath: string;
  reportPath: string;
  filesFound: number;
  filesCopied?: number;
  extraction?: CorpusExtraction;
  stats?: GenericIndexStats;
  skipped?: ImportSkippedFile[];
  warnings?: string[];
  error?: string;
}): ImportReport {
  const skipped = [...(input.skipped ?? []), ...(input.extraction?.skipped ?? [])];
  const warnings = [...(input.warnings ?? []), ...(input.extraction?.warnings ?? [])];
  return {
    ok: input.ok,
    corpus_id: input.corpusId,
    title: input.title,
    source_path: input.sourcePath,
    corpus_path: input.corpusPath,
    generated_at: new Date().toISOString(),
    files_found: input.filesFound,
    files_copied: input.filesCopied,
    files_imported: input.extraction?.files_imported ?? 0,
    files_skipped: skipped.length,
    documents: input.extraction?.documents.length ?? 0,
    chunks: input.stats?.chunks ?? 0,
    skipped,
    warnings,
    rights_notice: "Imported files are copied into your Dialogues folder and stay on this computer. Passages you search and fetch are shared with the AI app you use. You are responsible for confirming copyright, privacy, and source terms.",
    import_report_path: input.reportPath,
    error: input.error
  };
}

function corpusIdTaken(corpusId: string): boolean {
  try {
    return Boolean(getCorpusCapsule(corpusId));
  } catch {
    return false;
  }
}

/**
 * Copy a user-selected folder into a new collection and index it. Work happens
 * in a hidden staging folder; the collection only appears once its index is
 * built, so an interrupted or failed import never looks ready.
 */
export async function importFolder(input: {
  sourcePath: string;
  name?: string;
  corpusId?: string;
  limits?: Partial<ImportLimits>;
}) {
  const started = Date.now();
  const limits: ImportLimits = { ...DEFAULT_IMPORT_LIMITS, ...input.limits };
  assertLocalPathInput(input.sourcePath);

  const source = path.resolve(input.sourcePath);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`Folder not found: ${source}`);
  }
  const realSource = fs.realpathSync.native(source);

  const title = input.name?.trim() || path.basename(source);
  const corpusId = slugify(input.corpusId?.trim() || title);
  if (!isSafeId(corpusId)) throw new Error(`Invalid corpus ID: ${corpusId}`);
  const targetRoot = path.join(userCorporaRoot(), corpusId);
  if (fs.existsSync(targetRoot) || corpusIdTaken(corpusId)) {
    throw new Error(`Corpus already exists: ${corpusId}. Choose a different corpusId.`);
  }
  // Never copy the Dialogues folder into itself.
  const realData = fs.existsSync(dataDir()) ? fs.realpathSync.native(dataDir()) : path.resolve(dataDir());
  if (isInside(realSource, realData) || isInside(realData, realSource)) {
    throw new Error("The folder to import cannot contain, or be inside, the Dialogues data folder. Choose the folder with your own documents.");
  }

  return withCorpusWriter(corpusId, "importing a folder", async () => {
    const walk = walkFolder(source, limits, (relative) =>
      SUPPORTED_EXTENSIONS.has(path.extname(relative).toLowerCase()) ? null : "unsupported file type"
    );
    if (walk.limitReached) {
      throw new Error(`This folder has ${walk.limitReached}. Import a smaller folder, or split it into several collections.`);
    }
    if (walk.files.length === 0) {
      throw new Error("No supported files found. Supported imports: .txt, .md, .markdown, .pdf, .epub, .docx.");
    }

    const stagingRoot = path.join(userCorporaRoot(), `.staging-${corpusId}-${crypto.randomBytes(4).toString("hex")}`);
    const failureReportPath = dataPath("imports", `${corpusId}-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-import-report.md`);
    let indexBuilt = false;
    try {
      const documentsRoot = path.join(stagingRoot, "documents");
      fs.mkdirSync(documentsRoot, { recursive: true });
      for (const file of walk.files) {
        const destination = path.join(documentsRoot, file.relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(file.absolute, destination);
      }

      writeCapsuleFiles(stagingRoot, corpusId, title);
      const capsule = loadCorpusFromPath(stagingRoot, "user");
      const extraction = await documentsFromCorpus(capsule, limits);

      if (extraction.documents.length === 0) {
        const report = buildReport({
          ok: false,
          corpusId,
          title,
          sourcePath: source,
          corpusPath: targetRoot,
          reportPath: failureReportPath,
          filesFound: walk.files.length + walk.skipped.length,
          filesCopied: walk.files.length,
          extraction,
          skipped: walk.skipped,
          error: "No extractable text found. OCR is not supported yet for image-only PDFs."
        });
        writeImportReport(report);
        appendImportLog(report);
        const reasons = report.skipped.slice(0, 20).map((item) => `${item.path}: ${item.reason}`).join("; ");
        throw new Error(`No extractable text found. OCR is not supported yet for image-only PDFs.${reasons ? ` ${reasons}` : ""} Report: ${failureReportPath}`);
      }

      const stats = reindexGenericCorpus(capsule, extraction.documents, { coverage: "local-documents" });
      indexBuilt = true;
      const report = buildReport({
        ok: true,
        corpusId,
        title,
        sourcePath: source,
        corpusPath: targetRoot,
        reportPath: path.join(targetRoot, "import-report.md"),
        filesFound: walk.files.length + walk.skipped.length,
        filesCopied: walk.files.length,
        extraction,
        stats,
        skipped: walk.skipped
      });
      writeImportReport({ ...report, import_report_path: path.join(stagingRoot, "import-report.md") });
      renameWithRetry(stagingRoot, targetRoot);
      invalidateCorpusCache();
      appendImportLog(report);
      appendLogEvent("imports", {
        command: "import_folder",
        corpus_id: corpusId,
        result_count: report.documents,
        index_path: stats.indexPath,
        duration_ms: Date.now() - started,
        files_found: report.files_found,
        files_imported: report.files_imported,
        files_skipped: report.files_skipped
      });
      return {
        ok: true,
        corpus_id: corpusId,
        title,
        source_path: source,
        corpus_path: targetRoot,
        copied_files: walk.files.length,
        skipped_files: report.files_skipped,
        documents: report.documents,
        chunks: report.chunks,
        warnings: report.warnings,
        skipped: report.skipped,
        import_report_path: report.import_report_path,
        import_log_path: importLogPath(),
        rights_notice: report.rights_notice,
        reindex: {
          ok: true,
          corpus_id: corpusId,
          indexed_documents: extraction.documents.length,
          skipped: extraction.skipped,
          warnings: extraction.warnings,
          files_found: extraction.files_found,
          files_imported: extraction.files_imported,
          ...stats
        }
      };
    } catch (error) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      if (indexBuilt && !fs.existsSync(targetRoot)) {
        fs.rmSync(path.dirname(indexPathFor(corpusId)), { recursive: true, force: true });
      }
      invalidateCorpusCache();
      appendLogEvent("errors", {
        command: "import_folder",
        corpus_id: corpusId,
        error: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - started
      });
      throw error;
    }
  });
}
