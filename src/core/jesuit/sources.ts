export const JESUIT_CORPUS_ID = "jesuit-relations";
export const JESUIT_VOLUME_COUNT = 73;

export const JESUIT_RIGHTS_NOTICE = [
  "The Thwaites edition of The Jesuit Relations and Allied Documents was published 1896-1901 and is treated here as public-domain source material.",
  "Downloaded OCR text is a local copy on this computer. Confirm that your use complies with the source site's terms and your local requirements before redistribution.",
  "Dialogues stores downloaded text in your Dialogues data folder under source-cache/jesuit-relations/."
].join(" ");

function padVolume(volume: number): string {
  return String(volume).padStart(2, "0");
}

export function jesuitArchiveId(volume: number): string {
  return `jesuits${padVolume(volume)}jesuuoft`;
}

export function jesuitArchiveUrl(id: string): string {
  return `https://archive.org/details/${id}`;
}

export function jesuitArchiveTextUrl(id: string): string {
  return `https://archive.org/download/${id}/${id}_djvu.txt`;
}
