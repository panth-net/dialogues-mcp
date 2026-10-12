# Dialogues

Spend time inside the minds of people who left great diaries and letters, through the AI app you already use.

Watch Pepys bury his cheese as the Great Fire closes in. Follow Van Gogh explaining to his brother why he keeps painting when nothing sells. Read Tolstoy scolding himself in his diary for sixty years. You ask questions in plain English; your AI finds the exact passages and walks you through a life, quoting and citing what was actually written.

Dialogues runs on your computer. Document collections and their search files are stored in a folder on your computer. When you ask about a collection, the passages Dialogues finds are sent to the AI app you are using (Claude, Codex, Cursor, VS Code, or Antigravity), which handles them under its own terms. Dialogues itself needs no account, API key, or hosted service, and it downloads a collection only after you agree.

> **Status:** not yet published to npm. Until it is, use [Install from a local copy](#install-from-a-local-copy).

## Install

You need [Node.js](https://nodejs.org) 22.16 or newer. Then paste this into the AI app you want to use:

<!-- install-prompt:start -->
```text
Install Dialogues MCP on this computer (`npm install -g dialogues-mcp`) and connect it to the app I'm talking to you in (`dialogues setup --client <app>`, where <app> is claude-desktop, claude-code, codex, cursor, vscode, or antigravity). If you aren't sure which app I'm using, ask me first. If Node.js is missing, or the install tells you it's too old, stop and help me fix that first.

When you're done, tell me in plain English whether it worked, which app you connected, where my files are, and whether I should quit and reopen the app. Then give me a short message I can send after I restart, a clear table of which documents are downloaded and which are available but not downloaded yet, and a few example questions I could ask about a collection (showcasing some nuanced uses not just the obvious ones).
```
<!-- install-prompt:end -->

Or run it yourself in a terminal:

```bash
npm install -g dialogues-mcp
dialogues setup --client claude-desktop   # or claude-code, codex, cursor, vscode, antigravity
```

`setup` connects only the app you name. It backs up that app's settings first, never touches other entries, and downloads no collections. Your collections are stored in `~/Dialogues` unless you choose another folder with `--data-dir`.

## First conversation

Fully quit and reopen the app you connected, then send:

<!-- first-message:start -->
```text
Hi! I want to use Dialogues. Show me the document collections, recommend where to start, and help me choose. Ask me before downloading anything.
```
<!-- first-message:end -->

Your AI shows the collections and recommends a small sample from six of them: Pepys, Van Gogh, the Jesuit Relations, Darwin, Lincoln, and Gandhi. It tells you what each sample contains, how much it downloads, and the source terms (the Van Gogh letters and Gandhi's Collected Works are non-commercial). Nothing downloads until you say yes. After you have tried the sample, ask for more of any collection.

## Install from a local copy

Before the npm release, or to test a change, build a package from this folder and install that file:

```bash
npm ci
npm pack                       # writes dialogues-mcp-<version>.tgz
npm install -g ./dialogues-mcp-<version>.tgz
dialogues setup --client claude-code
```

Double-click installers are in `installers/` (`Install Dialogues.bat` on Windows, `Install Dialogues.command` on macOS; `sh installers/setup.sh <app>` on Linux). From a checkout they build and install this folder; they ask which app to connect and change only that one.

## What can I actually do with it?

> Walk me through the week of the Great Fire, day by day.

> What was Gandhi writing the week he decided to march to the sea?

> I feel stuck in my work. What did Van Gogh tell Theo when nothing was selling?

> Put me inside the Amistad fight. What was Adams writing the night before he argued it?

The AI reads the collection's guide, searches, fetches exact passages, and answers with quotes and citations, not from memory. Every collection has a **Where to start** list if you don't know what to ask. If a collection is in Russian or classical Chinese, ask in English: the AI searches in the original language and translates back.

## The collections

Every collection ships as a guide plus a curated list of original sources. Ask your AI *"show me the collections I can download"* and it shows this table and lets you pick.

| Collection | Era | Who you're talking to |
| --- | --- | --- |
| Libanius Letters | 300s | The best-connected professor of the late Roman Empire — 1,500+ Greek letters working favors, students, and politics in fourth-century Antioch. |
| Augustine Writings | 354–430 | The late-Roman bishop who invented introspective autobiography — conversion, grief, memory, and time, argued in the first person. |
| Maimonides Geniza | 1100s | Autograph drafts and letters of the great medieval philosopher-physician, preserved by accident for 800 years in a Cairo synagogue storeroom. |
| Teika Diary | 1180–1235 | A great classical Japanese poet's diary spanning 56 years of court life — kept while he shaped the canon of Japanese verse. |
| Babur Nama | 1494–1529 | Founder of the Mughal Empire writing his own life with disarming honesty — battles lost, kingdoms won, gardens planted, and homesickness for melons. |
| Yi Sun-sin War Diary | 1592–1598 | The Korean admiral's day-by-day war diary, written between naval battles he never lost — while fighting his own court as much as the Japanese. |
| Jesuit Relations | 1610–1791 | Annual field reports from French missionaries in North America — first-contact ethnography, winters, martyrdoms, and the collision of worlds. |
| Xu Xiake Travels | 1613–1639 | Ming-dynasty travel writer who walked China for thirty years, taking geographic field notes centuries ahead of their time. |
| Evliya Çelebi Travels | 1630s–1670s | Ottoman gentleman-traveler who spent forty years wandering three continents and wrote ten volumes of it — wit, tall tales, and detail nobody else recorded. |
| Samuel Pepys Diary | 1660–1669 | Naval administrator who recorded 1660s London without self-censorship: the plague, the Great Fire, court politics, marriage fights, and his own money. |
| Newton Papers | 1660s–1727 | Newton beyond the Principia — alchemy, heretical theology, and Mint work, from scholarly transcriptions of his private papers. |
| Samson Occom Papers | 1740s–1792 | Mohegan minister and the first Native American to publish in English — sermons, diaries, and letters negotiating two worlds that both claimed him. |
| Miranda Archive | 1770s–1816 | The Venezuelan revolutionary who fought in three revolutions and archived everything — the paper trail of independence before Bolívar. |
| John Quincy Adams Diary | 1779–1848 | A U.S. president who kept a diary for 68 years — Congress, courts, slavery fights, and self-scolding. |
| Beethoven Letters | 1790s–1827 | Beethoven in his own hand — patrons, publishers, encroaching deafness, and the Immortal Beloved. |
| Jane Austen Letters | 1796–1817 | Austen's surviving letters, mostly to her sister Cassandra — sharp, domestic, and gossipy; the novelist off duty. |
| Faraday Papers | 1810s–1860s | The bookbinder's apprentice who became the greatest experimentalist of his century — electricity worked out trial by trial. |
| Babad Diponegoro | 1825–1832 | A Javanese prince's verse autobiography, written in exile after leading the largest anti-colonial war Java ever saw. |
| Lovelace / Babbage | 1830s–1850s | Ada Lovelace, Charles Babbage, and the first computer that never got built — letters, notes, and the famous Note G. |
| Lincoln Papers | 1830s–1865 | Lincoln in his own words — speeches, letters, telegrams, and drafts from New Salem to the second inaugural, plus original manuscripts. |
| Thoreau Journals and Letters | 1830s–1862 | The Walden naturalist who turned daily walks, bean fields, and tax refusals into a philosophy of attention. |
| Darwin Correspondence | 1830s–1882 | Darwin working out evolution by mail — decades of letters to Hooker, Huxley, Lyell, and Wallace. |
| Douglass Papers | 1840s–1895 | Frederick Douglass from fugitive to statesman — speeches, letters, and newspaper work spanning abolition, war, and Reconstruction. |
| Whitman Papers | 1840s–1892 | America's poet in prose — Civil War letters from Washington hospitals, working notebooks, and the correspondence behind Leaves of Grass. |
| Tolstoy Diaries | 1847–1910 | Tolstoy kept diaries for over sixty years — moral self-accounting, vows, failures, and the private struggle behind the novels (in Russian). |
| Nightingale Papers | 1850s–1910 | The founder of modern nursing — a data reformer whose books and letters turned hospital death rates into a public argument. |
| Mark Twain Letters | 1853–1910 | Six decades of letters from Samuel Clemens — the making, marketing, bankruptcy, and private grief of America's funniest man. |
| Van Gogh Letters | 1872–1890 | Vincent's letters, mostly to his brother Theo — the complete inner record of an artist's development, poverty, doubt, and conviction. |
| Naser al-Din Shah Diary | 1873 | A Persian Shah's personal diary of his grand tour of Europe — railways, ballets, battleships, and empires seen through curious royal eyes. |
| Witbooi Papers | 1880s–1905 | Nama kaptein whose captured letter-books record diplomacy, warning, and armed resistance against German colonial power — in his own words. |
| Ida B. Wells Writings | 1892–1895 | Investigative journalist who documented American lynching with names, dates, and statistics when publishing them got her presses destroyed. |
| Kartini Letters | 1899–1904 | A Javanese noblewoman writing Dutch pen friends about colonialism, seclusion, and women's education — she died at 25 and the letters became a national cause. |
| Wright Brothers Papers | 1899–1948 | Two bicycle mechanics work out powered flight — Orville's own account of December 17, 1903, plus catalog pointers to the Kitty Hawk diaries. |
| Gandhi Collected Works | 1900s–1948 | The written record of Gandhi's campaigns — letters, speeches, and articles tracing nonviolence from a Durban law office to Indian independence. |

Dialogues contains no downloaded text, only guides and source lists. When you pick a collection, Dialogues downloads the permitted source text from the original archive to your computer and builds a search file. A curated source list is a selection, not the whole archive. Your AI always asks before downloading anything.

One caveat: the Teika Diary is catalog only. No machine-readable text of the Meigetsuki is openly available online, so it becomes searchable only if you import a transcription yourself.

## Use your own documents

Put your files in one folder, then tell your AI:

> Use Dialogues to import this folder as a new document collection:
> C:\Users\me\Documents\Grandmas Letters
> Name it "Grandma's Letters". Then help me make the guide.

Supported files: `.txt`, `.md`, `.pdf` (with selectable text), `.epub`, `.docx`. Image-only PDFs need OCR first. The files are copied into your Dialogues folder; hidden files, credential-looking files (such as `.env` or private keys), and links that point outside the folder are skipped. PDF support depends on an optional component; if it is unavailable on your computer, other file types still import and Dialogues says which PDFs it skipped.

## Where things are stored

```text
~/Dialogues/                 (or the folder you chose)
  indexes/<collection>/      search files
  source-cache/<collection>/ downloaded source text
  user-corpora/<collection>/ your imported collections
  logs/                      operation logs (queries, passage IDs, errors; never document text)
  preferences.json           how you like answers
  consents.jsonl             what you agreed to download, and when
```

A small file at `~/.dialogues/config.json` remembers which folder you chose. Dialogues never writes inside its own program folder. If you used an earlier version, `dialogues migrate` previews copying your old collections into the new folder; `dialogues migrate --apply` copies and verifies them and leaves the originals in place.

## Privacy

- Collections, search files, and logs stay on your computer.
- Passages that Dialogues returns to your AI app are shared with that app.
- Dialogues contacts the internet only when you agree to download a collection (from the original archive) or when you install or update the package. It has no telemetry, no update checks, and no network listener.
- Logs can contain your search wording. Set `DIALOGUES_LOG=off` to stop logging, or run `dialogues logs clear`.

See [PRIVACY.md](PRIVACY.md) for details.

## Everyday commands

You normally never need these; your AI uses the tools for you.

```text
dialogues ready              read-only check: is everything in place?
dialogues doctor --fix       repair folders and app entries Dialogues created
dialogues list               show collections and what is downloaded
dialogues update             update to the latest release (only when you run it)
dialogues uninstall          disconnect the apps Dialogues connected (keeps your collections)
dialogues logs tail          see what Dialogues did recently
```

`dialogues uninstall --delete-data --confirm-data-dir <folder>` also deletes your Dialogues folder; it refuses unless you repeat the exact folder path. Then remove the program with `npm uninstall -g dialogues-mcp`.

Client details (Claude Desktop, Claude Code, Codex, Cursor, VS Code, Antigravity) are in [docs/MCP_SETUP.md](docs/MCP_SETUP.md).

## For AI assistants

If the user asked you to set this up from this folder, read [AGENTS.md](AGENTS.md) (or [CLAUDE.md](CLAUDE.md) in Claude Code) and follow it. Connect only the app the user is using, and never download a collection without the user's agreement.

## Contributing

```bash
npm ci
npm run build
npm test            # offline tests; no downloads, no real app settings
npm run typecheck
npm run privacy-scan
npm run pack:check  # builds the package and test-installs it outside the checkout
```

A document collection is called a corpus in the code. Each one is a capsule: `corpus.yaml`, `guide.md`, `search-rules.md`, `source-notes.md`, `citation-rules.md`, a `source-manifest.yaml` listing where the text comes from, and optionally a `sample.yaml`. See [Create a corpus](docs/CREATE_A_CORPUS.md), [Corpus capsules](docs/CORPUS_CAPSULES.md), [Corpus data policy](docs/CORPUS_DATA_POLICY.md), and [Curating a built-in corpus](docs/CURATING_A_BUILTIN_CORPUS.md).

To work on Dialogues with its data inside the checkout, set `DIALOGUES_WORKSPACE_MODE=repo` (data goes to `./workspace`, which git ignores).

## License

The Dialogues code is MIT licensed (see [LICENSE](LICENSE)). The documents you download keep their own terms: many are public domain, and some are non-commercial or share-alike (for example the Van Gogh letters and Gandhi's Collected Works). Dialogues ships guides and source lists only, never the texts. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
