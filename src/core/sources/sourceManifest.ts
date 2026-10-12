import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { readYamlFile } from "../yamlFiles.js";
import type { CorpusCapsule } from "../corpus/types.js";
import {
  RIGHTS_LEVELS,
  SUPPORTED_SOURCE_TYPES,
  type DownloadMode,
  type RightsLevel,
  type SourceItem,
  type SourceManifest,
  type SourcePath,
  type SourceType
} from "./types.js";

const RIGHTS_SET = new Set<string>(RIGHTS_LEVELS);
const SOURCE_TYPE_SET = new Set<string>(SUPPORTED_SOURCE_TYPES);

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return asRecord(value, label);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function optionalStringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value.map((item, index) => requireString(item, `${label}[${index}]`));
}

function parseDownloadModes(value: unknown): Record<string, DownloadMode> {
  const record = asRecord(value, "source-manifest.yaml download_modes");
  const modes: Record<string, DownloadMode> = {};
  for (const [id, rawMode] of Object.entries(record)) {
    const mode = asRecord(rawMode, `source-manifest.yaml download_modes.${id}`);
    modes[id] = {
      visible_to_users: optionalBoolean(mode.visible_to_users, `source-manifest.yaml download_modes.${id}.visible_to_users`),
      description: optionalString(mode.description, `source-manifest.yaml download_modes.${id}.description`),
      metadata: optionalRecord(mode.metadata, `source-manifest.yaml download_modes.${id}.metadata`)
    };
  }
  if (Object.keys(modes).length === 0) {
    throw new Error("source-manifest.yaml download_modes must define at least one mode");
  }
  return modes;
}

function parsePaths(value: unknown): Record<string, SourcePath> {
  const record = value === undefined || value === null ? {} : asRecord(value, "source-manifest.yaml paths");
  const paths: Record<string, SourcePath> = {};
  for (const [id, rawPath] of Object.entries(record)) {
    const sourcePath = asRecord(rawPath, `source-manifest.yaml paths.${id}`);
    paths[id] = {
      title: requireString(sourcePath.title, `source-manifest.yaml paths.${id}.title`),
      point: optionalString(sourcePath.point, `source-manifest.yaml paths.${id}.point`),
      description: optionalString(sourcePath.description, `source-manifest.yaml paths.${id}.description`),
      metadata: optionalRecord(sourcePath.metadata, `source-manifest.yaml paths.${id}.metadata`)
    };
  }
  return paths;
}

function parseSourceItem(raw: unknown, index: number): SourceItem {
  const item = asRecord(raw, `source-manifest.yaml items[${index}]`);
  const sourceType = requireString(item.source_type, `source-manifest.yaml items[${index}].source_type`);
  if (!SOURCE_TYPE_SET.has(sourceType)) {
    throw new Error(`source-manifest.yaml items[${index}] unknown source_type: ${sourceType}`);
  }
  const rights = optionalString(item.rights_level, `source-manifest.yaml items[${index}].rights_level`);
  if (rights !== undefined && !RIGHTS_SET.has(rights)) {
    throw new Error(`source-manifest.yaml item ${item.id ?? index} unknown rights_level: ${rights}`);
  }
  const selected = optionalBoolean(item.selected, `source-manifest.yaml items[${index}].selected`);
  const metadata = optionalRecord(item.metadata, `source-manifest.yaml items[${index}].metadata`);
  return {
    id: requireString(item.id, `source-manifest.yaml items[${index}].id`),
    source_type: sourceType as SourceType,
    url: optionalString(item.url, `source-manifest.yaml items[${index}].url`),
    api_url: optionalString(item.api_url, `source-manifest.yaml items[${index}].api_url`),
    title: optionalString(item.title, `source-manifest.yaml items[${index}].title`),
    author: optionalString(item.author, `source-manifest.yaml items[${index}].author`),
    recipient: optionalString(item.recipient, `source-manifest.yaml items[${index}].recipient`),
    date: optionalString(item.date, `source-manifest.yaml items[${index}].date`),
    document_type: optionalString(item.document_type, `source-manifest.yaml items[${index}].document_type`),
    rights_level: rights as RightsLevel | undefined,
    selected,
    paths: optionalStringList(item.paths, `source-manifest.yaml items[${index}].paths`),
    curator_score: optionalNumber(item.curator_score, `source-manifest.yaml items[${index}].curator_score`),
    signals: optionalStringList(item.signals, `source-manifest.yaml items[${index}].signals`),
    why_keep: optionalString(item.why_keep, `source-manifest.yaml items[${index}].why_keep`),
    why_skip: optionalString(item.why_skip, `source-manifest.yaml items[${index}].why_skip`),
    metadata
  };
}

function itemHasImportInstruction(item: SourceItem): boolean {
  if (item.url || item.api_url) return true;
  const metadata = item.metadata ?? {};
  return typeof metadata.local_path === "string"
    || typeof metadata.import_instructions === "string"
    || item.source_type === "catalog_only"
    || item.source_type === "user_supplied_only";
}

export function validateSourceManifest(raw: unknown, expectedCorpusId?: string): SourceManifest {
  const record = asRecord(raw, "source-manifest.yaml");
  const version = record.version;
  if (!Number.isInteger(version) || version !== 1) {
    throw new Error("source-manifest.yaml version must be 1");
  }
  const corpusId = requireString(record.corpus_id, "source-manifest.yaml corpus_id");
  if (expectedCorpusId && corpusId !== expectedCorpusId) {
    throw new Error(`source-manifest.yaml corpus_id ${corpusId} does not match corpus ${expectedCorpusId}`);
  }
  const downloadModes = parseDownloadModes(record.download_modes);
  const defaultMode = requireString(record.default_mode, "source-manifest.yaml default_mode");
  if (!downloadModes[defaultMode]) {
    throw new Error(`source-manifest.yaml default_mode ${defaultMode} is not defined in download_modes`);
  }
  const paths = parsePaths(record.paths);
  if (!Array.isArray(record.items)) {
    throw new Error("source-manifest.yaml items must be a list");
  }
  const items = record.items.map(parseSourceItem);
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`source-manifest.yaml duplicate item id: ${item.id}`);
    seen.add(item.id);
    for (const pathId of item.paths ?? []) {
      if (!paths[pathId]) throw new Error(`source-manifest.yaml item ${item.id} references unknown path: ${pathId}`);
    }
    if (item.selected && !itemHasImportInstruction(item)) {
      throw new Error(`source-manifest.yaml selected item ${item.id} needs url, api_url, local_path, or import instructions`);
    }
  }
  return {
    version,
    corpus_id: corpusId,
    source_policy: requireString(record.source_policy, "source-manifest.yaml source_policy"),
    default_mode: defaultMode,
    download_modes: downloadModes,
    paths,
    items
  };
}

export function sourceManifestPathForCapsule(capsule: CorpusCapsule): string | null {
  const configured = capsule.manifest.source_manifest;
  if (configured) return path.resolve(capsule.rootPath, configured);
  const conventional = path.join(capsule.rootPath, "source-manifest.yaml");
  return fs.existsSync(conventional) ? conventional : null;
}

// Parsed manifests are cached per file and re-read only when the file changes;
// some manifests are large and listing collections reads all of them.
const manifestCache = new Map<string, { signature: string; manifest: SourceManifest }>();

export function loadSourceManifest(capsule: CorpusCapsule): SourceManifest {
  const manifestPath = sourceManifestPathForCapsule(capsule);
  if (!manifestPath) {
    throw new Error(`Corpus ${capsule.id} does not have a source-manifest.yaml`);
  }
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`source manifest not found for ${capsule.id}: ${manifestPath}`);
  }
  const stat = fs.statSync(manifestPath);
  const signature = `${capsule.id}:${stat.size}:${stat.mtimeMs}`;
  const cached = manifestCache.get(manifestPath);
  if (cached && cached.signature === signature) return cached.manifest;
  const raw = readYamlFile(manifestPath);
  const manifest = validateSourceManifest(raw, capsule.id);
  manifestCache.set(manifestPath, { signature, manifest });
  return manifest;
}

export function tryLoadSourceManifest(capsule: CorpusCapsule): SourceManifest | null {
  const manifestPath = sourceManifestPathForCapsule(capsule);
  if (!manifestPath || !fs.existsSync(manifestPath)) return null;
  return loadSourceManifest(capsule);
}

export function hasSourceManifest(capsule: CorpusCapsule): boolean {
  const manifestPath = sourceManifestPathForCapsule(capsule);
  return Boolean(manifestPath && fs.existsSync(manifestPath));
}

export function selectedManifestItems(
  manifest: SourceManifest,
  selection: { mode?: string; path?: string } = {}
): SourceItem[] {
  const mode = selection.mode ?? manifest.default_mode;
  if (!manifest.download_modes[mode]) {
    throw new Error(`Unknown download mode: ${mode}. Available modes: ${Object.keys(manifest.download_modes).join(", ")}`);
  }
  if (selection.path && !manifest.paths[selection.path]) {
    throw new Error(`Unknown path: ${selection.path}. Available paths: ${Object.keys(manifest.paths).join(", ") || "none"}`);
  }
  return manifest.items.filter((item) => {
    if (mode === "full-dev") {
      return selection.path ? (item.paths ?? []).includes(selection.path) : true;
    }
    if (!item.selected) return false;
    if (selection.path && !(item.paths ?? []).includes(selection.path)) return false;
    return true;
  });
}

export function writeSourceManifest(filePath: string, manifest: SourceManifest): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(manifest), "utf8");
}
