// Keeps every copy of the install prompt and first message identical to
// resources/install-prompts.json.
//   node scripts/sync-prompts.mjs            rewrite the README blocks
//   node scripts/sync-prompts.mjs --check    exit 1 if anything is out of sync
//   ... --landing <path-to-landing-repo>     also check/write content/install-prompts.json there
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const landingIndex = args.indexOf("--landing");
const landing = landingIndex >= 0 ? args[landingIndex + 1] : null;

const resourcePath = path.join(root, "resources", "install-prompts.json");
const resourceText = fs.readFileSync(resourcePath, "utf8");
const prompts = JSON.parse(resourceText);

const blocks = {
  "install-prompt": prompts.install_prompt,
  "first-message": prompts.first_message
};

let drift = [];
const readmePath = path.join(root, "README.md");
let readme = fs.readFileSync(readmePath, "utf8").replace(/\r\n/g, "\n");
for (const [name, text] of Object.entries(blocks)) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const from = readme.indexOf(start);
  const to = readme.indexOf(end);
  if (from < 0 || to < from) {
    drift.push(`README.md is missing the ${name} markers`);
    continue;
  }
  const wanted = `${start}\n\`\`\`text\n${text}\n\`\`\`\n${end}`;
  const current = readme.slice(from, to + end.length);
  if (current !== wanted) {
    drift.push(`README.md ${name} block differs from resources/install-prompts.json`);
    readme = readme.slice(0, from) + wanted + readme.slice(to + end.length);
  }
}

if (landing) {
  const landingCopy = path.join(path.resolve(landing), "content", "install-prompts.json");
  const current = fs.existsSync(landingCopy) ? fs.readFileSync(landingCopy, "utf8") : null;
  if (current === null || JSON.stringify(JSON.parse(current)) !== JSON.stringify(prompts)) {
    drift.push(`${landingCopy} differs from resources/install-prompts.json`);
    if (!check) fs.writeFileSync(landingCopy, resourceText);
  }
}

if (check) {
  if (drift.length) {
    for (const line of drift) console.error(line);
    console.error("Run: node scripts/sync-prompts.mjs");
    process.exit(1);
  }
  console.log("prompts in sync");
} else {
  fs.writeFileSync(readmePath, readme);
  console.log(drift.length ? `updated: ${drift.join("; ")}` : "prompts already in sync");
}
