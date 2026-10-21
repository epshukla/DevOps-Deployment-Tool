import { DOCUMENTS_URL_PREFIX } from "@deployx/shared";

/** Storage object key for one document version: {org}/{project}/{document} */
export function documentStorageKey(orgId: string, projectId: string, documentId: string): string {
  return `${orgId}/${projectId}/${documentId}`;
}

export interface DocumentVersionRef {
  readonly id: string;
  readonly version: number;
  readonly is_current: boolean;
  readonly storage_key: string;
}

/**
 * Versions of one path to delete so at most `keep` remain. The current
 * version is never pruned; otherwise the newest versions are kept.
 */
export function versionsToPrune(
  versions: readonly DocumentVersionRef[],
  keep: number,
): readonly DocumentVersionRef[] {
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const current = sorted.find((v) => v.is_current);
  const others = sorted.filter((v) => !v.is_current);
  const slots = Math.max(0, keep - (current ? 1 : 0));
  return others.slice(slots);
}

/** Expiry timestamp for an upload, or null when it never expires. */
export function documentExpiry(expiresInDays: number | null, now: Date = new Date()): string | null {
  if (expiresInDays == null) return null;
  return new Date(now.getTime() + expiresInDays * 86_400_000).toISOString();
}

/**
 * Public link of a document on a deployment's URL, e.g.
 * https://x.trycloudflare.com/files/guides/setup.pdf. Null without a URL.
 */
export function publicDocumentUrl(deploymentUrl: string | null | undefined, path: string): string | null {
  if (!deploymentUrl) return null;
  return `${deploymentUrl.replace(/\/+$/, "")}${DOCUMENTS_URL_PREFIX}${path}`;
}
