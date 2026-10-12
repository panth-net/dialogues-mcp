export type StableId = {
  corpusId: string;
  documentId: string;
  chunkIndex: number;
};

const MAX_ID_LENGTH = 600;
const MAX_CHUNK_INDEX = 10_000_000;

export function makeStableId(corpusId: string, documentId: string, chunkIndex: number): string {
  return `corpus:${corpusId}:doc:${documentId}:chunk:${chunkIndex}`;
}

/**
 * Passage IDs come from clients, so parse strictly: bounded length, a safe
 * corpus slug, no control characters, and a bounded chunk number. The parts
 * are only ever used as query bindings, never as paths.
 */
export function parseStableId(id: string): StableId | null {
  if (typeof id !== "string" || id.length > MAX_ID_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(id)) return null;
  const match = id.match(/^corpus:([a-z0-9][a-z0-9-]{0,99}):doc:(.+):chunk:(\d{1,8})$/);
  if (!match) return null;
  const chunkIndex = Number.parseInt(match[3], 10);
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > MAX_CHUNK_INDEX) return null;
  return {
    corpusId: match[1],
    documentId: match[2],
    chunkIndex
  };
}
