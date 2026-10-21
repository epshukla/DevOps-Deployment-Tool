import { NextResponse } from "next/server";
import {
  DOCUMENTS_BUCKET,
  DOCUMENT_MANIFEST_URL_TTL_SECONDS,
  type DocumentManifest,
  type DocumentManifestEntry,
} from "@deployx/shared";
import {
  authenticateRunner,
  authorizeRunnerForDeploymentProject,
} from "@/lib/auth/runner";

interface RouteParams {
  readonly params: Promise<{ deploymentId: string }>;
}

interface DocumentRow {
  readonly path: string;
  readonly storage_key: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly content_type: string;
}

/**
 * GET /api/runner/deployments/[deploymentId]/documents
 *
 * The manifest of documents a runner should serve on this deployment's URL:
 * current, finalized, unexpired, public versions, each with a short-lived
 * signed download URL. The runner mirrors exactly this set into its object
 * store (adds what's new or changed, removes what's gone).
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { deploymentId } = await params;
  const auth = await authenticateRunner(request);
  if (!auth.ok) return auth.response;
  const { runner, supabase } = auth;

  const authz = await authorizeRunnerForDeploymentProject(supabase, runner, deploymentId);
  if (!authz.ok) return authz.response;
  const { projectId, projectSlug } = authz.value;

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("project_documents")
    .select("path, storage_key, sha256, size_bytes, content_type")
    .eq("project_id", projectId)
    .eq("is_current", true)
    .eq("status", "ready")
    .eq("visibility", "public")
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order("path", { ascending: true })
    .limit(1000);

  if (error) {
    return NextResponse.json({ error: "Failed to load documents" }, { status: 500 });
  }

  const rows = (data ?? []) as DocumentRow[];
  let documents: DocumentManifestEntry[] = [];

  if (rows.length > 0) {
    const { data: signed, error: signError } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .createSignedUrls(
        rows.map((r) => r.storage_key),
        DOCUMENT_MANIFEST_URL_TTL_SECONDS,
      );
    if (signError || !signed) {
      return NextResponse.json({ error: "Failed to sign document URLs" }, { status: 500 });
    }

    const urlByKey = new Map(
      signed
        .filter((s) => s.signedUrl && s.path)
        .map((s) => [s.path as string, s.signedUrl]),
    );
    documents = rows.flatMap((r) => {
      const url = urlByKey.get(r.storage_key);
      return url
        ? [{
            path: r.path,
            sha256: r.sha256,
            size_bytes: Number(r.size_bytes),
            content_type: r.content_type,
            url,
          }]
        : [];
    });
  }

  const manifest: DocumentManifest = { project_slug: projectSlug, documents };
  return NextResponse.json(manifest);
}
