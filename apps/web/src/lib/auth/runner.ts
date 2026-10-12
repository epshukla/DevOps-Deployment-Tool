import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { RunnerRegistration } from "@deployx/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Hash a token using SHA-256 for storage/lookup.
 * Tokens are stored as hashes in runner_registrations.token_hash.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Generate a cryptographically secure registration token.
 * Returns both the plaintext (shown to user once) and the hash (stored in DB).
 */
export function generateToken(): { readonly token: string; readonly hash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, hash: hashToken(token) };
}

/**
 * Authenticate an incoming request from a runner.
 * Extracts Bearer token from Authorization header, hashes it,
 * and looks up the runner in runner_registrations.
 *
 * Returns the runner record and a service-role Supabase client.
 * Returns a NextResponse error if authentication fails.
 */
export async function authenticateRunner(
  request: Request,
): Promise<
  | { readonly ok: true; readonly runner: RunnerRegistration; readonly supabase: SupabaseClient }
  | { readonly ok: false; readonly response: NextResponse }
> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Missing or invalid Authorization header" },
        { status: 401 },
      ),
    };
  }

  const token = authHeader.slice(7);
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Empty bearer token" },
        { status: 401 },
      ),
    };
  }

  const tokenHash = hashToken(token);
  const supabase = createServiceClient();

  const { data: runner, error } = await supabase
    .from("runner_registrations")
    .select("*")
    .eq("token_hash", tokenHash)
    .single();

  if (error || !runner) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid runner token" },
        { status: 401 },
      ),
    };
  }

  return { ok: true, runner: runner as RunnerRegistration, supabase };
}

// ── Resource authorization ──────────────────────────────────────

export interface AuthorizedRun {
  readonly id: string;
  readonly project_id: string;
  readonly org_id: string;
  readonly runner_id: string | null;
  readonly status: string;
}

type AuthorizeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: NextResponse };

function notFound(what: string): { ok: false; response: NextResponse } {
  return {
    ok: false,
    response: NextResponse.json({ error: `${what} not found` }, { status: 404 }),
  };
}

/**
 * Load a pipeline run on behalf of a runner, enforcing tenancy.
 *
 * - The run's project must belong to the runner's org. A run in another org
 *   is reported as 404 (not 403) so tokens can't probe for run ids.
 * - With `requireClaimedBy`, only the runner that claimed the run may act on
 *   it (status reports, logs, secrets, artifacts…).
 */
export async function authorizeRunnerForRun(
  supabase: SupabaseClient,
  runner: Pick<RunnerRegistration, "id" | "org_id">,
  runId: string,
  options: { readonly requireClaimedBy: boolean },
): Promise<AuthorizeResult<AuthorizedRun>> {
  const { data: run } = await supabase
    .from("pipeline_runs")
    .select("id, project_id, runner_id, status, projects!inner(org_id)")
    .eq("id", runId)
    .maybeSingle();

  const orgId = (run?.projects as unknown as { org_id: string } | null)?.org_id;
  if (!run || orgId !== runner.org_id) {
    return notFound("Pipeline run");
  }

  if (options.requireClaimedBy && run.runner_id !== runner.id) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "This run is assigned to a different runner" },
        { status: 403 },
      ),
    };
  }

  return {
    ok: true,
    value: {
      id: run.id as string,
      project_id: run.project_id as string,
      org_id: orgId,
      runner_id: (run.runner_id as string | null) ?? null,
      status: run.status as string,
    },
  };
}

/**
 * Load a deployment on behalf of a runner: the run must be in the runner's
 * org and the deployment must belong to the same project as the run.
 * Org-level (not claim-level) because the health monitor keeps reporting on
 * deployments long after the run that created them has finished.
 */
export async function authorizeRunnerForDeployment(
  supabase: SupabaseClient,
  runner: Pick<RunnerRegistration, "id" | "org_id">,
  runId: string,
  deploymentId: string,
): Promise<AuthorizeResult<{ readonly run: AuthorizedRun; readonly projectId: string }>> {
  const runResult = await authorizeRunnerForRun(supabase, runner, runId, {
    requireClaimedBy: false,
  });
  if (!runResult.ok) return runResult;

  const { data: deployment } = await supabase
    .from("deployments")
    .select("id, project_id")
    .eq("id", deploymentId)
    .maybeSingle();

  if (!deployment || deployment.project_id !== runResult.value.project_id) {
    return notFound("Deployment");
  }

  return {
    ok: true,
    value: { run: runResult.value, projectId: deployment.project_id as string },
  };
}
