import fs from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import { readJsonFile, sha256File, sha256Text, writeFileAtomic, writeJsonAtomic } from "../state/files.js";

// Every outbound request for source text goes through here. Manifests and
// remote links are treated as data: each hop (including redirects and text
// links discovered inside downloaded JSON) must use http(s), stay on the
// collection's allowed hosts, and must not resolve to a private or loopback
// address. Requests have connect and body deadlines, a byte cap, per-host
// pacing, and Retry-After-aware retries.

export const USER_AGENT = "Dialogues-MCP (local-first corpus downloader; +https://github.com/panth-net/dialogues-mcp)";

export type HttpContext = {
  /** Registrable domains (e.g. "loc.gov") whose hosts may be contacted. */
  allowedDomains: string[];
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  bodyTimeoutMs?: number;
  maxBytes?: number;
  maxAttempts?: number;
  /** Cache-only mode used when rebuilding an index from downloaded files. */
  offline?: boolean;
  /** Test hook: replace the network. */
  fetchImpl?: typeof fetch;
  /** Test hook: skip DNS-based private address checks. */
  skipDnsCheck?: boolean;
  /** Override the minimum delay between requests to one host. */
  minIntervalMs?: number;
};

export class SourceFetchError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
  }
}

export class OfflineCacheMissError extends Error {
  constructor(url: string) {
    super(`Not downloaded yet: ${redactUrl(url)}`);
  }
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
export const DEFAULT_BODY_TIMEOUT_MS = 180_000;
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_RETRY_AFTER_MS = 60_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_HOST_INTERVAL_MS = 400;
const HOST_INTERVAL_MS: Record<string, number> = {
  "loc.gov": 1000,
  "archive.org": 750,
  "gutenberg.org": 750
};

export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid url]";
  }
}

const MULTI_LABEL_SUFFIXES = new Set(["ac.uk", "co.uk", "org.uk", "gov.uk", "ac.jp", "co.jp", "com.au", "org.au", "edu.au", "ac.in", "gov.in", "co.in", "ac.za", "org.za", "co.za", "ac.nz", "co.nz"]);

/** Approximate registrable domain: enough to group a source's hosts. */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

export function hostAllowed(hostname: string, allowedDomains: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function ipv4Private(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

/** Loopback, private, link-local, unique-local, multicast, and mapped forms. */
export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return ipv4Private(address);
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipv4Private(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) return true;
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower) || lower.startsWith("64:ff9b:") || lower.startsWith("2001:db8");
  }
  return true;
}

export async function assertUrlAllowed(rawUrl: string, ctx: HttpContext): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SourceFetchError("Source URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SourceFetchError(`Source URL scheme ${url.protocol} is not allowed.`);
  }
  if (url.username || url.password) throw new SourceFetchError("Source URLs must not contain credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan)$/i.test(host)) {
    throw new SourceFetchError(`Source host ${host} is a local network name.`);
  }
  if (net.isIP(host)) {
    throw new SourceFetchError("Source URLs must use a host name, not an IP address.");
  }
  if (!hostAllowed(host, ctx.allowedDomains)) {
    throw new SourceFetchError(`Source host ${host} is not one of this collection's sources (${ctx.allowedDomains.join(", ") || "none"}).`);
  }
  if (!ctx.skipDnsCheck && !ctx.fetchImpl) {
    const addresses = await dns.lookup(host, { all: true, verbatim: true }).catch(() => [] as Array<{ address: string }>);
    if (addresses.length && addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new SourceFetchError(`Source host ${host} resolves to a private or local address.`);
    }
  }
  return url;
}

const lastRequestAt = new Map<string, number>();

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function paceHost(hostname: string, signal?: AbortSignal, override?: number): Promise<void> {
  const domain = registrableDomain(hostname);
  const interval = override ?? HOST_INTERVAL_MS[domain] ?? DEFAULT_HOST_INTERVAL_MS;
  const last = lastRequestAt.get(domain) ?? 0;
  const wait = last + interval - Date.now();
  lastRequestAt.set(domain, Math.max(Date.now(), last + interval));
  await sleep(wait, signal);
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
  return null;
}

async function readBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SourceFetchError(`Source file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // Counts decompressed bytes, so compressed bombs are bounded too.
      if (total > maxBytes) {
        throw new SourceFetchError(`Source file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchOnce(startUrl: string, ctx: HttpContext): Promise<{ body: Buffer; finalUrl: string; contentType: string | null }> {
  const doFetch = ctx.fetchImpl ?? fetch;
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertUrlAllowed(current, ctx);
    await paceHost(url.hostname, ctx.signal, ctx.minIntervalMs);
    // One controller governs the request and its body. The connect deadline
    // is cleared once headers arrive; the body deadline covers the whole hop.
    const controller = new AbortController();
    const timedOut = { connect: false, body: false };
    const connectTimer = setTimeout(() => {
      timedOut.connect = true;
      controller.abort(new Error("connect timeout"));
    }, ctx.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    const bodyTimer = setTimeout(() => {
      timedOut.body = true;
      controller.abort(new Error("body timeout"));
    }, ctx.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS);
    const onOuterAbort = () => controller.abort(ctx.signal?.reason);
    ctx.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const cleanup = () => {
      clearTimeout(connectTimer);
      clearTimeout(bodyTimer);
      ctx.signal?.removeEventListener("abort", onOuterAbort);
    };
    const body = { get aborted() { return timedOut.body; } };
    const bodySignal = controller.signal;
    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/xml,application/json,text/plain,application/pdf,application/zip,*/*;q=0.8"
        }
      });
      clearTimeout(connectTimer);
    } catch (error) {
      cleanup();
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
      throw new SourceFetchError(
        timedOut.connect || timedOut.body ? `Timed out contacting ${url.hostname}` : `Network error contacting ${url.hostname}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        true
      );
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel().catch(() => undefined);
      cleanup();
      current = new URL(response.headers.get("location") as string, url).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      cleanup();
      const error = new SourceFetchError(`HTTP ${response.status} from ${redactUrl(url.toString())}`, response.status, RETRYABLE_STATUS.has(response.status));
      (error as SourceFetchError & { retryAfterMs?: number | null }).retryAfterMs = retryAfterMs(response.headers.get("retry-after"));
      throw error;
    }
    try {
      return {
        body: await readBody(response, ctx.maxBytes ?? DEFAULT_MAX_BYTES, bodySignal),
        finalUrl: url.toString(),
        contentType: response.headers.get("content-type")
      };
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
      if (error instanceof SourceFetchError) throw error;
      throw new SourceFetchError(body.aborted ? `Timed out downloading from ${url.hostname}` : `Download interrupted from ${url.hostname}`, undefined, true);
    } finally {
      cleanup();
    }
  }
  throw new SourceFetchError("Too many redirects.");
}

export async function fetchBytes(url: string, ctx: HttpContext): Promise<{ body: Buffer; finalUrl: string; contentType: string | null }> {
  if (ctx.offline) throw new OfflineCacheMissError(url);
  const attempts = Math.max(1, ctx.maxAttempts ?? 4);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchOnce(url, ctx);
    } catch (error) {
      lastError = error;
      if (ctx.signal?.aborted) throw error;
      if (!(error instanceof SourceFetchError) || !error.retryable || attempt === attempts) throw error;
      const hinted = (error as SourceFetchError & { retryAfterMs?: number | null }).retryAfterMs;
      const backoff = hinted ?? Math.min(500 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 250);
      await sleep(backoff, ctx.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchTextFromUrl(url: string, ctx: HttpContext): Promise<string> {
  return (await fetchBytes(url, ctx)).body.toString("utf8").replace(/^\uFEFF/, "");
}

type CacheSidecar = {
  source_url: string;
  final_url: string;
  sha256: string;
  bytes: number;
  fetched_at: string;
  migrated?: boolean;
};

export const MIGRATED_UNRECORDED_URL = "unrecorded:migrated-from-earlier-install";

export function cacheSidecarPath(filePath: string): string {
  return `${filePath}.source.json`;
}

/** A cached file is reused only if it was fetched from the same URL and is intact. */
export function validCachedFile(filePath: string, url: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const sidecar = readJsonFile<CacheSidecar>(cacheSidecarPath(filePath));
  if (sidecar.status !== "ok") return false;
  // Files migrated from a pre-1.0 install have no recorded URL; they are
  // accepted for the same collection and file name only if intact.
  const migratedUnrecorded = sidecar.value.migrated === true && sidecar.value.source_url === MIGRATED_UNRECORDED_URL;
  if (sidecar.value.source_url !== url && !migratedUnrecorded) return false;
  try {
    return fs.statSync(filePath).size === sidecar.value.bytes && sha256File(filePath) === sidecar.value.sha256;
  } catch {
    return false;
  }
}

export function writeCacheSidecar(filePath: string, sourceUrl: string, finalUrl: string, extra: Partial<CacheSidecar> = {}): void {
  writeJsonAtomic(cacheSidecarPath(filePath), {
    source_url: sourceUrl,
    final_url: finalUrl,
    sha256: sha256File(filePath),
    bytes: fs.statSync(filePath).size,
    fetched_at: new Date().toISOString(),
    ...extra
  } satisfies CacheSidecar);
}

/**
 * Return cached bytes when the cache provably matches `url`; otherwise fetch,
 * then write atomically. A failed refresh leaves the previous cache intact.
 */
export async function cachedFetch(filePath: string, url: string, ctx: HttpContext & { force?: boolean }): Promise<Buffer> {
  if (!ctx.force && validCachedFile(filePath, url)) return fs.readFileSync(filePath);
  if (ctx.offline && !ctx.force && fs.existsSync(filePath)) {
    // Offline rebuilds may use a file whose sidecar is missing only if it
    // was explicitly migrated; otherwise it is treated as not downloaded.
    throw new OfflineCacheMissError(url);
  }
  const fetched = await fetchBytes(url, ctx);
  writeFileAtomic(filePath, fetched.body);
  writeCacheSidecar(filePath, url, fetched.finalUrl);
  return fetched.body;
}

export async function cachedFetchText(filePath: string, url: string, ctx: HttpContext & { force?: boolean }): Promise<string> {
  return (await cachedFetch(filePath, url, ctx)).toString("utf8").replace(/^\uFEFF/, "");
}

export function contentDigest(value: string | Uint8Array): string {
  return sha256Text(value);
}
