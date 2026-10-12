import fs from "node:fs";
import path from "node:path";
import { getCorpusCapsule } from "../corpus/loader.js";
import { getSourceAdapter } from "../sources/adapters.js";
import { canDownloadText, rightsLevelForItem, rightsSummary } from "../sources/rights.js";
import { loadSourceManifest, selectedManifestItems } from "../sources/sourceManifest.js";
import { harvestRoot, openCandidateDb, upsertCandidate } from "./candidateDb.js";
import { allowedDomainsFor } from "../sources/download.js";

export type HarvestOptions = {
  mode?: string;
  path?: string;
  yes?: boolean;
  force?: boolean;
};

function rawRoot(corpusId: string): string {
  return path.join(harvestRoot(corpusId), "raw");
}

function normalizedRoot(corpusId: string): string {
  return path.join(harvestRoot(corpusId), "normalized");
}

function reportPath(corpusId: string): string {
  return path.join(harvestRoot(corpusId), "harvest-report.md");
}

function recordsPath(corpusId: string): string {
  return path.join(harvestRoot(corpusId), "source-records.jsonl");
}

function appendJsonl(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function writeHarvestReport(input: {
  corpusId: string;
  mode: string;
  pathId?: string;
  text: number;
  metadataOnly: number;
  imagesOnly: number;
  transcriptionMissing: number;
  rightsBlocked: number;
  errors: Array<{ id: string; reason: string }>;
  rightsSummary: Record<string, number>;
}): void {
  const lines = [
    `# Harvest Report: ${input.corpusId}`,
    "",
    `Generated: ${new Date().toISOString()}`,
    `Mode: ${input.mode}`,
    `Path: ${input.pathId ?? "all"}`,
    "",
    "## Summary",
    "",
    `- Items with text: ${input.text}`,
    `- Metadata only: ${input.metadataOnly}`,
    `- Images only: ${input.imagesOnly}`,
    `- Transcription missing: ${input.transcriptionMissing}`,
    `- Rights blocked: ${input.rightsBlocked}`,
    `- Errors: ${input.errors.length}`,
    "",
    "## Rights Summary",
    "",
    ...Object.entries(input.rightsSummary).map(([rights, count]) => `- ${rights}: ${count}`),
    "",
    "## Errors",
    "",
    ...(input.errors.length ? input.errors.map((item) => `- ${item.id}: ${item.reason}`) : ["- None"])
  ];
  fs.mkdirSync(harvestRoot(input.corpusId), { recursive: true });
  fs.writeFileSync(reportPath(input.corpusId), `${lines.join("\n")}\n`, "utf8");
}

export async function harvestSources(corpusId: string, options: HarvestOptions = {}) {
  if (!options.yes) {
    throw new Error("Harvest is curator-only and can download broad candidate source material. Re-run with --yes after confirming source terms.");
  }
  const capsule = getCorpusCapsule(corpusId);
  const manifest = loadSourceManifest(capsule);
  const mode = options.mode ?? "full-dev";
  const items = selectedManifestItems(manifest, { mode, path: options.path });
  const db = openCandidateDb(corpusId);
  fs.mkdirSync(rawRoot(corpusId), { recursive: true });
  fs.mkdirSync(normalizedRoot(corpusId), { recursive: true });
  fs.writeFileSync(recordsPath(corpusId), "", "utf8");

  let text = 0;
  let metadataOnly = 0;
  let imagesOnly = 0;
  let transcriptionMissing = 0;
  let rightsBlocked = 0;
  const errors: Array<{ id: string; reason: string }> = [];

  try {
    for (const item of items) {
      try {
        if (!canDownloadText(item)) {
          rightsBlocked += rightsLevelForItem(item) === "borrow_only" ? 1 : 0;
          metadataOnly += rightsLevelForItem(item) === "catalog_only" ? 1 : 0;
          upsertCandidate(db, corpusId, item, {
            extractionStatus: rightsLevelForItem(item),
            metadata: item.metadata
          });
          appendJsonl(recordsPath(corpusId), {
            id: item.id,
            source_url: item.url ?? item.api_url ?? null,
            status: rightsLevelForItem(item),
            rights_level: rightsLevelForItem(item)
          });
          continue;
        }
        const adapter = getSourceAdapter(item.source_type);
        const fetched = await adapter.fetchItem(item, {
          rawRoot: rawRoot(corpusId),
          normalizedRoot: normalizedRoot(corpusId),
          force: options.force,
          http: { allowedDomains: allowedDomainsFor(manifest) }
        });
        if (fetched.status === "text") text += 1;
        else if (fetched.status === "metadata_only") {
          metadataOnly += 1;
          transcriptionMissing += 1;
        } else if (fetched.status === "rights_blocked") {
          rightsBlocked += 1;
        }
        upsertCandidate(db, corpusId, item, {
          extractionStatus: fetched.status,
          textPath: fetched.textPath,
          rawPath: fetched.rawPath,
          metadata: fetched.metadata
        });
        appendJsonl(recordsPath(corpusId), {
          id: item.id,
          source_type: item.source_type,
          source_url: item.url ?? item.api_url ?? null,
          title: item.title,
          date: item.date,
          author: item.author,
          document_type: item.document_type,
          rights_level: rightsLevelForItem(item),
          extraction_status: fetched.status,
          text_path: fetched.textPath ?? null,
          raw_path: fetched.rawPath ?? null,
          warnings: fetched.warnings
        });
      } catch (error) {
        errors.push({ id: item.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    db.close();
  }

  writeHarvestReport({
    corpusId,
    mode,
    pathId: options.path,
    text,
    metadataOnly,
    imagesOnly,
    transcriptionMissing,
    rightsBlocked,
    errors,
    rightsSummary: rightsSummary(items)
  });

  return {
    ok: errors.length === 0,
    corpus_id: corpusId,
    mode,
    path: options.path ?? null,
    items: items.length,
    text,
    metadata_only: metadataOnly,
    images_only: imagesOnly,
    transcription_missing: transcriptionMissing,
    rights_blocked: rightsBlocked,
    errors,
    harvest_path: harvestRoot(corpusId),
    candidates_db_path: path.join(harvestRoot(corpusId), "candidates.sqlite"),
    harvest_report_path: reportPath(corpusId),
    source_records_path: recordsPath(corpusId)
  };
}
