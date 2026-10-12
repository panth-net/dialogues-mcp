// Privacy and artifact scan for files that would be published.
//   node scripts/privacy-scan.mjs                 scan the candidate repository files
//   node scripts/privacy-scan.mjs --dir <folder>  scan every file under a folder (e.g. an extracted package)
// Findings name the file, line, and rule only; matched text is never printed.
// Private terms can be supplied in .privacy-scan.local.json ({"terms": [...]})
// or DIALOGUES_PRIVACY_TERMS (comma-separated); neither is ever published.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dirIndex = args.indexOf("--dir");
const scanDir = dirIndex >= 0 ? path.resolve(args[dirIndex + 1]) : null;

// Filenames rejected without opening the file.
const CREDENTIAL_NAMES = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn|gpg)$/i,
  /(^|\/)(credentials?|secrets?)(\.[^/]*)?$/i,
  /(keypair|wallet|service[-_]?account)[^/]*\.json$/i,
  /(^|\/)\.(npmrc|netrc|pgpass|git-credentials)$/i
];
const ALLOWED_CREDENTIAL_NAMES = [/(^|\/)\.env\.example$/i];

// Files that must never be published, by path.
const FORBIDDEN_PATHS = [
  [/(^|\/)workspace\//, "contributor workspace data"],
  [/(^|\/)user-corpora\/(?!\.gitkeep$)/, "user collections"],
  [/(^|\/)corpora\/[^/]+\/data\//, "downloaded collection data"],
  [/\.sqlite(-\w+)?$/i, "SQLite database"],
  [/\.db$/i, "database file"],
  [/\.jsonl$/i, "log or record file"],
  [/(^|\/)gameplan[^/]*\.md$/i, "planning notes"],
  [/(^|\/)repomix[^/]*$/i, "repository dump"],
  [/(^|\/)\.playwright-mcp\//, "browser tool output"],
  [/\.tgz$/i, "packed archive"],
  [/(^|\/)node_modules\//, "dependencies"],
  [/(^|\/)\.privacy-scan\.local\.json$/, "local scanner terms"]
];

// Content rules. Placeholders below are allowed.
const PLACEHOLDER = /(C:[\\/]+Users[\\/]+(me|you|<[^>]+>|USERNAME|name)\b|\/Users\/(you|me|<[^>]+>|name)\b|\/home\/(you|me|<[^>]+>|user|name)\b|C:[\\/]+path[\\/]+to\b|\/absolute\/path\/to\b|[A-Z]:[\\/]+local-corpora\b)/gi;
const CONTENT_RULES = [
  ["windows-user-path", /[A-Z]:[\\/]{1,2}Users[\\/]{1,2}[A-Za-z0-9._ -]+/g],
  ["mac-user-path", /\/Users\/[A-Za-z0-9._-]+/g],
  ["linux-home-path", /\/home\/[A-Za-z0-9._-]+/g],
  ["drive-path", /\b[D-Z]:[\\/]{1,2}[A-Za-z0-9._-]+/g],
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ["openai-style-key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{30,}\b/g]
];
const EMAIL_ALLOW = /@(example\.(com|org|net|test)|users\.noreply\.github\.com|anthropic\.com)$/i;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function localTerms() {
  const terms = [];
  const file = path.join(root, ".privacy-scan.local.json");
  if (fs.existsSync(file)) terms.push(...(JSON.parse(fs.readFileSync(file, "utf8")).terms ?? []));
  if (process.env.DIALOGUES_PRIVACY_TERMS) terms.push(...process.env.DIALOGUES_PRIVACY_TERMS.split(","));
  return terms.map((term) => term.trim()).filter(Boolean);
}

function candidateFiles() {
  if (scanDir) {
    const files = [];
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile()) files.push(path.relative(scanDir, full).split(path.sep).join("/"));
      }
    };
    visit(scanDir);
    return { base: scanDir, files };
  }
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
  const files = output.split("\0").filter(Boolean).filter((file) => fs.existsSync(path.join(root, file)));
  return { base: root, files };
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

const { base, files } = candidateFiles();
const terms = localTerms();
const findings = [];
for (const file of files) {
  if (CREDENTIAL_NAMES.some((rule) => rule.test(file)) && !ALLOWED_CREDENTIAL_NAMES.some((rule) => rule.test(file))) {
    findings.push({ file, rule: "credential-like file name (not opened)" });
    continue;
  }
  const forbidden = FORBIDDEN_PATHS.find(([rule]) => rule.test(file));
  if (forbidden) {
    findings.push({ file, rule: `unexpected file: ${forbidden[1]}` });
    continue;
  }
  const full = path.join(base, file);
  const size = fs.statSync(full).size;
  const buffer = fs.readFileSync(full);
  if (isBinary(buffer)) continue;
  if (size > MAX_TEXT_BYTES) {
    findings.push({ file, rule: "large text file (possible source text dump)" });
    continue;
  }
  const lines = buffer.toString("utf8").split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.replace(PLACEHOLDER, "");
    for (const [name, rule] of CONTENT_RULES) {
      for (const match of line.matchAll(rule)) {
        if (name === "email" && EMAIL_ALLOW.test(match[0])) continue;
        findings.push({ file, line: index + 1, rule: name });
      }
    }
    for (const term of terms) {
      if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(rawLine)) {
        findings.push({ file, line: index + 1, rule: "private term" });
      }
    }
  });
}

if (findings.length) {
  for (const finding of findings) {
    console.error(`${finding.file}${finding.line ? `:${finding.line}` : ""}  ${finding.rule}`);
  }
  console.error(`\n${findings.length} finding(s) in ${files.length} file(s). Matched text is not shown.`);
  process.exit(1);
}
console.log(`privacy scan: ${files.length} file(s) clean${terms.length ? ` (${terms.length} local term(s) checked)` : " (no local terms configured)"}`);
