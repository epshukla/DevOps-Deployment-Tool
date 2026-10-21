"use server";

import { revalidatePath } from "next/cache";
import { requireUserWithOrg } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import {
  documentExpiry,
  documentStorageKey,
  versionsToPrune,
} from "@/lib/documents";
import {
  CreateDocumentUploadSchema,
  DocumentVisibilitySchema,
  DOCUMENTS_BUCKET,
  DOCUMENT_MAX_VERSIONS,
  hasMinRole,
  type CreateDocumentUploadInput,
} from "@deployx/shared";

interface ActionResult {
  readonly error?: string;
  readonly success?: boolean;
}

interface UploadTicket extends ActionResult {
  readonly documentId?: string;
  readonly storageKey?: string;
  /** Token for supabase.storage.uploadToSignedUrl (a presigned PUT) */
  readonly token?: string;
}

interface UrlResult extends ActionResult {
  readonly url?: string;
}

const NO_PERMISSION = "You need the developer role to manage documents";

async function loadProject(projectId: string) {
  const ctx = await requireUserWithOrg();
  const { data: project } = await ctx.supabase
    .from("projects")
    .select("id, org_id")
    .eq("id", projectId)
    .maybeSingle();
  return { ...ctx, project: project as { id: string; org_id: string } | null };
}

/**
 * Step 1 of an upload: reserve a new version row and hand the browser a
 * signed upload URL, so the file goes straight to object storage.
 */
export async function createDocumentUpload(
  projectId: string,
  input: CreateDocumentUploadInput,
): Promise<UploadTicket> {
  const { supabase, user, role, project } = await loadProject(projectId);
  if (!project) return { error: "Project not found" };
  if (!hasMinRole(role, "developer")) return { error: NO_PERMISSION };

  const parsed = CreateDocumentUploadSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid document" };
  }
  const doc = parsed.data;

  const { data: latest } = await supabase
    .from("project_documents")
    .select("version")
    .eq("project_id", projectId)
    .eq("path", doc.path)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const id = crypto.randomUUID();
  const storageKey = documentStorageKey(project.org_id, projectId, id);

  const { error: insertError } = await supabase.from("project_documents").insert({
    id,
    project_id: projectId,
    org_id: project.org_id,
    path: doc.path,
    version: ((latest?.version as number | undefined) ?? 0) + 1,
    status: "pending",
    is_current: false,
    storage_key: storageKey,
    content_type: doc.content_type || "application/octet-stream",
    size_bytes: doc.size_bytes,
    sha256: doc.sha256,
    visibility: doc.visibility,
    expires_at: documentExpiry(doc.expires_in_days),
    uploaded_by: user.id,
  });
  if (insertError) {
    return {
      error: insertError.code === "23505"
        ? "Another upload of this path is in progress — try again"
        : "Failed to start upload",
    };
  }

  const { data: signed, error: signError } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUploadUrl(storageKey);
  if (signError || !signed?.token) {
    await supabase.from("project_documents").delete().eq("id", id);
    return { error: "Failed to create upload URL" };
  }

  return { success: true, documentId: id, storageKey, token: signed.token };
}

/**
 * Step 2 of an upload: check the object landed with the declared size, make
 * it the current version and prune versions beyond DOCUMENT_MAX_VERSIONS.
 */
export async function finalizeDocumentUpload(
  projectId: string,
  documentId: string,
): Promise<ActionResult> {
  const { supabase, user, role, project } = await loadProject(projectId);
  if (!project) return { error: "Project not found" };
  if (!hasMinRole(role, "developer")) return { error: NO_PERMISSION };

  const { data: doc } = await supabase
    .from("project_documents")
    .select("id, path, version, size_bytes, storage_key, status")
    .eq("id", documentId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (!doc) return { error: "Upload not found" };
  if (doc.status === "ready") return { success: true };

  const folder = `${project.org_id}/${projectId}`;
  const { data: objects } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .list(folder, { search: documentId, limit: 1 });
  const object = objects?.find((o) => o.name === documentId);
  const storedSize = (object?.metadata as { size?: number } | undefined)?.size;
  if (!object || (storedSize != null && storedSize !== doc.size_bytes)) {
    return { error: "Uploaded file is missing or its size doesn't match — upload again" };
  }

  const { error: readyError } = await supabase
    .from("project_documents")
    .update({ status: "ready" })
    .eq("id", documentId);
  if (readyError) return { error: "Failed to save document" };

  const { error: promoteError } = await supabase.rpc("promote_project_document", {
    p_document_id: documentId,
  });
  if (promoteError) return { error: "Failed to publish this version" };

  await pruneOldVersions(supabase, projectId, doc.path as string);

  await recordAuditEvent(supabase, {
    org_id: project.org_id,
    user_id: user.id,
    action: "create",
    resource_type: "document",
    resource_id: documentId,
    details: { path: doc.path, version: doc.version },
  });

  revalidatePath(`/projects/${projectId}`);
  return { success: true };
}

async function pruneOldVersions(
  supabase: Awaited<ReturnType<typeof requireUserWithOrg>>["supabase"],
  projectId: string,
  path: string,
): Promise<void> {
  const { data: versions } = await supabase
    .from("project_documents")
    .select("id, version, is_current, storage_key")
    .eq("project_id", projectId)
    .eq("path", path)
    .eq("status", "ready");

  const prune = versionsToPrune(versions ?? [], DOCUMENT_MAX_VERSIONS);
  if (prune.length === 0) return;

  await supabase.storage.from(DOCUMENTS_BUCKET).remove(prune.map((v) => v.storage_key));
  await supabase.from("project_documents").delete().in("id", prune.map((v) => v.id));
}

/** Delete every version of a path. */
export async function deleteDocument(projectId: string, path: string): Promise<ActionResult> {
  const { supabase, user, role, project } = await loadProject(projectId);
  if (!project) return { error: "Project not found" };
  if (!hasMinRole(role, "developer")) return { error: NO_PERMISSION };

  const { data: versions } = await supabase
    .from("project_documents")
    .select("id, storage_key")
    .eq("project_id", projectId)
    .eq("path", path);
  if (!versions || versions.length === 0) return { error: "Document not found" };

  const { error: storageError } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .remove(versions.map((v) => v.storage_key as string));
  if (storageError) return { error: "Failed to delete the stored file" };

  const { error } = await supabase
    .from("project_documents")
    .delete()
    .eq("project_id", projectId)
    .eq("path", path);
  if (error) return { error: "Failed to delete document" };

  await recordAuditEvent(supabase, {
    org_id: project.org_id,
    user_id: user.id,
    action: "delete",
    resource_type: "document",
    resource_id: versions[0].id as string,
    details: { path, versions: versions.length },
  });

  revalidatePath(`/projects/${projectId}`);
  return { success: true };
}

/** Make an older version the current one again. */
export async function restoreDocumentVersion(
  projectId: string,
  documentId: string,
): Promise<ActionResult> {
  const { supabase, user, role, project } = await loadProject(projectId);
  if (!project) return { error: "Project not found" };
  if (!hasMinRole(role, "developer")) return { error: NO_PERMISSION };

  const { data: doc } = await supabase
    .from("project_documents")
    .select("id, path, version")
    .eq("id", documentId)
    .eq("project_id", projectId)
    .eq("status", "ready")
    .maybeSingle();
  if (!doc) return { error: "Version not found" };

  const { error } = await supabase.rpc("promote_project_document", { p_document_id: documentId });
  if (error) return { error: "Failed to restore version" };

  await recordAuditEvent(supabase, {
    org_id: project.org_id,
    user_id: user.id,
    action: "rollback",
    resource_type: "document",
    resource_id: documentId,
    details: { path: doc.path, version: doc.version },
  });

  revalidatePath(`/projects/${projectId}`);
  return { success: true };
}

/** Public documents are served on the deployment URL; private ones never are. */
export async function setDocumentVisibility(
  projectId: string,
  path: string,
  visibility: string,
): Promise<ActionResult> {
  const { supabase, user, role, project } = await loadProject(projectId);
  if (!project) return { error: "Project not found" };
  if (!hasMinRole(role, "developer")) return { error: NO_PERMISSION };

  const parsed = DocumentVisibilitySchema.safeParse(visibility);
  if (!parsed.success) return { error: "Invalid visibility" };

  const { data, error } = await supabase
    .from("project_documents")
    .update({ visibility: parsed.data })
    .eq("project_id", projectId)
    .eq("path", path)
    .select("id");
  if (error) return { error: "Failed to update visibility" };
  if (!data || data.length === 0) return { error: "Document not found" };

  await recordAuditEvent(supabase, {
    org_id: project.org_id,
    user_id: user.id,
    action: "update",
    resource_type: "document",
    resource_id: data[0].id as string,
    details: { path, visibility: parsed.data },
  });

  revalidatePath(`/projects/${projectId}`);
  return { success: true };
}

/** A 5-minute signed download link (works for private documents too). */
export async function getDocumentDownloadUrl(
  projectId: string,
  documentId: string,
): Promise<UrlResult> {
  const { supabase, project } = await loadProject(projectId);
  if (!project) return { error: "Project not found" };

  const { data: doc } = await supabase
    .from("project_documents")
    .select("storage_key, path")
    .eq("id", documentId)
    .eq("project_id", projectId)
    .eq("status", "ready")
    .maybeSingle();
  if (!doc) return { error: "Document not found" };

  const filename = (doc.path as string).split("/").pop();
  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(doc.storage_key as string, 300, { download: filename });
  if (error || !data?.signedUrl) return { error: "Failed to generate download URL" };

  return { success: true, url: data.signedUrl };
}
