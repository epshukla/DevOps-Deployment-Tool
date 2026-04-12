import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  decryptSecret,
  verifyWebhookSignature,
  GitHubPushEventSchema,
  extractBranchFromRef,
  matchesBranchFilter,
} from "@deployx/shared";

interface RouteParams {
  readonly params: Promise<{ projectId: string }>;
}

function getEncryptionKey(): string {
  const key = process.env.DEPLOYX_SECRET_KEY;
  if (!key) {
    throw new Error("DEPLOYX_SECRET_KEY environment variable is not set");
  }
  return key;
}

/**
 * POST /api/webhooks/github/[projectId]
 *
 * Receives GitHub webhook events and triggers pipeline runs.
 * Authentication: HMAC-SHA256 signature verification (no user session).
 */
export async function POST(request: Request, { params }: RouteParams) {
  const { projectId } = await params;
  const supabase = createServiceClient();

  // Read raw body for signature verification
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-hub-signature-256");
  const eventType = request.headers.get("x-github-event") ?? "unknown";

  // Fetch webhook config for this project
  const { data: config } = await supabase
    .from("webhook_configs")
    .select("id, project_id, pipeline_definition_id, secret_encrypted, branch_filter, events, is_active, created_by")
    .eq("project_id", projectId)
    .single();

  if (!config) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Verify HMAC signature
  if (!signatureHeader) {
    await logDelivery(supabase, config.id, eventType, null, "rejected", "Missing signature header");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let webhookSecret: string;
  try {
    webhookSecret = decryptSecret(config.secret_encrypted, getEncryptionKey());
  } catch {
    await logDelivery(supabase, config.id, eventType, null, "error", "Failed to decrypt webhook secret");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  if (!verifyWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
    await logDelivery(supabase, config.id, eventType, null, "rejected", "Invalid signature");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Handle ping event (GitHub sends this when webhook is first configured)
  if (eventType === "ping") {
    await logDelivery(supabase, config.id, "ping", null, "success", "Pong");
    return NextResponse.json({ pong: true });
  }

  // Check if webhook is active
  if (!config.is_active) {
    await logDelivery(supabase, config.id, eventType, null, "skipped", "Webhook is disabled");
    return NextResponse.json({ skipped: true, reason: "disabled" });
  }

  // Only process push events for now
  if (eventType !== "push") {
    await logDelivery(supabase, config.id, eventType, null, "skipped", `Event type '${eventType}' not handled`);
    return NextResponse.json({ skipped: true, reason: "event_type" });
  }

  // Parse payload
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    await logDelivery(supabase, config.id, eventType, null, "error", "Invalid JSON payload");
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = GitHubPushEventSchema.safeParse(payload);
  if (!parsed.success) {
    await logDelivery(supabase, config.id, eventType, null, "error", "Invalid push event payload");
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const pushEvent = parsed.data;

  // Ignore branch deletions
  if (pushEvent.deleted) {
    await logDelivery(supabase, config.id, eventType, pushEvent.ref, "skipped", "Branch deletion");
    return NextResponse.json({ skipped: true, reason: "branch_deletion" });
  }

  // Extract branch name
  const branch = extractBranchFromRef(pushEvent.ref);
  if (!branch) {
    await logDelivery(supabase, config.id, eventType, pushEvent.ref, "skipped", "Non-branch ref");
    return NextResponse.json({ skipped: true, reason: "non_branch_ref" });
  }

  // Check branch filter
  if (!matchesBranchFilter(branch, config.branch_filter)) {
    await logDelivery(supabase, config.id, eventType, pushEvent.ref, "skipped", `Branch '${branch}' does not match filter '${config.branch_filter}'`);
    return NextResponse.json({ skipped: true, reason: "branch_filter" });
  }

  // Find pipeline definition
  let pipelineDefinitionId = config.pipeline_definition_id;

  if (!pipelineDefinitionId) {
    // Fall back to the project's first pipeline definition
    const { data: firstPipeline } = await supabase
      .from("pipeline_definitions")
      .select("id, current_version_id")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (!firstPipeline) {
      await logDelivery(supabase, config.id, eventType, pushEvent.ref, "error", "No pipeline configured");
      return NextResponse.json({ error: "No pipeline configured" }, { status: 200 });
    }

    pipelineDefinitionId = firstPipeline.id;
  }

  // Get the current version of the pipeline
  const { data: definition } = await supabase
    .from("pipeline_definitions")
    .select("id, current_version_id")
    .eq("id", pipelineDefinitionId)
    .single();

  if (!definition?.current_version_id) {
    await logDelivery(supabase, config.id, eventType, pushEvent.ref, "error", "Pipeline has no version");
    return NextResponse.json({ error: "Pipeline has no version" }, { status: 200 });
  }

  // Create pipeline run
  const { data: run, error: runError } = await supabase
    .from("pipeline_runs")
    .insert({
      pipeline_definition_id: pipelineDefinitionId,
      pipeline_version_id: definition.current_version_id,
      project_id: projectId,
      status: "created",
      trigger_type: "webhook",
      trigger_ref: pushEvent.ref,
      git_branch: branch,
      git_sha: pushEvent.after,
      created_by: config.created_by,
    })
    .select("id")
    .single();

  if (runError || !run) {
    await logDelivery(supabase, config.id, eventType, pushEvent.ref, "error", "Failed to create pipeline run");
    return NextResponse.json({ error: "Failed to create pipeline run" }, { status: 500 });
  }

  // Transition to queued
  await supabase
    .from("pipeline_runs")
    .update({ status: "queued", updated_at: new Date().toISOString() })
    .eq("id", run.id);

  // Update last_triggered_at
  await supabase
    .from("webhook_configs")
    .update({ last_triggered_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", config.id);

  // Log successful delivery
  await logDelivery(supabase, config.id, eventType, pushEvent.ref, "success", `Triggered run for ${branch}@${pushEvent.after.slice(0, 7)}`, run.id);

  return NextResponse.json({ pipeline_run_id: run.id });
}

/**
 * Logs a webhook delivery attempt for auditing.
 */
async function logDelivery(
  supabase: ReturnType<typeof createServiceClient>,
  webhookConfigId: string,
  eventType: string,
  payloadRef: string | null,
  status: string,
  statusMessage: string,
  pipelineRunId?: string,
): Promise<void> {
  await supabase.from("webhook_deliveries").insert({
    webhook_config_id: webhookConfigId,
    event_type: eventType,
    payload_ref: payloadRef,
    status,
    status_message: statusMessage,
    pipeline_run_id: pipelineRunId ?? null,
  });
}
