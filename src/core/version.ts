import fs from "node:fs";
import { resolveFromPackage } from "./paths.js";

let cached: { name: string; version: string } | null = null;

/** Name and version come from package.json so CLI, server, and registry agree. */
export function packageInfo(): { name: string; version: string } {
  if (!cached) {
    const parsed = JSON.parse(fs.readFileSync(resolveFromPackage("package.json"), "utf8")) as { name?: string; version?: string };
    cached = { name: parsed.name ?? "dialogues-mcp", version: parsed.version ?? "0.0.0" };
  }
  return cached;
}

export function packageVersion(): string {
  return packageInfo().version;
}

// Node 22.16 is the supported floor: search depends on FTS5 in Node's bundled
// SQLite, which official Node 22 builds before 22.16 lack.
export const MIN_NODE_VERSION = "22.16.0";

export function nodeVersionSupported(version = process.versions.node): boolean {
  const [major, minor, patch] = version.split(".").map((part) => Number.parseInt(part, 10));
  const [minMajor, minMinor, minPatch] = MIN_NODE_VERSION.split(".").map((part) => Number.parseInt(part, 10));
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}
