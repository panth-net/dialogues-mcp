# Corpus Capsules

A Dialogues corpus is not just files. It is a capsule:

```text
documents + metadata + search file + guide + search rules + source notes + citation rules
```

Every capsule must include:

```text
corpus.yaml
guide.md
search-rules.md
source-notes.md
citation-rules.md
```

Built-in curated corpora also include:

```text
selection-rules.md
source-manifest.yaml     # items, rights levels, download modes, and topic paths
sample.yaml              # optional small first-run sample
```

Topic paths are declared in `source-manifest.yaml` under `paths:` and assigned per item; they are what `search` filters and `--path` downloads use. (Older separate `paths/*.yaml` files are no longer used.) These files are shareable. Downloaded source text, harvests, logs, and SQLite search files are not package data; they live in the user's data folder.

`corpus.yaml` is validated at startup. Invalid corpora are skipped and reported as readable loader errors by `list_corpora`, `dialogues list --json`, and `dialogues doctor --json`.

## Required Manifest Fields

```yaml
id: example-corpus
title: Example Corpus
description: A concise description of the source set.
languages:
  - en
type: historical_archive
status: user
data_policy: user_provided_local
default_search_mode: fts
guide: guide.md
search_rules: search-rules.md
source_notes: source-notes.md
citation_rules: citation-rules.md
fields:
  - doc_id
  - title
  - chunk_index
chunking:
  min_chars: 300
  max_chars: 1600
  overlap_chars: 150
  preserve_paragraphs: true
license:
  data_included: false
  user_must_confirm_rights: true
  notes: "User is responsible for confirming rights."
```

License and data policy fields are required. Dialogues refuses to index a corpus object that is missing required manifest metadata.

## Corpus Locations

Built-in corpora (read-only, shipped with the package):

```text
corpora/
```

User corpora (created or imported by the user):

```text
<data-dir>/user-corpora/
```

Externally registered corpora (read-only unless you pass `--edit-installed`; their search files live in the data folder):

```text
<data-dir>/installed-corpora.json
```

Search files for every corpus live in `<data-dir>/indexes/<corpus-id>/index.sqlite`.

Example:

```json
{
  "corpora": [
    {
      "path": "D:/local-corpora/city-archive"
    }
  ]
}
```

Relative installed paths are resolved from the data folder. Absolute paths are used as-is. `dialogues migrate` rewrites relative entries from older installs to absolute paths.

## Guide Composition

`get_corpus_guide` returns one combined guide with nine stable sections:

1. What this corpus is
2. What kinds of questions it can answer
3. What kinds of questions it cannot answer
4. Historical/literary/contextual search strategy
5. Important vocabulary
6. Common traps
7. Citation rules
8. Response style
9. Suggested first searches

The composed guide always tells the AI not to answer only from memory, to search first, to fetch passages with context, and to synthesize with citations and limitations.

## Default Guide Templates

New user corpora created by `dialogues import-folder` receive editable guide files copied from:

```text
templates/corpus/guide.md
templates/corpus/search-rules.md
templates/corpus/source-notes.md
templates/corpus/citation-rules.md
```

The generated files live inside the user corpus folder, so users can revise them without changing code.

## Import Pipeline

`dialogues import-folder <path> --name <name>` copies a local folder into `<data-dir>/user-corpora/<id>/` and builds its search file. The import is staged in a hidden folder and only appears once its search file is ready. Hidden, system, and credential-looking files, symbolic links, and junctions are skipped; file count, file size, total size, folder depth, archive size, PDF pages, and processing time are capped.

Supported v1 files:

- `.txt`
- `.md`
- `.markdown`
- text-layer `.pdf`
- `.epub`
- `.docx`

Image-only PDFs fail visibly with an OCR-not-supported message. Dialogues does not create a silent empty index when no text can be extracted.

Every import writes:

```text
<data-dir>/user-corpora/<id>/import-report.md
<data-dir>/logs/imports.jsonl
```

The report lists files found, imported, skipped, warnings, indexed document/chunk counts, the source/license notice, and a suggested next prompt.

## Chunking

The shared chunker prefers paragraphs, preserves document boundaries, merges tiny paragraphs, splits giant paragraphs, keeps original and normalized text, and uses deterministic chunk indexes.

Imported corpora get this editable default:

```yaml
chunking:
  min_chars: 300
  max_chars: 1600
  overlap_chars: 150
  preserve_paragraphs: true
```

## Search Suggestions

`suggest_searches` reads the loaded corpus guide files, especially
`search-rules.md`, and returns rule-based search queries with reasons. It does
not call an LLM. For curated built-ins, pass a path when you know the user's
source path:

```bash
dialogues corpus suggest-searches lincoln-papers "How did Lincoln reason under pressure?" --path legal-mind
```

Use it when a question uses modern or broad wording that may not appear directly in the source. The result is a starting point: run a suggested query, fetch promising passages, then refine with vocabulary discovered in context.

## Curated Source Manifests

Manifest-backed built-ins support:

```bash
dialogues corpus download-options <corpus-id>
dialogues corpus download <corpus-id> --yes
dialogues corpus download <corpus-id> --path <path-id> --yes
dialogues corpus source-status <corpus-id>
dialogues corpus regress <corpus-id>
```

`download-options` works before any local index exists. It lists modes, guided paths, selected item counts, and rights summaries.

`download` fetches only selected source items from original sources after explicit local confirmation. Items marked `borrow_only`, `catalog_only`, or `user_supplied_only` never download source text.

`source-status` reports installed paths, downloaded items, skipped items, no-text items, rights confirmation, and index stats without returning source text.

`regress` is a workflow smoke test. For searchable paths, it verifies guide -> search -> fetch. For catalog-only or user-supplied-only paths, it verifies that the limitation is explicit instead of pretending metadata is passage evidence.
