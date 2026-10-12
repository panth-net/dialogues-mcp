import fs from "node:fs";
import path from "node:path";
import { createCorpus } from "../corpus/authoring.js";
import { getCorpusCapsule, invalidateCorpusCache } from "../corpus/loader.js";
import { reindexCorpus } from "../search/corpusTools.js";
import { userCorporaRoot } from "../paths.js";

const DEMO_ID = "dialogues-demo";

const DEMO_FILES = [
  {
    name: "1887-mill-letter.txt",
    text: `Letter from Clara Moss to Elias Reed, 1887

Dear Elias,

The mill whistle has changed the shape of the morning. Mother says the whole town now eats by the clock, not by hunger. I went to the office to ask about the lost wages, and Mr. Vale said the ledger was correct though he would not show it.

What worries me is not only the money. It is that everyone speaks as if the new rules have always existed. Please bring the blue notebook when you come on Sunday. I have kept dates, names, and what each woman was paid.`
  },
  {
    name: "1887-meeting-minutes.txt",
    text: `Minutes of the Brookfield Reading Room Committee, 1887

The committee met after supper in the back room of Hale's store. Mrs. Moss proposed that the room stay open two evenings each week for workers who cannot come before dark.

Mr. Vale objected that newspapers encourage complaint. Reverend Pike answered that complaint is not disorder when it is made plainly and with evidence. The motion passed by six votes to three.`
  },
  {
    name: "1888-note-from-school.txt",
    text: `Note from Teacher Anna Bell, 1888

Several children arrived late because the factory bell and the school bell now disagree. Parents ask whether lessons may begin ten minutes later during winter.

I recommend the change. The children are tired, but they notice everything. One girl wrote that clocks are a kind of weather grown indoors.`
  }
];

export async function runQuickstart(options: { force?: boolean } = {}) {
  const rootPath = path.join(userCorporaRoot(), DEMO_ID);
  if (fs.existsSync(rootPath) && options.force) {
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
  let created = false;
  if (!fs.existsSync(rootPath)) {
    createCorpus({ name: "Dialogues Demo Letters", corpusId: DEMO_ID });
    created = true;
  }

  const docsRoot = path.join(rootPath, "documents");
  fs.mkdirSync(docsRoot, { recursive: true });
  for (const file of DEMO_FILES) {
    fs.writeFileSync(path.join(docsRoot, file.name), `${file.text}\n`, "utf8");
  }

  fs.writeFileSync(
    path.join(rootPath, "guide.md"),
    `# Corpus Guide

## What this corpus is

This is a tiny project-created synthetic demo corpus of late nineteenth-century town documents. It is not a real archive. It exists so users can test Dialogues without downloads or rights questions.

## How to talk with this corpus

Treat these as small historical-style documents about work, time, wages, reading rooms, school, and ordinary civic friction. Keep answers grounded in fetched passages.

## How to search

Try concrete words such as \`wages OR ledger\`, \`clock OR bell OR time\`, and \`committee OR motion OR complaint\`. Fetch before interpreting.

## How to answer

A good answer should answer directly, use fetched evidence, cite every source passage, explain old or strange language, distinguish fact from interpretation, mention source gaps, and avoid fake certainty. In normal answers, quote selectively.

Seek to understand before answering. For broad questions, gather several relevant fetched passages before answering. Do not echo guide or workflow language in the answer. The user can ask for a quote-forward version with substantial fetched block quotes, not tiny teaser excerpts, when source rights allow.

## How to bring this corpus to life

Look for recurring worries, practical constraints, repeated metaphors, contradictions, what the writers assume everyone knows, what is not said, changes over time, and moments of tension, pride, fatigue, or humor.

## Limitations

This is a deliberately tiny synthetic demo. It proves the workflow; it is not evidence about a real town.
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(rootPath, "search-rules.md"),
    `# Search Rules

- Work and wages: \`wages OR ledger OR paid\`
- Time and discipline: \`clock OR bell OR morning OR winter\`
- Civic debate: \`committee OR motion OR complaint OR evidence\`
- Education and children: \`school OR children OR lessons\`
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(rootPath, "source-notes.md"),
    `# Source Notes

These are project-created synthetic demo documents bundled for local testing. No historical corpus is represented. The demo is legally safe to copy, but it should not be cited as historical evidence.
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(rootPath, "citation-rules.md"),
    `# Citation Rules

Cite fetched passages using the returned document title and chunk. Do not cite snippets as evidence.
`,
    "utf8"
  );

  invalidateCorpusCache();
  const capsule = getCorpusCapsule(DEMO_ID);
  const reindex = await reindexCorpus(capsule);
  return {
    ok: true,
    corpus_id: DEMO_ID,
    created,
    corpus_path: rootPath,
    documents_path: docsRoot,
    reindex,
    example_prompts: [
      "What changed when the town started living by the clock?",
      "What tensions show up around wages and evidence?",
      "How does the reading room debate connect education, complaint, and public order?"
    ],
    next_step: `Run: dialogues corpus guide ${DEMO_ID}, then dialogues search ${DEMO_ID} "clock OR bell".`
  };
}
