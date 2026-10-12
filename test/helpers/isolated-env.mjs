// Import this first in every test file. Each test file gets its own temporary
// home folder and Dialogues data folder, so tests never read or write the
// developer's real data, app configs, or the repository checkout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export const testBase = fs.mkdtempSync(path.join(os.tmpdir(), "dialogues-test-"));
export const homeDir = path.join(testBase, "home");
export const dataDir = path.join(testBase, "data");
fs.mkdirSync(homeDir, { recursive: true });

process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
process.env.DIALOGUES_HOME = dataDir;
delete process.env.DIALOGUES_WORKSPACE;
delete process.env.DIALOGUES_WORKSPACE_MODE;
// Never touch real app configs or real vendor CLIs from tests.
process.env.DIALOGUES_CLAUDE_DESKTOP_CONFIG = path.join(homeDir, "claude", "claude_desktop_config.json");
process.env.DIALOGUES_CURSOR_CONFIG = path.join(homeDir, ".cursor", "mcp.json");
process.env.DIALOGUES_VSCODE_USER_DIR = path.join(homeDir, "vscode", "User");
process.env.CODEX_HOME = path.join(homeDir, ".codex");
process.env.CLAUDE_CONFIG_DIR = path.join(homeDir, ".claude");
process.env.DIALOGUES_CLAUDE_CLI = "none";
process.env.DIALOGUES_CODEX_CLI = "none";

process.on("exit", () => {
  try {
    fs.rmSync(testBase, { recursive: true, force: true });
  } catch {
    // Best effort; the OS temp folder is cleaned eventually.
  }
});

/** No real DNS, no pacing delays; the network itself is mocked by each test. */
export const TEST_HTTP = { skipDnsCheck: true, minIntervalMs: 0 };

export function tempDir(name) {
  const dir = path.join(testBase, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function userCorpusDir(corpusId) {
  return path.join(dataDir, "user-corpora", corpusId);
}

export const BASE_MANIFEST = {
  languages: ["en"],
  type: "test",
  status: "test",
  data_policy: "test",
  default_search_mode: "fts",
  guide: "guide.md",
  search_rules: "search-rules.md",
  source_notes: "source-notes.md",
  citation_rules: "citation-rules.md",
  fields: ["doc_id", "chunk_index"],
  license: { data_included: false, user_must_confirm_rights: true, notes: "Test." }
};

/** Write a minimal valid capsule. */
export function writeCapsule(dir, manifest, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "corpus.yaml"), YAML.stringify({ ...BASE_MANIFEST, description: "Test corpus.", ...manifest }), "utf8");
  for (const file of ["guide.md", "search-rules.md", "source-notes.md", "citation-rules.md"]) {
    fs.writeFileSync(path.join(dir, file), files[file] ?? `# ${file}\n\nSearch, fetch, cite. Limitations apply.\n`, "utf8");
  }
  for (const [name, content] of Object.entries(files)) {
    if (!["guide.md", "search-rules.md", "source-notes.md", "citation-rules.md"].includes(name)) {
      fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : YAML.stringify(content), "utf8");
    }
  }
  return dir;
}

export function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(href);
    return handler(href, init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}
