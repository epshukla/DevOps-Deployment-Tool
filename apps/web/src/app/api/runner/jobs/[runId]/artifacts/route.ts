import { NextResponse } from "next/server";
import { authenticateRunner, authorizeRunnerForRun } from "@/lib/auth/runner";
import { UploadArtifactSchema, ARTIFACT_MAX_SIZE_BYTES } from "@deployx/shared";

/**
 * POST /api/runner/jobs/[runId]/artifacts
 * Upload a build artifact to Supabase Storage.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const auth = await authenticateRunner(request);
  if (!auth.ok) return auth.response;
  const { runId } = await params;
  const { runner, supabase } = auth;

  // Only the runner executing this run may attach artifacts to it
  const authz = await authorizeRunnerForRun(supabase, runner, runId, {
    requireClaimedBy: true,
  });
  if (!authz.ok) return authz.response;
  const run = authz.value;

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Content-Type must be multipart/form-data" },
      { status: 400 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Failed to parse form data" },
      { status: 400 },
    );
  }

  const file = formData.get("file") as File | null;
  const filename = (formData.get("filename") as string | null) ?? file?.name;
  const claimedProjectId = formData.get("project_id") as string | null;

  if (!file || !filename) {
    return NextResponse.json(
      { error: "file and filename are required" },
      { status: 400 },
    );
  }

  // The storage path is derived from the run, never from client input
  if (claimedProjectId && claimedProjectId !== run.project_id) {
    return NextResponse.json(
      { error: "project_id does not match the run's project" },
      { status: 400 },
    );
  }
  const projectId = run.project_id;

  if (file.size > ARTIFACT_MAX_SIZE_BYTES) {
    return NextResponse.json(
      { error: `File exceeds maximum size of ${ARTIFACT_MAX_SIZE_BYTES} bytes` },
      { status: 400 },
    );
  }

  const parsed = UploadArtifactSchema.safeParse({
    filename,
    pipeline_run_id: runId,
    project_id: projectId,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const orgId = run.org_id;
  const storagePath = `${orgId}/${projectId}/${runId}/${filename}`;

  const buffer = Buffer.from(await file.arrayBuffer());
  const { error: uploadError } = await supabase.storage
    .from("build-artifacts")
    .upload(storagePath, buffer, {
      contentType: file.type || "application/octet-stream",
      upsert: true,
    });

  if (uploadError) {
    return NextResponse.json(
      { error: `Upload failed: ${uploadError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ path: storagePath }, { status: 201 });
}

/**
 * GET /api/runner/jobs/[runId]/artifacts
 * List artifacts for a pipeline run.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const auth = await authenticateRunner(request);
  if (!auth.ok) return auth.response;
  const { runId } = await params;
  const { runner, supabase } = auth;

  const authz = await authorizeRunnerForRun(supabase, runner, runId, {
    requireClaimedBy: false,
  });
  if (!authz.ok) return authz.response;
  const run = authz.value;

  const prefix = `${run.org_id}/${run.project_id}/${runId}`;

  const { data: files, error } = await supabase.storage
    .from("build-artifacts")
    .list(prefix);

  if (error) {
    return NextResponse.json(
      { error: `Failed to list artifacts: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    artifacts: (files ?? []).map((f) => ({
      name: f.name,
      size: f.metadata?.size ?? null,
      created_at: f.created_at,
      path: `${prefix}/${f.name}`,
    })),
  });
}
