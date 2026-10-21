import { describe, it, expect } from "vitest";
import {
  CreateDocumentUploadSchema,
  DocumentPathSchema,
  documentsBucketName,
  isSafeDocumentPath,
  normalizeDocumentPath,
} from "../document";
import { DOCUMENT_MAX_SIZE_BYTES } from "../../constants";

const SHA = "a".repeat(64);

describe("normalizeDocumentPath", () => {
  it("trims, converts backslashes and collapses slashes", () => {
    expect(normalizeDocumentPath("  /guides//setup.pdf/ ")).toBe("guides/setup.pdf");
    expect(normalizeDocumentPath("docs\\intro.md")).toBe("docs/intro.md");
  });
});

describe("isSafeDocumentPath", () => {
  it("accepts simple nested paths", () => {
    expect(isSafeDocumentPath("report.pdf")).toBe(true);
    expect(isSafeDocumentPath("a/b/c/d/e.txt")).toBe(true);
  });

  it("rejects traversal, hidden files, odd characters and deep paths", () => {
    expect(isSafeDocumentPath("../secret")).toBe(false);
    expect(isSafeDocumentPath("a/../b")).toBe(false);
    expect(isSafeDocumentPath(".env")).toBe(false);
    expect(isSafeDocumentPath("my file.pdf")).toBe(false);
    expect(isSafeDocumentPath("a?b")).toBe(false);
    expect(isSafeDocumentPath("a/b/c/d/e/f")).toBe(false);
    expect(isSafeDocumentPath("")).toBe(false);
    expect(isSafeDocumentPath("x".repeat(201))).toBe(false);
  });
});

describe("DocumentPathSchema", () => {
  it("normalizes before validating", () => {
    expect(DocumentPathSchema.parse("/guides/setup.pdf")).toBe("guides/setup.pdf");
    expect(DocumentPathSchema.safeParse("/../x").success).toBe(false);
  });
});

describe("CreateDocumentUploadSchema", () => {
  it("applies defaults", () => {
    const parsed = CreateDocumentUploadSchema.parse({ path: "a.pdf", size_bytes: 10, sha256: SHA });
    expect(parsed).toMatchObject({
      visibility: "public",
      content_type: "application/octet-stream",
      expires_in_days: null,
    });
  });

  it("rejects oversize and empty files and bad checksums", () => {
    const base = { path: "a.pdf", sha256: SHA };
    expect(CreateDocumentUploadSchema.safeParse({ ...base, size_bytes: 0 }).success).toBe(false);
    expect(
      CreateDocumentUploadSchema.safeParse({ ...base, size_bytes: DOCUMENT_MAX_SIZE_BYTES + 1 }).success,
    ).toBe(false);
    expect(
      CreateDocumentUploadSchema.safeParse({ path: "a.pdf", size_bytes: 1, sha256: "XYZ" }).success,
    ).toBe(false);
  });
});

describe("documentsBucketName", () => {
  it("produces a valid S3 bucket name", () => {
    expect(documentsBucketName("my-app")).toBe("docs-my-app");
    expect(documentsBucketName("My_App.v2")).toBe("docs-my-app-v2");
    expect(documentsBucketName("")).toBe("docs-project");
    const long = documentsBucketName("a".repeat(100));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });
});
