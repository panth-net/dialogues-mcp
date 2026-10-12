import path from "node:path";
import { indexesRoot, assertSafeId } from "../paths.js";
import { acquireLock } from "./files.js";

// One writer per collection: download, import, and reindex all take this
// lock. It is re-entrant within a process so a download can hold it while it
// calls the indexer.

const held = new Map<string, { depth: number; release: () => void }>();

export function corpusLockPath(corpusId: string): string {
  return path.join(indexesRoot(), assertSafeId(corpusId, "corpus ID"), ".writer.lock");
}

function enter(corpusId: string, purpose: string): () => void {
  const lockPath = corpusLockPath(corpusId);
  const current = held.get(lockPath);
  if (current) {
    current.depth += 1;
  } else {
    held.set(lockPath, { depth: 1, release: acquireLock(lockPath, purpose) });
  }
  return () => {
    const entry = held.get(lockPath);
    if (!entry) return;
    entry.depth -= 1;
    if (entry.depth === 0) {
      held.delete(lockPath);
      entry.release();
    }
  };
}

export function withCorpusWriter<T>(corpusId: string, purpose: string, fn: () => T): T {
  const leave = enter(corpusId, purpose);
  let result: T;
  try {
    result = fn();
  } catch (error) {
    leave();
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(leave) as T;
  }
  leave();
  return result;
}
