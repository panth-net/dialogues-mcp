import fs from "node:fs";
import path from "node:path";
import { logsRoot, userHome } from "../paths.js";
import { renameWithRetry } from "../state/files.js";

// Operation logs stay in <data-dir>/logs. They can contain search queries,
// passage IDs, paths, timings, and error messages, which may be sensitive, but
// never document text. DIALOGUES_LOG=off disables them; DIALOGUES_LOG=errors
// keeps only errors. Each file rotates at LOG_ROTATE_BYTES, keeping one
// previous file.

export type LogKind = "imports" | "searches" | "fetches" | "errors";

export type LogEvent = {
  event_id: string;
  timestamp: string;
  kind: LogKind;
  command?: string;
  tool?: string;
  corpus_id?: string;
  query?: string;
  result_count?: number;
  fetched_id?: string;
  context_window?: number;
  error?: string;
  index_path?: string;
  duration_ms?: number;
  [key: string]: unknown;
};

const LOG_KINDS: LogKind[] = ["imports", "searches", "fetches", "errors"];
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const MAX_STRING = 1000;
// Fields that could carry document text are dropped, whatever the caller passes.
const FORBIDDEN_KEYS = /^(text|text_raw|text_norm|passage|passages|content|body|snippet|document_text)$/i;

export function logMode(): "all" | "errors" | "off" {
  const value = (process.env.DIALOGUES_LOG ?? "").trim().toLowerCase();
  if (value === "off" || value === "0" || value === "false") return "off";
  if (value === "errors") return "errors";
  return "all";
}

export function logPath(kind: LogKind): string {
  return path.join(logsRoot(), `${kind}.jsonl`);
}

function eventId(kind: LogKind): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `evt_${kind}_${stamp}_${suffix}`;
}

/** Remove URL credentials and query strings, shorten home paths, and cap length. */
export function sanitizeLogString(value: string): string {
  let text = value.replace(/\b(https?:\/\/)([^\s/@]+@)?([^\s?#]+)(\?[^\s#]*)?(#\S*)?/gi, (_match, scheme: string, _auth, rest: string) => `${scheme}${rest}`);
  const home = userHome();
  if (home && home.length > 3) {
    text = text.split(home).join("~");
    text = text.split(home.replace(/\\/g, "/")).join("~");
  }
  return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}...[truncated]` : text;
}

function sanitizeEvent(event: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (FORBIDDEN_KEYS.test(key)) continue;
    if (typeof value === "string") clean[key] = sanitizeLogString(value);
    else if (value === undefined) continue;
    else if (typeof value === "number" || typeof value === "boolean" || value === null) clean[key] = value;
    else clean[key] = sanitizeLogString(JSON.stringify(value));
  }
  return clean;
}

function rotateIfNeeded(filePath: string): void {
  try {
    if (fs.statSync(filePath).size < LOG_ROTATE_BYTES) return;
    renameWithRetry(filePath, `${filePath}.1`);
  } catch {
    // Missing file or a failed rotation must never break the operation itself.
  }
}

export function appendLogEvent(kind: LogKind, event: Omit<Partial<LogEvent>, "kind" | "event_id" | "timestamp">): LogEvent {
  const record: LogEvent = {
    event_id: eventId(kind),
    timestamp: new Date().toISOString(),
    kind,
    ...sanitizeEvent(event as Record<string, unknown>)
  };
  const mode = logMode();
  if (mode === "off" || (mode === "errors" && kind !== "errors")) return record;
  try {
    fs.mkdirSync(logsRoot(), { recursive: true });
    const filePath = logPath(kind);
    rotateIfNeeded(filePath);
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Logging is best effort; a read-only data folder must not fail a search.
  }
  return record;
}

/** Append a structured record to a named JSONL file in the logs folder. */
export function appendJsonlLog(fileName: string, value: Record<string, unknown>): string {
  const filePath = path.join(logsRoot(), fileName);
  if (logMode() === "off") return filePath;
  fs.mkdirSync(logsRoot(), { recursive: true });
  rotateIfNeeded(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(sanitizeEvent(value))}\n`, "utf8");
  return filePath;
}

function parseLine(line: string): LogEvent | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as LogEvent : null;
  } catch {
    return null;
  }
}

export function readLog(kind: LogKind): LogEvent[] {
  const filePath = logPath(kind);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).map(parseLine).filter((item): item is LogEvent => Boolean(item));
}

export function tailLogs(options: { kind?: LogKind; errors?: boolean; limit?: number } = {}): LogEvent[] {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
  const kinds = options.errors ? ["errors" as const] : options.kind ? [options.kind] : LOG_KINDS;
  return kinds
    .flatMap((kind) => readLog(kind))
    .sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")))
    .slice(-limit);
}

export function findLogEvent(eventId: string): LogEvent | null {
  for (const kind of LOG_KINDS) {
    const found = readLog(kind).find((event) => event.event_id === eventId);
    if (found) return found;
  }
  return null;
}

/** Delete operation logs (user-controlled retention). */
export function clearLogs(): string[] {
  const removed: string[] = [];
  if (!fs.existsSync(logsRoot())) return removed;
  for (const entry of fs.readdirSync(logsRoot())) {
    if (/\.jsonl(\.1)?$/.test(entry)) {
      fs.rmSync(path.join(logsRoot(), entry), { force: true });
      removed.push(entry);
    }
  }
  return removed;
}

export function formatLogEvent(event: LogEvent): string {
  const parts = [
    event.timestamp,
    event.event_id,
    event.kind,
    event.command ?? event.tool,
    event.corpus_id,
    event.query ? `query=${event.query}` : undefined,
    event.result_count !== undefined ? `results=${event.result_count}` : undefined,
    event.fetched_id ? `fetched=${event.fetched_id}` : undefined,
    event.error ? `error=${event.error}` : undefined,
    event.duration_ms !== undefined ? `${event.duration_ms}ms` : undefined
  ].filter(Boolean);
  return parts.join(" | ");
}
