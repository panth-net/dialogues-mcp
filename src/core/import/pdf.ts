import { normalizeImportedText } from "./chunk.js";

// PDF.js is loaded only when a PDF is actually processed. On some systems its
// optional native canvas package is missing, which makes the module fail to
// load; that must only affect PDFs, never search, MCP startup, or other
// formats. DIALOGUES_DISABLE_PDF=1 simulates that case.

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

export class PdfSupportUnavailableError extends Error {
  constructor(reason: string) {
    super(`PDF support is unavailable on this computer (${reason}). Other file types still work; convert PDFs to text to import them.`);
  }
}

let loading: Promise<PdfJsModule> | null = null;

export function loadPdfJs(): Promise<PdfJsModule> {
  if (process.env.DIALOGUES_DISABLE_PDF === "1") {
    return Promise.reject(new PdfSupportUnavailableError("disabled by DIALOGUES_DISABLE_PDF"));
  }
  loading ??= import("pdfjs-dist/legacy/build/pdf.mjs").catch((error: unknown) => {
    loading = null;
    throw new PdfSupportUnavailableError(error instanceof Error ? error.message.split("\n")[0] : String(error));
  });
  return loading;
}

export async function pdfSupportStatus(): Promise<{ available: boolean; detail: string }> {
  try {
    const pdfjs = await loadPdfJs();
    return { available: true, detail: `PDF.js ${pdfjs.version}` };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export type PdfLimits = {
  maxPages: number;
  timeoutMs: number;
};

export const DEFAULT_PDF_LIMITS: PdfLimits = {
  maxPages: 2000,
  timeoutMs: 120_000
};

export type PdfExtraction = {
  numPages: number;
  pages: Array<{ pageNumber: number; text: string }>;
  title: string | null;
  author: string | null;
  warnings: string[];
  truncated: boolean;
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Extract the text layer. No OCR; pages without text produce warnings. */
export async function extractPdfText(buffer: Uint8Array, limits: Partial<PdfLimits> = {}): Promise<PdfExtraction> {
  const { maxPages, timeoutMs } = { ...DEFAULT_PDF_LIMITS, ...limits };
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const loadingTask = pdfjs.getDocument({
    data,
    // PDF.js 6.4 no longer compiles fonts with eval (the old isEvalSupported
    // switch is gone); XFA forms and font loading are not needed for text.
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`PDF processing exceeded ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  const work = (async (): Promise<PdfExtraction> => {
    const document = await loadingTask.promise;
    const metadata = await document.getMetadata().catch(() => undefined) as { info?: Record<string, unknown> } | undefined;
    const pages: PdfExtraction["pages"] = [];
    const warnings: string[] = [];
    const pageCount = Math.min(document.numPages, maxPages);
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const textContent = await page.getTextContent();
        const text = normalizeImportedText(textContent.items
          .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
          .filter(Boolean)
          .join(" "));
        if (text) pages.push({ pageNumber, text });
        else warnings.push(`page ${pageNumber} has no extractable text`);
      } finally {
        page.cleanup();
      }
    }
    const truncated = document.numPages > maxPages;
    if (truncated) warnings.push(`only the first ${maxPages} of ${document.numPages} pages were read`);
    return {
      numPages: document.numPages,
      pages,
      title: stringValue(metadata?.info?.Title),
      author: stringValue(metadata?.info?.Author),
      warnings,
      truncated
    };
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    await loadingTask.destroy().catch(() => undefined);
    work.catch(() => undefined);
  }
}
