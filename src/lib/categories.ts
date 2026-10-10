// Canonical values are the only category names written into storage paths.
export const CANONICAL_CATEGORY_VALUES = [
  "financial",
  "medical",
  "legal",
  "immigration",
  "home",
  "employment",
  "education",
  "travel",
  "relationship",
  "general",
] as const;

// CanonicalCategory is the compile-time equivalent of a constrained Python Literal.
export type CanonicalCategory = (typeof CANONICAL_CATEGORY_VALUES)[number];

// Upload callers may use these historical names, but storage always uses the canonical value.
export const CATEGORY_ALIAS_VALUES = ["finance", "health"] as const;
export const UPLOAD_CATEGORY_VALUES = [...CANONICAL_CATEGORY_VALUES, ...CATEGORY_ALIAS_VALUES] as const;

// Category aliases prevent old clients from creating parallel top-level folders.
const CATEGORY_ALIASES: Readonly<Record<string, CanonicalCategory>> = {
  finance: "financial",
  health: "medical",
};

/**
 * Input:
 * - A possible canonical category value.
 * Output:
 * - True when the value is one of the storage taxonomy categories.
 * What this function does:
 * - Narrows untrusted strings before they are used as category keys.
 */
export function isCanonicalCategory(value: string): value is CanonicalCategory {
  return CANONICAL_CATEGORY_VALUES.includes(value as CanonicalCategory);
}

/**
 * Input:
 * - A category supplied by an API or MCP caller.
 * Output:
 * - Its canonical storage category, or null when unsupported.
 * What this function does:
 * - Normalizes historical aliases while rejecting the retired `family` category.
 */
export function normalizeCategory(value?: string | null): CanonicalCategory | null {
  const cleaned = value?.trim().toLowerCase();
  if (!cleaned) return null;
  if (isCanonicalCategory(cleaned)) return cleaned;
  return CATEGORY_ALIASES[cleaned] ?? null;
}
