import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { packageRoot } from "./paths.js";
import { sha256Text } from "./state/files.js";

// Built-in capsule YAML is parsed once at build time into dist/builtin-catalog.json.
// At runtime a file is taken from the catalog only if its content hash still
// matches, so edited or user files are always parsed fresh.

type Catalog = Map<string, { sha256: string; value: unknown }>;

let catalog: Catalog | null = null;

function loadCatalog(): Catalog {
  if (catalog) return catalog;
  catalog = new Map();
  try {
    const file = path.join(packageRoot(), "dist", "builtin-catalog.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version: number; files: Record<string, { sha256: string; value: unknown }> };
    if (parsed.version === 1) {
      for (const [relative, entry] of Object.entries(parsed.files)) catalog.set(relative, entry);
    }
  } catch {
    // No catalog (e.g. running tests against src): parse everything.
  }
  return catalog;
}

export function catalogKey(filePath: string): string {
  return path.relative(packageRoot(), path.resolve(filePath)).split(path.sep).join("/");
}

export function parseYamlText(text: string, filePath: string): unknown {
  const entry = loadCatalog().get(catalogKey(filePath));
  if (entry && entry.sha256 === sha256Text(text)) return structuredClone(entry.value);
  return YAML.parse(text);
}

export function readYamlFile(filePath: string): unknown {
  return parseYamlText(fs.readFileSync(filePath, "utf8").replace(/^﻿/, ""), filePath);
}
