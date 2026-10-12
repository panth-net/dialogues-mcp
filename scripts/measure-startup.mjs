// Measures process start to MCP-ready and the first list_corpora response,
// for the legacy (2025) handshake and the pinned modern (2026-07-28) era.
// Usage: node scripts/measure-startup.mjs [--cli <dist/cli/index.js>] [--data-dir <dir>] [--runs N]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dataDirIndex = args.indexOf("--data-dir");
const runsIndex = args.indexOf("--runs");
const dataDir = dataDirIndex >= 0 ? args[dataDirIndex + 1] : undefined;
const runs = runsIndex >= 0 ? Number(args[runsIndex + 1]) : 3;
const cliIndex = args.indexOf("--cli");
const cli = cliIndex >= 0 ? path.resolve(args[cliIndex + 1]) : path.join(root, "dist", "cli", "index.js");

async function once(mode) {
  const started = performance.now();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "serve", ...(dataDir ? ["--data-dir", dataDir] : [])],
    env: { ...getDefaultEnvironment(), ...(process.env.HOME ? { HOME: process.env.HOME } : {}), ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}) },
    stderr: "pipe"
  });
  const client = new Client(
    { name: "dialogues-measure", version: "1.0.0" },
    mode === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}
  );
  try {
    await client.connect(transport);
    const ready = performance.now() - started;
    const listStart = performance.now();
    await client.callTool({ name: "list_corpora", arguments: {} });
    return { mode, era: client.getProtocolEra(), ready_ms: Math.round(ready), first_list_ms: Math.round(performance.now() - listStart) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

const results = [];
for (const mode of ["legacy", "modern"]) {
  for (let run = 0; run < runs; run += 1) results.push({ run: run + 1, ...(await once(mode)) });
}
console.log(JSON.stringify({ node: process.versions.node, platform: `${process.platform}-${process.arch}`, data_dir: dataDir ?? "(default)", results }, null, 2));
