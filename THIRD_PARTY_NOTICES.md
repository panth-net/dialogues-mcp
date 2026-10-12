# Third-party notices

## Code

Dialogues' own code is MIT licensed (see `LICENSE`). It depends on open-source packages installed by npm, each under its own license. The direct runtime dependencies are:

| Package | License |
| --- | --- |
| @modelcontextprotocol/server, @modelcontextprotocol/client | Apache-2.0 |
| pdfjs-dist | Apache-2.0 |
| @napi-rs/canvas (optional, used by PDF.js) | MIT |
| mammoth | BSD-2-Clause |
| adm-zip, commander, fast-xml-parser, html-to-text, jsonc-parser, zod | MIT |
| yaml | ISC |

Transitive dependencies are under MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, Zlib, or dual MIT/GPL-3.0 (jszip, used here under MIT) terms. `npm ls --omit=dev --all` lists the exact set for a given install. Their license texts ship inside each package in `node_modules`.

## Documents

Dialogues ships guides and source lists, never source texts. Texts you download keep the terms of their publishers, recorded per item as a rights level and summarized in the notice you agree to before downloading. Notable cases:

- **Vincent van Gogh - The Letters** (Van Gogh Museum and Huygens ING): CC BY-NC-SA 4.0. Non-commercial use; share adaptations under the same license; attribute the edition.
- **The Collected Works of Mahatma Gandhi** (Publications Division, Government of India, via archive.org scans): offered under non-commercial terms.
- **Darwin Correspondence Project**, **Newton Project**, and other scholarly editions: their own terms, as summarized in each collection's `source-notes.md`.
- Project Gutenberg texts: public domain in the United States; check your local law elsewhere. Dialogues removes the Project Gutenberg header and footer when indexing, so indexed text carries no Project Gutenberg trademark.

The guides, search rules, source notes, and citation rules written for Dialogues are covered by the MIT license with the code.
