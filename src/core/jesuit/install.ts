import path from "node:path";
import { JESUIT_CORPUS_ID, JESUIT_VOLUME_COUNT, jesuitArchiveId, jesuitArchiveTextUrl, jesuitArchiveUrl } from "./sources.js";

// Jesuit Relations downloads now use the shared source-manifest pipeline
// (corpora/jesuit-relations/source-manifest.yaml). This module only knows
// where pre-1.0 versions kept their files, for migration.

export type LegacyJesuitSource = {
  volume: number;
  id: string;
  title: string;
  archiveUrl: string;
  textUrl: string;
  rawPath: string;
  cleanPath: string;
};

/** File locations used by pre-1.0 checkouts: corpora/jesuit-relations/data/. */
export function legacyJesuitSources(packageRoot: string): LegacyJesuitSource[] {
  const dataRoot = path.join(packageRoot, "corpora", JESUIT_CORPUS_ID, "data");
  return Array.from({ length: JESUIT_VOLUME_COUNT }, (_, index) => {
    const volume = index + 1;
    const id = jesuitArchiveId(volume);
    return {
      volume,
      id,
      title: `The Jesuit Relations and Allied Documents, Volume ${volume}`,
      archiveUrl: jesuitArchiveUrl(id),
      textUrl: jesuitArchiveTextUrl(id),
      rawPath: path.join(dataRoot, "raw", `${id}_djvu.txt`),
      cleanPath: path.join(dataRoot, "clean", `${id}.txt`)
    };
  });
}
