import fs from "node:fs";
import path from "node:path";
import { readYamlFile } from "../yamlFiles.js";
import {
  builtInCorporaRoot,
  dataDir,
  indexPathFor,
  installedCorporaPath,
  isRealInside,
  isSafeId,
  userCorporaRoot
} from "../paths.js";
import type {
  CorpusCapsule,
  CorpusLoadError,
  CorpusManifest,
  InstalledCorporaManifest,
  InstalledCorpusEntry
} from "./types.js";

const REQUIRED_MANIFEST_FIELDS: Array<keyof CorpusManifest> = [
  "id",
  "title",
  "description",
  "languages",
  "type",
  "status",
  "data_policy",
  "default_search_mode",
  "guide",
  "search_rules",
  "source_notes",
  "citation_rules",
  "fields",
  "license"
];

export type CorpusListResult = {
  corpora: CorpusCapsule[];
  errors: CorpusLoadError[];
};

export type CorpusSource = CorpusCapsule["source"];

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`corpus.yaml ${field} must be a non-empty string`);
  }
  return value.trim();
}

function validateStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`corpus.yaml ${field} must be a non-empty list`);
  }
  const invalid = value.find((item) => typeof item !== "string" || !item.trim());
  if (invalid !== undefined) {
    throw new Error(`corpus.yaml ${field} must contain only non-empty strings`);
  }
  return value as string[];
}

function validateOptionalChunking(manifest: Partial<CorpusManifest>): void {
  if (manifest.chunking === undefined) return;
  if (!manifest.chunking || typeof manifest.chunking !== "object" || Array.isArray(manifest.chunking)) {
    throw new Error("corpus.yaml chunking must be an object when provided");
  }
  const chunking = manifest.chunking as Record<string, unknown>;
  for (const field of ["min_chars", "max_chars", "overlap_chars"]) {
    if (chunking[field] === undefined) continue;
    if (!Number.isInteger(chunking[field]) || (chunking[field] as number) < 0) {
      throw new Error(`corpus.yaml chunking.${field} must be a non-negative integer`);
    }
  }
  if (chunking.preserve_paragraphs !== undefined && typeof chunking.preserve_paragraphs !== "boolean") {
    throw new Error("corpus.yaml chunking.preserve_paragraphs must be boolean");
  }
  const minChars = typeof chunking.min_chars === "number" ? chunking.min_chars : undefined;
  const maxChars = typeof chunking.max_chars === "number" ? chunking.max_chars : undefined;
  if (maxChars !== undefined && maxChars < 200) {
    throw new Error("corpus.yaml chunking.max_chars must be at least 200");
  }
  if (minChars !== undefined && maxChars !== undefined && minChars > maxChars) {
    throw new Error("corpus.yaml chunking.min_chars must be less than or equal to max_chars");
  }
}

function validateOptionalDownloadPolicy(manifest: Partial<CorpusManifest>): void {
  if (manifest.downloadable !== undefined && typeof manifest.downloadable !== "boolean") {
    throw new Error("corpus.yaml downloadable must be boolean when provided");
  }
  if (manifest.download_policy !== undefined && ![
    "public_source",
    "curated_public_source",
    "user_supplied_only",
    "catalog_only"
  ].includes(manifest.download_policy)) {
    throw new Error("corpus.yaml download_policy must be public_source, curated_public_source, user_supplied_only, or catalog_only");
  }
}

function resolveCapsuleFile(rootPath: string, relativeFile: string, label: string): string {
  const cleanRelative = requireString(relativeFile, label);
  if (path.isAbsolute(cleanRelative)) {
    throw new Error(`corpus.yaml ${label} must be a relative path`);
  }
  const resolved = path.resolve(rootPath, cleanRelative);
  const root = path.resolve(rootPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`corpus.yaml ${label} must stay inside the corpus folder`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`missing guide file for ${label}: ${cleanRelative}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`guide file for ${label} is not a file: ${cleanRelative}`);
  }
  // Symlinks and junctions must not lead outside the capsule either.
  if (!isRealInside(root, resolved)) {
    throw new Error(`corpus.yaml ${label} must stay inside the corpus folder`);
  }
  return resolved;
}

function resolveOptionalCapsuleFile(rootPath: string, relativeFile: string | undefined, label: string): string | undefined {
  if (relativeFile === undefined) return undefined;
  return resolveCapsuleFile(rootPath, relativeFile, label);
}

function validateManifest(raw: unknown, rootPath: string): CorpusManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error("corpus.yaml must contain a YAML object");
  }

  const manifest = raw as Partial<CorpusManifest>;
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (manifest[field] === undefined || manifest[field] === null) {
      throw new Error(`corpus.yaml missing required field: ${field}`);
    }
  }

  manifest.id = requireString(manifest.id, "id");
  manifest.title = requireString(manifest.title, "title");
  manifest.description = requireString(manifest.description, "description");
  manifest.type = requireString(manifest.type, "type");
  manifest.status = requireString(manifest.status, "status");
  manifest.data_policy = requireString(manifest.data_policy, "data_policy");
  manifest.default_search_mode = requireString(manifest.default_search_mode, "default_search_mode");
  manifest.guide = requireString(manifest.guide, "guide");
  manifest.search_rules = requireString(manifest.search_rules, "search_rules");
  manifest.source_notes = requireString(manifest.source_notes, "source_notes");
  manifest.citation_rules = requireString(manifest.citation_rules, "citation_rules");
  if (manifest.tagline !== undefined) {
    manifest.tagline = requireString(manifest.tagline, "tagline");
  }
  if (manifest.selection_rules !== undefined) {
    manifest.selection_rules = requireString(manifest.selection_rules, "selection_rules");
  }
  if (manifest.source_manifest !== undefined) {
    manifest.source_manifest = requireString(manifest.source_manifest, "source_manifest");
  }
  if (manifest.sample_profile !== undefined) {
    manifest.sample_profile = requireString(manifest.sample_profile, "sample_profile");
  }
  manifest.languages = validateStringList(manifest.languages, "languages");
  manifest.fields = validateStringList(manifest.fields, "fields");
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(manifest.id)) {
    throw new Error("corpus.yaml id must be a lowercase slug using letters, numbers, and hyphens");
  }
  if (manifest.default_search_mode !== "fts") {
    throw new Error("corpus.yaml default_search_mode must be 'fts' for v1");
  }
  validateOptionalChunking(manifest);
  validateOptionalDownloadPolicy(manifest);
  if (!manifest.license || typeof manifest.license !== "object") {
    throw new Error("corpus.yaml license must be an object");
  }
  if (typeof manifest.license.data_included !== "boolean") {
    throw new Error("corpus.yaml license.data_included must be boolean");
  }
  if (typeof manifest.license.user_must_confirm_rights !== "boolean") {
    throw new Error("corpus.yaml license.user_must_confirm_rights must be boolean");
  }
  if (typeof manifest.license.notes !== "string" || !manifest.license.notes.trim()) {
    throw new Error("corpus.yaml license.notes is required");
  }

  resolveCapsuleFile(rootPath, manifest.guide, "guide");
  resolveCapsuleFile(rootPath, manifest.search_rules, "search_rules");
  resolveCapsuleFile(rootPath, manifest.source_notes, "source_notes");
  resolveCapsuleFile(rootPath, manifest.citation_rules, "citation_rules");
  resolveOptionalCapsuleFile(rootPath, manifest.selection_rules, "selection_rules");
  resolveOptionalCapsuleFile(rootPath, manifest.source_manifest, "source_manifest");
  resolveOptionalCapsuleFile(rootPath, manifest.sample_profile, "sample_profile");

  return manifest as CorpusManifest;
}

type CachedCapsule = { signature: string; capsule: CorpusCapsule };
const capsuleCache = new Map<string, CachedCapsule>();

function fileSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function capsuleSignature(rootPath: string): string {
  const manifestPath = path.join(rootPath, "corpus.yaml");
  const parts = [fileSignature(manifestPath)];
  for (const name of ["guide.md", "search-rules.md", "source-notes.md", "citation-rules.md", "selection-rules.md", "source-manifest.yaml", "sample.yaml"]) {
    parts.push(fileSignature(path.join(rootPath, name)));
  }
  return parts.join("|");
}

function lazyText(target: CorpusCapsule, key: "guide" | "searchRules" | "sourceNotes" | "citationRules", filePath: string): void {
  let value: string | undefined;
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      value ??= readText(filePath);
      return value;
    }
  });
}

export function loadCorpusFromPath(rootPath: string, source: CorpusSource = "installed"): CorpusCapsule {
  const resolvedRoot = path.resolve(rootPath);
  const signature = capsuleSignature(resolvedRoot);
  const cached = capsuleCache.get(resolvedRoot);
  if (cached && cached.signature === signature && cached.capsule.source === source && cached.capsule.indexPath === indexPathFor(cached.capsule.id)) {
    return cached.capsule;
  }

  const manifestPath = path.join(resolvedRoot, "corpus.yaml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("missing corpus.yaml");
  }

  const raw = readYamlFile(manifestPath);
  const manifest = validateManifest(raw, resolvedRoot);
  const selectionRulesPath = resolveOptionalCapsuleFile(resolvedRoot, manifest.selection_rules, "selection_rules");
  const sourceManifestPath = resolveOptionalCapsuleFile(resolvedRoot, manifest.source_manifest, "source_manifest");
  const sampleProfilePath = resolveOptionalCapsuleFile(resolvedRoot, manifest.sample_profile, "sample_profile");

  const capsule = {
    id: manifest.id,
    rootPath: resolvedRoot,
    source,
    manifest,
    selectionRules: selectionRulesPath ? readText(selectionRulesPath) : undefined,
    selectionRulesPath,
    sourceManifestPath,
    sampleProfilePath,
    indexPath: indexPathFor(manifest.id)
  } as CorpusCapsule;
  lazyText(capsule, "guide", path.join(resolvedRoot, manifest.guide));
  lazyText(capsule, "searchRules", path.join(resolvedRoot, manifest.search_rules));
  lazyText(capsule, "sourceNotes", path.join(resolvedRoot, manifest.source_notes));
  lazyText(capsule, "citationRules", path.join(resolvedRoot, manifest.citation_rules));
  capsuleCache.set(resolvedRoot, { signature, capsule });
  return capsule;
}

/** Drop cached capsules, e.g. after an import adds or edits a collection. */
export function invalidateCorpusCache(): void {
  capsuleCache.clear();
}

function listCorpusRoots(basePath: string): string[] {
  if (!fs.existsSync(basePath)) return [];
  return fs
    .readdirSync(basePath, { withFileTypes: true })
    // Dot folders are staging areas for imports in progress.
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(basePath, entry.name));
}

function installedCorporaManifestPath(): string {
  return installedCorporaPath();
}

function normalizeInstalledEntry(raw: unknown, index: number): InstalledCorpusEntry {
  if (typeof raw === "string") return { path: raw };
  if (raw && typeof raw === "object") {
    const entry = raw as Partial<InstalledCorpusEntry>;
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      throw new Error(`installed-corpora.json entry ${index} missing non-empty path`);
    }
    if (entry.id !== undefined && (typeof entry.id !== "string" || !entry.id.trim())) {
      throw new Error(`installed-corpora.json entry ${index} id must be a non-empty string when provided`);
    }
    return { path: entry.path, id: entry.id };
  }
  throw new Error(`installed-corpora.json entry ${index} must be a path string or object with path`);
}

function readInstalledCorpusRoots(errors: CorpusLoadError[]): string[] {
  const manifestPath = installedCorporaManifestPath();
  if (!fs.existsSync(manifestPath)) return [];

  try {
    const raw = JSON.parse(readText(manifestPath)) as unknown;
    const entriesRaw = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as InstalledCorporaManifest).corpora)
        ? (raw as InstalledCorporaManifest).corpora
        : null;
    if (!entriesRaw) {
      throw new Error("installed-corpora.json must be an array or an object with a corpora array");
    }
    return entriesRaw.map((entry, index) => {
      const normalized = normalizeInstalledEntry(entry, index);
      return path.isAbsolute(normalized.path)
        ? path.resolve(normalized.path)
        : path.resolve(dataDir(), normalized.path);
    });
  } catch (error) {
    errors.push({
      rootPath: manifestPath,
      message: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

export function listCorpusCapsules(): CorpusListResult {
  const corpora: CorpusCapsule[] = [];
  const errors: CorpusLoadError[] = [];
  const seen = new Set<string>();
  const rootEntries: Array<{ rootPath: string; source: CorpusSource }> = [
    ...listCorpusRoots(builtInCorporaRoot()).map((rootPath) => ({ rootPath, source: "built_in" as const })),
    ...listCorpusRoots(userCorporaRoot()).map((rootPath) => ({ rootPath, source: "user" as const })),
    ...readInstalledCorpusRoots(errors).map((rootPath) => ({ rootPath, source: "installed" as const }))
  ];

  const seenRoots = new Set<string>();
  for (const { rootPath, source } of rootEntries) {
    const resolvedRoot = path.resolve(rootPath);
    if (seenRoots.has(resolvedRoot)) continue;
    seenRoots.add(resolvedRoot);
    try {
      const capsule = loadCorpusFromPath(resolvedRoot, source);
      if (seen.has(capsule.id)) {
        errors.push({ corpusId: capsule.id, rootPath: resolvedRoot, message: `duplicate corpus id: ${capsule.id}` });
        continue;
      }
      seen.add(capsule.id);
      corpora.push(capsule);
    } catch (error) {
      errors.push({
        rootPath: resolvedRoot,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { corpora, errors };
}

export function getCorpusCapsule(corpusId: string): CorpusCapsule {
  if (typeof corpusId !== "string" || !isSafeId(corpusId)) {
    throw new Error(`Unknown corpus: ${String(corpusId).slice(0, 120)}. Corpus IDs use lowercase letters, numbers, and hyphens.`);
  }
  const { corpora, errors } = listCorpusCapsules();
  const capsule = corpora.find((item) => item.id === corpusId);
  if (capsule) return capsule;

  const detail = errors.length
    ? ` Loader errors: ${errors.map((error) => `${error.rootPath}: ${error.message}`).join("; ")}`
    : "";
  throw new Error(`Unknown corpus: ${corpusId}.${detail}`);
}

export function assertCorpusIndexable(capsule: CorpusCapsule): void {
  const { manifest } = capsule;
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (manifest[field] === undefined || manifest[field] === null) {
      throw new Error(`Corpus ${capsule.id} cannot be indexed: missing manifest field ${field}`);
    }
  }
  if (!manifest.data_policy.trim()) {
    throw new Error(`Corpus ${capsule.id} cannot be indexed: data_policy is required`);
  }
  if (!manifest.license || !manifest.license.notes.trim()) {
    throw new Error(`Corpus ${capsule.id} cannot be indexed: license notes are required`);
  }
}
