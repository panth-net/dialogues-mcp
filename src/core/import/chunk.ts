export type ChunkingConfig = {
  min_chars: number;
  max_chars: number;
  overlap_chars: number;
  preserve_paragraphs: boolean;
};

export type TextChunk = {
  chunk_index: number;
  text_raw: string;
  text_norm: string;
};

export const DEFAULT_CHUNKING: ChunkingConfig = {
  min_chars: 300,
  max_chars: 1600,
  overlap_chars: 150,
  preserve_paragraphs: true
};

export function normalizeImportedText(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/-\n(?=\p{Ll})/gu, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compactChunkText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function normalizeChunkText(input: string): string {
  return compactChunkText(input
    .replace(/(\p{Script=Han})/gu, " $1 ")
  );
}

function paragraphsFromText(input: string, preserveParagraphs: boolean): string[] {
  const normalized = normalizeImportedText(input);
  if (!normalized) return [];
  if (!preserveParagraphs) return [compactChunkText(normalized)];
  return normalized
    .split(/\n\s*\n/g)
    .map((paragraph) => compactChunkText(paragraph))
    .filter(Boolean);
}

function splitLongText(text: string, config: ChunkingConfig): string[] {
  const max = Math.max(200, config.max_chars);
  const overlap = Math.max(0, Math.min(config.overlap_chars, Math.floor(max / 3)));
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(text.length, start + max);
    if (end < text.length) {
      const searchStart = Math.max(start + Math.floor(max * 0.5), end - 300);
      const boundary = Math.max(text.lastIndexOf(". ", end), text.lastIndexOf("; ", end), text.lastIndexOf(" ", end));
      if (boundary > searchStart) end = boundary + 1;
    }

    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

export function chunkText(input: string, config: Partial<ChunkingConfig> = {}): TextChunk[] {
  const resolved: ChunkingConfig = { ...DEFAULT_CHUNKING, ...config };
  const max = Math.max(200, resolved.max_chars);
  const min = Math.max(0, Math.min(resolved.min_chars, max));
  const paragraphs = paragraphsFromText(input, resolved.preserve_paragraphs);
  const rawChunks: string[] = [];
  let current = "";

  const flush = () => {
    const value = current.trim();
    if (value) rawChunks.push(value);
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > max) {
      flush();
      rawChunks.push(...splitLongText(paragraph, resolved));
      continue;
    }

    if (!current) {
      current = paragraph;
      continue;
    }

    const candidate = `${current}\n\n${paragraph}`;
    if (candidate.length <= max && (current.length < min || paragraph.length < min)) {
      current = candidate;
    } else {
      flush();
      current = paragraph;
    }
  }
  flush();

  return rawChunks.map((text, index) => ({
    chunk_index: index,
    text_raw: text,
    text_norm: normalizeChunkText(text)
  }));
}
