import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../core/paths.js";

export type ServerLaunch = {
  command: string;
  args: string[];
};

/** The installed CLI script that `mcp serve` runs (dist/cli/index.js). */
export function cliScriptPath(): string {
  return fileURLToPath(new URL("../cli/index.js", import.meta.url));
}

/**
 * Apps launch Dialogues with absolute paths to Node and to the installed
 * script, plus the data folder. No shell, no PATH lookup, no npx download:
 * stdout is reserved for MCP traffic.
 */
export function resolveServerLaunch(dataDirectory = dataDir()): ServerLaunch {
  const script = cliScriptPath();
  if (!fs.existsSync(script)) {
    throw new Error(`Dialogues is not built: ${script} is missing. Run npm run build (contributors) or reinstall the package.`);
  }
  return {
    command: process.execPath,
    args: [script, "mcp", "serve", "--data-dir", path.resolve(dataDirectory)]
  };
}

export function launchDigestInput(launch: ServerLaunch): string {
  return JSON.stringify({ command: launch.command, args: launch.args });
}
