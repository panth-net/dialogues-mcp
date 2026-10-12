# Corpus Data Policy

Dialogues is local-first. The package includes guides, source lists, importers, and adapters. It does not bundle source texts or search files.

## Rules

- Built-in capsules may include `corpus.yaml`, `guide.md`, `search-rules.md`, `source-notes.md`, `citation-rules.md`, `selection-rules.md`, `source-manifest.yaml`, and `sample.yaml`. They must not include source texts or SQLite indexes.
- Built-in capsules are read-only at runtime. Downloads, search files, imported collections, logs, preferences, and consent records live in the user's data folder.
- Users are responsible for confirming copyright, license, privacy, provenance, and source terms before importing, downloading, or sharing outputs.
- Every capsule declares whether data is downloaded or user-provided, and every source item carries a rights level.
- Download reports and consent records keep the source list, rights summary, and the notice the user agreed to (with its hash), separately from report timestamps.
- A license label such as `open_license` or `no_known_restrictions` is not, by itself, permission to redistribute. Prebuilt text or index bundles are out of scope for v1 and would need per-source review.

## Consent

- Every built-in download requires an explicit agreement to a notice that names the selection, its size when known, and the rights levels involved.
- An agreement covers exactly that selection and notice. A different selection, or a changed notice, needs a new agreement. Clients may pass the `noticeSha256` they showed; a mismatch refuses the download.
- `confirmedRights` is what the AI client reports. It is a record of agreement in that conversation, not independent proof of who agreed.

## No-circumvention policy

Do not bypass login, borrowing, DRM, paywalls, IIIF restrictions, robots exclusions, or archive access controls. Do not scrape borrow-only books. Do not package restricted source text.

Adapters refuse text downloads for `borrow_only`, `catalog_only`, and `user_supplied_only` items. `unknown`, `noncommercial_open_license`, and `rights_confirmed_user_download` items are downloaded only under the explicit agreement above.

## Network boundary

- Only built-in capsules (shipped with Dialogues) can be downloaded through the MCP tool. Externally registered or user capsules cannot point the downloader at arbitrary URLs.
- Each collection may contact only the hosts named in its own source list (grouped by registrable domain, e.g. `loc.gov` covers `tile.loc.gov`). Redirects and text links discovered inside downloaded records are checked at every hop.
- Requests to IP literals, local network names, or hosts that resolve to private, loopback, or link-local addresses are refused.
- Requests have connect and body deadlines and size limits (decompressed bytes count), are paced per host, and retry `408/425/429/5xx` responses honoring `Retry-After`.
- Cached files are reused only when their recorded source URL and hash match; a failed forced refresh keeps the previous file.

## Samples

Six collections offer a small first-run sample (`sample.yaml`): Pepys, Van Gogh, Jesuit Relations, Darwin, Lincoln, and Gandhi. Each sample lists exact items, an upstream download size measured on 2026-10-08, and any text window or document filter. Where an archive is published only as one file (the complete Pepys diary, the Van Gogh XML archive), the whole file is downloaded and the notice says so; only the sample portion is made searchable until the user approves more. Later approvals add to the search file; they never discard an earlier sample or a fuller selection.

## Built-in collection posture

- `jesuit-relations`: 73 Thwaites volumes as Internet Archive OCR text, listed in `source-manifest.yaml`; public domain.
- `vangogh-letters`: the official XML edition, one archive file, CC BY-NC-SA 4.0. Users may instead import their own local files with `dialogues corpus import vangogh-letters --from <folder>`.
- Other manifest-backed collections ship source IDs, paths, rights levels, source URLs, and curator notes only. Users download selected items from the original sources.
- `faraday-papers` is hybrid: Project Gutenberg texts are downloadable; Royal Institution and AIM25 records are catalog-only.
- `teika-diary` is catalog-only.
- `dialogues-demo`, created by `dialogues quickstart`, contains tiny project-written synthetic documents.

## Repository protections

`.gitignore` excludes downloaded data, search files, user corpora, the contributor `workspace/`, logs, planning notes, and environment files. `npm run privacy-scan` checks the files that would be published.
