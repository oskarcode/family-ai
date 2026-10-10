// Shared taxonomy types keep storage and ingestion modules aligned.
import type { CanonicalCategory } from "./categories.js";

// InventoryRecord is the raw filesystem metadata consumed by policy and classification.
export type InventoryRecord = {
  top_folder: string;
  folder: string;
  filename: string;
  relative_path: string;
  extension: string;
  size_bytes: number;
};

// CatalogCategory is the fixed taxonomy used for search paths and default sensitivity.
export type CatalogCategory = CanonicalCategory;

// PersonTag identifies the family member or shared household scope for a document.
export type PersonTag = "oskar" | "kaitlin" | "zadia" | "baby2" | "shared";

// Sensitivity controls the intended audience for stored family information.
export type Sensitivity = "restricted" | "family" | "shared";

// ProcessingStatus records the next action selected by ingestion policy.
export type ProcessingStatus =
  | "index_now"
  | "store_only"
  | "split_then_index"
  | "ocr_then_index"
  | "extract_then_classify"
  | "manual_review"
  | "invalid_source";

// EnrichedRecord combines source inventory with all derived ingestion decisions.
export type EnrichedRecord = InventoryRecord & {
  year: string;
  person: PersonTag;
  category: CatalogCategory;
  doc_type: string;
  sensitivity: Sensitivity;
  status: ProcessingStatus;
  status_reason: string;
  target_r2_key: string;
};
