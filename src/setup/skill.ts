import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFromPackage } from "../core/paths.js";
import { sha256Text, writeFileAtomic } from "../core/state/files.js";
import type { ClientId, OwnedEntry } from "./ownership.js";

// One conversation skill, installed only for selected apps that load skills
// from a folder. Ownership is tracked by digest so user edits are preserved.

export function packagedSkillPath(): string {
  return resolveFromPackage("integrations", "skills", "dialogues", "SKILL.md");
}

export function skillTarget(client: ClientId): string | null {
  const home = os.homedir();
  if (client === "claude-code") {
    const base = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(home, ".claude");
    return path.join(base, "skills", "dialogues", "SKILL.md");
  }
  if (client === "codex") return path.join(home, ".agents", "skills", "dialogues", "SKILL.md");
  return null;
}

export type SkillOutcome = {
  status: "installed" | "updated" | "unchanged" | "kept-user-version" | "not-supported" | "failed";
  path: string | null;
  digest?: string;
  detail: string;
};

export function installSkill(client: ClientId, previous: OwnedEntry["skill"] | null | undefined, options: { dryRun?: boolean } = {}): SkillOutcome {
  const target = skillTarget(client);
  if (!target) return { status: "not-supported", path: null, detail: "This app does not load skills from a folder; Dialogues' instructions come from the MCP server itself." };
  try {
    const content = fs.readFileSync(packagedSkillPath(), "utf8");
    const digest = sha256Text(content);
    if (fs.existsSync(target)) {
      const current = sha256Text(fs.readFileSync(target, "utf8"));
      if (current === digest) return { status: "unchanged", path: target, digest, detail: "Skill already up to date." };
      if (!previous || previous.path !== target || previous.digest !== current) {
        return { status: "kept-user-version", path: target, detail: "A dialogues skill already exists there and was not created (or was edited) outside this setup; it was left alone." };
      }
      if (!options.dryRun) writeFileAtomic(target, content);
      return { status: "updated", path: target, digest, detail: "Skill updated." };
    }
    if (!options.dryRun) writeFileAtomic(target, content);
    return { status: "installed", path: target, digest, detail: "Skill installed." };
  } catch (error) {
    return { status: "failed", path: target, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function uninstallSkill(previous: OwnedEntry["skill"] | null | undefined, options: { dryRun?: boolean } = {}): SkillOutcome {
  if (!previous) return { status: "not-supported", path: null, detail: "No skill was installed by Dialogues." };
  if (!fs.existsSync(previous.path)) return { status: "unchanged", path: previous.path, detail: "Skill already removed." };
  const current = sha256Text(fs.readFileSync(previous.path, "utf8"));
  if (current !== previous.digest) return { status: "kept-user-version", path: previous.path, detail: "The skill was edited after setup, so it was left alone." };
  if (!options.dryRun) {
    fs.rmSync(previous.path, { force: true });
    const dir = path.dirname(previous.path);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
  return { status: "updated", path: previous.path, detail: "Skill removed." };
}
