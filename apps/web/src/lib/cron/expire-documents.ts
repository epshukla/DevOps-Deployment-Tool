import type { SupabaseClient } from "@supabase/supabase-js";
import { DOCUMENTS_BUCKET, DOCUMENT_PENDING_TTL_HOURS } from "@deployx/shared";

export interface ExpireDocumentsResult {
  readonly expired: number;
  readonly abandoned: number;
  readonly error?: string;
}

interface DocumentRow {
  readonly id: string;
  readonly project_id: string;
  readonly path: string;
  readonly storage_key: string;
}

/**
 * Document lifecycle rules, run by the platform tick:
 *
 * 1. A path whose current version has passed its expiry is removed with all
 *    of its versions (runners drop it from their object store on next sync).
 * 2. Uploads that were started but never finalized within
 *    DOCUMENT_PENDING_TTL_HOURS are removed.
 */
export async function expireDocuments(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<ExpireDocumentsResult> {
  const { data: expiredCurrent, error } = await supabase
    .from("project_documents")
    .select("id, project_id, path, storage_key")
    .eq("is_current", true)
    .lte("expires_at", now.toISOString())
    .limit(200);
  if (error) return { expired: 0, abandoned: 0, error: error.message };

  let expired = 0;
  for (const doc of (expiredCurrent ?? []) as DocumentRow[]) {
    const { data: versions } = await supabase
      .from("project_documents")
      .select("id, project_id, path, storage_key")
      .eq("project_id", doc.project_id)
      .eq("path", doc.path);
    const rows = (versions ?? []) as DocumentRow[];
    if (await removeDocuments(supabase, rows.length > 0 ? rows : [doc])) expired++;
  }

  const pendingCutoff = new Date(now.getTime() - DOCUMENT_PENDING_TTL_HOURS * 3_600_000);
  const { data: pending } = await supabase
    .from("project_documents")
    .select("id, project_id, path, storage_key")
    .eq("status", "pending")
    .lte("created_at", pendingCutoff.toISOString())
    .limit(200);
  const abandonedRows = (pending ?? []) as DocumentRow[];
  const abandoned = abandonedRows.length > 0 && (await removeDocuments(supabase, abandonedRows))
    ? abandonedRows.length
    : 0;

  return { expired, abandoned };
}

async function removeDocuments(
  supabase: SupabaseClient,
  rows: readonly DocumentRow[],
): Promise<boolean> {
  // Objects first: a row without an object is harmless, the reverse leaks storage
  const { error: storageError } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .remove(rows.map((r) => r.storage_key));
  if (storageError) return false;

  const { error } = await supabase
    .from("project_documents")
    .delete()
    .in("id", rows.map((r) => r.id));
  return !error;
}
