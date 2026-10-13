# Privacy

Dialogues runs on your computer. This page describes exactly what it stores, what it sends, and to whom.

## What stays on your computer

Everything Dialogues stores is in your data folder (`~/Dialogues` unless you chose another one):

- search files (`indexes/`), downloaded source text (`source-cache/`), and collections you imported (`user-corpora/`);
- `preferences.json` (for example how you like answers formatted);
- `consents.jsonl`: a record of each download, with the time, the selection, and the notice text and its hash;
- `install-state.json`: which app entries and skill files Dialogues created, with a digest of each, the data folder, and the version (no other app settings);
- `logs/`: operation logs.

Outside the data folder, Dialogues writes only: the entry it adds to the app you connect, the conversation skill file for apps that load skills, a small pointer file `~/.dialogues/config.json` that remembers your data folder, and files you explicitly export.

## What is sent to your AI app

When you ask a question, the AI app calls Dialogues' tools. The results (collection lists, search snippets, fetched passages, citations, and metadata) go to that app, and from there to its AI service, under that app's own terms. If you ask about a private document you imported, its passages are shared with that app. Dialogues does not control what the app does with them.

## Network activity

Dialogues contacts the internet only:

- when you ask for a collection to be downloaded: requests go to the original archives listed in that collection's source list (for example the Library of Congress, the Internet Archive, Project Gutenberg, the Darwin Correspondence Project, the Van Gogh Museum's letters site);
- when you install or update the package with npm (`npm install`, `dialogues update`).

Starting the server, listing collections, searching, fetching passages, `dialogues ready`, and `dialogues doctor` make no network requests. Dialogues has no telemetry, no automatic update checks, no account, and does not listen on a network port.

## Logs

Operation logs record what Dialogues did: commands, collection IDs, search queries, passage IDs, result counts, timings, file paths, and error messages. Queries and paths can be sensitive. Logs never contain document text. URLs in logs are stripped of credentials and query strings, and your home folder is shortened to `~`. Each log rotates at 5 MB (one previous file is kept).

- `DIALOGUES_LOG=off` turns operation logs off; `DIALOGUES_LOG=errors` keeps only errors.
- `dialogues logs clear` deletes them.
- Download records (`consents.jsonl`) are kept regardless of the log setting, because they record what was downloaded and under which terms.

## Imports

`import_folder` copies only the folder you choose. It skips hidden files and folders, system files, files that look like credentials or keys (for example `.env`, `id_rsa`, `*.pem`), and symbolic links or junctions that point elsewhere. Skipped files are listed by name in the import report; their contents are never read.

## Removing your data

`dialogues uninstall` disconnects apps and keeps your collections. `dialogues uninstall --delete-data --confirm-data-dir <exact folder>` deletes the data folder. Folders you imported from are never touched.
