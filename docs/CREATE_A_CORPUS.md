# Create A Corpus

A Dialogues corpus is a local folder with documents, metadata, a search index, and guide files that teach an AI how to read the source set.

Create one:

```bash
node dist/cli/index.js corpus create "Grandma's Letters"
```

Drop files into:

```text
<data-dir>/user-corpora/grandmas-letters/documents/
```

Then index them:

```bash
node dist/cli/index.js reindex grandmas-letters
```

## Guide

`guide.md` should explain:

- What the corpus is.
- Who made the documents and for whom.
- Approximate dates and places.
- What questions the corpus can answer.
- What the AI should avoid.
- How to bring the corpus to life.

Bad:

```md
This is a folder of letters. Answer questions about it.
```

Good:

```md
These are family letters written between 1942 and 1946. Attend to rationing, military service, illness, money, and what family members avoid saying directly. Do not assume every silence means agreement. Quote sparingly and cite fetched passages.
```

## Search Rules

`search-rules.md` translates user language into source vocabulary.

Examples:

- Old letters: `mother OR father OR enclosed OR received`
- Public-domain novel: `marriage OR fortune OR estate OR reputation`
- City archive: `ordinance OR permit OR complaint OR council`
- Meeting minutes: `motion OR seconded OR vote OR adjourned`
- Religious text: `prayer OR sin OR grace OR covenant`
- Family documents: `rent OR wages OR school OR doctor`

## Source Notes

`source-notes.md` should cover provenance, privacy, OCR/transcription quality, translation issues, missing metadata, and rights.

## Citation Rules

`citation-rules.md` should tell the AI to cite fetched passages, not snippets. If dates, authors, or page numbers are missing, say that the local import did not provide them.

## Profile Helper

Run:

```bash
node dist/cli/index.js corpus profile grandmas-letters
```

The CLI asks plain-English questions and rewrites `guide.md` and `source-notes.md`. Use `corpus lint` afterward for suggestions:

```bash
node dist/cli/index.js corpus lint grandmas-letters
```
