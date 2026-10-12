import type { GenericDocumentInput } from "../db/genericIndex.js";
import type { CorpusCapsule } from "../corpus/types.js";
import type { HttpContext } from "./http.js";

export const RIGHTS_LEVELS = [
  "public_domain",
  "no_known_restrictions",
  "open_license",
  "noncommercial_open_license",
  "rights_confirmed_user_download",
  "user_supplied_only",
  "borrow_only",
  "catalog_only",
  "unknown"
] as const;

export type RightsLevel = typeof RIGHTS_LEVELS[number];

export const SUPPORTED_SOURCE_TYPES = [
  "loc_item",
  "loc_collection_search",
  "static_text_url",
  "static_html_url",
  "static_json_url",
  "static_pdf_url",
  "tei_xml_url",
  "darwin_correspondence",
  "darwin_online",
  "umass_credo_item",
  "newton_project_item",
  "science_museum_item",
  "clay_lovelace_item",
  "vangogh_xml_zip",
  "catalog_only",
  "user_supplied_only"
] as const;

export type SourceType = typeof SUPPORTED_SOURCE_TYPES[number];

export type DownloadPolicy =
  | "public_source"
  | "curated_public_source"
  | "user_supplied_only"
  | "catalog_only";

export type DownloadMode = {
  visible_to_users?: boolean;
  description?: string;
  metadata?: Record<string, unknown>;
};

export type SourcePath = {
  title: string;
  point?: string;
  description?: string;
  metadata?: Record<string, unknown>;
};

export type SourceItem = {
  id: string;
  source_type: SourceType;
  url?: string;
  api_url?: string;
  title?: string;
  author?: string;
  recipient?: string;
  date?: string;
  document_type?: string;
  rights_level?: RightsLevel;
  selected?: boolean;
  paths?: string[];
  curator_score?: number;
  signals?: string[];
  why_keep?: string;
  why_skip?: string;
  metadata?: Record<string, unknown>;
};

export type SourceManifest = {
  version: number;
  corpus_id: string;
  source_policy: string;
  default_mode: string;
  download_modes: Record<string, DownloadMode>;
  paths: Record<string, SourcePath>;
  items: SourceItem[];
};

export type FetchOptions = {
  rawRoot: string;
  normalizedRoot: string;
  force?: boolean;
  http: HttpContext;
  capsule?: CorpusCapsule;
};

export type FetchStatus =
  | "text"
  | "metadata_only"
  | "catalog_only"
  | "user_supplied_only"
  | "rights_blocked"
  | "error";

export type FetchedSourceDocument = {
  item: SourceItem;
  status: FetchStatus;
  rawPath?: string;
  textPath?: string;
  text?: string;
  metadata: Record<string, unknown>;
  warnings: string[];
  /** Adapters that expand one item into many documents (e.g. an archive). */
  documents?: GenericDocumentInput[];
};

export type SourceAdapter = {
  sourceType: SourceType;
  fetchItem(item: SourceItem, options: FetchOptions): Promise<FetchedSourceDocument>;
  normalize(fetched: FetchedSourceDocument): GenericDocumentInput[];
};

export type SourceDownloadSelection = {
  mode?: string;
  path?: string;
};
