import fs from "node:fs";
import { readYamlFile } from "../yamlFiles.js";
import type { CorpusCapsule } from "../corpus/types.js";
import { sha256Text } from "../state/files.js";
import { canDownloadText, rightsLevelForItem, rightsSummary } from "./rights.js";
import { selectedManifestItems } from "./sourceManifest.js";
import type { SourceItem, SourceManifest } from "./types.js";

// A selection says exactly which manifest items a download covers. Each
// download is recorded with a selection ID derived from the items, rules, and
// notice text, so a changed selection or notice shows up as a new record.

export type SelectionSpec =
  | { kind: "sample" }
  | { kind: "set"; mode?: string; path?: string }
  | { kind: "items"; itemIds: string[] };

export type ItemRule = {
  text_window?: { start: string; end?: string };
  document_filter?: { every_nth?: number; include_ids?: string[] };
};

export type SampleProfile = {
  version: 1;
  profile_version: number;
  title: string;
  summary: string;
  download_bytes: number | null;
  download_note: string;
  items: Array<{ id: string } & ItemRule>;
};

export type CoverageKind = "sample" | "selected-set" | "partial-selection";

export type ResolvedSelection = {
  selection_id: string;
  spec: SelectionSpec;
  coverage: CoverageKind;
  label: string;
  items: SourceItem[];
  rules: Record<string, ItemRule>;
  download_bytes: number | null;
  download_note: string | null;
  notice: string;
  notice_sha256: string;
  text_items: number;
  blocked_items: number;
  rights_summary: Record<string, number>;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function parseRule(raw: Record<string, unknown>, label: string): ItemRule {
  const rule: ItemRule = {};
  if (raw.text_window !== undefined) {
    const window = asRecord(raw.text_window, `${label}.text_window`);
    if (typeof window.start !== "string" || !window.start.trim()) throw new Error(`${label}.text_window.start must be a non-empty string`);
    if (window.end !== undefined && (typeof window.end !== "string" || !window.end.trim())) throw new Error(`${label}.text_window.end must be a non-empty string`);
    rule.text_window = { start: window.start, end: window.end as string | undefined };
  }
  if (raw.document_filter !== undefined) {
    const filter = asRecord(raw.document_filter, `${label}.document_filter`);
    const everyNth = filter.every_nth;
    if (everyNth !== undefined && (!Number.isInteger(everyNth) || (everyNth as number) < 1)) {
      throw new Error(`${label}.document_filter.every_nth must be a positive integer`);
    }
    const includeIds = filter.include_ids;
    if (includeIds !== undefined && (!Array.isArray(includeIds) || includeIds.some((id) => typeof id !== "string"))) {
      throw new Error(`${label}.document_filter.include_ids must be a list of strings`);
    }
    rule.document_filter = { every_nth: everyNth as number | undefined, include_ids: includeIds as string[] | undefined };
  }
  return rule;
}

export function validateSampleProfile(raw: unknown, manifest: SourceManifest): SampleProfile {
  const record = asRecord(raw, "sample.yaml");
  if (record.version !== 1) throw new Error("sample.yaml version must be 1");
  if (!Number.isInteger(record.profile_version) || (record.profile_version as number) < 1) {
    throw new Error("sample.yaml profile_version must be a positive integer");
  }
  for (const field of ["title", "summary", "download_note"]) {
    if (typeof record[field] !== "string" || !(record[field] as string).trim()) throw new Error(`sample.yaml ${field} must be a non-empty string`);
  }
  const bytes = record.download_bytes;
  if (bytes !== null && bytes !== undefined && (!Number.isInteger(bytes) || (bytes as number) < 0)) {
    throw new Error("sample.yaml download_bytes must be a non-negative integer or null");
  }
  if (!Array.isArray(record.items) || record.items.length === 0) throw new Error("sample.yaml items must be a non-empty list");
  const known = new Map(manifest.items.map((item) => [item.id, item]));
  const items = record.items.map((rawItem, index) => {
    const item = asRecord(rawItem, `sample.yaml items[${index}]`);
    if (typeof item.id !== "string" || !known.has(item.id)) {
      throw new Error(`sample.yaml items[${index}] references unknown manifest item: ${String(item.id)}`);
    }
    if (!canDownloadText(known.get(item.id) as SourceItem)) {
      throw new Error(`sample.yaml item ${item.id} has no downloadable text`);
    }
    return { id: item.id, ...parseRule(item, `sample.yaml items[${index}]`) };
  });
  return {
    version: 1,
    profile_version: record.profile_version as number,
    title: record.title as string,
    summary: record.summary as string,
    download_bytes: (bytes ?? null) as number | null,
    download_note: record.download_note as string,
    items
  };
}

const profileCache = new Map<string, { signature: string; manifest: SourceManifest; profile: SampleProfile }>();

export function loadSampleProfile(capsule: CorpusCapsule, manifest: SourceManifest): SampleProfile | null {
  if (!capsule.sampleProfilePath || !fs.existsSync(capsule.sampleProfilePath)) return null;
  const stat = fs.statSync(capsule.sampleProfilePath);
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const cached = profileCache.get(capsule.sampleProfilePath);
  if (cached && cached.signature === signature && cached.manifest === manifest) return cached.profile;
  const raw = readYamlFile(capsule.sampleProfilePath);
  const profile = validateSampleProfile(raw, manifest);
  profileCache.set(capsule.sampleProfilePath, { signature, manifest, profile });
  return profile;
}

export function encodeSelectionSpec(spec: SelectionSpec): string {
  if (spec.kind === "sample") return "sample";
  if (spec.kind === "items") return `items:${spec.itemIds.join(",")}`;
  return `set:${spec.mode ?? ""}:${spec.path ?? ""}`;
}

function buildNotice(capsule: CorpusCapsule, manifest: SourceManifest, items: SourceItem[], label: string, downloadNote: string | null): string {
  const summary = rightsSummary(items);
  return [
    `Collection: ${capsule.manifest.title} (${capsule.id}). Selection: ${label}.`,
    downloadNote,
    capsule.manifest.license.notes,
    "Dialogues downloads these documents from their original sources to this computer. It never bypasses logins, borrowing, DRM, paywalls, or other access controls.",
    `Rights levels in this selection: ${Object.entries(summary).map(([level, count]) => `${level} ${count}`).join(", ") || "none"}.`,
    manifest.source_policy ? `Source policy: ${manifest.source_policy}.` : null
  ].filter(Boolean).join(" ");
}

export function resolveSelection(
  capsule: CorpusCapsule,
  manifest: SourceManifest,
  spec: SelectionSpec
): ResolvedSelection {
  let items: SourceItem[];
  let rules: Record<string, ItemRule> = {};
  let coverage: CoverageKind;
  let label: string;
  let downloadBytes: number | null = null;
  let downloadNote: string | null = null;

  if (spec.kind === "sample") {
    const profile = loadSampleProfile(capsule, manifest);
    if (!profile) throw new Error(`${capsule.id} has no sample selection. Choose the full selection instead.`);
    const byId = new Map(manifest.items.map((item) => [item.id, item]));
    items = profile.items.map((entry) => byId.get(entry.id) as SourceItem);
    rules = Object.fromEntries(profile.items.map(({ id, ...rule }) => [id, rule]));
    coverage = "sample";
    label = `${profile.title} (sample profile v${profile.profile_version})`;
    downloadBytes = profile.download_bytes;
    downloadNote = profile.download_note;
  } else if (spec.kind === "items") {
    const byId = new Map(manifest.items.map((item) => [item.id, item]));
    const unknown = spec.itemIds.filter((id) => !byId.has(id));
    if (unknown.length) throw new Error(`Unknown source item(s): ${unknown.slice(0, 5).join(", ")}`);
    items = spec.itemIds.map((id) => byId.get(id) as SourceItem);
    coverage = "partial-selection";
    label = `${items.length} chosen item(s)`;
  } else {
    items = selectedManifestItems(manifest, { mode: spec.mode, path: spec.path });
    const fullDefault = !spec.path && (spec.mode ?? manifest.default_mode) === manifest.default_mode;
    coverage = fullDefault ? "selected-set" : "partial-selection";
    label = spec.path
      ? `path ${spec.path} (${items.length} item(s))`
      : `${spec.mode ?? manifest.default_mode} (${items.length} item(s))`;
  }

  const notice = buildNotice(capsule, manifest, items, label, downloadNote);
  const noticeSha = sha256Text(notice);
  const selectionId = sha256Text(JSON.stringify({
    corpus: capsule.id,
    spec: encodeSelectionSpec(spec),
    items: items.map((item) => [item.id, item.url ?? item.api_url ?? null]),
    rules,
    notice: noticeSha
  })).slice(0, 16);
  return {
    selection_id: selectionId,
    spec,
    coverage,
    label,
    items,
    rules,
    download_bytes: downloadBytes,
    download_note: downloadNote,
    notice,
    notice_sha256: noticeSha,
    text_items: items.filter(canDownloadText).length,
    blocked_items: items.filter((item) => !canDownloadText(item)).length,
    rights_summary: rightsSummary(items)
  };
}

export function describeItem(item: SourceItem) {
  return {
    id: item.id,
    title: item.title ?? item.id,
    source_type: item.source_type,
    rights_level: rightsLevelForItem(item),
    downloadable_text: canDownloadText(item)
  };
}
