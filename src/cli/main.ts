import { Command, Option } from "commander";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { configureRuntime, dataDir, dataPath, ensureDataDirectories, runtimeConfig } from "../core/paths.js";
import { getCorpusCapsule, listCorpusCapsules } from "../core/corpus/loader.js";
import { corpusCoverage } from "../core/corpus/coverage.js";
import { formatBytes, indexBytes, listCorpusSizes } from "../core/corpus/size.js";
import {
  createCorpus,
  guidePathForCorpus,
  lintCorpus,
  profileCorpus,
  type CorpusProfileAnswers
} from "../core/corpus/authoring.js";
import { composeCorpusGuide } from "../core/guides/compose.js";
import { getGenericIndexStats } from "../core/db/genericIndex.js";
import { fetchCorpus, reindexCorpus, searchCorpus } from "../core/search/corpusTools.js";
import { suggestSearches } from "../core/search/suggest.js";
import { importFolder } from "../core/import/importFolder.js";
import { runCorpusRegression } from "../core/corpus/regression.js";
import { importVanGoghLetters, VANGOGH_CORPUS_ID, VANGOGH_RIGHTS_NOTICE } from "../core/vangogh/import.js";
import { runQuickstart } from "../core/demo/quickstart.js";
import { appendLogEvent, clearLogs, findLogEvent, formatLogEvent, tailLogs, type LogKind } from "../core/logs/events.js";
import { hasSourceManifest, loadSourceManifest, selectedManifestItems } from "../core/sources/sourceManifest.js";
import {
  cancelDownload,
  downloadFromSourceManifest,
  listDownloadOptions,
  previewDownload,
  sourceStatus,
  specFromOptions,
  type JobProgress
} from "../core/sources/download.js";
import { discoverSources, type DiscoverSource } from "../core/curation/discover.js";
import { harvestSources } from "../core/curation/harvest.js";
import { runCurationScore } from "../core/curation/scoring.js";
import { exportCuratedManifest, exportReviewCsv, importReviewCsv } from "../core/curation/review.js";
import { applyMigration, planMigration } from "../core/state/migration.js";
import { packageInfo } from "../core/version.js";
import { serveDialoguesStdio } from "../mcp/server.js";
import { CLIENT_ADAPTERS, generateSnippet, isClientId, snippetFileName, type SnippetClient } from "../setup/clients.js";
import { resolveServerLaunch } from "../setup/launch.js";
import { CLIENT_IDS, type ClientId } from "../setup/ownership.js";
import { EXIT, runReady, runSetup, runUninstall, runUpdate } from "../setup/lifecycle.js";
import { writeFileAtomic } from "../core/state/files.js";
import { formatDoctor, runDoctor } from "./doctor.js";

const program = new Command();

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeText(value: string): void {
  process.stdout.write(`${value}\n`);
}

function writeProgress(value: string): void {
  process.stderr.write(`${value}\n`);
}

function setExit(code: number): void {
  if (code !== 0) process.exitCode = code;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseClients(values: string[] | undefined): ClientId[] {
  const clients = (values ?? []).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  for (const client of clients) {
    if (!isClientId(client)) {
      throw new Error(`Unknown app "${client}". Use claude-desktop, claude-code, codex, cursor, vscode, or antigravity.`);
    }
  }
  return [...new Set(clients)] as ClientId[];
}

function assertLogKind(value: string): asserts value is LogKind {
  if (!["imports", "searches", "fetches", "errors"].includes(value)) {
    throw new Error("Unsupported log kind. Use imports, searches, fetches, or errors.");
  }
}

function normalizeProfileAnswers(raw: unknown): CorpusProfileAnswers {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Profile answers must be a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  const field = (key: keyof CorpusProfileAnswers) => {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : "";
  };
  const answers: CorpusProfileAnswers = {
    documents: field("documents"),
    authors: field("authors"),
    audience: field("audience"),
    dates: field("dates"),
    importance: field("importance"),
    payAttention: field("payAttention"),
    avoid: field("avoid"),
    citation: field("citation"),
    sensitive: field("sensitive")
  };
  const missing = Object.entries(answers)
    .filter(([key, value]) => key !== "sensitive" && !value)
    .map(([key]) => key);
  if (missing.length) throw new Error(`Profile answers missing fields: ${missing.join(", ")}`);
  return answers;
}

function readProfileAnswers(filePath: string): CorpusProfileAnswers {
  return normalizeProfileAnswers(JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as unknown);
}

async function askProfileAnswers(): Promise<CorpusProfileAnswers> {
  if (!input.isTTY) {
    throw new Error("Interactive profile requires a TTY. Use --answers <json-file> for noninteractive runs.");
  }
  const rl = createInterface({ input, output });
  try {
    const ask = async (question: string) => (await rl.question(`${question}\n> `)).trim();
    return {
      documents: await ask("What are these documents?"),
      authors: await ask("Who wrote or created them?"),
      audience: await ask("Who were they written for or used by?"),
      dates: await ask("Approximate dates?"),
      importance: await ask("Why do they matter?"),
      payAttention: await ask("What should the AI pay attention to?"),
      avoid: await ask("What should the AI avoid doing?"),
      citation: await ask("How should it cite passages?"),
      sensitive: await ask("Are there sensitive/private issues? Type no if none.")
    };
  } finally {
    rl.close();
  }
}

function openGuidePath(filePath: string): { opened: boolean; command: string | null; status?: number | null; error?: string } {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (editor) {
    const result = spawnSync(editor, [filePath], { stdio: "inherit", shell: true });
    return { opened: result.status === 0, command: editor, status: result.status, error: result.error?.message };
  }
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
  const result = spawnSync(command, args, { stdio: "ignore" });
  return { opened: result.status === 0, command, status: result.status, error: result.error?.message };
}

async function confirmNotice(notice: string, question: string, yes?: boolean): Promise<boolean> {
  if (yes) return true;
  if (!input.isTTY) return false;
  writeProgress(notice);
  const rl = createInterface({ input, output: process.stderr });
  try {
    return (await rl.question(`${question} Type YES to continue: `)).trim() === "YES";
  } finally {
    rl.close();
  }
}

function progressPrinter(corpusId: string) {
  let last = "";
  return (progress: JobProgress) => {
    const line = `[${corpusId}] ${progress.done}/${progress.total}${progress.current ? `: ${progress.current}` : ""}`;
    if (line !== last) writeProgress(line);
    last = line;
  };
}

program
  .name("dialogues")
  .description("Guided conversations with historical documents, running on your computer (MCP server and CLI)")
  .version(packageInfo().version)
  .addOption(new Option("--data-dir <path>", "Dialogues data folder (default: remembered folder, else ~/Dialogues)"))
  .addOption(new Option("--workspace <path>", "Deprecated alias for --data-dir").hideHelp());

// Resolve the data folder before any command does stateful work.
program.hook("preAction", (_root, actionCommand) => {
  const merged = { ...program.opts(), ...actionCommand.opts() } as { dataDir?: string; workspace?: string };
  const config = configureRuntime({ dataDir: merged.dataDir, legacyWorkspace: merged.workspace });
  for (const warning of config.warnings) writeProgress(`warning: ${warning}`);
});

// ---------- Setup and lifecycle ----------

program
  .command("setup")
  .description("Connect Dialogues to the AI app you use (only the apps you name)")
  .option("--client <app>", "App to connect: claude-desktop, claude-code, codex, cursor, vscode, antigravity (repeatable)", collect)
  .option("--all", "Connect every supported app that looks installed")
  .option("--data-dir <path>", "Where to keep collections (default ~/Dialogues)")
  .option("--replace", "Overwrite an existing dialogues entry that this setup did not create")
  .option("--no-skill", "Do not install the conversation skill")
  .option("--no-probe", "Skip starting the server once to check it")
  .option("--migrate", "Also copy collections from an earlier install into the data folder")
  .option("--vscode-profile <id>", "VS Code profile folder name (default profile if omitted)")
  .option("--dry-run", "Show what would change without writing")
  .option("--json", "Print one machine-readable result")
  .action(async (options: { client?: string[]; all?: boolean; replace?: boolean; skill?: boolean; probe?: boolean; migrate?: boolean; vscodeProfile?: string; dryRun?: boolean; json?: boolean }) => {
    let clients = parseClients(options.client);
    if (options.all) clients = CLIENT_IDS.filter((client) => CLIENT_ADAPTERS[client].detect().hint);
    if (!clients.length && !options.json && input.isTTY) {
      const rl = createInterface({ input, output: process.stderr });
      try {
        writeProgress("Which app do you want to connect? 1 Claude Desktop, 2 Claude Code, 3 Codex, 4 Cursor, 5 VS Code, 6 Antigravity");
        const choice = (await rl.question("Type a number: ")).trim();
        const picked = CLIENT_IDS[Number(choice) - 1];
        if (picked) clients = [picked as ClientId];
      } finally {
        rl.close();
      }
    }
    const result = await runSetup({
      clients,
      replace: options.replace,
      skill: options.skill,
      probe: options.probe,
      migrate: options.migrate,
      vscodeProfile: options.vscodeProfile,
      dryRun: options.dryRun
    });
    if (options.json) writeJson(result);
    else if (result.clients) {
      writeText(result.ok ? "Dialogues is connected." : `Setup finished with problems (${result.status}).`);
      writeText(`Data folder: ${result.data_dir}`);
      for (const client of result.clients) {
        writeText(`- ${client.display_name}: ${client.status}. ${client.detail}`);
        if (client.backup_path) writeText(`  Backup of the previous settings: ${client.backup_path}`);
        if (client.recovery) writeText(`  ${client.recovery}`);
        if (client.skill && client.skill.status !== "not-supported") writeText(`  Skill: ${client.skill.detail}`);
      }
      if (result.server_check) writeText(result.server_check.detail);
      if (result.migration) writeText("Collections from an earlier install were found: run dialogues migrate to review copying them here.");
      writeText("No document collections were downloaded.");
      writeText(result.privacy ?? "");
      writeText(result.next_step ?? "");
    } else {
      writeText(result.detail ?? "");
    }
    setExit(result.exit_code);
  });

program
  .command("install")
  .argument("<client>", "claude-desktop, claude-code, codex, cursor, vscode, or antigravity")
  .description("Same as: dialogues setup --client <client>")
  .option("--json", "Print machine-readable output")
  .action(async (client: string, options: { json?: boolean }) => {
    if (client === "all") throw new Error("Choose one app, or use: dialogues setup --all");
    const result = await runSetup({ clients: parseClients([client]) });
    if (options.json) writeJson(result);
    else writeText("clients" in result ? `${result.status}. ${result.next_step}` : result.detail);
    setExit(result.exit_code);
  });

program
  .command("ready")
  .description("Read-only status check (no changes, no network)")
  .option("--json", "Print machine-readable output")
  .action(async (options: { json?: boolean }) => {
    const report = await runReady();
    if (options.json) writeJson(report);
    else {
      writeText(`Dialogues ${report.version}: ${report.ok ? "ready" : "needs attention"}`);
      writeText(`Data folder: ${report.data_dir} (${report.data_dir_origin}${report.data_dir_exists ? "" : ", not created yet"})`);
      writeText(`Node.js ${report.node.version}; ${report.sqlite.detail}; PDF: ${report.pdf_support.available ? "available" : "unavailable"}`);
      writeText(`Connected apps: ${report.connected_apps.map((app) => app.display_name).join(", ") || "none"}`);
      writeText(`Collections: ${report.collections.total} (${Object.entries(report.collections.by_state).map(([state, count]) => `${state} ${count}`).join(", ")})`);
      for (const problem of report.problems) writeText(`- ${problem}`);
    }
    setExit(report.ok ? 0 : EXIT.failed);
  });

program
  .command("doctor")
  .description("Check the local setup; --fix repairs only what Dialogues owns (never downloads)")
  .option("--json", "Print machine-readable output")
  .option("--fix", "Create missing folders, clean up interrupted work, refresh app entries Dialogues created")
  .action(async (options: { json?: boolean; fix?: boolean }) => {
    const report = await runDoctor({ fix: options.fix });
    if (options.json) writeJson(report);
    else writeText(formatDoctor(report));
    if (!report.ok) setExit(EXIT.failed);
  });

program
  .command("uninstall")
  .description("Disconnect apps that Dialogues connected; collections are kept unless you ask")
  .option("--client <app>", "Only this app (repeatable); default: every app Dialogues connected", collect)
  .option("--all", "Every app Dialogues connected")
  .option("--delete-data", "Also delete the Dialogues data folder")
  .option("--confirm-data-dir <path>", "Required with --delete-data: the exact data folder path")
  .option("--vscode-profile <id>", "VS Code profile folder name")
  .option("--dry-run", "Show what would change without writing")
  .option("--json", "Print machine-readable output")
  .action((options: { client?: string[]; all?: boolean; deleteData?: boolean; confirmDataDir?: string; vscodeProfile?: string; dryRun?: boolean; json?: boolean }) => {
    const result = runUninstall({
      clients: parseClients(options.client),
      all: options.all,
      deleteData: options.deleteData,
      confirmDataDir: options.confirmDataDir,
      vscodeProfile: options.vscodeProfile,
      dryRun: options.dryRun
    });
    if (options.json) writeJson(result);
    else {
      for (const client of result.clients) writeText(`- ${client.client}: ${client.status}. ${client.detail}`);
      writeText(result.data.detail);
      writeText(result.next_step);
    }
    setExit(result.exit_code);
  });

program
  .command("update")
  .description("Update Dialogues from npm (only when you run this)")
  .option("--version <version>", "Install this version instead of the latest")
  .option("--dry-run", "Show the command without running it")
  .option("--json", "Print machine-readable output")
  .action((options: { version?: string; dryRun?: boolean; json?: boolean }) => {
    const result = runUpdate({ dryRun: options.dryRun, version: options.version });
    if (options.json) writeJson(result);
    else writeText(JSON.stringify(result, null, 2));
    setExit(result.exit_code);
  });

program
  .command("migrate")
  .description("Copy collections from an earlier install into the data folder (preview by default; originals are kept)")
  .option("--apply", "Copy and verify the files")
  .option("--from <path>", "Also look in this earlier checkout or install folder (repeatable)", collect)
  .option("--only-from", "Look only in the --from folders")
  .option("--json", "Print machine-readable output")
  .action((options: { apply?: boolean; from?: string[]; onlyFrom?: boolean; json?: boolean }) => {
    const plan = planMigration({ from: options.from, onlyFrom: options.onlyFrom });
    if (!options.apply) {
      const preview = { ok: true, preview: true, ...plan, items: plan.items.slice(0, 200), items_total: plan.items.length };
      if (options.json) writeJson(preview);
      else {
        writeText(`Data folder: ${plan.data_dir}`);
        for (const source of plan.sources.filter((entry) => entry.exists)) writeText(`Looked in: ${source.path} (${source.kind})`);
        writeText(`Would copy ${plan.totals.copy} file(s) (${formatBytes(plan.totals.bytes_to_copy)}); ${plan.totals.skip_identical} already identical; ${plan.totals.conflict} conflict(s).`);
        for (const item of plan.items.filter((entry) => entry.action === "conflict").slice(0, 20)) writeText(`  conflict: ${item.destination}`);
        writeText("Run with --apply to copy. Nothing is moved or deleted.");
      }
      return;
    }
    ensureDataDirectories();
    const result = applyMigration(plan);
    if (options.json) writeJson(result);
    else {
      writeText(`Copied ${result.copied} file(s); ${result.skipped_identical} already identical; ${result.conflicts} conflict(s); ${result.errors} error(s).`);
      for (const item of result.error_items.slice(0, 20)) writeText(`  error: ${item.source}: ${item.error}`);
      writeText(result.note);
    }
    setExit(result.ok ? 0 : EXIT.partial);
  });

program
  .command("init")
  .description("Create the data folder and write MCP config snippets for every app (does not change any app)")
  .option("--json", "Print machine-readable output")
  .action((options: { json?: boolean }) => {
    ensureDataDirectories();
    const launch = resolveServerLaunch();
    const written = (CLIENT_IDS as SnippetClient[]).map((client) => {
      const file = dataPath("mcp", snippetFileName(client));
      writeFileAtomic(file, `${generateSnippet(client, launch)}\n`);
      return { client, path: file };
    });
    const response = { ok: true, data_dir: dataDir(), written, next_step: "Connect an app with: dialogues setup --client <app>" };
    if (options.json) writeJson(response);
    else {
      writeText(`Data folder: ${response.data_dir}`);
      for (const item of written) writeText(`Snippet for ${item.client}: ${item.path}`);
      writeText(response.next_step);
    }
  });

program
  .command("list")
  .description("List document collections")
  .option("--json", "Print machine-readable output")
  .action((options: { json?: boolean }) => {
    const { corpora, errors } = listCorpusCapsules();
    const response = {
      ok: errors.length === 0,
      corpora: corpora.map((capsule) => {
        const coverage = corpusCoverage(capsule);
        const bytes = indexBytes(capsule);
        return {
          id: capsule.id,
          title: capsule.manifest.title,
          source: capsule.source,
          state: coverage.state,
          downloadable: capsule.manifest.downloadable ?? hasSourceManifest(capsule),
          download_policy: capsule.manifest.download_policy ?? (hasSourceManifest(capsule) ? "curated_public_source" : "user_supplied_only"),
          index_bytes: bytes,
          ...getGenericIndexStats(capsule),
          coverage
        };
      }),
      errors
    };
    if (options.json) writeJson(response);
    else {
      for (const corpus of response.corpora) {
        const local = corpus.indexed ? `${corpus.documents} document(s), ${formatBytes(corpus.index_bytes)} search file` : "nothing local";
        writeText(`${corpus.id}: ${corpus.title} [${corpus.state}] (${local})`);
      }
      for (const error of errors) writeText(`ERROR ${error.rootPath}: ${error.message}`);
    }
  });

// ---------- MCP ----------

const mcp = program.command("mcp").description("MCP commands");

mcp
  .command("serve")
  .description("Start the stdio MCP server (used by apps; stdout carries MCP messages only)")
  .option("--data-dir <path>", "Data folder")
  .option("--workspace <path>", "Deprecated alias for --data-dir")
  .action(() => {
    serveDialoguesStdio();
  });

mcp
  .command("config")
  .argument("<client>", "claude-desktop, claude-code, codex, cursor, vscode, antigravity, or all")
  .description("Print (and save under <data-dir>/mcp) a config snippet to paste into an app")
  .option("--install", "Connect the app instead (same as dialogues setup --client)")
  .option("--json", "Print machine-readable output")
  .action(async (client: string, options: { install?: boolean; json?: boolean }) => {
    const all: SnippetClient[] = [...CLIENT_IDS];
    if (client !== "all" && !all.includes(client as SnippetClient)) {
      throw new Error("Unsupported app. Use claude-desktop, claude-code, codex, cursor, vscode, antigravity, or all.");
    }
    if (options.install) {
      if (client === "all") throw new Error("--install works for one app at a time. Use dialogues setup --client <app>.");
      const result = await runSetup({ clients: parseClients([client]) });
      if (options.json) writeJson(result);
      else writeText("clients" in result ? `${result.status}. ${result.next_step}` : result.detail);
      setExit(result.exit_code);
      return;
    }
    const launch = resolveServerLaunch();
    const clients = client === "all" ? all : [client as SnippetClient];
    const written = clients.map((item) => {
      const file = dataPath("mcp", snippetFileName(item));
      const snippet = generateSnippet(item, launch);
      writeFileAtomic(file, `${snippet}\n`);
      return { client: item, path: file, snippet };
    });
    if (options.json) writeJson({ ok: true, data_dir: dataDir(), written });
    else for (const item of written) writeText(`# ${item.client} (saved to ${item.path})\n${item.snippet}\n`);
  });

// ---------- Logs ----------

const logs = program.command("logs").description("Inspect local Dialogues operation logs");

logs
  .command("tail")
  .description("Show recent import/search/fetch/error events")
  .option("--errors", "Only show errors")
  .option("--kind <kind>", "imports, searches, fetches, or errors")
  .option("--limit <number>", "Number of events to show", "20")
  .option("--json", "Print machine-readable output")
  .action((options: { errors?: boolean; kind?: string; limit: string; json?: boolean }) => {
    let kind: LogKind | undefined;
    if (options.kind) {
      assertLogKind(options.kind);
      kind = options.kind;
    }
    const events = tailLogs({ errors: options.errors, kind, limit: Number.parseInt(options.limit, 10) });
    if (options.json) writeJson({ ok: true, events });
    else {
      if (!events.length) writeText("No log events found.");
      for (const event of events) writeText(formatLogEvent(event));
    }
  });

logs
  .command("show")
  .argument("<eventId>", "Event ID from logs tail")
  .option("--json", "Print machine-readable output")
  .description("Show one log event")
  .action((eventId: string, options: { json?: boolean }) => {
    const event = findLogEvent(eventId);
    if (!event) throw new Error(`Log event not found: ${eventId}`);
    if (options.json) writeJson({ ok: true, event });
    else writeText(JSON.stringify(event, null, 2));
  });

logs
  .command("clear")
  .description("Delete the operation logs (search queries, passage IDs, errors)")
  .option("--json", "Print machine-readable output")
  .action((options: { json?: boolean }) => {
    const removed = clearLogs();
    if (options.json) writeJson({ ok: true, removed });
    else writeText(`Removed ${removed.length} log file(s). Set DIALOGUES_LOG=off to stop logging.`);
  });

// ---------- Collections ----------

const corpus = program.command("corpus").description("Collection commands");

corpus
  .command("size")
  .argument("[corpusId]", "Corpus ID; omit to show all")
  .option("--json", "Print machine-readable output")
  .description("Show local word counts and search file sizes")
  .action((corpusId: string | undefined, options: { json?: boolean }) => {
    const response = listCorpusSizes(corpusId);
    if (options.json) writeJson(response);
    else {
      for (const size of response.sizes) {
        writeText(`${size.id}: ${size.indexed ? `${(size.words ?? 0).toLocaleString()} words, ${size.documents} local source item(s), ${size.chunks} chunks, ${size.index_size} search file` : "not indexed"}`);
      }
      for (const error of response.errors) writeText(`ERROR ${error.rootPath}: ${error.message}`);
    }
  });

corpus
  .command("create")
  .argument("<name>", "Display name for the new corpus")
  .option("--corpus-id <id>", "Stable corpus ID")
  .option("--force", "Replace an existing user corpus with the same ID")
  .option("--json", "Print machine-readable output")
  .description("Create an editable user corpus capsule in the data folder")
  .action((name: string, options: { corpusId?: string; force?: boolean; json?: boolean }) => {
    const response = createCorpus({ name, corpusId: options.corpusId, force: options.force });
    const outputResponse = { ...response, capsule: undefined };
    if (options.json) writeJson(outputResponse);
    else {
      writeText(`Created corpus: ${response.corpus_id}`);
      writeText(`Corpus path: ${response.corpus_path}`);
      writeText(`Documents path: ${response.documents_path}`);
      writeText(`Guide: ${response.guide_path}`);
      writeText(response.next_step.replace("dialogues corpus reindex", "dialogues reindex"));
    }
  });

corpus
  .command("profile")
  .argument("<corpusId>", "Corpus ID")
  .option("--answers <path>", "JSON file with profile answers for noninteractive use")
  .option("--edit-installed", "Allow editing an externally registered capsule")
  .option("--json", "Print machine-readable output")
  .description("Ask plain-English questions and update a user corpus guide")
  .action(async (corpusId: string, options: { answers?: string; editInstalled?: boolean; json?: boolean }) => {
    const answers = options.answers ? readProfileAnswers(options.answers) : await askProfileAnswers();
    const response = profileCorpus(corpusId, answers, { allowInstalled: options.editInstalled });
    if (options.json) writeJson(response);
    else {
      writeText(`Updated guide for ${corpusId}: ${response.guide_path}`);
      writeText(`Updated source notes: ${response.source_notes_path}`);
      if (response.privacy_notes_path) writeText(`Wrote privacy notes: ${response.privacy_notes_path}`);
      writeText(response.warning);
    }
  });

corpus
  .command("lint")
  .argument("<corpusId>", "Corpus ID")
  .option("--json", "Print machine-readable output")
  .description("Check whether corpus guide files are useful and actionable")
  .action((corpusId: string, options: { json?: boolean }) => {
    const response = lintCorpus(corpusId);
    if (options.json) writeJson(response);
    else {
      writeText(`Guide lint for ${corpusId}: ${response.ok ? "ok" : "needs attention"}`);
      for (const check of response.checks) {
        writeText(`${check.ok ? "OK" : "WARN"} ${check.name}`);
        if (!check.ok) writeText(`  ${check.suggestion}`);
      }
      writeText(response.note);
    }
  });

corpus
  .command("edit-guide")
  .argument("<corpusId>", "Corpus ID")
  .option("--json", "Print machine-readable output without launching an editor")
  .description("Open guide.md for a corpus in the default editor")
  .action((corpusId: string, options: { json?: boolean }) => {
    const guidePath = guidePathForCorpus(corpusId);
    if (options.json) {
      writeJson({ ok: true, corpus_id: corpusId, guide_path: guidePath, opened: false, note: "JSON mode does not launch an editor." });
      return;
    }
    writeText("Opening the corpus guide. Edit the plain Markdown instructions, save, then re-run corpus lint if useful.");
    writeText(`Guide path: ${guidePath}`);
    const opened = openGuidePath(guidePath);
    if (!opened.opened) {
      writeText("No editor could be opened automatically. Open the guide path above manually.");
      if (opened.error) writeText(`Editor error: ${opened.error}`);
    }
  });

corpus
  .command("guide")
  .argument("<corpusId>", "Corpus ID")
  .description("Print the composed corpus guide")
  .option("--json", "Print machine-readable output")
  .action((corpusId: string, options: { json?: boolean }) => {
    const capsule = getCorpusCapsule(corpusId);
    const guide = composeCorpusGuide(capsule);
    if (options.json) writeJson({ ok: true, corpus_id: capsule.id, guide });
    else writeText(guide);
  });

corpus
  .command("suggest-searches")
  .argument("<corpusId>", "Corpus ID")
  .argument("<userQuestion>", "User question to translate into source search vocabulary")
  .option("--path <path>", "Prefer search vocabulary from a curated source path")
  .option("--json", "Print machine-readable output")
  .description("Suggest source-appropriate searches from corpus guide files")
  .action((corpusId: string, userQuestion: string, options: { path?: string; json?: boolean }) => {
    const response = suggestSearches(getCorpusCapsule(corpusId), userQuestion, { path: options.path });
    if (options.json) writeJson(response);
    else {
      for (const suggestion of response.suggested_queries) {
        writeText(`${suggestion.query}`);
        writeText(`  ${suggestion.why}`);
      }
      writeText(response.next_steps.message);
    }
  });

corpus
  .command("download-options")
  .argument("<corpusId>", "Corpus ID")
  .option("--json", "Print machine-readable output")
  .description("Show download choices: the sample, the full selection, paths, and rights summary")
  .action((corpusId: string, options: { json?: boolean }) => {
    const response = listDownloadOptions(corpusId);
    if (options.json) writeJson(response);
    else {
      writeText(`Download options for ${response.corpus_id}`);
      if (response.sample) writeText(`Sample (--sample): ${response.sample.title}; download ${response.sample.download_bytes === null ? "size unknown" : formatBytes(response.sample.download_bytes)}`);
      if (response.default_mode) writeText(`Full selection: ${response.default_mode}`);
      writeText(`Download policy: ${response.download_policy}`);
      if (response.paths.length) {
        writeText("Paths:");
        for (const sourcePath of response.paths) writeText(`- ${sourcePath.id}: ${sourcePath.title} (${sourcePath.items} items)`);
      }
      if ("note" in response && response.note) writeText(response.note);
    }
  });

corpus
  .command("source-status")
  .argument("<corpusId>", "Corpus ID")
  .option("--json", "Print machine-readable output")
  .description("Show approved selections, download progress, and what the search file covers")
  .action((corpusId: string, options: { json?: boolean }) => {
    const response = sourceStatus(corpusId);
    if (options.json) writeJson(response);
    else {
      writeText(`Source status for ${response.corpus_id}: ${response.collection_state}`);
      for (const approval of response.approved_selections) writeText(`- approved: ${approval.label} (${approval.coverage}), agreed ${approval.consented_at ?? "before agreements were recorded"}`);
      writeText(`Downloaded: ${response.downloaded_items}; failed: ${response.failed_items}; no text: ${response.no_text_items}; blocked: ${response.blocked_items}`);
      writeText(`Download job: ${response.job.status}`);
      writeText(`Downloaded files: ${response.source_cache_files} (${formatBytes(response.source_cache_bytes)})`);
      writeText(`Search file: ${response.search_file ? `${response.search_file.documents} documents, ${response.search_file.chunks} passages (${response.search_file.coverage})` : "none"}`);
      writeText(`Report: ${response.download_report_path}`);
    }
  });

corpus
  .command("download")
  .argument("[corpusId]", "Built-in collection ID (or use --all)")
  .option("--all", "Download every downloadable built-in collection, one after another")
  .option("--sample", "Download the small sample instead of the full selection")
  .option("--mode <mode>", "Source manifest download mode")
  .option("--path <path>", "Curated source path to download")
  .option("--limit <number>", "Only the first N items of the chosen selection")
  .option("--yes", "Agree to the shown notice without prompting (only after reviewing it)")
  .option("--dry-run", "Show what would be downloaded without downloading")
  .option("--force", "Download again even if already on this computer")
  .option("--skip-index", "Download without rebuilding the search file")
  .option("--allow-external-manifest", "Allow a non-built-in capsule's source list (curators only)")
  .option("--json", "Print machine-readable output")
  .description("Download source text for built-in collections from their original sources")
  .action(async (corpusId: string | undefined, options: {
    all?: boolean;
    sample?: boolean;
    mode?: string;
    path?: string;
    limit?: string;
    yes?: boolean;
    dryRun?: boolean;
    force?: boolean;
    skipIndex?: boolean;
    allowExternalManifest?: boolean;
    json?: boolean;
  }) => {
    if (Boolean(corpusId) === Boolean(options.all)) throw new Error("Give one collection ID, or --all (not both).");
    if (options.all && (options.mode || options.path || options.limit)) throw new Error("--mode, --path, and --limit apply to one collection, not --all.");
    const targets = options.all
      ? listCorpusCapsules().corpora.filter((capsule) => capsule.source === "built_in" && hasSourceManifest(capsule) && listDownloadOptions(capsule.id).downloadable).map((capsule) => capsule.id)
      : [corpusId as string];
    const results: unknown[] = [];
    let failures = 0;
    for (const id of targets) {
      let itemIds: string[] | undefined;
      if (options.limit) {
        const limit = Number.parseInt(options.limit, 10);
        const manifest = loadSourceManifest(getCorpusCapsule(id));
        const items = selectedManifestItems(manifest, { mode: options.mode, path: options.path });
        if (!Number.isInteger(limit) || limit < 1 || limit > items.length) throw new Error(`--limit must be between 1 and ${items.length}.`);
        if (options.sample) throw new Error("--limit cannot be combined with --sample.");
        itemIds = items.slice(0, limit).map((item) => item.id);
      }
      const spec = specFromOptions({ sample: options.sample, mode: options.mode, path: options.path, itemIds });
      const preview = previewDownload(id, spec);
      const confirmed = options.dryRun ? false : await confirmNotice(
        `${preview.title}: ${preview.label}. ${preview.download_note ?? ""}\n${preview.rights_notice}`,
        `Download ${preview.text_items} item(s) for ${id}?`,
        options.yes
      );
      if (!confirmed && !options.dryRun) {
        results.push({ corpus_id: id, ok: false, needs_confirmation: true, rights_notice: preview.rights_notice });
        failures += 1;
        continue;
      }
      try {
        const response = await downloadFromSourceManifest(id, {
          sample: options.sample,
          mode: options.mode,
          path: options.path,
          itemIds,
          dryRun: options.dryRun,
          confirmedRights: confirmed,
          force: options.force,
          skipIndex: options.skipIndex,
          allowExternalManifest: options.allowExternalManifest,
          onProgress: options.json ? undefined : progressPrinter(id)
        });
        if ("ok" in response && response.ok === false && !options.dryRun) failures += 1;
        results.push(response);
        if (!options.json) {
          if ("downloaded" in response && response.downloaded && response.skipped && response.no_text) {
            writeText(`${id}: ${response.status}; ${response.downloaded.length} downloaded, ${response.skipped.length} failed, ${response.no_text.length} without text; search file coverage: ${response.index_coverage ?? "not built"}`);
            for (const failed of response.skipped.slice(0, 10)) writeText(`  failed: ${failed.id}: ${failed.reason}`);
            writeText(`  ${response.next_step}`);
          } else {
            writeText(`${id}: ${preview.label}; ${preview.text_items} item(s) with text${preview.download_bytes !== null ? `, about ${formatBytes(preview.download_bytes)}` : ""}.`);
          }
        }
      } catch (error) {
        failures += 1;
        results.push({ corpus_id: id, ok: false, error: error instanceof Error ? error.message : String(error) });
        if (!options.json) writeText(`${id}: failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (options.json) writeJson(options.all ? { ok: failures === 0, results } : results[0]);
    if (failures) setExit(failures === targets.length ? EXIT.failed : EXIT.partial);
  });

corpus
  .command("cancel-download")
  .argument("<corpusId>", "Collection ID")
  .option("--json", "Print machine-readable output")
  .description("Mark an interrupted download as canceled so it is not resumed")
  .action((corpusId: string, options: { json?: boolean }) => {
    const response = cancelDownload(corpusId);
    if (options.json) writeJson(response);
    else writeText(response.note);
  });

corpus
  .command("regress")
  .argument("<corpusId>", "Collection ID")
  .option("--json", "Print machine-readable output")
  .description("Run built-in corpus workflow regression prompts")
  .action((corpusId: string, options: { json?: boolean }) => {
    const response = runCorpusRegression(getCorpusCapsule(corpusId));
    if (options.json) writeJson(response);
    else {
      writeText(`Regression prompts: ${response.prompt_count}`);
      writeText(`Workflow smoke test: ${response.status}`);
      for (const prompt of response.prompts) {
        writeText(`- ${prompt.prompt}`);
        if (prompt.path) writeText(`  path: ${prompt.path}`);
        if (prompt.expected_no_text) writeText(`  expected no text: ${prompt.note ?? "catalog-only or user-supplied path"}`);
        else {
          writeText(`  searches: ${prompt.searches.map((search) => `${search.query} (${search.count})`).join("; ")}`);
          writeText(`  fetched: ${prompt.fetched_id ?? "none"}`);
        }
      }
      writeText(response.reminder);
      writeText(response.next_step);
    }
  });

corpus
  .command("import")
  .argument("<corpusId>", "vangogh-letters")
  .requiredOption("--from <path>", "Local folder containing Van Gogh letter export files")
  .option("--yes", "Confirm the rights notice without prompting")
  .option("--force", "Replace previously imported local Van Gogh files")
  .option("--json", "Print machine-readable output")
  .description("Import your own local files into the Van Gogh collection")
  .action(async (corpusId: string, options: { from: string; yes?: boolean; force?: boolean; json?: boolean }) => {
    if (corpusId !== VANGOGH_CORPUS_ID) throw new Error(`Local import into a built-in collection is supported for ${VANGOGH_CORPUS_ID}. For other folders use: dialogues import-folder <path>`);
    const confirmed = await confirmNotice(VANGOGH_RIGHTS_NOTICE, "Copy and index these local Van Gogh files?", options.yes);
    if (!confirmed) throw new Error("Confirmation required. Re-run with --yes or type YES at the prompt after reviewing the rights notice.");
    const response = await importVanGoghLetters({ from: options.from, yes: true, force: options.force });
    if (options.json) writeJson(response);
    else {
      writeText(`Imported ${response.documents} Van Gogh letter document(s), ${response.chunks} chunk(s).`);
      writeText(`Report: ${response.import_report_path}`);
      writeText(response.next_step);
    }
  });

async function runReindex(corpusId: string, options: { json?: boolean }): Promise<void> {
  const response = await reindexCorpus(getCorpusCapsule(corpusId));
  if (options.json) writeJson(response);
  else writeText(`Rebuilt ${corpusId}: ${"documents" in response ? response.documents : "?"} document(s), ${"chunks" in response ? response.chunks : "?"} passage(s).`);
}

corpus
  .command("reindex")
  .argument("<corpusId>", "Collection ID")
  .option("--json", "Print machine-readable output")
  .description("Same as: dialogues reindex <corpusId>")
  .action(runReindex);

corpus
  .command("install")
  .argument("<corpusId>", "Collection ID")
  .option("--json", "Print machine-readable output")
  .description("Deprecated: rebuild a collection's search file (use dialogues reindex)")
  .action(runReindex);

program
  .command("reindex")
  .argument("<corpusId>", "Collection ID")
  .option("--json", "Print machine-readable output")
  .description("Rebuild a collection's search file from files already on this computer")
  .action(runReindex);

program
  .command("quickstart")
  .description("Create and index a tiny synthetic demo collection (no download)")
  .option("--force", "Replace the existing demo collection")
  .option("--json", "Print machine-readable output")
  .action(async (options: { force?: boolean; json?: boolean }) => {
    const response = await runQuickstart({ force: options.force });
    if (options.json) writeJson(response);
    else {
      writeText(`Demo collection ready: ${response.corpus_id}`);
      writeText(`Folder: ${response.corpus_path}`);
      writeText("Example prompts:");
      for (const prompt of response.example_prompts) writeText(`- ${prompt}`);
      writeText(response.next_step);
    }
  });

// ---------- Curator tools ----------

const source = program.command("source").description("Curator source harvesting commands");

source
  .command("discover")
  .argument("<corpusId>", "Corpus ID")
  .option("--source <source>", "Discovery source", "loc-lincoln")
  .option("--query <query>", "Search query or comma-separated queries. Defaults to Lincoln mind-evidence terms")
  .option("--limit <count>", "Maximum new candidates to discover", (value) => Number.parseInt(value, 10), 500)
  .option("--page-size <count>", "Source API page size", (value) => Number.parseInt(value, 10), 50)
  .option("--delay-ms <ms>", "Delay between source requests", (value) => Number.parseInt(value, 10), 750)
  .option("--fetch-text", "Download and normalize text for discovered candidates")
  .option("--force", "Replace cached raw and normalized source files")
  .option("--yes", "Confirm curator source discovery")
  .option("--json", "Print machine-readable output")
  .description("Discover archive candidates into the data folder for curator review")
  .action(async (corpusId: string, options: { source: DiscoverSource; query?: string; limit: number; pageSize: number; delayMs: number; fetchText?: boolean; force?: boolean; yes?: boolean; json?: boolean }) => {
    const response = await discoverSources(corpusId, options);
    if (options.json) writeJson(response);
    else {
      writeText(`Discovered ${response.discovered} new candidate source item(s) for ${corpusId}`);
      writeText(`Fetched text: ${response.fetched_text}`);
      writeText(`Candidates DB: ${response.candidates_db_path}`);
      writeText(`Report: ${response.discovery_report_path}`);
      writeText(response.note);
    }
  });

source
  .command("harvest")
  .argument("<corpusId>", "Corpus ID")
  .option("--mode <mode>", "Harvest mode", "full-dev")
  .option("--path <path>", "Only harvest items assigned to a curated path")
  .option("--yes", "Confirm curator harvest")
  .option("--force", "Replace cached harvested files")
  .option("--json", "Print machine-readable output")
  .description("Harvest source candidates into the data folder for curator review")
  .action(async (corpusId: string, options: { mode: string; path?: string; yes?: boolean; force?: boolean; json?: boolean }) => {
    const response = await harvestSources(corpusId, options);
    if (options.json) writeJson(response);
    else {
      writeText(`Harvested ${response.items} candidate source item(s) for ${corpusId}`);
      writeText(`Candidates DB: ${response.candidates_db_path}`);
      writeText(`Report: ${response.harvest_report_path}`);
    }
  });

const curate = program.command("curate").description("Curator scoring, review, and manifest export commands");

curate
  .command("score")
  .argument("<corpusId>", "Corpus ID")
  .option("--json", "Print machine-readable output")
  .description("Score harvested source candidates with deterministic mind-evidence rules")
  .action((corpusId: string, options: { json?: boolean }) => {
    const response = runCurationScore(corpusId);
    if (options.json) writeJson(response);
    else writeText(`Scored ${response.candidates} candidate(s) for ${corpusId}. Top candidates: ${response.top_candidates_path}`);
  });

curate
  .command("export-review")
  .argument("<corpusId>", "Corpus ID")
  .option("--path <path>", "Curated path to review")
  .option("--json", "Print machine-readable output")
  .description("Export candidate review CSV for Excel or Sheets")
  .action((corpusId: string, options: { path?: string; json?: boolean }) => {
    const response = exportReviewCsv(corpusId, options.path);
    if (options.json) writeJson(response);
    else writeText(`Review rows: ${response.rows}. Review CSV: ${response.review_path}`);
  });

curate
  .command("import-review")
  .argument("<corpusId>", "Corpus ID")
  .argument("<csvPath>", "Review CSV path")
  .option("--json", "Print machine-readable output")
  .description("Import manual review decisions; selected=true overrides scoring")
  .action((corpusId: string, csvPath: string, options: { json?: boolean }) => {
    const response = importReviewCsv(corpusId, csvPath);
    if (options.json) writeJson(response);
    else writeText(`Imported ${response.imported} review row(s) for ${corpusId}`);
  });

curate
  .command("export-manifest")
  .argument("<corpusId>", "Corpus ID")
  .option("--mode <mode>", "Download mode to write", "curated-core")
  .option("--path <path>", "Only export selected items assigned to this path")
  .option("--write-capsule", "Write into the capsule's source-manifest.yaml (source checkout only)")
  .option("--json", "Print machine-readable output")
  .description("Export selected candidates as a source manifest (to the data folder by default)")
  .action((corpusId: string, options: { mode?: string; path?: string; writeCapsule?: boolean; json?: boolean }) => {
    const response = exportCuratedManifest(corpusId, options);
    if (options.json) writeJson(response);
    else {
      writeText(`Exported ${response.selected_items} selected source item(s) for ${corpusId}`);
      writeText(`Manifest: ${response.source_manifest_path}`);
      writeText(response.note);
    }
  });

// ---------- Search ----------

program
  .command("import-folder")
  .argument("<path>", "Local folder containing .txt, .md, .pdf, .epub, or .docx files")
  .option("--name <name>", "Display name for the new collection")
  .option("--corpus-id <id>", "Stable collection ID")
  .option("--json", "Print machine-readable output")
  .description("Copy a local folder into a new collection and build its search file")
  .action(async (sourcePath: string, options: { name?: string; corpusId?: string; json?: boolean }) => {
    const response = await importFolder({ sourcePath, name: options.name, corpusId: options.corpusId });
    if (options.json) writeJson(response);
    else {
      writeText(`Imported ${response.copied_files} file(s) as ${response.corpus_id}`);
      writeText(`Collection folder: ${response.corpus_path}`);
      writeText(`Import report: ${response.import_report_path}`);
      if (response.skipped.length) writeText(`Skipped ${response.skipped.length} file(s); see the report.`);
      writeText(response.rights_notice);
    }
  });

program
  .command("search")
  .argument("<corpusId>", "Corpus ID")
  .argument("<query>", "SQLite FTS query")
  .option("--limit <number>", "Result limit", "10")
  .option("--author <author>", "Filter by author")
  .option("--date-start <date>", "Filter documents with date >= value")
  .option("--date-end <date>", "Filter documents with date <= value")
  .option("--language <language>", "Filter by language")
  .option("--document-id <id>", "Filter by document ID")
  .option("--path <path>", "Filter by curated source path")
  .option("--min-curator-score <number>", "Filter by minimum curator score")
  .option("--document-type <type>", "Filter by document type")
  .option("--json", "Print machine-readable output")
  .description("Search a collection from the command line")
  .action((corpusId: string, query: string, options: { limit: string; author?: string; dateStart?: string; dateEnd?: string; language?: string; documentId?: string; path?: string; minCuratorScore?: string; documentType?: string; json?: boolean }) => {
    const response = searchCorpus(getCorpusCapsule(corpusId), query, Number.parseInt(options.limit, 10), {
      author: options.author,
      dateStart: options.dateStart,
      dateEnd: options.dateEnd,
      language: options.language,
      documentId: options.documentId,
      path: options.path,
      minCuratorScore: options.minCuratorScore ? Number.parseInt(options.minCuratorScore, 10) : undefined,
      documentType: options.documentType
    });
    if (options.json) writeJson(response);
    else {
      const warning = "warning" in response && typeof response.warning === "string" ? response.warning : undefined;
      if (warning) writeText(warning);
      for (const result of response.results) {
        writeText(`${result.id}`);
        writeText(`  ${result.citation}`);
        writeText(`  ${result.snippet}`);
      }
      if (response.results.length === 0 && !warning) writeText(response.next_steps.message);
    }
  });

program
  .command("fetch")
  .argument("<id>", "Stable passage ID")
  .option("--context-window <number>", "Passages before/after target", "2")
  .option("--json", "Print machine-readable output")
  .description("Fetch a passage by stable ID")
  .action((id: string, options: { contextWindow: string; json?: boolean }) => {
    const corpusId = id.match(/^corpus:([a-z0-9-]+):/)?.[1];
    if (!corpusId) throw new Error("Not a valid passage ID. Expected corpus:<corpusId>:doc:<documentId>:chunk:<n>.");
    const response = fetchCorpus(getCorpusCapsule(corpusId), id, Number.parseInt(options.contextWindow, 10));
    if (options.json) writeJson(response);
    else {
      for (const passage of response.passages) {
        writeText(`${passage.is_target ? ">>" : "  "} ${passage.citation}`);
        writeText(passage.text);
      }
    }
  });

const readOnlyCommands = new Set(["ready"]);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const command = process.argv.slice(2).find((arg) => !arg.startsWith("-")) ?? "dialogues";
  if (!readOnlyCommands.has(command)) {
    try {
      runtimeConfig();
      appendLogEvent("errors", { command, error: message });
    } catch {
      // Never let error logging hide the original error.
    }
  }
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = EXIT.failed;
});

