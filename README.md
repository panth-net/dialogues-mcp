# Dialogues MCP

**Website:** https://panth-net.github.io/dialogues-mcp-landing-page/

Talk with historical diaries and letters.

Dialogues MCP lets your AI app read from a document collection stored on your computer. Ask a question and get answers that quote and cite the original diaries and letters.

Free · Open source · Runs on your computer

## Install

You need [Node.js](https://nodejs.org) 22.16 or newer. Dialogues MCP works with Claude Desktop, Claude Code, Codex, Cursor, VS Code, and Antigravity.

1. To set up Dialogues MCP, copy the prompt below and paste it into your AI app.
2. Once the install is complete, restart your desktop AI app, then send your first message, like the one below.

**Send this to your AI to install**

<!-- install-prompt:start -->
```text
Install Dialogues MCP on this computer (`npm install -g dialogues-mcp`) and connect it to the app I'm talking to you in (`dialogues setup --client <app>`, where <app> is claude-desktop, claude-code, codex, cursor, vscode, or antigravity). If you aren't sure which app I'm using, ask me first. If Node.js is missing, or the install tells you it's too old, stop and help me fix that first.

When you're done, tell me in plain English whether it worked, which app you connected, where my files are, and whether I should quit and reopen the app. Then give me a short message I can send after I restart, a clear table of which documents are downloaded and which are available but not downloaded yet, and a few example questions I could ask about a collection (showcasing some nuanced uses not just the obvious ones).
```
<!-- install-prompt:end -->

**Send your first message**

<!-- first-message:start -->
```text
Hi! I want to use Dialogues. Show me the document collections, recommend where to start, and help me choose. Ask me before downloading anything.
```
<!-- first-message:end -->

### Install it yourself

```bash
npm install -g dialogues-mcp
dialogues setup --client claude-desktop   # or claude-code, codex, cursor, vscode, antigravity
```

`setup` connects only the app you name. It backs up that app's settings first and downloads no documents. Fully quit and reopen the app afterwards. Details for each app are in [docs/MCP_SETUP.md](docs/MCP_SETUP.md).

## Documents

Dialogues MCP runs completely on your computer. The diaries and letters are downloaded to your computer and stay there. The package contains no document text, only guides and source lists, and your AI asks before downloading anything.

| Collection | Downloads from |
| --- | --- |
| Abraham Lincoln Papers | [Library of Congress](https://www.loc.gov) · [Project Gutenberg](https://www.gutenberg.org) |
| Augustine of Hippo Writings | [Project Gutenberg](https://www.gutenberg.org) · [Internet Archive](https://archive.org) |
| Babad Diponegoro | [Internet Archive](https://archive.org) · [British Library Endangered Archives](https://eap.bl.uk) · [Wikimedia Commons](https://commons.wikimedia.org) |
| Beethoven Letters | [Project Gutenberg](https://www.gutenberg.org) |
| Darwin Correspondence and Working Science | [Darwin Correspondence Project](https://www.darwinproject.ac.uk) · [Project Gutenberg](https://www.gutenberg.org) |
| Evliya Celebi Travels | [Project Gutenberg](https://www.gutenberg.org) · [Internet Archive](https://archive.org) |
| Florence Nightingale Papers | [Project Gutenberg](https://www.gutenberg.org) · [Wellcome Collection](https://wellcomecollection.org) |
| Francisco de Miranda Archive | [Internet Archive](https://archive.org) · [HathiTrust](https://www.hathitrust.org) · [Wikisource](https://wikisource.org) |
| Frederick Douglass Papers | [Library of Congress](https://www.loc.gov) |
| Fujiwara no Teika Diary (listed, not downloadable) | [e-Museum, Japan](https://emuseum.nich.go.jp) |
| Gandhi Collected Works | [Internet Archive](https://archive.org) · [Gandhi Heritage Portal](https://www.gandhiheritageportal.org) |
| Hendrik Witbooi Papers | [DBNL](https://www.dbnl.org) · [UNESCO](https://www.unesco.org) |
| Henry David Thoreau Journals and Letters | [Project Gutenberg](https://www.gutenberg.org) |
| Ida B. Wells Writings | [Project Gutenberg](https://www.gutenberg.org) · [University of Chicago Library](https://www.lib.uchicago.edu) |
| Isaac Newton Papers | [The Newton Project](https://www.newtonproject.ox.ac.uk) · [Chymistry of Isaac Newton](https://webapp1.dlib.indiana.edu/newton) |
| Jane Austen Letters | [Project Gutenberg](https://www.gutenberg.org) |
| John Quincy Adams Diary | [Internet Archive](https://archive.org) · [Massachusetts Historical Society](https://www.masshist.org) · [Primary Source Cooperative](https://www.primarysourcecoop.org) |
| Kartini Letters | [Project Gutenberg](https://www.gutenberg.org) · [DBNL](https://www.dbnl.org) |
| Leo Tolstoy Diaries | [State Tolstoy Museum](https://www.tolstoy.ru) |
| Libanius Letters | [Internet Archive](https://archive.org) · [Perseids](https://fgh.perseids.org) |
| Lovelace, Babbage, and Early Computing | [Science Museum Group](https://collection.sciencemuseumgroup.org.uk) · [Clay Mathematics Institute](https://www.claymath.org) |
| Maimonides in the Cairo Geniza | [Princeton Geniza Project](https://geniza.princeton.edu) · [Internet Archive](https://archive.org) · [Project Gutenberg](https://www.gutenberg.org) |
| Mark Twain Letters | [Project Gutenberg](https://www.gutenberg.org) |
| Michael Faraday Papers | [Royal Institution](https://www.rigb.org) · [Project Gutenberg](https://www.gutenberg.org) · [AIM25 London archives](https://atom.aim25.com) |
| Naser al-Din Shah Diary | [Internet Archive](https://archive.org) |
| Samson Occom Papers | [Dartmouth Library](https://collections.dartmouth.edu) · [Internet Archive](https://archive.org) |
| Samuel Pepys Diary | [Project Gutenberg](https://www.gutenberg.org) |
| The Baburnama | [Internet Archive](https://archive.org) · [Project Gutenberg](https://www.gutenberg.org) |
| The Jesuit Relations and Allied Documents | [Internet Archive](https://archive.org) |
| Van Gogh Letters | [Van Gogh Letters Project](https://vangoghletters.org) |
| Walt Whitman Papers | [Walt Whitman Archive](https://whitmanarchive.org) |
| Wilbur and Orville Wright Papers | [Library of Congress](https://www.loc.gov) · [Internet Archive](https://archive.org) · [Project Gutenberg](https://www.gutenberg.org) |
| Xu Xiake Travel Diaries | [Wikisource](https://wikisource.org) · [Chinese Text Project](https://ctext.org) |
| Yi Sun-sin War Diary | [Institute for the Translation of Korean Classics](https://db.itkc.or.kr) · [Wikisource](https://wikisource.org) · [Korea Heritage Service](https://www.heritage.go.kr) · [LTI Korea Library](https://library.ltikorea.or.kr) |

Some sources are non-commercial or share-alike, such as the Van Gogh letters and Gandhi's Collected Works. Your AI shows the terms before you agree to a download.

You can also add your own files (`.txt`, `.md`, `.pdf` with selectable text, `.epub`, `.docx`): ask your AI to use Dialogues to import a folder as a new document collection.

## Commands

Your AI uses Dialogues for you. These commands are for checking and maintenance:

```text
dialogues ready              check that everything is in place (read-only)
dialogues doctor --fix       repair folders and app entries Dialogues created
dialogues list               show collections and what is downloaded
dialogues update             update to the latest release
dialogues uninstall          disconnect the apps Dialogues connected (keeps your documents)
dialogues logs tail          see what Dialogues did recently
```

Documents are stored in `~/Dialogues` unless you choose another folder with `--data-dir`. To remove everything, run `dialogues uninstall --delete-data --confirm-data-dir <folder>`, then `npm uninstall -g dialogues-mcp`.

## Privacy

Documents, search files, and logs stay on your computer. Passages Dialogues finds are sent to the AI app you use, under that app's terms. Dialogues has no account, telemetry, or update checks, and goes online only to download documents you agreed to. See [PRIVACY.md](PRIVACY.md).

## Development

```bash
npm ci
npm run build
npm test
npm run typecheck
```

`npm pack` builds a package you can install with `npm install -g ./dialogues-mcp-<version>.tgz`. AI assistants setting up from a checkout should follow [AGENTS.md](AGENTS.md). To add a collection, see [docs/CREATE_A_CORPUS.md](docs/CREATE_A_CORPUS.md).

## License

MIT, see [LICENSE](LICENSE). Downloaded documents keep their own terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
