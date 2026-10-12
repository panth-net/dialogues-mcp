import fs from "node:fs";
import path from "node:path";
import { convert as htmlToText } from "html-to-text";
import { XMLParser } from "fast-xml-parser";
import { normalizeImportedText } from "../import/chunk.js";
import { extractPdfText } from "../import/pdf.js";
import { writeFileAtomic } from "../state/files.js";
import { cachedFetch, cachedFetchText } from "./http.js";
import type { GenericDocumentInput } from "../db/genericIndex.js";
import { assertDownloadAllowedByRights, canDownloadText, rightsLevelForItem } from "./rights.js";
import { vanGoghDocumentsFromZip } from "../vangogh/import.js";
import {
  SUPPORTED_SOURCE_TYPES,
  type FetchOptions,
  type FetchedSourceDocument,
  type SourceAdapter,
  type SourceItem,
  type SourceType
} from "./types.js";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140) || "source-item";
}

function safeFileName(item: SourceItem, ext: string): string {
  return `${slugify(item.id)}${ext}`;
}

function sourceUrl(item: SourceItem): string | undefined {
  return item.api_url ?? item.url;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text || undefined;
  }
  if (Array.isArray(value)) {
    return value.map(stringValue).filter(Boolean).join("; ") || undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["title", "name", "label", "id", "url"]) {
      const child = record[key];
      if (typeof child === "string" || typeof child === "number") {
        const text = String(child).trim();
        if (text) return text;
      }
    }
  }
  return undefined;
}

function metadataString(metadata: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(metadata[key]);
    if (value) return value;
  }
  return undefined;
}

function locItemIdentifier(item: SourceItem, loc: Record<string, unknown>, root: Record<string, unknown>): string {
  const explicit = stringValue(item.metadata?.loc_item_id);
  if (explicit) return explicit;
  for (const value of [loc.item_id, loc.id, root.id, item.url, item.api_url, item.id]) {
    const text = stringValue(value);
    const match = text?.match(/\bmal\d+\b/i);
    if (match) return match[0];
  }
  return item.id;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstRecord(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    const record = recordValue(value);
    if (record) return record;
  }
  return {};
}

function locJsonUrl(item: SourceItem): string | undefined {
  const url = sourceUrl(item);
  if (!url) return undefined;
  if (!/loc\.gov/i.test(url)) return url;
  if (/[?&](fo=json|format=json)/i.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}fo=json`;
}

function writeTextFile(filePath: string, text: string): void {
  writeFileAtomic(filePath, text);
}

function httpOptions(options: FetchOptions) {
  return { ...options.http, force: options.force };
}

function rawText(options: FetchOptions, rawPath: string, url: string): Promise<string> {
  return cachedFetchText(rawPath, url, httpOptions(options));
}

function blockedFetchResult(item: SourceItem): FetchedSourceDocument | null {
  if (canDownloadText(item)) return null;
  return {
    item,
    status: item.source_type === "catalog_only" || rightsLevelForItem(item) === "catalog_only"
      ? "catalog_only"
      : item.source_type === "user_supplied_only" || rightsLevelForItem(item) === "user_supplied_only"
        ? "user_supplied_only"
        : "rights_blocked",
    metadata: { rights_level: rightsLevelForItem(item), source_url: item.url ?? item.api_url ?? null },
    warnings: [`${rightsLevelForItem(item)} item ${item.id} does not download source text`]
  };
}

function collectStrings(value: unknown, keyHint = ""): Array<{ key: string; value: string }> {
  if (typeof value === "string") return [{ key: keyHint, value }];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, keyHint));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => collectStrings(child, key));
}

function firstJsonString(value: unknown, keyPattern: RegExp): string | undefined {
  return collectStrings(value)
    .find(({ key, value: text }) => keyPattern.test(key) && text.trim())?.value.trim();
}

function jsonStrings(value: unknown, keyPattern: RegExp): string[] {
  return collectStrings(value)
    .filter(({ key, value: text }) => keyPattern.test(key) && text.trim())
    .map(({ value: text }) => text.trim());
}

function stripHtml(raw: string): string {
  return normalizeImportedText(htmlToText(raw, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: false } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" }
    ]
  }));
}

function stripProjectGutenbergWrapper(raw: string): string {
  if (!/project gutenberg/i.test(raw)) return raw;
  let text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const start = text.match(/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[\s\S]*?\*\*\*/i);
  if (start?.index !== undefined) {
    text = text.slice(start.index + start[0].length);
  }
  const end = text.search(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i);
  if (end >= 0) text = text.slice(0, end);
  return text;
}

function xmlText(raw: string): string {
  const stripped = stripHtml(raw
    .replace(/<\?xml\b[\s\S]*?\?>/gi, " ")
    .replace(/<teiheader\b[\s\S]*?<\/teiheader>/gi, " ")
    .replace(/<note\b[\s\S]*?<\/note>/gi, " ")
    .replace(/<printpgno\b[\s\S]*?<\/printpgno>/gi, " ")
    .replace(/<anchor\b[\s\S]*?<\/anchor>/gi, " ")
    .replace(/<\/(?:p|ab|div|head|l|item)>/gi, "\n\n")
    .replace(/<(?:lb|br)\b[^>]*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " "));
  if (stripped) return stripped;
  try {
    const parser = new XMLParser({
      ignoreAttributes: true,
      textNodeName: "#text",
      removeNSPrefix: true,
      trimValues: true
    });
    const parsed = parser.parse(raw) as unknown;
    const chunks: string[] = [];
    const walk = (value: unknown, key = ""): void => {
      if (/^(note|teiHeader)$/i.test(key)) return;
      if (typeof value === "string" || typeof value === "number") {
        const text = String(value).trim();
        if (text) chunks.push(text);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((child) => walk(child, key));
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, childKey);
      }
      if (/^(p|ab|div|head|l|lb|br)$/i.test(key)) chunks.push("\n");
    };
    walk(parsed);
    const text = normalizeImportedText(chunks.join(" "));
    if (text) return text;
  } catch {
    // Some public archive XML/TEI pages are fragments. Falling back to tag stripping is intentional.
  }
  return stripHtml(raw
    .replace(/<note\b[\s\S]*?<\/note>/gi, " ")
    .replace(/<\/(?:p|ab|div|head|l)>/gi, "$&\n\n"));
}

function applyTextCleanup(item: SourceItem, text: string): string {
  if (item.metadata?.text_cleanup === "collapse_blank_lines") {
    return normalizeImportedText(text).replace(/\n{4,}/g, "\n\n").trim();
  }
  return text;
}

function htmlFragment(raw: string, pattern: RegExp): string | undefined {
  return raw.match(pattern)?.[1];
}

async function pdfText(buffer: Buffer): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
  const pdf = await extractPdfText(buffer);
  return {
    text: normalizeImportedText(pdf.pages.map((page) => `[Page ${page.pageNumber}]\n${page.text}`).join("\n\n")),
    metadata: {
      pdf_title: pdf.title ?? undefined,
      pdf_author: pdf.author ?? undefined,
      pages: pdf.numPages
    },
    warnings: pdf.warnings.map((warning) => `PDF ${warning}`)
  };
}

function textFromJsonValue(value: unknown): string | undefined {
  const strings = collectStrings(value);
  const direct = strings
    .filter(({ key, value: text }) => /(full.?text|transcri(?:pt|ption)?|ocr|body|content|text)$/i.test(key) && text.length > 80)
    .sort((a, b) => b.value.length - a.value.length)[0]?.value;
  if (direct) return normalizeImportedText(direct);
  const loose = strings
    .filter(({ value: text }) => /\s/.test(text) && text.length > 500 && !/^https?:\/\//i.test(text))
    .sort((a, b) => b.value.length - a.value.length)[0]?.value;
  return loose ? normalizeImportedText(loose) : undefined;
}

function textUrlFromJson(value: unknown): string | undefined {
  const strings = collectStrings(value);
  return strings.find(({ value: text }) => /^https?:\/\/.+\.(?:txt|text)(?:\?|$)/i.test(text))?.value;
}

function textResourceKind(url: string): "json" | "xml" | "text" {
  if (/text-services\/word-coordinates-service/i.test(url)) return "json";
  return /\.xml(?:\?|$)/i.test(url) ? "xml" : "text";
}

async function fetchTextResource(item: SourceItem, url: string, options: FetchOptions): Promise<string> {
  const kind = textResourceKind(url);
  const ext = kind === "json" ? ".fulltext.json" : kind === "xml" ? ".fulltext.xml" : ".fulltext.txt";
  const rawPath = path.join(options.rawRoot, safeFileName(item, ext));
  const raw = await rawText(options, rawPath, url);
  if (kind === "json") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return textFromJsonValue(parsed) ?? "";
    } catch {
      return normalizeImportedText(raw);
    }
  }
  return kind === "xml" ? xmlText(raw) : normalizeImportedText(raw);
}

function jsonUrlFromKeys(value: unknown, keyPattern: RegExp, urlPattern: RegExp): string | undefined {
  return collectStrings(value)
    .find(({ key, value: text }) => keyPattern.test(key) && /^https?:\/\//i.test(text) && urlPattern.test(text))?.value;
}

function metadataFromJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const item = record.item && typeof record.item === "object" && !Array.isArray(record.item)
    ? record.item as Record<string, unknown>
    : record;
  return {
    title: item.title ?? record.title,
    date: item.date ?? record.date,
    contributor: item.contributor_names ?? item.contributor ?? item.contributors,
    subject: item.subject ?? record.subject,
    source_collection: item.partof ?? record.partof,
    raw_metadata: record
  };
}

function rootItem(value: unknown): { root: Record<string, unknown>; item: Record<string, unknown> } {
  const root = recordValue(value) ?? {};
  return {
    root,
    item: firstRecord(root.item, root.record, root.data, root)
  };
}

function baseDocument(item: SourceItem, fetched: FetchedSourceDocument, text: string): GenericDocumentInput {
  const title = item.title ?? metadataString(fetched.metadata, "title", "english_title", "chinese_title") ?? item.id;
  const author = item.author ?? metadataString(fetched.metadata, "author", "sender", "creator", "contributor") ?? null;
  const date = item.date ?? metadataString(fetched.metadata, "date", "created", "date_created") ?? null;
  const documentType = item.document_type ?? metadataString(fetched.metadata, "document_type", "type") ?? null;
  const sourceCollection = metadataString(fetched.metadata, "source_collection", "collection", "series") ?? null;
  return {
    id: slugify(item.id),
    title,
    sourcePath: fetched.textPath ?? fetched.rawPath ?? item.url ?? item.api_url ?? item.id,
    sourceUrl: item.url ?? item.api_url ?? null,
    author,
    date,
    text,
    documentType,
    sourceCollection,
    sourceItemId: item.id,
    rightsLevel: rightsLevelForItem(item),
    selectionPaths: item.paths ?? [],
    curatorScore: item.curator_score ?? null,
    metadata: {
      ...item.metadata,
      source_item_id: item.id,
      source_type: item.source_type,
      source_url: item.url ?? null,
      api_url: item.api_url ?? null,
      rights_level: rightsLevelForItem(item),
      document_type: item.document_type ?? null,
      paths: item.paths ?? [],
      signals: item.signals ?? [],
      curator_score: item.curator_score ?? null,
      why_keep: item.why_keep ?? null,
      fetched_metadata: fetched.metadata
    }
  };
}

function normalizeFetchedText(fetched: FetchedSourceDocument): GenericDocumentInput[] {
  if (fetched.documents) return fetched.documents;
  if (!fetched.text?.trim()) return [];
  return [baseDocument(fetched.item, fetched, fetched.text)];
}

async function fetchStatic(item: SourceItem, options: FetchOptions, kind: "text" | "html" | "json" | "xml" | "pdf"): Promise<FetchedSourceDocument> {
  const blocked = blockedFetchResult(item);
  if (blocked) return blocked;
  assertDownloadAllowedByRights(item);
  const url = sourceUrl(item);
  if (!url) throw new Error(`Source item ${item.id} is missing url or api_url`);
  const ext = kind === "json" ? ".json" : kind === "xml" ? ".xml" : kind === "html" ? ".html" : kind === "pdf" ? ".pdf" : ".txt";
  const rawPath = path.join(options.rawRoot, safeFileName(item, ext));
  let raw = "";
  let text = "";
  let metadata: Record<string, unknown> = {};
  const warnings: string[] = [];
  if (kind === "pdf") {
    const pdf = await pdfText(await cachedFetch(rawPath, url, httpOptions(options)));
    text = pdf.text;
    metadata = pdf.metadata;
    warnings.push(...pdf.warnings);
  } else {
    raw = await rawText(options, rawPath, url);
    text = kind === "text" ? applyTextCleanup(item, stripProjectGutenbergWrapper(raw)) : raw;
    if (kind === "html") text = stripHtml(raw);
    if (kind === "xml") text = xmlText(raw);
  }
  if (kind === "json") {
    const parsed = JSON.parse(raw) as unknown;
    metadata = metadataFromJson(parsed);
    const textUrl = textUrlFromJson(parsed);
    text = textFromJsonValue(parsed)
      ?? (textUrl ? normalizeImportedText(await rawText(options, path.join(options.rawRoot, safeFileName(item, ".linked.txt")), textUrl)) : "");
    if (textUrl) metadata.text_url = textUrl;
  }
  const cleanText = normalizeImportedText(text);
  const textPath = cleanText ? path.join(options.normalizedRoot, safeFileName(item, ".txt")) : undefined;
  if (textPath) writeTextFile(textPath, cleanText);
  return {
    item,
    status: cleanText ? "text" : "metadata_only",
    rawPath,
    textPath,
    text: cleanText,
    metadata,
    warnings: cleanText ? warnings : [...warnings, `${item.id} had metadata but no extractable text`]
  };
}

async function fetchLoc(item: SourceItem, options: FetchOptions): Promise<FetchedSourceDocument> {
  const blocked = blockedFetchResult(item);
  if (blocked) return blocked;
  const url = locJsonUrl(item);
  if (!url) throw new Error(`LOC source item ${item.id} is missing url or api_url`);
  const rawPath = path.join(options.rawRoot, safeFileName(item, ".json"));
  const raw = await rawText(options, rawPath, url);
  const parsed = JSON.parse(raw) as unknown;
  const { root, item: loc } = rootItem(parsed);
  const textUrl = textUrlFromJson(parsed)
    ?? jsonUrlFromKeys(parsed, /(fulltext_file|fulltext_service|transcri|ocr|full.?text|text|url)/i, /(text-services\/word-coordinates-service\?.*full_text=1|\.(?:txt|text|xml)(?:[?&]|$))/i);
  const text = textUrl ? await fetchTextResource(item, textUrl, options) : textFromJsonValue(parsed) ?? "";
  const cleanText = normalizeImportedText(text);
  const textPath = cleanText ? path.join(options.normalizedRoot, safeFileName(item, ".txt")) : undefined;
  if (textPath) writeTextFile(textPath, cleanText);
  const sourceCollection = stringValue(loc.partof ?? root.partof);
  const imageUrls = collectStrings(parsed)
    .map(({ value }) => value)
    .filter((value) => /^https?:\/\/.+\.(?:jpe?g|png|gif|tif|tiff|jp2)(?:\?|$)/i.test(value));
  const uniqueImageUrls = [...new Set(imageUrls)];
  return {
    item,
    status: cleanText ? "text" : "metadata_only",
    rawPath,
    textPath,
    text: cleanText,
    metadata: {
      title: loc.title ?? root.title,
      date: loc.date ?? root.date,
      contributor: loc.contributor_names ?? loc.contributor ?? root.contributor,
      source_collection: sourceCollection,
      rights: loc.rights_information ?? root.rights_information,
      loc_item_id: locItemIdentifier(item, loc, root),
      primary_image_url: uniqueImageUrls[0],
      image_urls: uniqueImageUrls.slice(0, 5),
      image_url_count: uniqueImageUrls.length,
      source_url: item.url ?? item.api_url ?? loc.url ?? root.url ?? null,
      text_url: textUrl
    },
    warnings: cleanText ? [] : [`${item.id} is LOC metadata/image material without transcription or OCR text`]
  };
}

function htmlMeta(raw: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return raw.match(new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1]?.trim()
    ?? raw.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["']`, "i"))?.[1]?.trim();
}

function htmlHeading(raw: string): string | undefined {
  const fragment = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    ?? raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return fragment ? stripHtml(fragment) : undefined;
}

function htmlTitle(raw: string): string | undefined {
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? stripHtml(title).replace(/\s*\|\s*Darwin Correspondence Project\s*$/i, "").trim() : undefined;
}

function darwinDetail(raw: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = raw.match(new RegExp(`<dt>\\s*${escaped}\\s*<\\/dt>\\s*<dd>([\\s\\S]*?)<\\/dd>`, "i"));
  return match?.[1] ? stripHtml(match[1]).replace(/\s*\[[^\]]+\]\s*$/g, "") : undefined;
}

function darwinLetterNumber(raw: string): string | undefined {
  const heading = htmlHeading(raw);
  const title = htmlTitle(raw);
  return htmlMeta(raw, "citation_number")
    ?? htmlMeta(raw, "letter:number")
    ?? darwinDetail(raw, "Letter no.")
    ?? raw.match(/\bDCP-LETT-([0-9A-Za-z.-]+)/i)?.[1]
    ?? heading?.match(/\bLetter\s+([0-9A-Za-z.-]+)/i)?.[1]
    ?? title?.match(/\bLetter\s+([0-9A-Za-z.-]+)/i)?.[1];
}

function darwinLetterText(raw: string): string | undefined {
  const body = raw.match(/<div class="body-content">([\s\S]*?)<\/div>\s*<\/div>\s*<div class="footnotes"/i)?.[1]
    ?? raw.match(/<div class="letter" id="letter">([\s\S]*?)<div class="cite">/i)?.[1];
  if (!body) return undefined;
  return stripHtml(body
    .replace(/<sup\b[\s\S]*?<\/sup>/gi, " ")
    .replace(/<div class="footnotes"[\s\S]*$/i, " "));
}

function darwinMetadata(raw: string, item: SourceItem): Record<string, unknown> {
  return {
    letter_number: darwinLetterNumber(raw),
    sender: htmlMeta(raw, "sender") ?? htmlMeta(raw, "author") ?? darwinDetail(raw, "From") ?? item.author,
    recipient: htmlMeta(raw, "recipient") ?? darwinDetail(raw, "To") ?? item.recipient,
    date: htmlMeta(raw, "date") ?? item.date,
    title: htmlTitle(raw) ?? htmlHeading(raw) ?? item.title,
    source_collection: "Darwin correspondence",
    source_url: item.url ?? item.api_url ?? null
  };
}

async function fetchDarwin(item: SourceItem, options: FetchOptions): Promise<FetchedSourceDocument> {
  const url = sourceUrl(item);
  if (!url) throw new Error(`Darwin source item ${item.id} is missing url or api_url`);
  const kind = /(darwinproject\.ac\.uk\/letter|docId=letters\/DCP-LETT)/i.test(url) ? "html" : /\.xml(?:\?|$)/i.test(url) ? "xml" : /\.txt(?:\?|$)/i.test(url) ? "text" : "html";
  const fetched = await fetchStatic(item, options, kind);
  const raw = fetched.rawPath && fs.existsSync(fetched.rawPath) ? fs.readFileSync(fetched.rawPath, "utf8") : fetched.text ?? "";
  const letterText = kind === "html" ? darwinLetterText(raw) : undefined;
  const cleanText = normalizeImportedText(letterText ?? fetched.text ?? "");
  if (fetched.textPath && cleanText) writeTextFile(fetched.textPath, cleanText);
  return {
    ...fetched,
    status: cleanText ? "text" : fetched.status,
    text: cleanText,
    metadata: {
      ...fetched.metadata,
      ...darwinMetadata(raw, item)
    }
  };
}

function umassMetadata(parsed: unknown, item: SourceItem): Record<string, unknown> {
  const { root, item: record } = rootItem(parsed);
  return {
    title: record.title ?? root.title ?? item.title,
    date: record.date ?? record.dates ?? root.date ?? item.date,
    creator: record.creator ?? record.creators ?? record.author ?? root.creator,
    contributor: record.contributor ?? record.contributors,
    correspondent: record.correspondent ?? record.correspondents,
    source_collection: record.collection ?? root.collection ?? "UMass Credo",
    series: record.series ?? root.series,
    collection_id: record.collection_id ?? record.identifier ?? root.identifier,
    document_type: record.type ?? record.document_type ?? item.document_type,
    raw_metadata: parsed
  };
}

async function fetchUmass(item: SourceItem, options: FetchOptions): Promise<FetchedSourceDocument> {
  const blocked = blockedFetchResult(item);
  if (blocked) return blocked;
  const url = sourceUrl(item);
  if (!url) throw new Error(`UMass source item ${item.id} is missing url or api_url`);
  if (!/\.json(?:\?|$)/i.test(url)) return fetchGenericArchive(item, options);
  const rawPath = path.join(options.rawRoot, safeFileName(item, ".json"));
  const raw = await rawText(options, rawPath, url);
  const parsed = JSON.parse(raw) as unknown;
  const textUrl = textUrlFromJson(parsed);
  const text = textFromJsonValue(parsed)
    ?? (textUrl ? normalizeImportedText(await rawText(options, path.join(options.rawRoot, safeFileName(item, ".linked.txt")), textUrl)) : "");
  const cleanText = normalizeImportedText(text);
  const textPath = cleanText ? path.join(options.normalizedRoot, safeFileName(item, ".txt")) : undefined;
  if (textPath) writeTextFile(textPath, cleanText);
  return {
    item,
    status: cleanText ? "text" : "metadata_only",
    rawPath,
    textPath,
    text: cleanText,
    metadata: { ...umassMetadata(parsed, item), text_url: textUrl },
    warnings: cleanText ? [] : [`${item.id} has UMass metadata but no available full text`]
  };
}

function teiMetadata(raw: string, item: SourceItem, sourceCollection: string): Record<string, unknown> {
  return {
    title: raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ? stripHtml(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") : item.title,
    author: raw.match(/<author[^>]*>([\s\S]*?)<\/author>/i)?.[1] ? stripHtml(raw.match(/<author[^>]*>([\s\S]*?)<\/author>/i)?.[1] ?? "") : item.author,
    date: raw.match(/<origDate[^>]*when=["']([^"']+)["']/i)?.[1]
      ?? raw.match(/<origDate[^>]*>([\s\S]*?)<\/origDate>/i)?.[1]?.trim()
      ?? raw.match(/<date[^>]*when=["']([^"']+)["']/i)?.[1]
      ?? raw.match(/<date[^>]*>([\s\S]*?)<\/date>/i)?.[1]?.trim()
      ?? item.date,
    manuscript_type: raw.match(/<msDesc\b/i) ? "manuscript" : undefined,
    transcription_type: raw.match(/\btype=["']diplomatic["']/i) ? "diplomatic" : raw.match(/\btype=["']normalized["']/i) ? "normalized" : undefined,
    license_url: raw.match(/<licen[cs]e[^>]+target=["']([^"']+)["']/i)?.[1],
    catalogue_id: raw.match(/\bxml:id=["']([A-Z]+[0-9]+)["']/i)?.[1]
      ?? item.metadata?.newton_catalogue_id,
    source_collection: sourceCollection,
    source_url: item.url ?? item.api_url ?? null
  };
}

function newtonProjectText(raw: string, url: string): string | undefined {
  if (/<TEI\b/i.test(raw)) return xmlText(raw);
  if (/newtonproject\.ox\.ac\.uk/i.test(url)) {
    const tei = htmlFragment(raw, /<div id=["']tei["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<div id=["']ft["']/i)
      ?? htmlFragment(raw, /<div id=["']tei["'][^>]*>([\s\S]*?)<\/div>\s*<div id=["']notepanels["']/i);
    if (tei) return stripHtml(tei);
  }
  if (/webapp1\.dlib\.indiana\.edu\/newton/i.test(url)) {
    const manuscript = htmlFragment(raw, /(<div class=["']teidiv0["'][\s\S]*?)(?=<div Type=["']0["'] Offset=|<div class=["']navigationPanel["']|<div class=["']row["'][^>]*>\s*<div class=["']twelvecol last["'][^>]*>\s*<div class=["']navigationPanel["'])/i);
    if (manuscript) return stripHtml(manuscript);
  }
  return undefined;
}

async function fetchNewton(item: SourceItem, options: FetchOptions): Promise<FetchedSourceDocument> {
  const url = sourceUrl(item);
  if (!url) throw new Error(`Newton source item ${item.id} is missing url or api_url`);
  const fetched = /newtonproject\.ox\.ac\.uk\/view\/texts\/xml\//i.test(url)
    ? await fetchStatic(item, options, "xml")
    : await fetchGenericArchive(item, options);
  const raw = fetched.rawPath && fs.existsSync(fetched.rawPath) ? fs.readFileSync(fetched.rawPath, "utf8") : fetched.text ?? "";
  const cleanText = normalizeImportedText(newtonProjectText(raw, url) ?? fetched.text ?? "");
  if (fetched.textPath && cleanText) writeTextFile(fetched.textPath, cleanText);
  return {
    ...fetched,
    status: cleanText ? "text" : fetched.status,
    text: cleanText,
    metadata: {
      ...fetched.metadata,
      ...teiMetadata(raw, item, /webapp1\.dlib\.indiana\.edu\/newton/i.test(url) ? "Chymistry of Isaac Newton" : "Newton Project")
    }
  };
}

async function fetchClayLovelace(item: SourceItem, options: FetchOptions): Promise<FetchedSourceDocument> {
  const fetched = await fetchGenericArchive(item, options);
  const raw = fetched.rawPath && fs.existsSync(fetched.rawPath) && !/\.pdf$/i.test(fetched.rawPath)
    ? fs.readFileSync(fetched.rawPath, "utf8")
    : "";
  return {
    ...fetched,
    metadata: {
      ...fetched.metadata,
      title: htmlHeading(raw) ?? metadataString(fetched.metadata, "pdf_title", "title") ?? item.title,
      source_collection: "Clay Lovelace",
      correspondent: htmlMeta(raw, "recipient") ?? item.recipient,
      date: htmlMeta(raw, "date") ?? item.date,
      source_url: item.url ?? item.api_url ?? null
    }
  };
}

function jsonLdRecords(raw: string): Record<string, unknown>[] {
  return [...raw.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .flatMap((match) => {
      try {
        const parsed = JSON.parse(match[1].trim()) as unknown;
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [];
      }
    })
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value));
}

function jsonObject(raw: string): Record<string, unknown> | undefined {
  if (!/^\s*\{/.test(raw)) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return recordValue(parsed);
  } catch {
    return undefined;
  }
}

function scienceMuseumValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text || undefined;
  }
  if (Array.isArray(value)) {
    return value.map(scienceMuseumValue).filter(Boolean).join("; ") || undefined;
  }
  const record = recordValue(value);
  if (!record) return undefined;
  for (const key of ["value", "title", "name", "label", "id"]) {
    const text = scienceMuseumValue(record[key]);
    if (text) return text;
  }
  const summary = recordValue(record.summary);
  if (summary) {
    const text = scienceMuseumValue(summary.title ?? summary.name ?? summary.value);
    if (text) return text;
  }
  return undefined;
}

function scienceMuseumValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(scienceMuseumValue).filter(Boolean) as string[];
  const text = scienceMuseumValue(value);
  return text ? [text] : [];
}

function scienceMuseumJsonAttributes(parsed: Record<string, unknown>): Record<string, unknown> {
  const data = recordValue(parsed.data);
  return firstRecord(data?.attributes, parsed.attributes, data, parsed);
}

function scienceMuseumTextFromJson(parsed: Record<string, unknown>, item: SourceItem): string {
  const attributes = scienceMuseumJsonAttributes(parsed);
  const creation = recordValue(attributes.creation);
  const lines = [
    ["Title", scienceMuseumValue(attributes.summary) ?? scienceMuseumValue(attributes.title) ?? item.title],
    ["Identifier", scienceMuseumValues(attributes.identifier).slice(0, 5).join("; ")],
    ["Date", scienceMuseumValue(creation?.date) ?? item.date],
    ["Maker", scienceMuseumValues(creation?.maker).join("; ")],
    ["Description", scienceMuseumValues(attributes.description).join("; ")],
    ["Parent", scienceMuseumValues(attributes.parent).join("; ")],
    ["Record type", scienceMuseumValue(attributes["@datatype"]) ?? scienceMuseumValue(attributes.type)]
  ];
  return normalizeImportedText(lines
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n"));
}

function scienceMuseumMetadataFromJson(parsed: Record<string, unknown>, item: SourceItem): Record<string, unknown> {
  const attributes = scienceMuseumJsonAttributes(parsed);
  const creation = recordValue(attributes.creation);
  const identifiers = scienceMuseumValues(attributes.identifier);
  return {
    title: scienceMuseumValue(attributes.summary) ?? scienceMuseumValue(attributes.title) ?? item.title,
    description: scienceMuseumValues(attributes.description).join("; ") || undefined,
    date: scienceMuseumValue(creation?.date) ?? item.date,
    maker: scienceMuseumValues(creation?.maker).join("; ") || undefined,
    source_collection: "Science Museum",
    object_id: identifiers[0] ?? item.id,
    identifiers,
    document_url: item.url ?? item.api_url ?? null
  };
}

async function fetchScienceMuseum(item: SourceItem, options: FetchOptions): Promise<FetchedSourceDocument> {
  const url = sourceUrl(item);
  if (!url) throw new Error(`Science Museum source item ${item.id} is missing url or api_url`);
  const fetched = /\.json(?:\?|$)/i.test(url) ? await fetchStatic(item, options, "json") : await fetchGenericArchive(item, options);
  const raw = fetched.rawPath && fs.existsSync(fetched.rawPath)
    ? fs.readFileSync(fetched.rawPath, "utf8")
    : "";
  const json = raw ? jsonObject(raw) : undefined;
  const recordBody = !json && raw ? htmlFragment(raw, /<main[^>]*id=["']main-content["'][^>]*>([\s\S]*?)<\/main>/i) : undefined;
  const recordText = json ? scienceMuseumTextFromJson(json, item) : recordBody ? stripHtml(recordBody) : fetched.text;
  const cleanText = normalizeImportedText(recordText ?? "");
  if (fetched.textPath && cleanText) writeTextFile(fetched.textPath, cleanText);
  const ld = !json && raw ? jsonLdRecords(raw).find((record) => ["Thing", "CreativeWork"].includes(String(record["@type"] ?? ""))) : undefined;
  const jsonMetadata = json ? scienceMuseumMetadataFromJson(json, item) : {};
  return {
    ...fetched,
    status: cleanText ? "text" : fetched.status,
    text: cleanText,
    metadata: {
      ...fetched.metadata,
      ...jsonMetadata,
      title: stringValue(ld?.name) ?? metadataString(jsonMetadata, "title") ?? metadataString(fetched.metadata, "title") ?? item.title,
      description: stringValue(ld?.description) ?? metadataString(jsonMetadata, "description"),
      date: stringValue(ld?.dateCreated) ?? metadataString(jsonMetadata, "date") ?? item.date,
      source_collection: metadataString(fetched.metadata, "source_collection") ?? "Science Museum",
      object_id: metadataString(jsonMetadata, "object_id") ?? metadataString(fetched.metadata, "object_id", "identifier") ?? stringValue(ld?.identifier) ?? item.id,
      image_url: stringValue(ld?.image),
      document_url: item.url ?? item.api_url ?? stringValue(ld?.url) ?? null
    },
    warnings: cleanText
      ? fetched.warnings
      : [`${item.id} has Science Museum metadata but no transcription; keeping as metadata-only`]
  };
}

async function fetchGenericArchive(item: SourceItem, options: FetchOptions): Promise<FetchedSourceDocument> {
  const url = sourceUrl(item);
  if (!url) throw new Error(`Source item ${item.id} is missing url or api_url`);
  if (/\.json(?:\?|$)/i.test(url)) return fetchStatic(item, options, "json");
  if (/\.xml(?:\?|$)/i.test(url) || /tei/i.test(item.source_type)) return fetchStatic(item, options, "xml");
  if (/\.pdf(?:\?|$)/i.test(url)) return fetchStatic(item, options, "pdf");
  if (/\.txt(?:\?|$)/i.test(url) || /\.text(?:\?|$)/i.test(url)) return fetchStatic(item, options, "text");
  return fetchStatic(item, options, "html");
}

async function fetchVanGoghArchive(item: SourceItem, options: FetchOptions): Promise<FetchedSourceDocument> {
  const blocked = blockedFetchResult(item);
  if (blocked) return blocked;
  const url = sourceUrl(item);
  if (!url) throw new Error(`Source item ${item.id} is missing url`);
  if (!options.capsule) throw new Error("Van Gogh archive parsing needs the collection capsule.");
  const rawPath = path.join(options.rawRoot, safeFileName(item, ".zip"));
  const zip = await cachedFetch(rawPath, url, { ...httpOptions(options), maxBytes: 64 * 1024 * 1024 });
  const { documents, skipped } = vanGoghDocumentsFromZip(zip, options.capsule);
  return {
    item,
    status: documents.length ? "text" : "metadata_only",
    rawPath,
    metadata: { letters: documents.length, skipped_entries: skipped.length, source_url: url },
    documents,
    warnings: documents.length ? [] : [`${item.id} contained no readable letters`]
  };
}

function terminalAdapter(sourceType: SourceType, status: "catalog_only" | "user_supplied_only"): SourceAdapter {
  return {
    sourceType,
    async fetchItem(item: SourceItem): Promise<FetchedSourceDocument> {
      return {
        item,
        status,
        metadata: { rights_level: rightsLevelForItem(item), source_url: item.url ?? item.api_url ?? null },
        warnings: [`${sourceType} item ${item.id} does not download source text`]
      };
    },
    normalize() {
      return [];
    }
  };
}

function adapter(sourceType: SourceType, fetcher: (item: SourceItem, options: FetchOptions) => Promise<FetchedSourceDocument>): SourceAdapter {
  return {
    sourceType,
    async fetchItem(item: SourceItem, options: FetchOptions): Promise<FetchedSourceDocument> {
      try {
        return await fetcher(item, options);
      } catch (error) {
        const url = sourceUrl(item) ?? "no source URL";
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Source item ${item.id} (${url}) failed: ${message}`);
      }
    },
    normalize: normalizeFetchedText
  };
}

const ADAPTERS: Record<SourceType, SourceAdapter> = {
  loc_item: adapter("loc_item", fetchLoc),
  loc_collection_search: adapter("loc_collection_search", fetchLoc),
  static_text_url: adapter("static_text_url", (item, options) => fetchStatic(item, options, "text")),
  static_html_url: adapter("static_html_url", (item, options) => fetchStatic(item, options, "html")),
  static_json_url: adapter("static_json_url", (item, options) => fetchStatic(item, options, "json")),
  static_pdf_url: adapter("static_pdf_url", (item, options) => fetchStatic(item, options, "pdf")),
  tei_xml_url: adapter("tei_xml_url", (item, options) => fetchStatic(item, options, "xml")),
  darwin_correspondence: adapter("darwin_correspondence", fetchDarwin),
  darwin_online: adapter("darwin_online", fetchDarwin),
  umass_credo_item: adapter("umass_credo_item", fetchUmass),
  newton_project_item: adapter("newton_project_item", fetchNewton),
  science_museum_item: adapter("science_museum_item", fetchScienceMuseum),
  clay_lovelace_item: adapter("clay_lovelace_item", fetchClayLovelace),
  vangogh_xml_zip: adapter("vangogh_xml_zip", fetchVanGoghArchive),
  catalog_only: terminalAdapter("catalog_only", "catalog_only"),
  user_supplied_only: terminalAdapter("user_supplied_only", "user_supplied_only")
};

export function getSourceAdapter(sourceType: string): SourceAdapter {
  if (!SUPPORTED_SOURCE_TYPES.includes(sourceType as SourceType)) {
    throw new Error(`Unknown source type: ${sourceType}. Supported source types: ${SUPPORTED_SOURCE_TYPES.join(", ")}`);
  }
  return ADAPTERS[sourceType as SourceType];
}

export function listSourceAdapters(): SourceType[] {
  return [...SUPPORTED_SOURCE_TYPES];
}
