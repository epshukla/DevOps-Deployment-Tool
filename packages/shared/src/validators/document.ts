import { z } from "zod";
import { DOCUMENT_MAX_EXPIRY_DAYS, DOCUMENT_MAX_SIZE_BYTES } from "../constants";

// ── Document paths ──────────────────────────────────────────────

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_PATH_LENGTH = 200;
const MAX_PATH_DEPTH = 5;

/**
 * Normalize a user-supplied document path: trim, use forward slashes, drop
 * leading/trailing slashes and collapse repeats. Validation happens after.
 */
export function normalizeDocumentPath(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/");
}

/**
 * Whether a normalized path is safe to use as an object key and a URL path:
 * up to five segments of letters, digits, dots, hyphens and underscores, no
 * segment starting with a dot (so no `..` or hidden files).
 */
export function isSafeDocumentPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  const segments = path.split("/");
  if (segments.length > MAX_PATH_DEPTH) return false;
  return segments.every((s) => SEGMENT_PATTERN.test(s));
}

export const DocumentPathSchema = z
  .string()
  .transform(normalizeDocumentPath)
  .refine(isSafeDocumentPath, {
    message:
      "Path may only use letters, numbers, dots, hyphens and underscores, up to 5 folders deep (e.g. guides/setup.pdf)",
  });

export const DocumentVisibilitySchema = z.enum(["public", "private"]);
export type DocumentVisibility = z.infer<typeof DocumentVisibilitySchema>;

// ── Web: start an upload ────────────────────────────────────────

export const CreateDocumentUploadSchema = z.object({
  path: DocumentPathSchema,
  size_bytes: z
    .number()
    .int()
    .positive("File is empty")
    .max(DOCUMENT_MAX_SIZE_BYTES, `File exceeds ${DOCUMENT_MAX_SIZE_BYTES / (1024 * 1024)} MB`),
  content_type: z.string().max(255).default("application/octet-stream"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, "Invalid SHA-256 checksum"),
  visibility: DocumentVisibilitySchema.default("public"),
  expires_in_days: z.number().int().min(1).max(DOCUMENT_MAX_EXPIRY_DAYS).nullable().default(null),
});

export type CreateDocumentUploadInput = z.input<typeof CreateDocumentUploadSchema>;

// ── Runner: document manifest ───────────────────────────────────

export interface DocumentManifestEntry {
  /** Object key inside the project's bucket, e.g. `guides/setup.pdf` */
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly content_type: string;
  /** Short-lived signed URL to download the file from the control plane's storage */
  readonly url: string;
}

export interface DocumentManifest {
  readonly project_slug: string;
  readonly documents: readonly DocumentManifestEntry[];
}

/**
 * The runner-side bucket for a project's public documents. S3 bucket names
 * are 3–63 characters of lowercase letters, digits and hyphens.
 */
export function documentsBucketName(projectSlug: string): string {
  const safe = projectSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `docs-${safe || "project"}`.slice(0, 63).replace(/-$/, "");
}
