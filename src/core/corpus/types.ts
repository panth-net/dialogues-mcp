export type CorpusLicense = {
  data_included: boolean;
  user_must_confirm_rights: boolean;
  notes: string;
};

export type CorpusChunkingConfig = {
  min_chars?: number;
  max_chars?: number;
  overlap_chars?: number;
  preserve_paragraphs?: boolean;
};

export type CorpusDownloadPolicy =
  | "public_source"
  | "curated_public_source"
  | "user_supplied_only"
  | "catalog_only";

export type CorpusManifest = {
  id: string;
  title: string;
  subtitle?: string;
  tagline?: string;
  description: string;
  languages: string[];
  type: string;
  status: string;
  data_policy: string;
  default_search_mode: string;
  guide: string;
  search_rules: string;
  source_notes: string;
  citation_rules: string;
  selection_rules?: string;
  source_manifest?: string;
  sample_profile?: string;
  downloadable?: boolean;
  download_policy?: CorpusDownloadPolicy;
  fields: string[];
  chunking?: CorpusChunkingConfig;
  license: CorpusLicense;
};

export type CorpusCapsule = {
  id: string;
  rootPath: string;
  source: "built_in" | "user" | "installed";
  manifest: CorpusManifest;
  guide: string;
  searchRules: string;
  sourceNotes: string;
  citationRules: string;
  selectionRules?: string;
  selectionRulesPath?: string;
  sourceManifestPath?: string;
  sampleProfilePath?: string;
  indexPath: string;
};

export type CorpusLoadError = {
  corpusId?: string;
  rootPath: string;
  message: string;
};

export type InstalledCorpusEntry = {
  path: string;
  id?: string;
};

export type InstalledCorporaManifest = {
  corpora: InstalledCorpusEntry[];
};
