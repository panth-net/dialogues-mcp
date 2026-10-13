# Claude Code Notes

Dialogues is local-first. The MCP server runs over stdio and reads built-in corpus capsules plus the user's data folder (`~/Dialogues` by default: search files, downloaded text, imported collections, logs).

Keep the core loop:

1. Read the corpus guide.
2. Suggest source-appropriate searches when needed.
3. Search with concrete source vocabulary.
4. Fetch promising passages with context.
5. Quote, cite, contextualize, and explain limitations.

Do not add hosted services, vector DBs, generic RAG infrastructure, telemetry, automatic update checks, or a web UI unless explicitly asked.

## Run and check

```bash
npm ci
npm run build
npm test
npm run typecheck
node dist/cli/index.js ready
node dist/cli/index.js doctor --fix
node dist/cli/index.js mcp serve
node dist/cli/index.js mcp config all     # print snippets; changes no app
```

## Set up as an MCP for the user

If the user says "set this up as an MCP", do the install from this folder. Opening the repository alone is not a request to install.

Connect only the app the user is using right now. Do not connect every app unless the user asks.

Windows:

```bash
installers/setup.bat claude-desktop --from-checkout
installers/setup.bat claude-code --from-checkout
installers/setup.bat codex --from-checkout
installers/setup.bat cursor --from-checkout
installers/setup.bat vscode --from-checkout
installers/setup.bat antigravity --from-checkout
```

macOS/Linux:

```bash
sh installers/setup.sh claude-desktop --from-checkout
sh installers/setup.sh claude-code --from-checkout
sh installers/setup.sh codex --from-checkout
sh installers/setup.sh cursor --from-checkout
sh installers/setup.sh vscode --from-checkout
sh installers/setup.sh antigravity --from-checkout
```

If you cannot tell which app they want, ask one question: "Which app do you want to connect: Claude Desktop, Claude Code, Codex, Cursor, VS Code, or Antigravity?"

Then verify:

```bash
dialogues ready
```

Do not make the user hand-edit Claude, Codex, Cursor, VS Code, or Antigravity config files unless setup fails. Do not read those files into the chat: they can contain credentials. The installer checks for Node.js 22.16+ and npm, installs the `dialogues` command, backs up and edits only the selected app's Dialogues entry, and downloads no document collections. Python is not required.

After setup, tell the user to fully quit and reopen the app, then send:

```text
Hi! I want to use Dialogues. Show me the document collections, recommend where to start, and help me choose.
```

Then show the collections as a table (title, one-sentence tagline, local size, status), recommend the small sample from Pepys, Van Gogh, Jesuit Relations, Darwin, Lincoln, and Gandhi with its sizes and source terms, and download what the user picks.

## Add a corpus

```bash
node dist/cli/index.js corpus create "New Corpus"
node dist/cli/index.js corpus profile new-corpus
node dist/cli/index.js reindex new-corpus
node dist/cli/index.js corpus lint new-corpus
```

User corpora are created in the data folder (`<data-dir>/user-corpora/`). Capsules use `corpus.yaml`, `guide.md`, `search-rules.md`, `source-notes.md`, `citation-rules.md`, and a local `documents/` folder.

Do not commit imported documents, downloaded corpus data, generated SQLite indexes, private logs, or planning notes.
