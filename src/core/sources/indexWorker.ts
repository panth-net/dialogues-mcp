import { parentPort, workerData } from "node:worker_threads";
import { buildIndexFromDownloads } from "./download.js";

// Builds a collection's search file off the MCP server's main thread, so a
// long build never blocks other requests. The parent job holds the writer lock.

const { corpusId } = workerData as { corpusId: string };

buildIndexFromDownloads(corpusId, { lockHeld: true })
  .then(() => parentPort?.postMessage({ ok: true }))
  .catch((error: unknown) => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }));
