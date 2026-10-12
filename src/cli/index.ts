#!/usr/bin/env node

// Entry point. It settles process-wide behavior and the data folder first,
// then loads only what the command needs: `mcp serve` loads just the server,
// everything else loads the full command-line interface.

import { configureRuntime } from "../core/paths.js";

// Some Node releases announce node:sqlite as experimental on first use. That one
// warning is noise for users; every other warning still prints (to stderr).
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message;
  if (typeof text === "string" && /SQLite is an experimental feature/.test(text)) return;
  return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

// A closed pipe (e.g. `dialogues list | head`, or an app that went away)
// ends the process quietly instead of crashing with EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

type ServeArgs = { dataDir?: string; workspace?: string } | null;

/** Recognize `[--data-dir X] mcp serve [--data-dir X | --workspace X]`. */
export function parseServeArgs(argv: string[]): ServeArgs {
  const positionals: string[] = [];
  const options: { dataDir?: string; workspace?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (flag === "--data-dir" || flag === "--workspace") {
      const value = inline ?? argv[index + 1];
      if (inline === undefined) index += 1;
      if (!value) return null;
      if (flag === "--data-dir") options.dataDir = value;
      else options.workspace = value;
      continue;
    }
    if (arg.startsWith("-")) return null;
    positionals.push(arg);
  }
  return positionals.length === 2 && positionals[0] === "mcp" && positionals[1] === "serve" ? options : null;
}

const serve = parseServeArgs(process.argv.slice(2));
if (serve) {
  const config = configureRuntime({ dataDir: serve.dataDir, legacyWorkspace: serve.workspace });
  for (const warning of config.warnings) process.stderr.write(`dialogues: ${warning}\n`);
  const { serveDialoguesStdio } = await import("../mcp/server.js");
  serveDialoguesStdio();
} else {
  await import("./main.js");
}
