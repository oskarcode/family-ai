// Vitest supplies taxonomy normalization assertions.
import { describe, expect, it } from "vitest";

// Shared category helpers define the canonical storage contract.
import {
  CANONICAL_CATEGORY_VALUES,
  normalizeCategory,
  UPLOAD_CATEGORY_VALUES,
} from "./categories.js";

describe("category taxonomy", () => {
  it("keeps relationship canonical and retires family", /**
   * Input:
   * - The exported canonical and upload category lists.
   * Output:
   * - Assertions for the supported and retired category names.
   * What this function does:
   * - Prevents future uploads from recreating the retired `family` prefix.
   */
  () => {
    expect(CANONICAL_CATEGORY_VALUES).toContain("relationship");
    expect(UPLOAD_CATEGORY_VALUES).not.toContain("family");
    expect(normalizeCategory("family")).toBeNull();
  });

  it("normalizes historical finance and health aliases", /**
   * Input:
   * - Historical category names accepted from older clients.
   * Output:
   * - Their canonical storage folder names.
   * What this function does:
   * - Keeps old callers working without creating duplicate top-level folders.
   */
  () => {
    expect(normalizeCategory("finance")).toBe("financial");
    expect(normalizeCategory("health")).toBe("medical");
    expect(normalizeCategory(" relationship ")).toBe("relationship");
  });
});
