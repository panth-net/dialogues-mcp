// Pre-parse built-in capsule YAML into dist/builtin-catalog.json so listing
// collections does not parse every manifest at startup. Entries carry the
// source file's hash; the runtime ignores any entry whose file has changed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpora = path.join(root, "corpora");
const files = {};
for (const id of fs.readdirSync(corpora).sort()) {
  for (const name of ["corpus.yaml", "source-manifest.yaml", "sample.yaml"]) {
    const file = path.join(corpora, id, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    files[`corpora/${id}/${name}`] = {
      sha256: crypto.createHash("sha256").update(text).digest("hex"),
      value: YAML.parse(text)
    };
  }
}
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "builtin-catalog.json"), JSON.stringify({ version: 1, files }));
console.log(`builtin-catalog.json: ${Object.keys(files).length} file(s)`);
