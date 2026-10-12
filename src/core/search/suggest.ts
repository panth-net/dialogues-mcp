import type { CorpusCapsule } from "../corpus/types.js";
import { tryLoadSourceManifest } from "../sources/sourceManifest.js";

export type SearchSuggestion = {
  query: string;
  why: string;
};

type SuggestionRule = {
  corpus: "jesuit" | "vangogh";
  patterns: RegExp[];
  suggestions: SearchSuggestion[];
};

export type SuggestSearchOptions = {
  path?: string;
};

const STOP_WORDS = new Set([
  "about",
  "after",
  "against",
  "also",
  "and",
  "are",
  "because",
  "before",
  "between",
  "could",
  "does",
  "from",
  "have",
  "into",
  "like",
  "said",
  "says",
  "say",
  "their",
  "there",
  "these",
  "they",
  "this",
  "through",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would"
]);

const RULES: SuggestionRule[] = [
  {
    corpus: "jesuit",
    patterns: [/democracy/i, /governance/i, /politic/i, /council/i, /assembly/i, /vote/i],
    suggestions: [
      {
        query: "council OR conseil OR assembly",
        why: "Modern political language may appear as councils, assemblies, and deliberation."
      },
      {
        query: "chief OR captain OR capitaine OR chef",
        why: "Leadership is often described through chief/captain vocabulary rather than modern office titles."
      }
    ]
  },
  {
    corpus: "jesuit",
    patterns: [/freedom/i, /liberty/i, /rights/i, /autonomy/i],
    suggestions: [
      {
        query: "liberty OR liberte OR freedom OR libre",
        why: "Freedom/autonomy vocabulary is central, but spelling and language vary."
      },
      {
        query: "obey OR command OR commander",
        why: "Discussions of freedom often appear through refusal, obedience, and command."
      }
    ]
  },
  {
    corpus: "jesuit",
    patterns: [/trade/i, /econom/i, /commerce/i, /gift/i],
    suggestions: [
      {
        query: "trade OR commerce OR beaver OR castor",
        why: "Trade and economy often appear through fur, beaver, and commerce vocabulary."
      },
      {
        query: "gift OR present OR wampum",
        why: "Exchange can appear as gifts, presents, or diplomatic material culture."
      }
    ]
  },
  {
    corpus: "jesuit",
    patterns: [/relig/i, /mission/i, /bapt/i, /convert/i],
    suggestions: [
      {
        query: "baptism OR bapteme OR conversion",
        why: "Missionary reports often frame religious change through baptism and conversion."
      },
      {
        query: "God OR Dieu OR prayer",
        why: "Use bilingual religious vocabulary to catch French and English passages."
      }
    ]
  },
  {
    corpus: "vangogh",
    patterns: [/paint/i, /art/i, /artist/i, /canvas/i, /drawing/i, /color/i, /colour/i, /yellow/i, /blue/i, /light/i],
    suggestions: [
      {
        query: "painting OR paint OR canvas OR drawing",
        why: "Van Gogh often discusses art through practical work materials and image-making terms."
      },
      {
        query: "yellow OR blue OR color OR colour OR light",
        why: "Questions about style or emotion may surface through color vocabulary."
      }
    ]
  },
  {
    corpus: "vangogh",
    patterns: [/nature/i, /landscape/i, /wheat/i, /cypress/i, /field/i, /sun/i],
    suggestions: [
      {
        query: "nature OR wheat OR cypress OR field OR sun",
        why: "Landscape questions should use concrete nature words that recur in the letters."
      },
      {
        query: "light OR yellow OR blue",
        why: "Nature and landscape passages often connect observation to color and light."
      }
    ]
  },
  {
    corpus: "vangogh",
    patterns: [/theo/i, /brother/i, /family/i, /mother/i, /father/i, /letter/i],
    suggestions: [
      {
        query: "Theo OR brother OR letter",
        why: "The letters often frame concerns through correspondence with Theo and family."
      },
      {
        query: "father OR mother OR family",
        why: "Family context can appear through direct kinship terms rather than abstract biography."
      }
    ]
  },
  {
    corpus: "vangogh",
    patterns: [/gauguin/i, /bernard/i, /\bwil\b/i, /sister/i],
    suggestions: [
      {
        query: "Gauguin OR Bernard OR Wil OR sister",
        why: "Search named correspondents and artistic peers directly before generalizing about relationships."
      },
      {
        query: "Theo OR brother",
        why: "Theo often anchors discussions of other people, plans, money, and work."
      }
    ]
  },
  {
    corpus: "vangogh",
    patterns: [/ill/i, /mental/i, /asylum/i, /hospital/i, /doctor/i, /fatigue/i, /suffer/i, /melanch/i, /anxiety/i],
    suggestions: [
      {
        query: "illness OR asylum OR hospital OR doctor OR fatigue",
        why: "Health and distress may appear through illness, institutional, and mood vocabulary."
      },
      {
        query: "suffering OR anxiety OR calm",
        why: "Emotional states may appear in plain affective language across the letters."
      }
    ]
  },
  {
    corpus: "vangogh",
    patterns: [/money/i, /poverty/i, /debt/i, /rent/i, /work/i, /model/i, /studio/i],
    suggestions: [
      {
        query: "money OR francs OR debt OR rent OR work",
        why: "Material constraints often appear as money, work, and expenses."
      },
      {
        query: "studio OR model OR canvas",
        why: "Working conditions may appear through studio, model, and materials vocabulary."
      }
    ]
  },
  {
    corpus: "vangogh",
    patterns: [/relig/i, /\bgod\b/i, /faith/i, /consol/i, /spirit/i],
    suggestions: [
      {
        query: "God OR religion OR faith OR consolation",
        why: "Spiritual questions may appear through God, faith, religion, and consolation vocabulary."
      },
      {
        query: "lonely OR loneliness OR friend OR friendship",
        why: "Consolation often appears beside loneliness, friendship, and correspondence."
      }
    ]
  },
  {
    corpus: "vangogh",
    patterns: [/advice/i, /confess/i, /theory/i, /logistic/i, /justify/i, /misunderstood/i],
    suggestions: [
      {
        query: "advice OR advise OR recommend OR theory OR composition",
        why: "Genre questions should search for advice and art-theory language, not only topic words."
      },
      {
        query: "send OR receive OR enclosed OR parcel OR justify OR misunderstood",
        why: "Daily logistics and self-justification often appear through ordinary correspondence verbs."
      }
    ]
  },
  {
    corpus: "vangogh",
    patterns: [/early/i, /arles/i, /saint[-\s]?remy/i, /saint[-\s]?rémy/i, /auvers/i, /period/i, /chronolog/i],
    suggestions: [
      {
        query: "London OR Hague OR Etten OR Arles OR Saint-Remy OR Auvers",
        why: "When date filters are unavailable, search period and place names directly."
      },
      {
        query: "Arles OR Gauguin OR Saint-Remy OR asylum OR Auvers OR Gachet",
        why: "Later chronology can be triangulated through major places, people, and care contexts."
      }
    ]
  }
];

function normalize(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function significantTerms(input: string): string[] {
  const found: string[] = [];
  for (const term of normalize(input).match(/[a-z0-9]{3,}/g) ?? []) {
    if (!STOP_WORDS.has(term) && !found.includes(term)) found.push(term);
  }
  return found;
}

function expandedQuestionTerms(input: string): string[] {
  const terms = significantTerms(input);
  const normalizedInput = normalize(input);
  const add = (values: string[]) => {
    for (const value of values) {
      const term = normalize(value).trim();
      if (term && !terms.includes(term)) terms.push(term);
    }
  };
  if (/\bdemocracy|democratic|republic|citizen|vote|popular\b/i.test(normalizedInput)) {
    add(["govern", "governing", "rule", "ruler", "people", "state", "order", "public", "assembly", "council"]);
  }
  if (/\bstatecraft|bureaucracy|bureaucratic|government|politic|political|policy\b/i.test(normalizedInput)) {
    add(["govern", "rule", "order", "institution", "law", "office", "state"]);
  }
  if (/\bhuman nature|nature|cultivation|self cultivation|virtue|moral\b/i.test(normalizedInput)) {
    add(["human", "nature", "cultivation", "learning", "heart", "mind"]);
  }
  if (/\bscientific method|method|experiment|evidence|observation\b/i.test(normalizedInput)) {
    add(["experiment", "observation", "trial", "specimen", "evidence", "method"]);
  }
  if (/\bcomput|program|algorithm|machine|engine\b/i.test(normalizedInput)) {
    add(["machine", "engine", "card", "notation", "calculation", "operation"]);
  }
  if (/\bcivil rights|rights|citizenship|suffrage|vote\b/i.test(normalizedInput)) {
    add(["rights", "citizenship", "vote", "law", "institution", "movement"]);
  }
  return terms;
}

function addSuggestion(target: SearchSuggestion[], seen: Set<string>, suggestion: SearchSuggestion): void {
  const query = suggestion.query.replace(/\s+/g, " ").trim();
  if (!query) return;
  const key = normalize(query);
  if (seen.has(key)) return;
  seen.add(key);
  target.push({ query, why: suggestion.why });
}

function extractBacktickQueries(line: string): string[] {
  return [...line.matchAll(/`([^`\n]{3,140})`/g)]
    .map((match) => match[1].trim())
    .filter((query) => query && !query.includes("<") && !query.includes(">") && !query.startsWith("corpus:"));
}

function lineMatchesQuestion(line: string, questionTerms: string[]): boolean {
  if (questionTerms.length === 0) return false;
  const normalizedLine = normalize(line);
  return questionTerms.some((term) => normalizedLine.includes(term));
}

function pathMetadataMatches(capsule: CorpusCapsule, pathId: string, questionTerms: string[]): boolean {
  const manifest = tryLoadSourceManifest(capsule);
  const sourcePath = manifest?.paths[pathId];
  if (!sourcePath) return false;
  return lineMatchesQuestion([pathId, sourcePath.title, sourcePath.point, sourcePath.description].filter(Boolean).join(" "), questionTerms);
}

function tableQueryFromLine(
  capsule: CorpusCapsule,
  line: string,
  questionTerms: string[],
  options: SuggestSearchOptions = {}
): SearchSuggestion | undefined {
  const cells = line
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
  if (cells.length < 2 || cells.some((cell) => /^-+$/.test(cell))) return undefined;
  if (/path|english|term|concept/i.test(cells[0]) && /search|french|corpus|query|vocabulary/i.test(cells[1])) return undefined;
  const pathId = cells[0];
  const pathMatches = options.path
    ? pathId === options.path
    : lineMatchesQuestion(pathId, questionTerms) || pathMetadataMatches(capsule, pathId, questionTerms);
  if (!pathMatches) return undefined;

  const queryCell = cells.slice(1).join(", ");
  const quoted = extractBacktickQueries(queryCell);
  if (quoted.length) {
    return {
      query: quoted[0],
      why: options.path
        ? `From the ${options.path} row in this corpus's search-rules.md.`
        : "From this corpus's path-specific search-rules table; it translates the user's wording into source vocabulary."
    };
  }

  const terms = queryCell
    .split(/[,;/]|\bor\b/i)
    .map((part) => part.trim())
    .filter((part) => /^[\p{L}\p{N}][\p{L}\p{N}\s'-]{1,40}$/u.test(part));

  const queryTerms = [...new Set(terms)].slice(0, 8);
  if (queryTerms.length === 0) return undefined;

  return {
    query: queryTerms.join(" OR "),
    why: options.path
      ? `From the ${options.path} row in this corpus's search-rules.md.`
      : "From this corpus's path-specific search-rules table; it translates the user's wording into source vocabulary."
  };
}

function suggestionsFromSearchRules(
  capsule: CorpusCapsule,
  questionTerms: string[],
  options: SuggestSearchOptions = {},
  includeExamples = true
): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];
  const seen = new Set<string>();
  const lines = capsule.searchRules.split(/\r?\n/);
  let inBadExamples = false;

  // Prefer path-specific table rows before broad inline examples.
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#+\s+/i.test(trimmed)) inBadExamples = false;
    if (/^bad\s*:?$/i.test(trimmed)) {
      inBadExamples = true;
      continue;
    }
    if (/^good\s*:?$/i.test(trimmed)) {
      inBadExamples = false;
      continue;
    }
    if (inBadExamples) continue;

    const tableSuggestion = tableQueryFromLine(capsule, line, questionTerms, options);
    if (tableSuggestion) addSuggestion(suggestions, seen, tableSuggestion);
  }

  if (suggestions.length > 0) return suggestions;

  inBadExamples = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#+\s+/i.test(trimmed)) inBadExamples = false;
    if (/^bad\s*:?$/i.test(trimmed)) {
      inBadExamples = true;
      continue;
    }
    if (/^good\s*:?$/i.test(trimmed)) {
      inBadExamples = false;
      continue;
    }
    if (inBadExamples) continue;

    const queries = extractBacktickQueries(line);
    if (queries.length === 0) continue;
    if (options.path ? !line.includes(options.path) : !lineMatchesQuestion(line, questionTerms)) continue;
    for (const query of queries) {
      addSuggestion(suggestions, seen, {
        query,
        why: "From this corpus's search-rules.md; it matches terms in the user's question."
      });
    }
  }

  if (suggestions.length > 0 || !includeExamples) return suggestions;

  inBadExamples = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#+\s+/i.test(trimmed)) inBadExamples = false;
    if (/^bad\s*:?$/i.test(trimmed)) {
      inBadExamples = true;
      continue;
    }
    if (/^good\s*:?$/i.test(trimmed)) {
      inBadExamples = false;
      continue;
    }
    if (inBadExamples) continue;

    for (const query of extractBacktickQueries(line)) {
      addSuggestion(suggestions, seen, {
        query,
        why: "Example query from this corpus's search-rules.md; use it as a starting point and refine after fetch."
      });
      if (suggestions.length >= 2) return suggestions;
    }
  }

  return suggestions;
}

function corpusKind(capsule: CorpusCapsule): "jesuit" | "vangogh" | "generic" {
  const combined = normalize([
    capsule.id,
    capsule.manifest.title,
    capsule.manifest.description,
    capsule.searchRules,
    capsule.guide
  ].join("\n"));
  if (combined.includes("jesuit relations") || combined.includes("jesuit")) return "jesuit";
  if (combined.includes("van gogh") || combined.includes("vangogh") || combined.includes("vincent")) return "vangogh";
  return "generic";
}

function corpusSpecificModernSuggestions(
  capsule: CorpusCapsule,
  userQuestion: string,
  options: SuggestSearchOptions = {}
): SearchSuggestion[] {
  const normalizedQuestion = normalize(userQuestion);
  const suggestions: SearchSuggestion[] = [];
  const add = (path: string, query: string, why: string) => {
    if (options.path && options.path !== path) return;
    suggestions.push({ query, why });
  };

  if (capsule.id === "lovelace-babbage" && /\bcomput|program|algorithm|software|engine|machine\b/i.test(normalizedQuestion)) {
    add(
      "program-traces-and-engine-design",
      "operation OR variable OR cards OR notation",
      "Modern computing terms should be tested through operation, variable, cards, and notation vocabulary before broad machine-design terms."
    );
  }

  if (capsule.id === "faraday-papers" && /\bscientific method|method|experiment|instrument|measurement\b/i.test(normalizedQuestion)) {
    add(
      "experimental-thinking",
      "experiment OR electricity OR instrument OR induction",
      "Method questions should start with experiment, instruments, measurement, and named phenomena."
    );
  }

  if (capsule.id === "darwin-correspondence" && /\btheory|uncertain|uncertainty|doubt|hypothesis|finished\b/i.test(normalizedQuestion)) {
    add(
      "thought-before-theory",
      "query OR doubt OR difficulty OR problem OR hypothesis",
      "Theory-before-publication questions should search for doubts, problems, hypotheses, and unfinished reasoning."
    );
  }

  return suggestions;
}

function fallbackQuery(userQuestion: string): string {
  const terms = significantTerms(userQuestion).slice(0, 4);
  return terms.length ? terms.join(" OR ") : "topic OR name OR place";
}

function collectSuggestions(capsule: CorpusCapsule, text: string, options: SuggestSearchOptions, includeExamples: boolean): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];
  const seen = new Set<string>();
  const questionTerms = expandedQuestionTerms(text);
  const kind = corpusKind(capsule);

  for (const suggestion of corpusSpecificModernSuggestions(capsule, text, options)) {
    addSuggestion(suggestions, seen, suggestion);
  }

  for (const suggestion of suggestionsFromSearchRules(capsule, questionTerms, options, includeExamples)) {
    addSuggestion(suggestions, seen, suggestion);
  }

  for (const rule of RULES) {
    if (rule.corpus !== kind) continue;
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      for (const suggestion of rule.suggestions) addSuggestion(suggestions, seen, suggestion);
    }
  }
  return suggestions;
}

/** Wider queries from the collection's own rules that match this text; no generic filler. */
export function ruleSuggestions(capsule: CorpusCapsule, text: string, options: SuggestSearchOptions = {}): SearchSuggestion[] {
  return collectSuggestions(capsule, text, options, false);
}

export function suggestSearches(capsule: CorpusCapsule, userQuestion: string, options: SuggestSearchOptions = {}): {
  ok: true;
  corpus_id: string;
  suggested_queries: SearchSuggestion[];
  next_steps: {
    message: string;
    suggested_queries: string[];
  };
} {
  const suggestions = collectSuggestions(capsule, userQuestion, options, true);
  const seen = new Set(suggestions.map((suggestion) => normalize(suggestion.query)));

  if (suggestions.length === 0) {
    addSuggestion(suggestions, seen, {
      query: fallbackQuery(userQuestion),
      why: "Fallback: start with concrete words from the user's question, then refine from fetched vocabulary."
    });
    addSuggestion(suggestions, seen, {
      query: "letter OR report OR account",
      why: "Generic old-document strategy: search for document genres and source forms when topic words are too modern."
    });
    addSuggestion(suggestions, seen, {
      query: "custom OR law OR council",
      why: "Generic institutional vocabulary can reveal social rules, authority, and public decisions."
    });
  }

  const capped = suggestions.slice(0, 6);
  return {
    ok: true,
    corpus_id: capsule.id,
    suggested_queries: capped,
    next_steps: {
      message: "Run one or two suggested searches, fetch promising passages, then refine with vocabulary discovered in context.",
      suggested_queries: capped.map((suggestion) => suggestion.query)
    }
  };
}
