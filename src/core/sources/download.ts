import fs from "node:fs";
import path from "node:path";
import type { CorpusCapsule } from "../corpus/types.js";
import { getCorpusCapsule } from "../corpus/loader.js";
import {
  GenericIndex,
  getIndexGeneration,
  getGenericIndexStats,
  reindexGenericCorpus,
  type GenericDocumentInput,
  type GenericIndexStats
} from "../db/genericIndex.js";
import { sourceCacheRootFor } from "../paths.js";
import { appendLogEvent } from "../logs/events.js";
import { readJsonFile, writeFileAtomic, writeJsonAtomic } from "../state/files.js";
import { withCorpusWriter } from "../state/corpusLock.js";
import { registrableDomain, OfflineCacheMissError, type HttpContext } from "./http.js";
import {
  appendRightsConfirmationLog,
  canDownloadText,
  readConsentRecords,
  rightsLevelForItem,
  rightsSummary
} from "./rights.js";
import {
  describeItem,
  encodeSelectionSpec,
  loadSampleProfile,
  resolveSelection,
  type CoverageKind,
  type ItemRule,
  type ResolvedSelection,
  type SelectionSpec
} from "./selection.js";
import { loadSourceManifest, selectedManifestItems, tryLoadSourceManifest } from "./sourceManifest.js";
import type { SourceItem, SourceManifest } from "./types.js";

// Downloads run as resumable jobs. Each finished item is checkpointed, so an
// interrupted or timed-out job continues where it stopped. Every approved
// selection is remembered; the search file is rebuilt from the union of all
// approved, downloaded items, so a later download never discards an earlier
// sample or a fuller set. The previous search file stays in place until the
// new one is built and validated.

export type ItemStatus = "pending" | "text" | "no_text" | "failed" | "blocked";

type ItemState = {
  status: ItemStatus;
  attempts: number;
  updated_at: string;
  last_error?: string;
  text_path?: string;
  raw_path?: string;
  documents?: number;
};

type Approval = {
  selection_id: string;
  spec: SelectionSpec;
  coverage: CoverageKind;
  label: string;
  item_ids: string[];
  rules: Record<string, ItemRule>;
  notice_sha256: string;
  consented_at: string | null;
  consent_channel: string;
};

type JobStatus = "running" | "interrupted" | "canceled" | "indexing" | "complete" | "failed";

type JobState = {
  selection_id: string;
  item_ids: string[];
  status: JobStatus;
  started_at: string;
  updated_at: string;
  force: boolean;
  skip_index: boolean;
  error?: string;
};

type IndexRecord = {
  generation_id: string | null;
  built_at: string;
  coverage: string;
  approved_selection_ids: string[];
  documents: number;
  chunks: number;
  items_indexed: number;
  items_missing: string[];
};

type DownloadStateV2 = {
  version: 2;
  corpus_id: string;
  approvals: Approval[];
  items: Record<string, ItemState>;
  job: JobState | null;
  index: IndexRecord | null;
};

export type JobProgress = {
  done: number;
  total: number;
  text: number;
  no_text: number;
  failed: number;
  blocked: number;
  current?: string;
};

function sourceCacheRoot(corpusId: string): string {
  return sourceCacheRootFor(corpusId);
}

function rawRoot(corpusId: string): string {
  return path.join(sourceCacheRoot(corpusId), "raw");
}

function normalizedRoot(corpusId: string): string {
  return path.join(sourceCacheRoot(corpusId), "normalized");
}

function reportPath(corpusId: string): string {
  return path.join(sourceCacheRoot(corpusId), "download-report.md");
}

function statePath(corpusId: string): string {
  return path.join(sourceCacheRoot(corpusId), "download-state.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyState(corpusId: string): DownloadStateV2 {
  return { version: 2, corpus_id: corpusId, approvals: [], items: {}, job: null, index: null };
}

/** Pre-1.0 state files recorded only the last download. Convert, don't discard. */
function upgradeLegacyState(corpusId: string, raw: Record<string, unknown>): DownloadStateV2 {
  const state = emptyState(corpusId);
  const selection = (raw.selection ?? {}) as { mode?: string; path?: string };
  const downloaded = Array.isArray(raw.downloaded) ? raw.downloaded as Array<{ id: string; text_path?: string; raw_path?: string }> : [];
  const noText = Array.isArray(raw.no_text) ? raw.no_text as Array<{ id: string; reason?: string }> : [];
  const skipped = Array.isArray(raw.skipped) ? raw.skipped as Array<{ id: string; reason?: string }> : [];
  const at = typeof raw.generated_at === "string" ? raw.generated_at : nowIso();
  for (const item of downloaded) state.items[item.id] = { status: "text", attempts: 1, updated_at: at, text_path: item.text_path, raw_path: item.raw_path };
  for (const item of noText) state.items[item.id] = { status: "no_text", attempts: 1, updated_at: at, last_error: item.reason };
  for (const item of skipped) {
    if (item.id === corpusId) continue;
    state.items[item.id] = { status: "failed", attempts: 1, updated_at: at, last_error: item.reason };
  }
  const itemIds = Object.keys(state.items);
  if (itemIds.length) {
    state.approvals.push({
      selection_id: "legacy",
      spec: { kind: "set", mode: selection.mode, path: selection.path },
      coverage: selection.path ? "partial-selection" : "selected-set",
      label: `earlier download (${selection.path ?? selection.mode ?? "default set"})`,
      item_ids: itemIds,
      rules: {},
      notice_sha256: "legacy",
      // The old report time was not a consent record; do not present it as one.
      consented_at: null,
      consent_channel: "legacy"
    });
  }
  return state;
}

export function loadDownloadState(corpusId: string): DownloadStateV2 {
  const result = readJsonFile<Record<string, unknown>>(statePath(corpusId));
  if (result.status === "missing") return emptyState(corpusId);
  if (result.status === "corrupt") {
    throw new Error(`Download state for ${corpusId} is unreadable (${result.error}). Fix or remove ${statePath(corpusId)}; Dialogues will not overwrite it.`);
  }
  const raw = result.value;
  if (raw.version === 2) return raw as unknown as DownloadStateV2;
  return upgradeLegacyState(corpusId, raw);
}

function saveState(state: DownloadStateV2): void {
  writeJsonAtomic(statePath(state.corpus_id), state);
}

export function encodeContinuation(corpusId: string, selectionId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, c: corpusId, s: selectionId })).toString("base64url");
}

export function decodeContinuation(token: string): { corpusId: string; selectionId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { v: number; c: string; s: string };
    if (parsed.v !== 1 || typeof parsed.c !== "string" || typeof parsed.s !== "string") throw new Error("bad token");
    return { corpusId: parsed.c, selectionId: parsed.s };
  } catch {
    throw new Error("Invalid continuation. Ask Dialogues for the download status, then continue from there.");
  }
}

/** Hosts a collection may contact: the domains named in its packaged manifest. */
export function allowedDomainsFor(manifest: SourceManifest): string[] {
  const domains = new Set<string>();
  for (const item of manifest.items) {
    for (const value of [item.url, item.api_url]) {
      if (!value) continue;
      try {
        domains.add(registrableDomain(new URL(value).hostname));
      } catch {
        // Invalid URLs are rejected later by the fetch layer.
      }
    }
  }
  return [...domains].sort();
}

function assertDownloadAllowedCapsule(capsule: CorpusCapsule, options: { allowExternalManifest?: boolean }): void {
  if (capsule.source !== "built_in" && !options.allowExternalManifest) {
    throw new Error(`${capsule.id} is not a built-in collection. Built-in downloads only use manifests shipped with Dialogues; import your own files with import_folder instead.`);
  }
}

function defaultSpec(): SelectionSpec {
  return { kind: "set" };
}

export function previewDownload(corpusId: string, spec: SelectionSpec = defaultSpec()) {
  const capsule = getCorpusCapsule(corpusId);
  const manifest = loadSourceManifest(capsule);
  const selection = resolveSelection(capsule, manifest, spec);
  const state = loadDownloadState(corpusId);
  const alreadyText = selection.items.filter((item) => state.items[item.id]?.status === "text").length;
  return {
    ok: true,
    corpus_id: capsule.id,
    title: capsule.manifest.title,
    selection_id: selection.selection_id,
    selection: encodeSelectionSpec(spec),
    label: selection.label,
    coverage: selection.coverage,
    source_count: selection.items.length,
    text_items: selection.text_items,
    blocked_items: selection.blocked_items,
    already_downloaded: alreadyText,
    download_bytes: selection.download_bytes,
    download_note: selection.download_note,
    rights_summary: selection.rights_summary,
    rights_notice: selection.notice,
    notice_sha256: selection.notice_sha256,
    items: selection.items.map(describeItem)
  };
}

type ActiveJob = {
  selectionId: string;
  controller: AbortController;
  promise: Promise<void>;
  progress: JobProgress;
};

const activeJobs = new Map<string, ActiveJob>();

function progressFor(state: DownloadStateV2, itemIds: string[]): JobProgress {
  const progress: JobProgress = { done: 0, total: itemIds.length, text: 0, no_text: 0, failed: 0, blocked: 0 };
  for (const id of itemIds) {
    const status = state.items[id]?.status ?? "pending";
    if (status === "pending") continue;
    progress.done += 1;
    if (status === "text") progress.text += 1;
    else if (status === "no_text") progress.no_text += 1;
    else if (status === "failed") progress.failed += 1;
    else if (status === "blocked") progress.blocked += 1;
  }
  return progress;
}

export type StartOptions = {
  confirmedRights?: boolean;
  /** Where the agreement came from, recorded with the consent. */
  channel?: string;
  /** Must match the previewed notice when given, so consent covers what was shown. */
  expectedNoticeSha256?: string;
  force?: boolean;
  skipIndex?: boolean;
  allowExternalManifest?: boolean;
  /** Index in a worker thread so a long build does not block the caller. */
  indexInWorker?: boolean;
  onProgress?: (progress: JobProgress) => void;
  http?: Partial<HttpContext>;
};

/** Record consent for a selection and start (or resume) its download job. */
export function startDownload(corpusId: string, spec: SelectionSpec, options: StartOptions) {
  const capsule = getCorpusCapsule(corpusId);
  assertDownloadAllowedCapsule(capsule, options);
  const manifest = loadSourceManifest(capsule);
  const selection = resolveSelection(capsule, manifest, spec);
  if (!options.confirmedRights) {
    return { started: false as const, needs_confirmation: true as const, preview: previewDownload(corpusId, spec) };
  }
  if (options.expectedNoticeSha256 && options.expectedNoticeSha256 !== selection.notice_sha256) {
    throw new Error("The source notice changed since it was shown. Show the new notice and ask again before downloading.");
  }
  const running = activeJobs.get(corpusId);
  if (running && running.selectionId !== selection.selection_id) {
    throw new Error(`A different download for ${corpusId} is already running. Cancel it or wait for it to finish.`);
  }
  if (!running) {
    const state = loadDownloadState(corpusId);
    const consentedAt = nowIso();
    appendRightsConfirmationLog({
      corpusId,
      selection: {
        mode: spec.kind === "set" ? spec.mode : undefined,
        path: spec.kind === "set" ? spec.path : undefined,
        selectionId: selection.selection_id
      },
      rightsNotice: selection.notice,
      sourceCount: selection.items.length,
      rightsLevels: selection.rights_summary,
      confirmation: true,
      channel: options.channel
    });
    state.approvals = state.approvals.filter((approval) => approval.selection_id !== selection.selection_id);
    state.approvals.push({
      selection_id: selection.selection_id,
      spec,
      coverage: selection.coverage,
      label: selection.label,
      item_ids: selection.items.map((item) => item.id),
      rules: selection.rules,
      notice_sha256: selection.notice_sha256,
      consented_at: consentedAt,
      consent_channel: options.channel ?? "unspecified"
    });
    state.job = {
      selection_id: selection.selection_id,
      item_ids: selection.items.map((item) => item.id),
      status: "running",
      started_at: consentedAt,
      updated_at: consentedAt,
      force: Boolean(options.force),
      skip_index: Boolean(options.skipIndex)
    };
    if (options.force) {
      for (const item of selection.items) {
        if (state.items[item.id]) state.items[item.id] = { ...state.items[item.id], status: "pending" };
      }
    }
    saveState(state);
    launchJob(capsule, manifest, selection, options);
  }
  return { started: true as const, selection_id: selection.selection_id, continuation: encodeContinuation(corpusId, selection.selection_id) };
}

/** Resume an interrupted job. Consent was bound when the job started. */
export function resumeDownload(corpusId: string, continuation: string, options: Omit<StartOptions, "confirmedRights"> = {}) {
  const token = decodeContinuation(continuation);
  if (token.corpusId !== corpusId) throw new Error("This continuation belongs to a different collection.");
  if (activeJobs.get(corpusId)?.selectionId === token.selectionId) return { resumed: true };
  const state = loadDownloadState(corpusId);
  const job = state.job;
  if (!job || job.selection_id !== token.selectionId) throw new Error("No matching download to continue. Check the download status.");
  if (job.status === "canceled") throw new Error("That download was canceled. Start it again (with agreement) if you still want it.");
  if (job.status === "complete") return { resumed: false };
  const approval = state.approvals.find((entry) => entry.selection_id === job.selection_id);
  if (!approval) throw new Error("The agreement for this download is missing. Start it again with agreement.");
  const capsule = getCorpusCapsule(corpusId);
  assertDownloadAllowedCapsule(capsule, options);
  const manifest = loadSourceManifest(capsule);
  const selection = resolveSelection(capsule, manifest, approval.spec);
  if (selection.selection_id !== approval.selection_id) {
    throw new Error("The collection's source list changed since you agreed. Review the new notice and start again.");
  }
  job.status = "running";
  job.updated_at = nowIso();
  saveState(state);
  launchJob(capsule, manifest, selection, { ...options, force: job.force, skipIndex: job.skip_index });
  return { resumed: true };
}

export function cancelDownload(corpusId: string) {
  const active = activeJobs.get(corpusId);
  active?.controller.abort(new Error("canceled"));
  const state = loadDownloadState(corpusId);
  if (state.job && state.job.status !== "complete") {
    state.job.status = "canceled";
    state.job.updated_at = nowIso();
    saveState(state);
  }
  return { ok: true, corpus_id: corpusId, canceled: Boolean(state.job), note: "Already downloaded items stay on this computer; the previous search file is unchanged." };
}

function launchJob(capsule: CorpusCapsule, manifest: SourceManifest, selection: ResolvedSelection, options: StartOptions): void {
  const controller = new AbortController();
  const state = loadDownloadState(capsule.id);
  const active: ActiveJob = {
    selectionId: selection.selection_id,
    controller,
    progress: progressFor(state, selection.items.map((item) => item.id)),
    promise: Promise.resolve()
  };
  active.promise = withCorpusWriter(capsule.id, "downloading source text", () => runJob(capsule, manifest, selection, options, controller.signal, active))
    .catch((error: unknown) => {
      const latest = loadDownloadState(capsule.id);
      if (latest.job && latest.job.selection_id === selection.selection_id && latest.job.status !== "canceled") {
        latest.job.status = controller.signal.aborted ? "interrupted" : "failed";
        latest.job.error = error instanceof Error ? error.message : String(error);
        latest.job.updated_at = nowIso();
        saveState(latest);
      }
      appendLogEvent("errors", { command: "download", corpus_id: capsule.id, error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      if (activeJobs.get(capsule.id) === active) activeJobs.delete(capsule.id);
    });
  activeJobs.set(capsule.id, active);
}

async function runJob(
  capsule: CorpusCapsule,
  manifest: SourceManifest,
  selection: ResolvedSelection,
  options: StartOptions,
  signal: AbortSignal,
  active: ActiveJob
): Promise<void> {
  const started = Date.now();
  fs.mkdirSync(rawRoot(capsule.id), { recursive: true });
  fs.mkdirSync(normalizedRoot(capsule.id), { recursive: true });
  const http: HttpContext = { allowedDomains: allowedDomainsFor(manifest), signal, ...options.http };
  const itemIds = selection.items.map((item) => item.id);
  for (const item of selection.items) {
    if (signal.aborted) throw signal.reason ?? new Error("canceled");
    const state = loadDownloadState(capsule.id);
    if (state.job?.status === "canceled") throw new Error("canceled");
    const current = state.items[item.id];
    // Finished items are never repeated on resume; failed ones are retried.
    if (current && (current.status === "text" || current.status === "no_text" || current.status === "blocked")) {
      continue;
    }
    active.progress = { ...progressFor(state, itemIds), current: item.title ?? item.id };
    options.onProgress?.(active.progress);
    const next: ItemState = { status: "pending", attempts: (current?.attempts ?? 0) + 1, updated_at: nowIso() };
    try {
      if (!canDownloadText(item)) {
        next.status = "blocked";
        next.last_error = `${rightsLevelForItem(item)} item: no automatic text download`;
      } else {
        const { getSourceAdapter } = await import("./adapters.js");
        const adapter = getSourceAdapter(item.source_type);
        const fetched = await adapter.fetchItem(item, {
          rawRoot: rawRoot(capsule.id),
          normalizedRoot: normalizedRoot(capsule.id),
          force: options.force,
          http,
          capsule
        });
        const documents = adapter.normalize(fetched);
        next.status = documents.length ? "text" : "no_text";
        next.text_path = fetched.textPath;
        next.raw_path = fetched.rawPath;
        next.documents = documents.length;
        if (!documents.length) next.last_error = fetched.warnings.join("; ") || "no extractable source text";
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      next.status = "failed";
      next.last_error = error instanceof Error ? error.message : String(error);
    }
    const fresh = loadDownloadState(capsule.id);
    fresh.items[item.id] = next;
    if (fresh.job) fresh.job.updated_at = nowIso();
    saveState(fresh);
  }

  const afterDownload = loadDownloadState(capsule.id);
  active.progress = progressFor(afterDownload, itemIds);
  options.onProgress?.(active.progress);
  if (afterDownload.job) {
    afterDownload.job.status = options.skipIndex ? "complete" : "indexing";
    afterDownload.job.updated_at = nowIso();
    saveState(afterDownload);
  }
  if (!options.skipIndex) {
    if (options.indexInWorker) {
      await buildIndexInWorker(capsule.id);
    } else {
      await buildIndexFromDownloads(capsule.id, { lockHeld: true });
    }
  }
  const done = loadDownloadState(capsule.id);
  if (done.job) {
    done.job.status = "complete";
    done.job.updated_at = nowIso();
  }
  saveState(done);
  writeReport(capsule, done);
  appendLogEvent("imports", {
    command: "download",
    corpus_id: capsule.id,
    result_count: progressFor(done, itemIds).text,
    duration_ms: Date.now() - started
  });
}

async function buildIndexInWorker(corpusId: string): Promise<void> {
  const { Worker } = await import("node:worker_threads");
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL("./indexWorker.js", import.meta.url), {
      workerData: { corpusId },
      env: process.env
    });
    worker.once("message", (message: { ok: boolean; error?: string }) => {
      if (message.ok) resolve();
      else reject(new Error(message.error ?? "Index build failed"));
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Index worker exited with code ${code}`));
    });
  });
}

function applyTextWindow(text: string, window: NonNullable<ItemRule["text_window"]>): string | null {
  const start = text.indexOf(window.start);
  if (start < 0) return null;
  const end = window.end ? text.indexOf(window.end, start + window.start.length) : -1;
  return text.slice(start, end > start ? end : undefined).trim();
}

function applyRule(documents: GenericDocumentInput[], rule: ItemRule | null, warnings: string[], itemId: string): GenericDocumentInput[] {
  if (!rule) return documents;
  let result = documents;
  if (rule.document_filter) {
    const sorted = [...result].sort((a, b) => a.id.localeCompare(b.id));
    const include = rule.document_filter.include_ids ? new Set(rule.document_filter.include_ids) : null;
    const every = rule.document_filter.every_nth;
    result = sorted.filter((document, index) => (include ? include.has(document.id) : true) && (every ? index % every === 0 : true));
  }
  if (rule.text_window) {
    const window = rule.text_window;
    result = result.flatMap((document) => {
      const text = applyTextWindow(document.text, window);
      if (!text) {
        warnings.push(`${itemId}: sample markers not found; item left out of the sample`);
        return [];
      }
      return [{ ...document, text, chunks: undefined, metadata: { ...document.metadata, sample_window: window } }];
    });
  }
  return result;
}

/** Which rule applies to an item across all approvals: a full approval wins over a sample. */
function effectiveRules(state: DownloadStateV2): Map<string, ItemRule | null> {
  // null means "use the whole item".
  const rules = new Map<string, ItemRule | null>();
  for (const approval of state.approvals) {
    for (const id of approval.item_ids) {
      const rule = approval.coverage === "sample" ? approval.rules[id] ?? null : null;
      if (!rules.has(id) || rule === null) rules.set(id, rule);
    }
  }
  return rules;
}

function coverageLabel(state: DownloadStateV2, manifest: SourceManifest, missing: string[]): string {
  const fullSet = new Set(selectedManifestItems(manifest).filter(canDownloadText).map((item) => item.id));
  const fullyApproved = state.approvals.some((approval) => approval.coverage === "selected-set");
  const allFullText = [...fullSet].every((id) => state.items[id]?.status === "text" || state.items[id]?.status === "no_text");
  if (fullyApproved && allFullText && missing.length === 0) return "selected-set";
  if (state.approvals.every((approval) => approval.coverage === "sample")) return missing.length ? "sample-partial" : "sample";
  return "partial-selection";
}

/**
 * Rebuild the search file from every approved item already downloaded,
 * reading only local files (no network). Earlier approvals are kept.
 */
export async function collectIndexDocuments(corpusId: string) {
  const capsule = getCorpusCapsule(corpusId);
  const manifest = loadSourceManifest(capsule);
  const state = loadDownloadState(corpusId);
  const rules = effectiveRules(state);
  const byId = new Map(manifest.items.map((item) => [item.id, item]));
  const documents: GenericDocumentInput[] = [];
  const warnings: string[] = [];
  const missing: string[] = [];
  let itemsIndexed = 0;
  const http: HttpContext = { allowedDomains: allowedDomainsFor(manifest), offline: true };
  const { getSourceAdapter } = await import("./adapters.js");
  for (const [id, rule] of rules) {
    const item = byId.get(id);
    if (!item || state.items[id]?.status !== "text") continue;
    try {
      const adapter = getSourceAdapter(item.source_type);
      const fetched = await adapter.fetchItem(item, { rawRoot: rawRoot(corpusId), normalizedRoot: normalizedRoot(corpusId), http, capsule });
      const normalized = applyRule(adapter.normalize(fetched), rule, warnings, id);
      if (normalized.length) itemsIndexed += 1;
      documents.push(...normalized);
    } catch (error) {
      missing.push(id);
      warnings.push(error instanceof OfflineCacheMissError || /Not downloaded yet/.test(String(error))
        ? `${id}: downloaded file is missing or changed; download again to include it`
        : `${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (capsule.id === "vangogh-letters") {
    const { hasVanGoghLocalImport } = await import("../vangogh/import.js");
    if (hasVanGoghLocalImport()) warnings.push("Letters imported from a local folder are indexed separately with `dialogues corpus import vangogh-letters`.");
  }
  const seen = new Set<string>();
  const unique = documents.filter((document) => (seen.has(document.id) ? false : (seen.add(document.id), true)));
  return { capsule, manifest, state, documents: unique, warnings, missing, itemsIndexed };
}

export async function buildIndexFromDownloads(
  corpusId: string,
  options: { lockHeld?: boolean } = {}
): Promise<GenericIndexStats & { warnings: string[]; coverage: string }> {
  const collected = await collectIndexDocuments(corpusId);
  // Never shrink what is searchable: documents already in the search file whose
  // source text is not on this computer (e.g. from an earlier install) are kept
  // as they are.
  if (fs.existsSync(collected.capsule.indexPath)) {
    const current = new GenericIndex(collected.capsule);
    try {
      const kept = current.exportDocuments(new Set(collected.documents.map((document) => document.id)));
      if (kept.length) {
        collected.documents.push(...kept);
        collected.warnings.push(`${kept.length} document(s) were kept from the previous search file because their source text is not on this computer.`);
      }
    } finally {
      current.close();
    }
  }
  if (collected.documents.length === 0) {
    throw new Error(`Nothing downloaded for ${corpusId} has searchable text yet; the previous search file was kept.${collected.warnings.length ? ` ${collected.warnings.slice(0, 5).join("; ")}` : ""}`);
  }
  const coverage = coverageLabel(collected.state, collected.manifest, collected.missing);
  const run = () => reindexGenericCorpus(collected.capsule, collected.documents, {
    coverage,
    selection: {
      approved_selection_ids: collected.state.approvals.map((approval) => approval.selection_id),
      items_missing: collected.missing
    },
    lockHeld: options.lockHeld
  });
  const stats = options.lockHeld ? run() : withCorpusWriter(corpusId, "rebuilding the search file", run);
  const generation = getIndexGeneration(collected.capsule);
  const state = loadDownloadState(corpusId);
  state.index = {
    generation_id: generation?.generation_id ?? null,
    built_at: nowIso(),
    coverage,
    approved_selection_ids: collected.state.approvals.map((approval) => approval.selection_id),
    documents: stats.documents,
    chunks: stats.chunks,
    items_indexed: collected.itemsIndexed,
    items_missing: collected.missing
  };
  saveState(state);
  return { ...stats, warnings: collected.warnings, coverage };
}

function writeReport(capsule: CorpusCapsule, state: DownloadStateV2): void {
  const counts = Object.values(state.items).reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
  const lines = [
    `# Source Download Report: ${capsule.id}`,
    "",
    `Report written: ${nowIso()} (this is not a consent record; see consents.jsonl)`,
    "",
    "## Approved selections",
    "",
    ...state.approvals.map((approval) => `- ${approval.label} [${approval.coverage}] agreed ${approval.consented_at ?? "before consent records were kept"}`),
    "",
    "## Items",
    "",
    ...Object.entries(counts).map(([status, count]) => `- ${status}: ${count}`),
    "",
    "## Not downloaded",
    "",
    ...(Object.entries(state.items).filter(([, item]) => item.status !== "text").map(([id, item]) => `- ${id}: ${item.status}${item.last_error ? ` (${item.last_error})` : ""}`)),
    "",
    "## Search file",
    "",
    state.index ? `- ${state.index.documents} documents, ${state.index.chunks} passages, coverage: ${state.index.coverage}` : "- not built"
  ];
  writeFileAtomic(reportPath(capsule.id), `${lines.join("\n")}\n`);
}

export type DownloadStatusResponse = ReturnType<typeof downloadStatus>;

export function downloadStatus(corpusId: string) {
  const state = loadDownloadState(corpusId);
  const job = state.job;
  const active = activeJobs.get(corpusId);
  const itemIds = job?.item_ids ?? [];
  const progress = active?.progress ?? progressFor(state, itemIds);
  const effectiveStatus: JobStatus | "none" = !job ? "none" : job.status === "running" && !active ? "interrupted" : job.status;
  return {
    corpus_id: corpusId,
    status: effectiveStatus,
    selection_id: job?.selection_id ?? null,
    progress,
    error: job?.error ?? null,
    continuation: job && (effectiveStatus === "interrupted" || effectiveStatus === "running" || effectiveStatus === "indexing")
      ? encodeContinuation(corpusId, job.selection_id)
      : null
  };
}

/** Wait for an active job, but never longer than `budgetMs`. */
export async function waitForDownload(corpusId: string, budgetMs: number): Promise<DownloadStatusResponse> {
  const active = activeJobs.get(corpusId);
  if (active) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      active.promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, budgetMs));
      })
    ]);
    if (timer) clearTimeout(timer);
  }
  return downloadStatus(corpusId);
}

export type SourceDownloadOptions = {
  mode?: string;
  path?: string;
  sample?: boolean;
  itemIds?: string[];
  confirmedRights?: boolean;
  force?: boolean;
  skipIndex?: boolean;
  dryRun?: boolean;
  channel?: string;
  allowExternalManifest?: boolean;
  onProgress?: (progress: JobProgress) => void;
  http?: Partial<HttpContext>;
};

export function specFromOptions(options: { mode?: string; path?: string; sample?: boolean; itemIds?: string[] }): SelectionSpec {
  if (options.sample) return { kind: "sample" };
  if (options.itemIds?.length) return { kind: "items", itemIds: options.itemIds };
  return { kind: "set", mode: options.mode, path: options.path };
}

/** Run a download to completion (CLI and tests). */
export async function downloadFromSourceManifest(corpusId: string, options: SourceDownloadOptions = {}) {
  const spec = specFromOptions(options);
  const preview = previewDownload(corpusId, spec);
  if (options.dryRun) {
    return { ...preview, dry_run: true, next_step: "Re-run with --yes after reviewing the notice to download." };
  }
  if (!options.confirmedRights) {
    return {
      ...preview,
      ok: false,
      needs_confirmation: true,
      next_step: "Ask the user to agree to this notice, then call again with confirmedRights: true."
    };
  }
  const started = startDownload(corpusId, spec, {
    confirmedRights: true,
    channel: options.channel ?? "cli",
    force: options.force,
    skipIndex: options.skipIndex,
    allowExternalManifest: options.allowExternalManifest,
    onProgress: options.onProgress,
    http: options.http
  });
  const active = activeJobs.get(corpusId);
  await active?.promise;
  const status = downloadStatus(corpusId);
  const state = loadDownloadState(corpusId);
  const selectionItems = preview.items.map((item) => item.id);
  const failed = selectionItems.filter((id) => state.items[id]?.status === "failed").map((id) => ({ id, reason: state.items[id]?.last_error ?? "failed" }));
  const noText = selectionItems.filter((id) => ["no_text", "blocked"].includes(state.items[id]?.status ?? "")).map((id) => ({ id, reason: state.items[id]?.last_error ?? "no text", status: state.items[id]?.status ?? "no_text" }));
  const downloaded = selectionItems.filter((id) => state.items[id]?.status === "text").map((id) => ({ id, text_path: state.items[id]?.text_path, raw_path: state.items[id]?.raw_path, status: "text" }));
  const indexStats = getGenericIndexStats(getCorpusCapsule(corpusId));
  const ok = status.status === "complete" && failed.length === 0;
  return {
    ok,
    corpus_id: corpusId,
    selection_id: "selection_id" in started ? started.selection_id : preview.selection_id,
    selection: preview.selection,
    coverage: preview.coverage,
    rights_notice: preview.rights_notice,
    source_count: preview.source_count,
    downloaded,
    skipped: failed,
    no_text: noText,
    rights_summary: preview.rights_summary,
    status: status.status,
    error: status.error,
    indexed: indexStats.indexed && !options.skipIndex && status.status === "complete",
    index: indexStats,
    index_coverage: state.index?.coverage ?? null,
    download_report_path: reportPath(corpusId),
    source_state_path: statePath(corpusId),
    next_step: options.skipIndex
      ? `Run dialogues reindex ${corpusId} to build the search file.`
      : failed.length
        ? `Some items failed. Run the same download again to retry them; the search file includes everything downloaded so far.`
        : `Call get_corpus_guide for ${corpusId}, then search and fetch with citations.`
  };
}

export type DownloadOptionsResponse = ReturnType<typeof listDownloadOptions>;

export function listDownloadOptions(corpusId: string) {
  const capsule = getCorpusCapsule(corpusId);
  const manifest = tryLoadSourceManifest(capsule);
  if (!manifest) {
    return {
      ok: true as const,
      corpus_id: capsule.id,
      default_mode: null,
      modes: [] as Array<{ id: string; description?: string; visible_to_users: boolean }>,
      paths: [] as Array<{ id: string; title: string; point?: string; items: number }>,
      sample: null,
      rights_summary: {} as Record<string, number>,
      downloadable: false,
      download_policy: capsule.manifest.download_policy ?? "user_supplied_only",
      note: "This collection has no source list. Import your own permitted files with import_folder."
    };
  }
  const sample = loadSampleProfile(capsule, manifest);
  const selectedItems = manifest.items.filter((item) => item.selected);
  return {
    ok: true as const,
    corpus_id: capsule.id,
    default_mode: manifest.default_mode,
    modes: Object.entries(manifest.download_modes)
      .filter(([, mode]) => mode.visible_to_users !== false)
      .map(([id, mode]) => ({ id, description: mode.description, visible_to_users: mode.visible_to_users !== false })),
    paths: Object.entries(manifest.paths).map(([id, sourcePath]) => ({
      id,
      title: sourcePath.title,
      point: sourcePath.point,
      items: manifest.items.filter((item) => item.selected && (item.paths ?? []).includes(id)).length
    })),
    sample: sample
      ? { title: sample.title, summary: sample.summary, items: sample.items.length, download_bytes: sample.download_bytes, download_note: sample.download_note, profile_version: sample.profile_version }
      : null,
    rights_summary: rightsSummary(selectedItems),
    downloadable: (capsule.manifest.downloadable ?? true) && selectedItems.some(canDownloadText),
    download_policy: capsule.manifest.download_policy ?? "curated_public_source",
    source_policy: manifest.source_policy
  };
}

function directorySize(rootPath: string): { files: number; bytes: number } {
  if (!fs.existsSync(rootPath)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(fullPath).size;
      }
    }
  };
  visit(rootPath);
  return { files, bytes };
}

export type CollectionState = "catalog_only" | "user_supplied" | "not_downloaded" | "sample" | "partial_selection" | "selected_set_complete";

export function collectionState(capsule: CorpusCapsule): { state: CollectionState; manifest: SourceManifest | null; download: DownloadStateV2 | null } {
  const manifest = tryLoadSourceManifest(capsule);
  const policy = capsule.manifest.download_policy;
  if (!manifest) {
    return { state: policy === "catalog_only" ? "catalog_only" : "user_supplied", manifest: null, download: null };
  }
  const textItems = selectedManifestItems(manifest).filter(canDownloadText);
  if (policy === "catalog_only" || capsule.manifest.downloadable === false || textItems.length === 0) {
    return { state: "catalog_only", manifest, download: null };
  }
  const download = loadDownloadState(capsule.id);
  const coverage = download.index?.coverage ?? null;
  if (!coverage) return { state: "not_downloaded", manifest, download };
  if (coverage === "selected-set") return { state: "selected_set_complete", manifest, download };
  if (coverage.startsWith("sample")) return { state: "sample", manifest, download };
  return { state: "partial_selection", manifest, download };
}

export function sourceStatus(corpusId: string) {
  const capsule = getCorpusCapsule(corpusId);
  const manifest = tryLoadSourceManifest(capsule);
  const state = loadDownloadState(capsule.id);
  const stats = getGenericIndexStats(capsule);
  const cache = directorySize(sourceCacheRoot(capsule.id));
  const selected = manifest ? selectedManifestItems(manifest) : [];
  const statusCounts = { text: 0, no_text: 0, failed: 0, blocked: 0, pending: 0 };
  for (const item of Object.values(state.items)) statusCounts[item.status] += 1;
  const textInSelected = selected.filter((item) => state.items[item.id]?.status === "text").length;
  const consents = readConsentRecords(capsule.id);
  return {
    ok: true,
    corpus_id: capsule.id,
    has_source_manifest: Boolean(manifest),
    // A migrated or imported index with no download record is still searchable.
    collection_state: ((s) => (s === "not_downloaded" && stats.indexed ? "partial_selection" : s))(collectionState(capsule).state),
    selected_source_items: manifest ? selected.length : null,
    manifest_items: manifest?.items.length ?? null,
    available_paths: manifest ? Object.keys(manifest.paths) : [],
    approved_selections: state.approvals.map((approval) => ({
      selection_id: approval.selection_id,
      label: approval.label,
      coverage: approval.coverage,
      items: approval.item_ids.length,
      consented_at: approval.consented_at,
      consent_channel: approval.consent_channel
    })),
    downloaded_items: statusCounts.text,
    no_text_items: statusCounts.no_text,
    blocked_items: statusCounts.blocked,
    failed_items: statusCounts.failed,
    pending_items: statusCounts.pending,
    // Kept for older clients: failed items were called "skipped".
    skipped_items: statusCounts.failed,
    selected_source_percent: manifest && selected.length ? Math.round((textInSelected / selected.length) * 1000) / 10 : null,
    full_archive_total: null,
    full_archive_percent: null,
    coverage_note: manifest
      ? "Counts describe the curated source list shipped with Dialogues, not the full external archive."
      : "No source list is available, so selected-set and full-archive coverage are not tracked here.",
    job: downloadStatus(capsule.id),
    search_file: state.index
      ? { coverage: state.index.coverage, built_at: state.index.built_at, documents: state.index.documents, chunks: state.index.chunks, items_missing: state.index.items_missing }
      : null,
    source_cache_files: cache.files,
    source_cache_bytes: cache.bytes,
    rights_confirmation_timestamp: consents.at(-1)?.consented_at ?? null,
    consent_records: consents.length,
    rights_summary: rightsSummary(selected),
    source_cache_path: sourceCacheRoot(capsule.id),
    download_report_path: reportPath(capsule.id),
    source_state_path: statePath(capsule.id),
    index_stats: stats
  };
}

export function sampleSummary(capsule: CorpusCapsule) {
  const manifest = tryLoadSourceManifest(capsule);
  if (!manifest) return null;
  const sample = loadSampleProfile(capsule, manifest);
  if (!sample) return null;
  return { title: sample.title, summary: sample.summary, items: sample.items.length, download_bytes: sample.download_bytes, download_note: sample.download_note, profile_version: sample.profile_version };
}

export type { SelectionSpec } from "./selection.js";
export type { SourceItem } from "./types.js";
