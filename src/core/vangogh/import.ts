import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import YAML from "yaml";
import { XMLParser } from "fast-xml-parser";
import { convert as htmlToText } from "html-to-text";
import { getCorpusCapsule } from "../corpus/loader.js";
import type { CorpusCapsule } from "../corpus/types.js";
import { builtInCorporaRoot, dataDir, isInside, logsRoot, sourceCacheRootFor } from "../paths.js";
import { reindexGenericCorpus, type GenericChunkInput, type GenericDocumentInput } from "../db/genericIndex.js";
import { chunkText, normalizeImportedText } from "../import/chunk.js";
import { appendLogEvent } from "../logs/events.js";
import { DEFAULT_IMPORT_LIMITS, assertLocalPathInput, isSafeArchiveEntryName, walkFolder } from "../import/safeWalk.js";
import { withCorpusWriter } from "../state/corpusLock.js";
import { writeFileAtomic, writeJsonAtomic } from "../state/files.js";

import { VANGOGH_CORPUS_ID } from "./ids.js";

export { VANGOGH_CORPUS_ID };
export const VANGOGH_DOWNLOAD_URL = "https://vangoghletters.org/vg/vangoghxml.zip";
export const VANGOGH_LICENSE = "CC BY-NC-SA 4.0";

export const VANGOGH_RIGHTS_NOTICE = [
  "No Van Gogh letter data is bundled with Dialogues.",
  "The official XML source files are available under CC BY-NC-SA 4.0, which includes non-commercial and share-alike terms.",
  "Download or import files only after reviewing the source terms, and confirm the terms before sharing outputs.",
  "Downloaded or imported files are stored in your Dialogues data folder under source-cache/vangogh-letters/."
].join(" ");

const SUPPORTED_EXTENSIONS = new Set([".xml", ".html", ".htm", ".txt", ".md", ".markdown", ".json"]);

type LetterMetadata = {
  id?: string;
  title?: string;
  author?: string;
  recipient?: string;
  date?: string;
  place?: string;
  language?: string;
  sourceUrl?: string;
};

type ParsedLetter = LetterMetadata & {
  sourcePath: string;
  text: string;
  fileType: string;
};

type ImportSkippedFile = {
  path: string;
  reason: string;
};

export type VanGoghImportOptions = {
  from: string;
  yes?: boolean;
  force?: boolean;
};

function corpusRoot(): string {
  return path.join(builtInCorporaRoot(), VANGOGH_CORPUS_ID);
}

function dataRoot(): string {
  return sourceCacheRootFor(VANGOGH_CORPUS_ID);
}

/** Letters the user imported from their own folder (not the official download). */
export function vanGoghLocalSourceRoot(): string {
  return path.join(dataRoot(), "local-source");
}

function reportPath(): string {
  return path.join(dataRoot(), "import-report.md");
}

function manifestPath(): string {
  return path.join(dataRoot(), "import-manifest.json");
}

function logPath(): string {
  return path.join(logsRoot(), "vangogh-imports.jsonl");
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "vangogh-letter";
}

function copySupportedFiles(source: string, target: string): { copied: number; skipped: ImportSkippedFile[] } {
  const walk = walkFolder(source, DEFAULT_IMPORT_LIMITS, (relative) =>
    SUPPORTED_EXTENSIONS.has(path.extname(relative).toLowerCase()) ? null : "unsupported file type"
  );
  if (walk.limitReached) throw new Error(`This folder has ${walk.limitReached}. Import a smaller folder.`);
  for (const file of walk.files) {
    const destination = path.join(target, file.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file.absolute, destination);
  }
  return { copied: walk.files.length, skipped: walk.skipped };
}

function isVanGoghArchiveLetter(entryName: string): boolean {
  const base = path.basename(entryName.replace(/\\/g, "/"));
  return /^(?:let[0-9a-z]+|RM\d+)\.xml$/i.test(base);
}

const MAX_ARCHIVE_ENTRIES = 5000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

/**
 * Parse the official XML archive in memory. Entry names are only matched,
 * never used as paths, and the archive is bounded by entry count and size.
 */
export function vanGoghDocumentsFromZip(zipBuffer: Buffer, capsule: CorpusCapsule): { documents: GenericDocumentInput[]; skipped: ImportSkippedFile[] } {
  const archive = new AdmZip(zipBuffer);
  const entries = archive.getEntries();
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error(`Van Gogh archive has more than ${MAX_ARCHIVE_ENTRIES} entries.`);
  const declared = entries.reduce((sum, entry) => sum + Number(entry.header.size ?? 0), 0);
  if (declared > MAX_ARCHIVE_BYTES) throw new Error("Van Gogh archive expands beyond the size limit.");
  const skipped: ImportSkippedFile[] = [];
  const letters: ParsedLetter[] = [];
  for (const entry of entries.sort((a, b) => a.entryName.localeCompare(b.entryName))) {
    const relative = entry.entryName.replace(/\\/g, "/");
    if (entry.isDirectory) continue;
    if (!isSafeArchiveEntryName(relative) || !isVanGoghArchiveLetter(relative)) {
      skipped.push({ path: relative, reason: "not a Van Gogh letter XML file" });
      continue;
    }
    const parsed = parseXmlText(entry.getData().toString("utf8").replace(/^\uFEFF/, ""), path.basename(relative));
    if (parsed) letters.push(parsed);
    else skipped.push({ path: relative, reason: "no extractable letter text" });
  }
  const usedIds = new Set<string>();
  return { documents: letters.map((letter) => toDocument(letter, capsule, usedIds)), skipped };
}

function countSupportedFiles(source: string): { supported: number; skipped: ImportSkippedFile[] } {
  const walk = walkFolder(source, DEFAULT_IMPORT_LIMITS, (relative) =>
    SUPPORTED_EXTENSIONS.has(path.extname(relative).toLowerCase()) ? null : "unsupported file type"
  );
  return { supported: walk.files.length, skipped: walk.skipped };
}

function firstMatch(input: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = input.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return htmlToText(value, { wordwrap: false }).trim();
  }
  return undefined;
}

function parseFrontmatter(raw: string): { metadata: LetterMetadata; body: string } {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!match) return { metadata: {}, body: raw };
  const parsed = YAML.parse(match[1]) as Record<string, unknown> | null;
  const metadata = metadataFromObject(parsed ?? {});
  return { metadata, body: raw.slice(match[0].length) };
}

function metadataFromObject(raw: Record<string, unknown>): LetterMetadata {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === "string" || typeof value === "number") {
        const text = String(value).trim();
        if (text) return text;
      }
    }
    return undefined;
  };
  return {
    id: pick("id", "letter_id", "letterId", "number", "doc_id"),
    title: pick("title", "heading", "subject"),
    author: pick("author", "sender", "from"),
    recipient: pick("recipient", "to", "addressee"),
    date: normalizeDate(pick("date", "when", "sent")),
    place: pick("place", "location", "from_place", "origin"),
    language: pick("language", "lang", "xml:lang"),
    sourceUrl: pick("source_url", "sourceUrl", "url")
  };
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const iso = value.match(/\d{4}(?:-\d{2})?(?:-\d{2})?/)?.[0];
  return iso ?? value;
}

function xmlParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    textNodeName: "#text",
    removeNSPrefix: true
  });
}

function collectText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join("\n\n");
  if (value && typeof value === "object") {
    const node = value as Record<string, unknown>;
    return Object.entries(node)
      .filter(([key]) => !key.startsWith("@") && !["id", "when", "lang", "type", "ref"].includes(key))
      .map(([, child]) => collectText(child))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

function findFirstNode(value: unknown, names: string[]): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstNode(item, names);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const node = value as Record<string, unknown>;
  for (const name of names) {
    if (node[name] !== undefined) return node[name];
  }
  for (const child of Object.values(node)) {
    const found = findFirstNode(child, names);
    if (found !== undefined) return found;
  }
  return undefined;
}

function textFromNode(value: unknown): string | undefined {
  const text = normalizeImportedText(collectText(value));
  return text || undefined;
}

function extractTypedXmlDiv(raw: string, type: "original" | "translation"): string | undefined {
  const startMatch = new RegExp(`<div\\b[^>]*\\btype=["']${type}["'][^>]*>`, "i").exec(raw);
  if (!startMatch) return undefined;
  const tail = raw.slice(startMatch.index + startMatch[0].length);
  const stopPattern = type === "translation"
    ? /<div\b[^>]*\btype=["']notes["'][^>]*>/i
    : /<div\b[^>]*\btype=["'](?:translation|textualNotes|notes)["'][^>]*>/i;
  const stopMatch = stopPattern.exec(tail);
  return tail.slice(0, stopMatch?.index ?? undefined);
}

function xmlFragmentToText(fragment: string): string | undefined {
  const cleaned = fragment
    .replace(/<note\b[\s\S]*?<\/note>/gi, " ")
    .replace(/<\/?(?:[A-Za-z0-9_-]+:)?(?:pb|lb|anchor|figure|graphic|ptr|whiteline)\b[^>]*\/?>/gi, " ")
    .replace(/<(?:[A-Za-z0-9_-]+:)?c\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?c>/gi, " ")
    .replace(/<\/(?:ab|p|div)>/gi, "$&\n\n");
  const text = normalizeImportedText(htmlToText(`<div>${cleaned}</div>`, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "note", format: "skip" }
    ]
  }));
  return text || undefined;
}

function textFromXmlRaw(raw: string): string | undefined {
  const translation = extractTypedXmlDiv(raw, "translation");
  if (translation) return xmlFragmentToText(translation);
  const original = extractTypedXmlDiv(raw, "original");
  if (original) return xmlFragmentToText(original);
  return undefined;
}

function parseXml(filePath: string, relative: string): ParsedLetter | undefined {
  return parseXmlText(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""), relative);
}

function parseXmlText(raw: string, relative: string): ParsedLetter | undefined {
  const parsed = xmlParser().parse(raw) as Record<string, unknown>;
  const textNode = findFirstNode(parsed, ["text", "body", "div"]);
  const text = textFromXmlRaw(raw) ?? textFromNode(textNode) ?? normalizeImportedText(htmlToText(raw, { wordwrap: false }));
  if (!text) return undefined;
  const metadata: LetterMetadata = {
    id: firstMatch(raw, [
      /<idno[^>]*(?:type|subtype)="jlb"[^>]*>([\s\S]*?)<\/idno>/i,
      /\b(?:xml:id|id)="([^"]+)"/i,
      /<idno[^>]*>([\s\S]*?)<\/idno>/i
    ]),
    title: firstMatch(raw, [/<title[^>]*>([\s\S]*?)<\/title>/i, /<head[^>]*>([\s\S]*?)<\/head>/i]),
    author: firstMatch(raw, [/<author[^>]*>([\s\S]*?)<\/author>/i, /<sender[^>]*>([\s\S]*?)<\/sender>/i]),
    recipient: firstMatch(raw, [
      /<(?:[^:>]+:)?addressee[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?addressee>/i,
      /<(?:recipient|addressee|persName)[^>]*(?:type|role)="(?:recipient|addressee)"[^>]*>([\s\S]*?)<\/(?:recipient|addressee|persName)>/i,
      /<(?:recipient|addressee)[^>]*>([\s\S]*?)<\/(?:recipient|addressee)>/i,
      /<to[^>]*>([\s\S]*?)<\/to>/i
    ]),
    date: normalizeDate(firstMatch(raw, [
      /<(?:[^:>]+:)?dateLet[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?dateLet>/i,
      /<date[^>]*when="([^"]+)"/i,
      /<date[^>]*>([\s\S]*?)<\/date>/i
    ])),
    place: firstMatch(raw, [
      /<(?:[^:>]+:)?placeLet[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?placeLet>/i,
      /<placeName[^>]*>([\s\S]*?)<\/placeName>/i,
      /<place[^>]*>([\s\S]*?)<\/place>/i
    ]),
    language: firstMatch(raw, [/\b(?:xml:lang|lang)="([^"]+)"/i]),
    sourceUrl: firstMatch(raw, [
      /<ptr[^>]+target="([^"]*vangoghletters\.org\/[^"]+)"/i,
      /<idno[^>]*(?:type|subtype)="url"[^>]*>([\s\S]*?)<\/idno>/i
    ])
  };
  return { ...metadata, sourcePath: relative, text, fileType: "xml" };
}

function parseHtml(filePath: string, relative: string): ParsedLetter | undefined {
  const raw = fs.readFileSync(filePath, "utf8");
  const text = normalizeImportedText(htmlToText(raw, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" }
    ]
  }));
  if (!text) return undefined;
  const meta = (name: string) => firstMatch(raw, [
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`, "i")
  ]);
  return {
    id: meta("letter:id") ?? meta("id"),
    title: firstMatch(raw, [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]),
    author: meta("author") ?? meta("sender"),
    recipient: meta("recipient") ?? meta("addressee"),
    date: normalizeDate(meta("date")),
    place: meta("place") ?? meta("location"),
    language: meta("language") ?? firstMatch(raw, [/<html[^>]+lang=["']([^"']+)["']/i]),
    sourceUrl: meta("source_url") ?? meta("url"),
    sourcePath: relative,
    text,
    fileType: "html"
  };
}

function parseTextLike(filePath: string, relative: string, fileType: string): ParsedLetter | undefined {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const { metadata, body } = parseFrontmatter(raw);
  const text = normalizeImportedText(body);
  if (!text) return undefined;
  return { ...metadata, sourcePath: relative, text, fileType };
}

function parseJson(filePath: string, relative: string): ParsedLetter[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as unknown;
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { letters?: unknown[] }).letters)
      ? (raw as { letters: unknown[] }).letters
      : [raw];
  return items.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const metadata = metadataFromObject(record);
    const textValue = record.text ?? record.body ?? record.content ?? record.letter;
    const text = normalizeImportedText(typeof textValue === "string" ? textValue : collectText(textValue));
    if (!text) return [];
    return [{
      ...metadata,
      id: metadata.id ?? `${relative}-${index + 1}`,
      sourcePath: `${relative}#${metadata.id ?? index + 1}`,
      text,
      fileType: "json"
    }];
  });
}

function parseFile(filePath: string, relative: string): ParsedLetter[] {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".xml") return [parseXml(filePath, relative)].filter((item): item is ParsedLetter => Boolean(item));
    if (ext === ".html" || ext === ".htm") return [parseHtml(filePath, relative)].filter((item): item is ParsedLetter => Boolean(item));
    if (ext === ".txt") return [parseTextLike(filePath, relative, "txt")].filter((item): item is ParsedLetter => Boolean(item));
    if (ext === ".md" || ext === ".markdown") return [parseTextLike(filePath, relative, "markdown")].filter((item): item is ParsedLetter => Boolean(item));
    if (ext === ".json") return parseJson(filePath, relative);
  } catch {
    return [];
  }
  return [];
}

function lettersFromLocalSource(target: string): { letters: ParsedLetter[]; skipped: ImportSkippedFile[]; supportedFiles: number } {
  const letters: ParsedLetter[] = [];
  const walk = walkFolder(target, DEFAULT_IMPORT_LIMITS);
  const skipped: ImportSkippedFile[] = [...walk.skipped];
  let supportedFiles = 0;
  for (const { absolute: file, relative } of walk.files) {
    const ext = path.extname(file).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      skipped.push({ path: relative, reason: "unsupported file type" });
      continue;
    }
    supportedFiles += 1;
    const parsed = parseFile(file, relative);
    if (parsed.length) letters.push(...parsed);
    else skipped.push({ path: relative, reason: "no extractable letter text or metadata parse failed" });
  }
  return { letters, skipped, supportedFiles };
}

function periodFromMetadata(letter: ParsedLetter): string | undefined {
  const haystack = `${letter.place ?? ""} ${letter.title ?? ""} ${letter.text.slice(0, 300)}`.toLowerCase();
  if (haystack.includes("arles")) return "Arles";
  if (haystack.includes("saint-remy") || haystack.includes("saint-rémy")) return "Saint-Remy";
  if (haystack.includes("auvers")) return "Auvers";
  if (haystack.includes("hague") || haystack.includes("etten") || haystack.includes("london")) return "early";
  return undefined;
}

function citationBase(letter: ParsedLetter, id: string): string {
  const title = letter.title?.trim() || id;
  const details = [
    letter.date,
    letter.recipient ? `to ${letter.recipient}` : undefined,
    letter.place
  ].filter(Boolean);
  return details.length ? `${title}, ${details.join(", ")}` : title;
}

function chunksForLetter(letter: ParsedLetter, id: string, capsule: CorpusCapsule): GenericChunkInput[] {
  const base = citationBase(letter, id);
  return chunkText(letter.text, capsule.manifest.chunking).map((chunk) => ({
    chunkIndex: chunk.chunk_index,
    text: chunk.text_raw,
    citation: `${base}, chunk ${chunk.chunk_index}`,
    metadata: {
      source_chunk_index: chunk.chunk_index,
      recipient: letter.recipient ?? null,
      date: letter.date ?? null,
      place: letter.place ?? null,
      period: periodFromMetadata(letter) ?? null,
      file_type: letter.fileType
    }
  }));
}

function toDocument(letter: ParsedLetter, capsule: CorpusCapsule, usedIds: Set<string>): GenericDocumentInput {
  const baseId = slugify(letter.id ?? letter.title ?? letter.sourcePath.replace(/\.[^.]+$/, ""));
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  const period = periodFromMetadata(letter);
  return {
    id,
    title: letter.title ?? id,
    sourcePath: letter.sourcePath,
    sourceUrl: letter.sourceUrl ?? null,
    author: letter.author ?? "Vincent van Gogh",
    date: letter.date ?? null,
    language: letter.language ?? null,
    text: letter.text,
    chunks: chunksForLetter(letter, id, capsule),
    metadata: {
      letter_id: letter.id ?? id,
      recipient: letter.recipient ?? null,
      date: letter.date ?? null,
      place: letter.place ?? null,
      period: period ?? null,
      file_type: letter.fileType,
      imported_from: letter.sourcePath,
      source_url: letter.sourceUrl ?? null,
      rights_notice: VANGOGH_RIGHTS_NOTICE
    }
  };
}

function appendJsonl(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function writeReport(input: {
  source: string;
  copied: number;
  skipped: ImportSkippedFile[];
  documents: GenericDocumentInput[];
  chunks: number;
  action: "download" | "import" | "reindex";
}): void {
  fs.mkdirSync(dataRoot(), { recursive: true });
  const lines = [
    "# Van Gogh Source Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Action: ${input.action}`,
    `Source: ${input.source}`,
    "",
    "## Summary",
    "",
    `- Files copied: ${input.copied}`,
    `- Documents indexed: ${input.documents.length}`,
    `- Chunks indexed: ${input.chunks}`,
    `- Files skipped: ${input.skipped.length}`,
    "",
    "## Skipped Files",
    "",
    ...(input.skipped.length ? input.skipped.map((item) => `- ${item.path}: ${item.reason}`) : ["- None"]),
    "",
    "## Rights Notice",
    "",
    VANGOGH_RIGHTS_NOTICE,
    "",
    "## Next Suggested Prompt",
    "",
    "Read the Van Gogh corpus guide, then ask: \"How do work, money, and color concerns interact in these imported letters?\""
  ];
  writeFileAtomic(reportPath(), `${lines.join("\n")}\n`);
}

function buildManifest(source: string, documents: GenericDocumentInput[]) {
  return {
    corpus_id: VANGOGH_CORPUS_ID,
    imported_at: new Date().toISOString(),
    source,
    rights_notice: VANGOGH_RIGHTS_NOTICE,
    documents: documents.map((document) => ({
      id: document.id,
      title: document.title,
      date: document.date,
      recipient: document.metadata?.recipient,
      place: document.metadata?.place,
      language: document.language,
      source_path: document.sourcePath
    }))
  };
}

function indexLocalSource(input: {
  target: string;
  source: string;
  copied: number;
  skipped: ImportSkippedFile[];
  action: "import" | "reindex";
}) {
  const started = Date.now();
  const capsule = getCorpusCapsule(VANGOGH_CORPUS_ID);
  let parsed: { letters: ParsedLetter[]; skipped: ImportSkippedFile[]; supportedFiles: number };
  let skipped: ImportSkippedFile[] = [];
  try {
    parsed = lettersFromLocalSource(input.target);
    skipped = [...input.skipped, ...parsed.skipped];
    if (parsed.supportedFiles === 0) {
      throw new Error("No supported Van Gogh files found. Supported formats: .xml, .html, .txt, .md, .markdown, .json.");
    }
    if (parsed.letters.length === 0) {
      throw new Error("No extractable Van Gogh letter text found in supported files.");
    }
  } catch (error) {
    appendLogEvent("errors", {
      command: input.action === "import" ? "corpus import vangogh-letters" : "reindex",
      corpus_id: VANGOGH_CORPUS_ID,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - started
    });
    throw error;
  }

  const usedIds = new Set<string>();
  const documents = parsed.letters.map((letter) => toDocument(letter, capsule, usedIds));
  const stats = reindexGenericCorpus(capsule, documents, { coverage: "local-import", selection: { kind: "local-import" } });
  const manifest = buildManifest(input.source, documents);
  writeJsonAtomic(manifestPath(), manifest);
  writeReport({
    source: input.source,
    copied: input.copied,
    skipped,
    documents,
    chunks: stats.chunks,
    action: input.action
  });
  appendJsonl(logPath(), {
    at: manifest.imported_at,
    corpus_id: VANGOGH_CORPUS_ID,
    action: input.action,
    documents: documents.length,
    chunks: stats.chunks,
    confirmed_rights: true
  });
  appendLogEvent("imports", {
    command: input.action === "import" ? "corpus import vangogh-letters" : "reindex",
    corpus_id: VANGOGH_CORPUS_ID,
    result_count: documents.length,
    index_path: stats.indexPath,
    duration_ms: Date.now() - started,
    files_imported: input.copied,
    files_skipped: skipped.length
  });

  return {
    ok: true,
    corpus_id: VANGOGH_CORPUS_ID,
    source_path: input.source,
    copied_files: input.copied,
    skipped_files: skipped.length,
    skipped,
    documents: documents.length,
    chunks: stats.chunks,
    indexPath: stats.indexPath,
    import_manifest_path: manifestPath(),
    import_report_path: reportPath(),
    import_log_path: logPath(),
    rights_notice: VANGOGH_RIGHTS_NOTICE,
    next_step: "Call get_corpus_guide for vangogh-letters, then search and fetch passages with recipient/date context."
  };
}

export function listVanGoghDownloadSources() {
  return [{
    id: "vangoghxml",
    archive_url: "https://vangoghletters.org",
    text_url: VANGOGH_DOWNLOAD_URL,
    license: VANGOGH_LICENSE,
    note: "Official XML source files for Vincent van Gogh - The Letters."
  }];
}

/** Import letters from the user's own local folder (no download). */
export async function importVanGoghLetters(options: VanGoghImportOptions) {
  assertLocalPathInput(options.from);
  const source = path.resolve(options.from);
  if (!options.yes) {
    throw new Error("Rights confirmation required. Re-run with --yes after reviewing the Van Gogh local import rights notice.");
  }
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`Van Gogh import folder not found: ${source}`);
  }
  if (isInside(dataDir(), source) || isInside(source, dataDir())) {
    throw new Error("The Van Gogh import folder cannot contain, or be inside, the Dialogues data folder. Use corpus reindex vangogh-letters for already-imported local data.");
  }
  return withCorpusWriter(VANGOGH_CORPUS_ID, "importing Van Gogh letters", () => {
    const target = vanGoghLocalSourceRoot();
    if (fs.existsSync(target)) {
      if (!options.force) {
        throw new Error("Van Gogh local source data already exists. Re-run with --force to replace it.");
      }
    }
    // Copy into a staging folder first; replace the old copy only on success.
    const staging = `${target}.staging-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    try {
      const copied = copySupportedFiles(source, staging);
      const previous = `${target}.previous-${process.pid}`;
      if (fs.existsSync(target)) fs.renameSync(target, previous);
      fs.renameSync(staging, target);
      try {
        const result = indexLocalSource({ target, source, copied: copied.copied, skipped: copied.skipped, action: "import" });
        fs.rmSync(previous, { recursive: true, force: true });
        return result;
      } catch (error) {
        fs.rmSync(target, { recursive: true, force: true });
        if (fs.existsSync(previous)) fs.renameSync(previous, target);
        throw error;
      }
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });
}

export function hasVanGoghLocalImport(): boolean {
  const target = vanGoghLocalSourceRoot();
  return fs.existsSync(target) && fs.statSync(target).isDirectory();
}

/** Rebuild the index from letters imported from a local folder. */
export async function reindexVanGoghLocalImport() {
  const target = vanGoghLocalSourceRoot();
  if (!hasVanGoghLocalImport()) {
    throw new Error("No local Van Gogh source data found. Download the official XML with: dialogues corpus download vangogh-letters --yes. Or import your own files with: dialogues corpus import vangogh-letters --from <folder> --yes");
  }
  const counted = countSupportedFiles(target);
  return indexLocalSource({
    target,
    source: target,
    copied: counted.supported,
    skipped: counted.skipped,
    action: "reindex"
  });
}

export function localVanGoghImportStatus() {
  return {
    corpus_id: VANGOGH_CORPUS_ID,
    data_path: dataRoot(),
    source_path: vanGoghLocalSourceRoot(),
    capsule_path: corpusRoot(),
    imported: fs.existsSync(manifestPath()),
    import_manifest_path: manifestPath(),
    import_report_path: reportPath(),
    rights_notice: VANGOGH_RIGHTS_NOTICE
  };
}
