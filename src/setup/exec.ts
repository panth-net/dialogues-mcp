import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathEnv = env.PATH ?? env.Path ?? "";
  const extensions = process.platform === "win32"
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) {
          if (process.platform === "win32" && extension === "") continue;
          return path.resolve(candidate);
        }
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

// cmd.exe quoting for .cmd/.bat shims (the same rules cross-spawn uses):
// quote for CreateProcess, then caret-escape cmd metacharacters.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function quoteForCmd(arg: string, doubleEscape: boolean): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`;
  quoted = quoted.replace(CMD_META, "^$1");
  if (doubleEscape) quoted = quoted.replace(CMD_META, "^$1");
  return quoted;
}

export type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut: boolean;
};

/**
 * Run a vendor CLI without a shell. Windows batch shims (.cmd/.bat) are run
 * through cmd.exe with explicit quoting so arguments containing spaces,
 * quotes, or JSON arrive intact.
 */
export function runCommand(command: string, args: string[], options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}): RunResult {
  const timeout = options.timeoutMs ?? 60_000;
  const isBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const result = isBatch
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[quoteForCmd(command, false), ...args.map((arg) => quoteForCmd(arg, true))].join(" ")}"`], {
        encoding: "utf8",
        windowsVerbatimArguments: true,
        timeout,
        env: options.env,
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"]
      })
    : spawnSync(command, args, {
        encoding: "utf8",
        timeout,
        env: options.env,
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"]
      });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
    timedOut: Boolean(result.error && /ETIMEDOUT/.test(result.error.message))
  };
}

/** A short, secret-free description of a failed command for user output. */
export function describeFailure(label: string, result: RunResult): string {
  if (result.timedOut) return `${label} did not finish in time.`;
  if (result.error) return `${label} could not run: ${result.error}`;
  // Vendor CLIs may echo configuration on failure; keep only the first line.
  const first = (result.stderr || result.stdout).split(/\r?\n/).find((line) => line.trim()) ?? "";
  return `${label} failed (exit ${result.status ?? "unknown"})${first ? `: ${first.trim().slice(0, 200)}` : ""}`;
}
