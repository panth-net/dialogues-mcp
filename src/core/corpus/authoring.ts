import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getCorpusCapsule, invalidateCorpusCache, loadCorpusFromPath } from "./loader.js";
import type { CorpusCapsule, CorpusManifest } from "./types.js";
import { DEFAULT_CHUNKING } from "../import/chunk.js";
import { isSafeId, userCorporaRoot } from "../paths.js";
import { writeFileAtomic } from "../state/files.js";

export type CorpusProfileAnswers = {
  documents: string;
  authors: string;
  audience: string;
  dates: string;
  importance: string;
  payAttention: string;
  avoid: string;
  citation: string;
  sensitive: string;
};

export type CorpusLintCheck = {
  name: string;
  ok: boolean;
  suggestion: string;
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "new-corpus";
}

function primaryQuery(title: string): string {
  return title
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 3)
    .join(" OR ") || "name OR place OR topic";
}

function defaultGuide(title: string): string {
  return `# Corpus Guide

## What this corpus is

${title} is a local user-created corpus. Describe the documents, their origin, authorship, dates, genre, and why they matter.

## How to talk with this corpus

Do not treat this as a lookup database. Treat it as a body of texts with voice, context, omissions, contradictions, and recurring concerns.

## How to search

Start broad. Search for concrete words that would appear in the source: names, places, roles, dates, materials, genres, and repeated phrases. Fetch passages before making claims. Refine based on vocabulary discovered.

Seek to understand before answering. For broad or open-ended questions, gather several relevant primary-source passages across contexts before answering. If the corpus does not support a complete answer, say what is missing instead of filling gaps from memory.

## How to answer

A good answer should answer the user directly, use fetched evidence, cite every source passage, explain old or strange language, distinguish fact from interpretation, mention source bias or gaps, suggest next questions when useful, and avoid fake certainty. In normal answers, quote selectively.

Do not echo the guide or workflow language in the answer. Use the workflow to prepare, then write naturally for the user's question.

In the first substantive answer from this corpus, briefly offer that the user can ask for a quote-forward version with substantial fetched block quotes, not tiny teaser excerpts, when source rights allow.

When the user asks for full quotes or a quote-forward answer, lead with sizeable fetched passages and citations before analysis; if source rights or privacy prevent that, say so and provide shorter cited excerpts.

Mention source language, translation, edition, or editorial mediation briefly when it materially affects interpretation; do not let provenance notes crowd out the answer.

## How to bring this corpus to life

Look for recurring worries, practical constraints, repeated metaphors, contradictions, what the author assumes everyone knows, what is not said, changes over time, and moments of tension, intimacy, comedy, fear, pride, or confusion.

## Limitations and privacy

Bias, OCR errors, transcription errors, translation issues, missing metadata, sensitive private information, incomplete folders, and anachronistic vocabulary can all affect answers. If evidence is weak or missing, say so.
`;
}

function defaultSearchRules(title: string): string {
  return `# Search Rules

Use concrete words from the documents. Start broad, fetch context, then refine.

Good first searches:

- \`${primaryQuery(title)}\`
- \`name OR place OR date\`
- \`letter OR report OR account OR minutes\`

Search angles to try:

- People: names, family roles, offices, organizations.
- Places and time: cities, neighborhoods, dates, seasons, events.
- Genre and action: letter, report, receipt, minutes, request, complaint, promise.

Translate modern wording into vocabulary that would plausibly appear in the source. If searches fail, try alternate spellings, older terms, source-language terms, and document genres.
`;
}

function defaultSourceNotes(title: string): string {
  return `# Source Notes

${title} is a local user-provided source set. Confirm authorship, dates, privacy, provenance, and rights before sharing outputs.

Imported or dropped-in documents stay local. Watch for missing metadata, OCR errors, transcription errors, translation issues, private information, incomplete folders, source bias, and source-language or edition limits.
`;
}

function defaultCitationRules(): string {
  return `# Citation Rules

Cite fetched passages, not search snippets.

Use the citation returned by fetch whenever possible. If the local corpus lacks dates, authors, or page metadata, say that the import did not provide that information.

If metadata identifies a source language, translation, edition, transcription, or editorial normalization, mention it briefly only when it affects interpretation or citation clarity.
`;
}

function manifestFor(id: string, title: string): CorpusManifest {
  return {
    id,
    title,
    description: `Local user-created corpus: ${title}`,
    languages: ["unknown"],
    type: "user_created",
    status: "user",
    data_policy: "user_provided_local",
    default_search_mode: "fts",
    guide: "guide.md",
    search_rules: "search-rules.md",
    source_notes: "source-notes.md",
    citation_rules: "citation-rules.md",
    fields: ["doc_id", "title", "source_path", "chunk_index", "page", "chapter"],
    chunking: DEFAULT_CHUNKING,
    license: {
      data_included: false,
      user_must_confirm_rights: true,
      notes: "User supplies local documents and is responsible for confirming rights, privacy, and source terms."
    }
  };
}

export function createCorpus(input: { name: string; corpusId?: string; force?: boolean }) {
  const title = input.name.trim();
  if (!title) throw new Error("Corpus name is required.");
  const corpusId = slugify(input.corpusId?.trim() || title);
  if (!isSafeId(corpusId)) throw new Error(`Invalid corpus ID: ${corpusId}`);
  if (getCorpusIdTakenByBuiltIn(corpusId)) {
    throw new Error(`${corpusId} is a built-in collection ID. Choose a different corpus ID.`);
  }
  const rootPath = path.join(userCorporaRoot(), corpusId);
  if (fs.existsSync(rootPath)) {
    if (!input.force) throw new Error(`Corpus already exists: ${corpusId}`);
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(rootPath, "documents"), { recursive: true });
  fs.writeFileSync(path.join(rootPath, "corpus.yaml"), YAML.stringify(manifestFor(corpusId, title)), "utf8");
  fs.writeFileSync(path.join(rootPath, "guide.md"), defaultGuide(title), "utf8");
  fs.writeFileSync(path.join(rootPath, "search-rules.md"), defaultSearchRules(title), "utf8");
  fs.writeFileSync(path.join(rootPath, "source-notes.md"), defaultSourceNotes(title), "utf8");
  fs.writeFileSync(path.join(rootPath, "citation-rules.md"), defaultCitationRules(), "utf8");
  invalidateCorpusCache();
  const capsule = loadCorpusFromPath(rootPath, "user");
  return {
    ok: true,
    corpus_id: corpusId,
    title,
    corpus_path: rootPath,
    documents_path: path.join(rootPath, "documents"),
    guide_path: path.join(rootPath, "guide.md"),
    next_step: `Drop local files into ${path.join(rootPath, "documents")} and run dialogues corpus reindex ${corpusId}.`,
    capsule
  };
}

function getCorpusIdTakenByBuiltIn(corpusId: string): boolean {
  try {
    return getCorpusCapsule(corpusId).source === "built_in";
  } catch {
    return false;
  }
}

function isSensitive(answer: string): boolean {
  return Boolean(answer.trim()) && !/^(no|none|n\/a|not applicable)$/i.test(answer.trim());
}

export function profileCorpus(corpusId: string, answers: CorpusProfileAnswers, options: { allowInstalled?: boolean } = {}) {
  const capsule = getCorpusCapsule(corpusId);
  if (capsule.source === "built_in") {
    throw new Error("Profile editing is for user-created or installed corpora, not built-in corpus capsules.");
  }
  if (capsule.source === "installed" && !options.allowInstalled) {
    throw new Error(`${corpusId} is an externally registered capsule and is read-only by default. Re-run with --edit-installed to change its guide files at ${capsule.rootPath}.`);
  }
  const guide = `# Corpus Guide

## What this corpus is

${answers.documents}

Authors or creators: ${answers.authors}

Written for or used by: ${answers.audience}

Approximate dates: ${answers.dates}

Why it matters: ${answers.importance}

## How to talk with this corpus

Pay attention to: ${answers.payAttention}

Avoid: ${answers.avoid}

## How to search

Search for concrete words from the documents: names, places, dates, roles, document genres, repeated phrases, and old or local vocabulary. Fetch passages before making claims, then refine searches from the vocabulary found in context.

Seek to understand before answering. For broad or open-ended questions, gather several relevant primary-source passages across contexts before answering. If the corpus does not support a complete answer, say what is missing instead of filling gaps from memory.

## How to answer

A good answer should answer directly, use fetched evidence, cite every source passage, distinguish fact from interpretation, mention uncertainty or gaps, and avoid fake certainty. In normal answers, quote selectively.

Do not echo the guide or workflow language in the answer. Use the workflow to prepare, then write naturally for the user's question.

In the first substantive answer from this corpus, briefly offer that the user can ask for a quote-forward version with substantial fetched block quotes, not tiny teaser excerpts, when source rights allow.

When the user asks for full quotes or a quote-forward answer, lead with sizeable fetched passages and citations before analysis; if source rights or privacy prevent that, say so and provide shorter cited excerpts.

Mention source language, translation, edition, or editorial mediation briefly when it materially affects interpretation; do not let provenance notes crowd out the answer.

Citation preference: ${answers.citation}

## How to bring this corpus to life

Look for recurring worries, practical constraints, repeated metaphors, contradictions, what the authors assume everyone knows, what is not said, changes over time, and moments of tension, intimacy, comedy, fear, pride, or confusion.

## Limitations and privacy

Sensitive or private issues: ${answers.sensitive || "None stated."}

Imported documents stay local. If evidence is weak, private, partial, OCR-damaged, mistranscribed, translated, biased, or missing metadata, say so.
`;
  const sourceNotes = `# Source Notes

What these documents are: ${answers.documents}

Authors or creators: ${answers.authors}

Audience or recipients: ${answers.audience}

Approximate dates: ${answers.dates}

Why they matter: ${answers.importance}

Privacy and sensitivity: ${answers.sensitive || "None stated."}

The user is responsible for confirming rights, privacy, provenance, and source terms. Documents stay local unless the user deliberately shares outputs.
`;
  writeFileAtomic(path.join(capsule.rootPath, "guide.md"), guide);
  writeFileAtomic(path.join(capsule.rootPath, "source-notes.md"), sourceNotes);
  invalidateCorpusCache();
  let privacyNotesPath: string | null = null;
  if (isSensitive(answers.sensitive)) {
    privacyNotesPath = path.join(capsule.rootPath, "privacy-notes.md");
    fs.writeFileSync(
      privacyNotesPath,
      `# Privacy Notes

${answers.sensitive}

Treat private or sensitive material as local-only source context. Do not reveal unnecessary personal details in answers.
`,
      "utf8"
    );
  }
  return {
    ok: true,
    corpus_id: corpusId,
    guide_path: path.join(capsule.rootPath, "guide.md"),
    source_notes_path: path.join(capsule.rootPath, "source-notes.md"),
    privacy_notes_path: privacyNotesPath,
    warning: "Private and sensitive documents stay local; confirm rights and privacy before sharing outputs."
  };
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function backtickQueryCount(text: string): number {
  return [...text.matchAll(/`([^`\n]{3,120})`/g)].length;
}

export function lintCorpus(corpusId: string) {
  const capsule = getCorpusCapsule(corpusId);
  const guide = capsule.guide.toLowerCase();
  const sourceNotes = capsule.sourceNotes.toLowerCase();
  const citationRules = capsule.citationRules.toLowerCase();
  const combined = `${guide}\n${sourceNotes}\n${citationRules}`;
  const checks: CorpusLintCheck[] = [
    {
      name: "what_this_corpus_is",
      ok: hasAny(guide, [/what this corpus is/, /what these documents are/, /origin/, /genre/]),
      suggestion: "Add a section explaining what the corpus contains, who created it, dates, genre, and why it matters."
    },
    {
      name: "how_to_search",
      ok: hasAny(guide, [/how to search/, /search for/, /source vocabulary/]),
      suggestion: "Add concrete search advice: names, places, dates, roles, genres, and alternate vocabulary."
    },
    {
      name: "how_to_answer",
      ok: hasAny(guide, [/how to answer/, /quote/, /evidence/, /interpretation/]),
      suggestion: "Add answer guidance: fetch first, quote selectively, cite, separate evidence from interpretation."
    },
    {
      name: "limitations",
      ok: hasAny(combined, [/limitations/, /bias/, /ocr/, /translation/, /missing metadata/, /uncertainty/]),
      suggestion: "Mention source gaps such as bias, OCR errors, translation, privacy, partial imports, or missing metadata."
    },
    {
      name: "citation_rule",
      ok: hasAny(citationRules, [/cite/, /citation/, /chunk/, /fetch/]),
      suggestion: "Add citation rules that require citations from fetched passages, not snippets."
    },
    {
      name: "privacy_or_source_note",
      ok: hasAny(sourceNotes, [/privacy/, /rights/, /source/, /provenance/, /license/]),
      suggestion: "Add source/privacy notes covering provenance, rights, sensitive material, and local-only storage."
    },
    {
      name: "three_search_angles",
      ok: backtickQueryCount(capsule.searchRules) >= 3 || hasAny(capsule.searchRules, [/people/i, /places/i, /genre/i]),
      suggestion: "Add at least three suggested search angles or example backtick queries in search-rules.md."
    }
  ];
  const failed = checks.filter((check) => !check.ok);
  return {
    ok: failed.length === 0,
    corpus_id: corpusId,
    checks,
    suggestions: failed.map((check) => check.suggestion),
    note: "Guide lint is advisory only. It does not block indexing."
  };
}

export function guidePathForCorpus(corpusId: string): string {
  const capsule = getCorpusCapsule(corpusId);
  return path.join(capsule.rootPath, capsule.manifest.guide);
}

export function capsulePathForCorpus(corpusId: string): string {
  const capsule = getCorpusCapsule(corpusId);
  return capsule.rootPath;
}
