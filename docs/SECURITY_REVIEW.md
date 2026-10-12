# Dependency security review

Recorded 2026-10-08. Re-run `npm audit` and `npm audit --omit=dev` before each release and update this file.

## Starting point

The pre-release tree reported 16 vulnerable entries (1 critical, 9 high, 5 moderate, 1 low). Most came through the v1 MCP SDK's HTTP server stack (express, hono, proxy-addr, qs, body-parser, ip-address, fast-uri), which Dialogues never used: it serves stdio only.

## What changed

| Finding | Action |
| --- | --- |
| `@modelcontextprotocol/sdk` (high: OAuth credential routing) and its HTTP stack: `proxy-addr` (critical), `hono`, `@hono/node-server`, `fast-uri`, `ip-address`, `qs`, `body-parser` | Replaced with `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.3.1, which have no HTTP framework dependencies. Removed. |
| `pdfjs-dist` (high: script execution from a malicious PDF, fixed in 6.2.108) | Upgraded to 6.4.299. PDF.js also loads only when a PDF is processed, with font loading and XFA disabled, page and time limits. |
| `adm-zip` (high: memory exhaustion from crafted ZIPs; symlink overwrite on extraction) | Upgraded to 0.6.1. Dialogues never extracts archives to disk; it reads entries in memory after checking entry count, declared size, and entry names. |
| `html-to-text` via `deepmerge-ts` (high: stack exhaustion) | Upgraded to 10.0.1 (`deepmerge-ts` 8.0.2). |
| `@xmldom/xmldom` via `mammoth` (high) | Resolved to 0.8.15 within mammoth's range. |
| `better-sqlite3` | Removed; Node's built-in `node:sqlite` is used. |

## Remaining (assessed, not reachable)

`npm audit --omit=dev` reports 3 moderate entries: `sprintf-js` (denial of service through unbounded precision specifiers), reached through `argparse`, reached through `mammoth`. No fixed `sprintf-js` release exists. `argparse` is required only by mammoth's command-line program (`node_modules/mammoth/bin/mammoth`); Dialogues imports mammoth as a library (`mammoth.convertToHtml`) and never loads that program, so the vulnerable code is not reachable from Dialogues. Follow-up: drop the entry when mammoth removes `argparse` or a fixed `sprintf-js` ships.

Release rule: no unresolved reachable high or critical finding; any remaining advisory needs a reachability note here.

## Optional native code

`@napi-rs/canvas` (an optional dependency of PDF.js) contains prebuilt native code. It is used only for PDF processing. Installing with `--omit=optional` removes it; Dialogues then reports PDFs as unsupported and everything else keeps working. The core (MCP server, search, downloads, imports of other formats) needs no compiled addon, compiler, or Python.
