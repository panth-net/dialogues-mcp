import type { CorpusCapsule } from "../corpus/types.js";

export type ComposedGuideSection = {
  number: number;
  title: string;
  body: string;
};

function cleanMarkdown(input: string): string {
  return input.replace(/\r\n/g, "\n").trim();
}

function extractBacktickQueries(...texts: string[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    const matches = text.matchAll(/`([^`\n]{3,120})`/g);
    for (const match of matches) {
      const value = match[1].trim();
      if (
        value &&
        !value.includes("<") &&
        !value.includes(">") &&
        !value.startsWith("corpus:") &&
        !found.includes(value)
      ) {
        found.push(value);
      }
    }
  }
  return found.slice(0, 8);
}

function extractVocabulary(searchRules: string): string {
  const tableLines = searchRules
    .split("\n")
    .filter((line) => line.trim().startsWith("|") && !line.includes("---"))
    .slice(0, 12);
  if (tableLines.length > 1) return tableLines.join("\n");

  const queries = extractBacktickQueries(searchRules);
  if (queries.length) {
    return queries.map((query) => `- ${query}`).join("\n");
  }

  return "- Use concrete names, places, roles, dates, document genres, and source-language terms from the corpus files.";
}

function formatSuggestedSearches(capsule: CorpusCapsule): string {
  const suggestions = extractBacktickQueries(capsule.guide, capsule.searchRules);
  if (!suggestions.length) {
    return [
      "- Search for one concrete source word from the user's question.",
      "- Search for a related role, institution, place, or genre term.",
      "- Fetch a promising hit, then reuse vocabulary found in that passage."
    ].join("\n");
  }
  return suggestions.map((query) => `- \`${query}\``).join("\n");
}

export function composeCorpusGuideSections(capsule: CorpusCapsule): ComposedGuideSection[] {
  const { manifest } = capsule;
  const guide = cleanMarkdown(capsule.guide);
  const searchRules = cleanMarkdown(capsule.searchRules);
  const sourceNotes = cleanMarkdown(capsule.sourceNotes);
  const citationRules = cleanMarkdown(capsule.citationRules);

  return [
    {
      number: 1,
      title: "What This Corpus Is",
      body: [
        manifest.description.trim(),
        manifest.subtitle ? `Subtitle: ${manifest.subtitle}` : "",
        `Languages: ${manifest.languages.join(", ")}`,
        `Corpus type: ${manifest.type}`,
        "",
        guide
      ].filter(Boolean).join("\n")
    },
    {
      number: 2,
      title: "What Kinds Of Questions It Can Answer",
      body: [
        "Use this corpus for questions that can be grounded in its documents, metadata, recurring vocabulary, and source context.",
        "Good questions ask what the corpus records, how language is used, what patterns recur, where claims appear, how passages compare, or what source-grounded interpretations are possible.",
        "Always verify answers with search results and fetched passages."
      ].join("\n")
    },
    {
      number: 3,
      title: "What Kinds Of Questions It Cannot Answer",
      body: [
        "Do not answer only from memory or general historical knowledge.",
        "Do not claim the corpus says something unless fetched passages support it.",
        "If the corpus is silent, ambiguous, biased, incomplete, mistranslated, OCR-damaged, or filtered through an editor or narrator, say so.",
        "",
        sourceNotes
      ].join("\n")
    },
    {
      number: 4,
      title: "Historical Literary Contextual Search Strategy",
      body: [
        "Seek to understand before answering: search first, fetch promising passages with context, then synthesize. Start with concrete words likely to appear in the source, not only the user's modern abstraction.",
        "For broad or open-ended questions, gather several relevant primary-source passages across contexts before answering. If the corpus does not support a complete answer, say what is missing instead of filling gaps from memory.",
        "Use the search rules below to translate the user's question into source vocabulary. Iterate based on terms discovered in fetched passages.",
        "",
        searchRules
      ].join("\n")
    },
    {
      number: 5,
      title: "Important Vocabulary",
      body: extractVocabulary(searchRules)
    },
    {
      number: 6,
      title: "Common Traps",
      body: [
        "- Treating snippets as evidence instead of fetching full context.",
        "- Treating absence of a modern word as absence of the older concept.",
        "- Ignoring source bias, genre, audience, translation, OCR damage, missing metadata, or editorial framing.",
        "- Answering from the first convenient hit instead of gathering enough primary-source evidence to understand the question.",
        "- Letting source limitations dominate the answer instead of answering the user's question from evidence.",
        "- Repeating guide or workflow language in the answer instead of answering naturally.",
        "- Overstating certainty from one passage.",
        "",
        sourceNotes
      ].join("\n")
    },
    {
      number: 7,
      title: "Citation Rules",
      body: citationRules
    },
    {
      number: 8,
      title: "Response Style",
      body: [
        "Answer directly, then show the evidence. In normal answers, quote selectively, cite every fetched passage used, and explain old or difficult language in plain terms.",
        "Do not echo the guide, workflow, or system-prompt wording in the answer. Use the workflow to prepare, then write naturally for the user's question.",
        "In the first substantive answer from a corpus, briefly offer that the user can ask for a quote-forward version with substantial fetched block quotes, not tiny teaser excerpts, when source rights allow.",
        "When the user asks for full quotes or a quote-forward answer, lead with sizeable fetched passages and citations before analysis; if source rights or privacy prevent that, say so and provide shorter cited excerpts.",
        "Mention source language, translation, edition, or editorial mediation briefly when it materially affects interpretation; do not let provenance notes crowd out the answer.",
        "Distinguish evidence from interpretation. Mention uncertainty and gaps. Synthesize like an informed reader of this corpus, not like a generic search-result summarizer.",
        "Never quote or deeply paraphrase from search snippets alone; fetch first."
      ].join("\n")
    },
    {
      number: 9,
      title: "Suggested First Searches",
      body: formatSuggestedSearches(capsule)
    }
  ];
}

export function composeCorpusGuide(capsule: CorpusCapsule): string {
  const { manifest } = capsule;
  const sections = composeCorpusGuideSections(capsule);
  return [
    `# ${manifest.title}`,
    manifest.subtitle ? `_${manifest.subtitle}_` : "",
    "",
    "## Required Workflow",
    "Do not answer only from memory. Seek to understand before answering: search first, fetch enough primary-source passages with context, then synthesize with citations and limitations.",
    "For broad or open-ended questions, gather multiple relevant contexts before answering. If evidence is thin, say what is missing.",
    "Do not repeat these workflow instructions in the final answer.",
    "If the user asks for full quotes, provide substantial fetched block quotes when source rights allow, then analyze them.",
    "",
    ...sections.flatMap((section) => [
      `## ${section.number}. ${section.title}`,
      section.body,
      ""
    ])
  ]
    .filter((part) => part !== "")
    .join("\n");
}
