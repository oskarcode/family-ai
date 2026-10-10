// Vitest supplies the behavior-focused taxonomy assertions.
import { describe, expect, it } from "vitest";

// Classifier functions under test derive category and document-type path segments.
import { detectCategory, detectDocType } from "./classifier.js";

describe("path classification", () => {
  it("classifies explicit relationship documents", /**
   * Input:
   * - A path containing the specific phrase "family letter".
   * Output:
   * - An assertion that the relationship category wins.
   * What this function does:
   * - Protects the intended home for family correspondence without classifying every family path.
   */
  () => {
    expect(detectCategory("notes/family letter 2026.md")).toBe("relationship");
  });

  it("does not match keywords inside unrelated words", /**
   * Input:
   * - Paths containing `Current` and `Please` rather than the standalone words `rent` and `lease`.
   * Output:
   * - Assertions that neither path is mislabeled as housing.
   * What this function does:
   * - Guards the word-boundary fix for the historical classifier false positives.
   */
  () => {
    expect(detectCategory("NYC - Current/document.pdf")).toBe("general");
    expect(detectCategory("Please-review/document.pdf")).toBe("general");
    expect(detectDocType("NYC - Current/document.pdf", "pdf")).toBe("pdf_document");
    expect(detectDocType("Please-review/document.pdf", "pdf")).toBe("pdf_document");
  });

  it("still recognizes standalone category and document-type terms", /**
   * Input:
   * - Paths containing standalone passport, rent, and lease terms.
   * Output:
   * - Assertions for immigration and housing classification.
   * What this function does:
   * - Confirms stricter matching preserves legitimate keyword behavior.
   */
  () => {
    expect(detectCategory("records/passport.pdf")).toBe("immigration");
    expect(detectCategory("records/current rent receipt.pdf")).toBe("home");
    expect(detectDocType("records/lease agreement.pdf", "pdf")).toBe("housing");
  });
});
