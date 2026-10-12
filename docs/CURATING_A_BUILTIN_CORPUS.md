# Curating a Built-In Corpus

Dialogues built-in corpora ship curation structure, not source text. The curator track is private and local; the public user track downloads only selected source items from original sources.

## What We Are Trying to Recover

Dialogues does not impersonate historical people or summarize famous doctrines. It reconstructs how minds and groups actually worked from source evidence: reasoning, revision, reaction, dialogue, constraint, contradiction, humor, uncertainty, method, influence, and practical decision-making.

## Curator Track

1. Create or edit the corpus capsule:
   - `corpora/<corpus-id>/corpus.yaml`
   - `guide.md`
   - `search-rules.md`
   - `source-notes.md`
   - `citation-rules.md`
   - `selection-rules.md`
   - `source-manifest.yaml` (items, rights levels, modes, and topic `paths:`)
   - `sample.yaml` (optional: a small, measured first-run sample)

2. Discover or harvest candidate material locally.

Use `source discover` when expanding beyond the current manifest into a real source archive. The first archive discovery path is Lincoln at the Library of Congress:

```bash
dialogues source discover lincoln-papers --source loc-lincoln --fetch-text --limit 500 --yes
```

This writes candidate metadata and, with `--fetch-text`, normalized local text into the data folder (`<data-dir>/harvests/`). The command is resumable: reruns skip already-fetched text unless `--force` is used. Keep limits and delays respectful of source-site rate limits.

Use `source harvest` only when harvesting records that are already listed in `source-manifest.yaml`; `full-dev` means all manifest items, not the whole external archive:

```bash
dialogues source harvest lincoln-papers --mode full-dev --yes
```

Discovery and harvest output stays under:

```text
<data-dir>/harvests/<corpus-id>/
  raw/
  normalized/
  candidates.sqlite
  discovery-report.md
  harvest-report.md
  source-records.jsonl
```

3. Score candidates:

```bash
dialogues curate score lincoln-papers
```

This writes deterministic scores and mind-evidence signals under `<data-dir>/curation/<corpus-id>/`.

4. Review in CSV:

```bash
dialogues curate export-review lincoln-papers --path legal-mind
dialogues curate import-review lincoln-papers <data-dir>/curation/lincoln-papers/review-legal-mind.csv
```

The review CSV includes metadata, score, signals, paths, selected, why_keep, and why_skip. It does not include full source text by default.

5. Export the curated public manifest:

```bash
dialogues curate export-manifest lincoln-papers --mode curated-core
```

This writes `<data-dir>/exports/lincoln-papers/source-manifest.yaml` with selected source IDs, source URLs, rights levels, paths, signals, scores, and curator notes. It must not include source text. In a source checkout, add `--write-capsule` to write `corpora/lincoln-papers/source-manifest.yaml` instead; installed built-in capsules are read-only.

## Public User Track

Users inspect the sample and curated paths:

```bash
dialogues corpus download-options lincoln-papers
```

Users download selected source items from original sources:

```bash
dialogues corpus download lincoln-papers --path legal-mind --yes
```

Then they search and fetch:

```bash
dialogues search lincoln-papers "law OR evidence" --path legal-mind
dialogues fetch corpus:lincoln-papers:doc:<document-id>:chunk:<chunk-index>
```

## Rights Checklist

- Do not commit source text, generated SQLite indexes, harvested files, downloaded documents, or private logs.
- Commit only guide files, selection rules, source manifests, sample profiles, docs, tests, and code.
- Do not bypass login, borrow gates, DRM, paywalls, IIIF restrictions, robots exclusions, or archive access controls.
- Mark `borrow_only`, `catalog_only`, and `user_supplied_only` honestly.
- `unknown`, `noncommercial_open_license`, and `rights_confirmed_user_download` require local user confirmation.
- Reports and logs must include rights summaries but no source text.

## Lincoln End-to-End Smoke Test

When Lincoln has curated items in `source-manifest.yaml`, verify:

```bash
dialogues corpus download-options lincoln-papers
dialogues corpus download lincoln-papers --path legal-mind --yes
dialogues corpus source-status lincoln-papers
dialogues search lincoln-papers "law OR evidence" --path legal-mind
dialogues corpus regress lincoln-papers
```

The result proves the complete loop: harvest, score, review, export manifest, user download, local index, path-aware search, fetch, cited answer with limitations.

## Built-In Release Smoke Test

Before release, each built-in corpus should satisfy the appropriate local smoke test:

```bash
dialogues corpus download-options lincoln-papers
dialogues corpus download-options douglass-papers
dialogues corpus download-options darwin-correspondence
dialogues corpus download-options newton-papers
dialogues corpus download-options lovelace-babbage
dialogues corpus download-options faraday-papers
dialogues corpus download-options vangogh-letters
dialogues corpus download-options thoreau-writings
dialogues corpus download-options jane-austen-letters
dialogues corpus download-options beethoven-letters
dialogues corpus download-options mark-twain-letters
```

For corpora with downloadable text, run download and regression locally:

```bash
dialogues corpus download lincoln-papers --yes
dialogues corpus regress lincoln-papers
```

For catalog-only corpora or paths, regression should report the expected no-text limitation rather than fail with invented evidence. That is the correct behavior until permitted local text exists.
