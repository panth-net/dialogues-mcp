// Remove build output so files deleted from src/ cannot survive in a package.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (path.basename(dist) !== "dist" || path.dirname(dist) !== root) throw new Error("refusing to clean an unexpected path");
fs.rmSync(dist, { recursive: true, force: true });
