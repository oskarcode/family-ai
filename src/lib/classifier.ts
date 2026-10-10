// Shared domain types keep classifier outputs compatible with storage and policy code.
import type { CatalogCategory, InventoryRecord, PersonTag, Sensitivity } from "./types.js";

// Ordered category rules provide deterministic first-match classification from paths.
const CATEGORY_KEYWORDS: Array<{ category: CatalogCategory; keywords: string[] }> = [
  {
    category: "relationship",
    keywords: ["relationship", "family letter", "marriage", "couples therapy"],
  },
  {
    category: "medical",
    keywords: ["medical", "health", "healthcare", "cigna", "vaccination", "ultrasound", "pregnancy", "pharmacy"],
  },
  {
    category: "legal",
    keywords: ["contract", "agreement", "lease", "legal", "court", "permit", "disclosure", "notary"],
  },
  {
    category: "financial",
    keywords: ["tax", "w2", "1098", "1099", "mortgage", "loan", "bank", "finance", "statement", "brokerage", "stock"],
  },
  {
    category: "immigration",
    keywords: ["visa", "passport", "green card", "immigration", "embassy", "ssn", "residency"],
  },
  {
    category: "home",
    keywords: ["house", "home", "utility", "plumbing", "inspection", "sewer", "electric", "rent", "valley stream"],
  },
  {
    category: "employment",
    keywords: ["offer", "employment", "pay", "salary", "cloudflare", "tencent", "benefits", "metlife", "vsp"],
  },
  {
    category: "education",
    keywords: ["yeshiva", "gwu", "teaching", "university", "certificate", "residency application"],
  },
  {
    category: "travel",
    keywords: ["trip", "flight", "airbnb", "travel", "shipment", "relocation", "airchina"],
  },
];

// Ordered document-type rules prefer semantic path evidence over file-format fallbacks.
const DOC_TYPE_KEYWORDS: Array<{ type: string; keywords: string[] }> = [
  { type: "tax", keywords: ["tax", "w2", "1098", "1099", "irs"] },
  { type: "mortgage", keywords: ["mortgage", "loan", "appraisal", "closing"] },
  { type: "insurance", keywords: ["insurance", "cigna", "metlife", "vsp", "benefits"] },
  { type: "identity", keywords: ["passport", "green card", "ssn", "birth certificate", "id"] },
  { type: "medical_records", keywords: ["medical", "health", "test", "ultrasound", "vaccination"] },
  { type: "housing", keywords: ["house", "home", "rent", "lease", "inspection", "utility"] },
  { type: "employment", keywords: ["offer", "contract", "employment", "pay", "salary"] },
];

/**
 * Input:
 * - Lowercase path text and a lowercase keyword or phrase.
 * Output:
 * - True when the keyword appears at non-alphanumeric boundaries.
 * What this function does:
 * - Prevents short terms such as `rent`, `lease`, and `id` matching inside unrelated words.
 */
function containsKeyword(path: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(path);
}

/**
 * Input:
 * - A source path that may contain one or more four-digit years.
 * Output:
 * - The last detected year, or "unknown" when no year is present.
 * What this function does:
 * - Derives the most specific year tag from the path ordering.
 */
export function detectYear(path: string): string {
  const yearMatch = path.match(/(20\d{2})/g);
  if (!yearMatch || yearMatch.length === 0) {
    return "unknown";
  }
  return yearMatch[yearMatch.length - 1] ?? "unknown";
}

/**
 * Input:
 * - A source path that may contain a family member name.
 * Output:
 * - The matching person tag, defaulting to "shared".
 * What this function does:
 * - Assigns ownership using the configured name-precedence rules.
 */
export function detectPerson(path: string): PersonTag {
  const lower = path.toLowerCase();
  // Apply named-person precedence before falling back to shared ownership.
  if (lower.includes("oskar")) return "oskar";
  if (lower.includes("kaitlin")) return "kaitlin";
  if (lower.includes("zadia")) return "zadia";
  if (lower.includes("baby 2") || lower.includes("baby2")) return "baby2";
  return "shared";
}

/**
 * Input:
 * - A source path whose words may match category rules.
 * Output:
 * - The first matching catalog category, or "general".
 * What this function does:
 * - Classifies a path according to ordered category keyword rules.
 */
export function detectCategory(path: string): CatalogCategory {
  const lower = path.toLowerCase();
  // Rule order is intentional: the first category match wins when keywords overlap.
  for (const rule of CATEGORY_KEYWORDS) {
    if (rule.keywords.some((keyword) => containsKeyword(lower, keyword))) {
      return rule.category;
    }
  }
  return "general";
}

/**
 * Input:
 * - A source path and its file extension.
 * Output:
 * - A semantic document type or a format-based fallback type.
 * What this function does:
 * - Prefers keyword-derived document types before using extension fallbacks.
 */
export function detectDocType(path: string, extension: string): string {
  const lower = path.toLowerCase();
  // Semantic path evidence takes precedence over generic extension classification.
  for (const rule of DOC_TYPE_KEYWORDS) {
    if (rule.keywords.some((keyword) => containsKeyword(lower, keyword))) {
      return rule.type;
    }
  }

  if (extension === "pdf") return "pdf_document";
  if (extension === "docx" || extension === "doc") return "word_document";
  if (extension === "xlsx" || extension === "csv" || extension === "numbers") return "spreadsheet";
  if (extension === "jpg" || extension === "jpeg" || extension === "png" || extension === "heic") return "image";
  return "general_document";
}

/**
 * Input:
 * - A previously classified catalog category.
 * Output:
 * - The sensitivity level assigned to that category.
 * What this function does:
 * - Maps sensitive domains to restricted access and household domains to family access.
 */
export function detectSensitivity(category: CatalogCategory): Sensitivity {
  // Apply the strongest category-based access restriction first.
  if (category === "medical" || category === "financial" || category === "immigration" || category === "legal") {
    return "restricted";
  }
  if (category === "home" || category === "employment") {
    return "family";
  }
  return "shared";
}

/**
 * Input:
 * - An original filename.
 * Output:
 * - A trimmed, path-safe canonical filename.
 * What this function does:
 * - Normalizes whitespace and unsupported characters for stable object keys.
 */
export function toCanonicalFilename(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_");
}

/**
 * Input:
 * - An inventory record and its category, year, person, and document-type classifications.
 * Output:
 * - The canonical hierarchical R2 object key.
 * What this function does:
 * - Combines classification metadata with a normalized filename into the storage key.
 */
export function buildR2Key(record: InventoryRecord, category: CatalogCategory, year: string, person: PersonTag, docType: string): string {
  const filename = toCanonicalFilename(record.filename);
  return `${category}/${year}/${person}/${docType}/${filename}`;
}
