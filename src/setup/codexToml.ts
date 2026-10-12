import { stableStringify } from "./ownership.js";
import type { ServerLaunch } from "./launch.js";

// Fallback editor for Codex's config.toml, used only when the `codex` CLI is
// not available. It replaces the Dialogues table and its subtables
// ([mcp_servers.dialogues], [mcp_servers.dialogues.env], ...) and leaves every
// other line, comment, and table untouched.

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;

function normalizeTableName(raw: string): string {
  return raw.split(".").map((part) => part.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")).join(".");
}

function isDialoguesTable(name: string): boolean {
  const normalized = normalizeTableName(name);
  return normalized === "mcp_servers.dialogues" || normalized.startsWith("mcp_servers.dialogues.");
}

export function codexBlock(launch: ServerLaunch): string {
  return [
    "[mcp_servers.dialogues]",
    `command = ${JSON.stringify(launch.command)}`,
    `args = [${launch.args.map((arg) => JSON.stringify(arg)).join(", ")}]`
  ].join("\n");
}

export type CodexTomlScan = {
  lines: string[];
  /** Line ranges [start, end) of Dialogues tables. */
  ranges: Array<[number, number]>;
  /** A dialogues entry defined some other way (inline table or dotted keys). */
  inlineDefinition: boolean;
};

export function scanCodexToml(text: string): CodexTomlScan {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const ranges: Array<[number, number]> = [];
  let currentTable = "";
  let start = -1;
  let inlineDefinition = false;
  lines.forEach((line, index) => {
    const header = line.match(HEADER);
    if (header) {
      if (start >= 0) {
        ranges.push([start, index]);
        start = -1;
      }
      currentTable = normalizeTableName(header[1]);
      if (isDialoguesTable(header[1])) start = index;
      return;
    }
    if (currentTable === "mcp_servers" && /^\s*("?dialogues"?)\s*(\.|=)/.test(line)) inlineDefinition = true;
    if (currentTable === "" && /^\s*mcp_servers\s*\.\s*"?dialogues"?\s*(\.|=)/.test(line)) inlineDefinition = true;
  });
  if (start >= 0) ranges.push([start, lines.length]);
  return { lines, ranges, inlineDefinition };
}

/** The current Dialogues tables as text, for ownership comparison. */
export function currentCodexBlock(scan: CodexTomlScan): string | null {
  if (!scan.ranges.length) return null;
  return scan.ranges
    .map(([start, end]) => scan.lines.slice(start, end).join("\n").trim())
    .join("\n\n");
}

export function codexBlockDigestInput(block: string): string {
  return stableStringify(block.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean));
}

export function replaceCodexBlock(text: string, block: string | null): string {
  const scan = scanCodexToml(text);
  const kept = scan.lines.filter((_, index) => !scan.ranges.some(([start, end]) => index >= start && index < end));
  const base = kept.join("\n").replace(/\s+$/g, "");
  if (!block) return base ? `${base}\n` : "";
  return `${base ? `${base}\n\n` : ""}${block}\n`;
}
