import fs from "node:fs";
import path from "node:path";
import { getCorpusCapsule } from "../corpus/loader.js";
import { curationRoot, listCandidates, openCandidateDb, updateCandidateScore, type CandidateRecord } from "./candidateDb.js";

export const MIND_EVIDENCE_SIGNALS = [
  "authored_by_target",
  "incoming_pressure",
  "response_to_pressure",
  "draft_or_revision",
  "letter",
  "diary_or_journal",
  "notebook",
  "marginalia",
  "legal_reasoning",
  "constitutional_reasoning",
  "scientific_reasoning",
  "mathematical_reasoning",
  "experimental_record",
  "joke_or_humor",
  "private_public_gap",
  "self_explanation",
  "movement_strategy",
  "institution_building",
  "argument_under_constraint",
  "practical_logistics",
  "social_reaction",
  "dialogue_with_others",
  "myth_breaker"
] as const;

const TARGET_NAMES: Record<string, string[]> = {
  "lincoln-papers": ["abraham lincoln", "lincoln"],
  "douglass-papers": ["frederick douglass", "douglass"],
  "darwin-correspondence": ["charles darwin", "darwin"],
  "newton-papers": ["isaac newton", "newton"],
  "lovelace-babbage": ["ada lovelace", "charles babbage", "lovelace", "babbage"],
  "faraday-papers": ["michael faraday", "faraday"]
};

function includesAny(haystack: string, terms: string[]): boolean {
  return terms.some((term) => haystack.includes(term));
}

function readCandidateText(candidate: CandidateRecord): string {
  if (!candidate.text_path || !fs.existsSync(candidate.text_path)) return "";
  return fs.readFileSync(candidate.text_path, "utf8").slice(0, 40000);
}

function candidateHaystack(candidate: CandidateRecord): string {
  return [
    candidate.title,
    candidate.author,
    candidate.recipient,
    candidate.document_type,
    candidate.metadata_json,
    readCandidateText(candidate)
  ].filter(Boolean).join("\n").toLowerCase();
}

export function scoreCandidate(corpusId: string, candidate: CandidateRecord): { score: number; signals: string[] } {
  const signals = new Set<string>(candidate.signals);
  let score = 0;
  const haystack = candidateHaystack(candidate);
  const documentType = (candidate.document_type ?? "").toLowerCase();
  const targetNames = TARGET_NAMES[corpusId] ?? corpusId.split("-").filter((part) => part.length > 3);

  if (candidate.author && includesAny(candidate.author.toLowerCase(), targetNames)) {
    signals.add("authored_by_target");
    score += 3;
  }
  if (documentType.includes("draft") || includesAny(haystack, ["draft", "revision", "revised", "amendment", "correction"])) {
    signals.add("draft_or_revision");
    score += 4;
  }
  if (documentType.includes("letter") || includesAny(haystack, ["dear sir", "dear friend", "yours truly", "letter"])) {
    signals.add("letter");
    score += 2;
  }
  if (includesAny(haystack, ["court", "case", "law", "legal", "evidence", "jury", "testimony", "statute"])) {
    signals.add("legal_reasoning");
    score += 3;
  }
  if (includesAny(haystack, ["constitution", "constitutional", "union", "executive power", "congress", "federal"])) {
    signals.add("constitutional_reasoning");
    score += 3;
  }
  if (includesAny(haystack, ["experiment", "observation", "species", "variation", "specimen", "hypothesis", "theory"])) {
    signals.add("scientific_reasoning");
    score += 3;
  }
  if (includesAny(haystack, ["calculation", "mathemat", "equation", "engine", "machine", "algorithm", "table"])) {
    signals.add("mathematical_reasoning");
    score += 3;
  }
  if (includesAny(haystack, ["petition", "request", "critic", "objection", "pressure", "demand", "attack"])) {
    signals.add("incoming_pressure");
    signals.add("response_to_pressure");
    score += 2;
  }
  if (includesAny(haystack, ["because", "therefore", "if ", "unless", "constraint", "cannot", "must"])) {
    signals.add("argument_under_constraint");
    score += 2;
  }
  if (includesAny(haystack, ["joke", "jest", "laugh", "humor", "story", "anecdote"])) {
    signals.add("joke_or_humor");
    score += 2;
  }
  if (includesAny(haystack, ["committee", "association", "office", "newspaper", "institution", "society", "meeting"])) {
    signals.add("institution_building");
    score += 2;
  }
  if (includesAny(haystack, ["posthumous", "memorial", "commemorative", "anniversary"])) {
    score -= 3;
  }
  if (includesAny(haystack, ["cover letter", "forwards letter", "forwarded letter", "sends letter", "sent letter", "printed circular", "circular letter", "printed letter", "pamphlet"])) {
    score -= 18;
  }
  return { score, signals: [...signals].sort() };
}

export function runCurationScore(corpusId: string) {
  const capsule = getCorpusCapsule(corpusId);
  const db = openCandidateDb(corpusId);
  try {
    const candidates = listCandidates(db, corpusId);
    fs.mkdirSync(curationRoot(corpusId), { recursive: true });
    const scorePath = path.join(curationRoot(corpusId), "scores.jsonl");
    fs.writeFileSync(scorePath, "", "utf8");
    const scored = candidates.map((candidate) => {
      const result = scoreCandidate(corpusId, candidate);
      updateCandidateScore(db, candidate.id, result.score, result.signals);
      const record = {
        id: candidate.id,
        title: candidate.title,
        score: result.score,
        signals: result.signals,
        paths: candidate.paths
      };
      fs.appendFileSync(scorePath, `${JSON.stringify(record)}\n`, "utf8");
      return record;
    }).sort((a, b) => b.score - a.score);

    const topPath = path.join(curationRoot(corpusId), "top-candidates.md");
    const lines = [
      `# Top Curation Candidates: ${capsule.manifest.title}`,
      "",
      ...(scored.slice(0, 50).map((item, index) => `${index + 1}. ${item.id} (${item.score}) ${item.title ?? ""} [${item.signals.join(", ")}]`))
    ];
    fs.writeFileSync(topPath, `${lines.join("\n")}\n`, "utf8");
    return {
      ok: true,
      corpus_id: corpusId,
      candidates: scored.length,
      scores_path: scorePath,
      top_candidates_path: topPath,
      signals: MIND_EVIDENCE_SIGNALS
    };
  } finally {
    db.close();
  }
}
