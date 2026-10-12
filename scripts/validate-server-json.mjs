// Validate server.json against the pinned MCP Registry schema and check that
// its name and versions agree with package.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(fs.readFileSync(path.join(root, "scripts", "schemas", "server.schema.2025-12-11.json"), "utf8"));
const server = JSON.parse(fs.readFileSync(path.join(root, "server.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const problems = [];
if (!validate(server)) {
  for (const error of validate.errors ?? []) problems.push(`schema: ${error.instancePath || "/"} ${error.message}`);
}
if (server.$schema !== schema.$id) problems.push(`$schema should be ${schema.$id}`);
if (server.name !== pkg.mcpName) problems.push(`server.json name ${server.name} must equal package.json mcpName ${pkg.mcpName}`);
if (server.version !== pkg.version) problems.push(`server.json version ${server.version} must equal package.json version ${pkg.version}`);
const npmPackage = (server.packages ?? []).find((entry) => entry.registryType === "npm");
if (!npmPackage) problems.push("server.json needs an npm package entry");
else {
  if (npmPackage.identifier !== pkg.name) problems.push(`package identifier ${npmPackage.identifier} must equal ${pkg.name}`);
  if (npmPackage.version !== pkg.version) problems.push(`package version ${npmPackage.version} must equal ${pkg.version}`);
  const positional = (npmPackage.packageArguments ?? []).filter((arg) => arg.type === "positional").map((arg) => arg.value);
  if (positional.join(" ") !== "mcp serve") problems.push("packageArguments must run `mcp serve`");
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`server.json valid (${server.name} ${server.version})`);
