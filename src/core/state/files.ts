import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

/**
 * Rename with short retries. Windows refuses to replace a file another
 * process holds open; antivirus scanners cause the same transient errors.
 */
export function renameWithRetry(from: string, to: string, attempts = 20): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !isRetryableFsError(error)) throw error;
      sleepSync(Math.min(50 * attempt, 400));
    }
  }
}

export function tempSibling(filePath: string, label = "tmp"): string {
  return `${filePath}.${label}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

/** Write to a sibling temp file, flush, then rename into place. */
export function writeFileAtomic(filePath: string, content: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = tempSibling(filePath);
  try {
    const fd = fs.openSync(tmp, "wx");
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, filePath);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export type JsonReadResult<T> =
  | { status: "missing" }
  | { status: "ok"; value: T }
  | { status: "corrupt"; error: string };

/** Distinguishes a missing file from a corrupt one so callers never reset state silently. */
export function readJsonFile<T = unknown>(filePath: string): JsonReadResult<T> {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "corrupt", error: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { status: "ok", value: JSON.parse(text.replace(/^\uFEFF/, "")) as T };
  } catch (error) {
    return { status: "corrupt", error: error instanceof Error ? error.message : String(error) };
  }
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function sha256Text(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

type LockRecord = { pid: number; acquired_at: string; purpose: string };

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class LockBusyError extends Error {
  constructor(readonly lockPath: string, readonly holder: LockRecord | null) {
    super(
      holder
        ? `Another Dialogues process (pid ${holder.pid}) is already ${holder.purpose} since ${holder.acquired_at}. Try again when it finishes.`
        : "Another Dialogues process is already changing this collection. Try again when it finishes."
    );
  }
}

const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

/**
 * Exclusive writer lock based on an O_EXCL lock file. A lock left behind by a
 * dead process (or older than six hours) is taken over.
 */
export function acquireLock(lockPath: string, purpose: string): () => void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const record: LockRecord = { pid: process.pid, acquired_at: new Date().toISOString(), purpose };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify(record));
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fs.rmSync(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readJsonFile<LockRecord>(lockPath);
      const holder = existing.status === "ok" ? existing.value : null;
      const age = holder ? Date.now() - Date.parse(holder.acquired_at) : Number.POSITIVE_INFINITY;
      const stale = !holder || !processAlive(holder.pid) || age > STALE_LOCK_MS;
      if (!stale || attempt > 0) throw new LockBusyError(lockPath, holder);
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new LockBusyError(lockPath, null);
}

export function withLock<T>(lockPath: string, purpose: string, fn: () => T): T {
  const release = acquireLock(lockPath, purpose);
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(release) as T;
    }
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}
