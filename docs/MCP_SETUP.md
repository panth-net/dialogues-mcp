# Connecting apps

Dialogues is a local stdio MCP server. It needs no HTTP endpoint, public URL, API key, or hosted connector. Apps start it with absolute paths to Node.js and to the installed `dialogues` script, plus your data folder:

```text
<node> <install-folder>/dist/cli/index.js mcp serve --data-dir <your data folder>
```

## Recommended: `dialogues setup`

```bash
dialogues setup --client claude-desktop
dialogues setup --client claude-code
dialogues setup --client codex
dialogues setup --client cursor
dialogues setup --client vscode
dialogues setup --client antigravity
```

Setup connects only the app you name. Add `--data-dir <folder>` to keep collections somewhere other than `~/Dialogues`, and `--json` for one machine-readable result on stdout (progress goes to stderr). It:

1. checks Node.js (22.16 or newer),
2. creates the data folder and remembers it in `~/.dialogues/config.json`,
3. backs up the app's settings, then adds or updates only the `dialogues` entry,
4. records what it created (app, location, a digest of the entry, data folder, version) in `<data-dir>/install-state.json`, without copying any other settings,
5. installs the conversation skill for apps that load skills from a folder (Claude Code, Codex),
6. starts the server once and calls its `ping` tool to check it works.

It never downloads collections. If the app already has a `dialogues` entry that this setup did not create (or that you edited), setup leaves it alone and says so; add `--replace` to overwrite it. Use `--all` only if you really want every detected app connected. `--dry-run` shows what would change.

Exit codes: `0` connected, `1` failed, `2` partly connected, `3` no app chosen, `4` left an existing entry alone.

The server check proves that Dialogues starts; it does not prove the app has loaded the new entry. Fully quit and reopen the app, then ask it to list Dialogues collections.

### Per app

| App | What setup does |
| --- | --- |
| Claude Desktop (Windows, macOS) | Edits `claude_desktop_config.json` (`%APPDATA%\Claude\` or `~/Library/Application Support/Claude/`), keeping every other entry. Quit Claude Desktop fully, including from the tray or menu bar. If you installed Claude Desktop from the Microsoft Store and Dialogues does not appear, add it through Claude Desktop's Settings > Developer > Edit Config using `dialogues mcp config claude-desktop`. Claude Desktop's local Code tab reads its own and Claude Code's settings. |
| Claude Code | Runs `claude mcp add-json dialogues ... --scope user`. When replacing an entry, it first adds a temporary `dialogues-setup-new` entry, so a failure never leaves you with none. Start a new Claude Code session afterwards. |
| Codex | Runs `codex mcp add dialogues -- <node> <script> mcp serve --data-dir <folder>` (respects `CODEX_HOME`). Without the `codex` command, it edits `config.toml` directly, replacing only the `[mcp_servers.dialogues]` table and its subtables. Codex's default tool timeout is 60 seconds; Dialogues downloads run in the background and return progress before then. |
| Cursor | Edits `~/.cursor/mcp.json` (`mcpServers.dialogues`). |
| VS Code | Edits your user `mcp.json` (`servers.dialogues`, type `stdio`), keeping comments. For a non-default profile, pass `--vscode-profile <folder name under User/profiles>`. Workspace `.vscode/mcp.json` files are never changed. |
| Antigravity | Edits `~/.gemini/config/mcp_config.json` (`mcpServers.dialogues`), keeping every other server. Early Antigravity builds used `~/.gemini/antigravity/mcp_config.json`; setup uses that file only when it has content and the newer one does not exist. To check which file your Antigravity reads, open the agent panel's menu, then Manage MCP Servers, then View raw config. Fully quit and reopen Antigravity afterwards. |

## Snippets for manual setup

```bash
dialogues mcp config claude-desktop
dialogues mcp config claude-code
dialogues mcp config codex
dialogues mcp config cursor
dialogues mcp config vscode
dialogues mcp config antigravity
dialogues mcp config all
```

Snippets are printed and saved under `<data-dir>/mcp/`. They contain absolute paths for this computer. There is deliberately no `npx dialogues-mcp@latest` fallback: that would download code every time an app starts.

## Checking and repairing

```bash
dialogues ready          # read-only: no changes, no network
dialogues doctor         # checks
dialogues doctor --fix   # creates missing folders, cleans up interrupted work,
                         # and refreshes app entries Dialogues created and you have not edited
```

`doctor --fix` never downloads collections and never connects an app you did not choose.

## Updating and removing

```bash
dialogues update                         # npm install -g dialogues-mcp@latest, then refreshes owned app entries
dialogues uninstall                      # removes app entries and skills Dialogues created and you have not edited
dialogues uninstall --client codex       # just one app
```

Your collections are kept unless you add `--delete-data --confirm-data-dir <exact folder>`. Folders you imported from and externally registered collections are never deleted. Remove the program with `npm uninstall -g dialogues-mcp`.

## Data folder

The data folder is chosen in this order: `--data-dir` (old name `--workspace`), `DIALOGUES_HOME` (old name `DIALOGUES_WORKSPACE`), `DIALOGUES_WORKSPACE_MODE=repo` (contributors: `./workspace` in a checkout), the folder remembered in `~/.dialogues/config.json`, then `~/Dialogues`. The current working directory never changes it. `dialogues ready` shows which rule applied.

Earlier versions kept data in `~/.dialogues/` or inside the checkout. `dialogues migrate` previews copying it; `dialogues migrate --apply` copies, verifies, and leaves the originals.

## Platform notes

- Windows and macOS: all five apps.
- Linux: Claude Code, Codex, Cursor, and VS Code. Claude Desktop has no Linux build.
- Vendor commands installed through npm on Windows (`claude.cmd`, `codex.cmd`) are run with explicit quoting, so paths with spaces work.
