import type { StepConfig, DeployConfig } from "@deployx/shared";
import type { RunnerApiClient, JobPayload } from "../api-client";
import type { LogStreamer } from "../logging/log-streamer";
import { resolveVariables, type VariableContext } from "./variable-resolver";
import { executeStep } from "./step-executor";
import { waitForApproval, type ApprovalOutcome } from "./approval-gate";
import { reportSafe, reportCancelled } from "./status-reporter";
import { executeDeployment } from "./deployment-executor";
import { uploadTaskArtifacts } from "./artifact-uploader";

// ── Types ───────────────────────────────────────────────────────

/** Task config as found in the claimed run's config_json (unvalidated) */
export interface PipelineTaskConfig {
  readonly depends_on?: readonly string[];
  readonly approval_required?: boolean;
  readonly steps?: readonly StepConfig[];
  readonly deploy?: DeployConfig;
  readonly artifacts?: readonly string[];
}

export type TaskOutcome = "success" | "failed" | "cancelled";
type StepOutcome = TaskOutcome;

/** Per-run state shared by every task */
export interface RunContext {
  readonly client: RunnerApiClient;
  readonly job: JobPayload;
  readonly logStreamer: LogStreamer;
  readonly variableContext: VariableContext;
  /** key: "taskName:stepName" → step_run id */
  readonly stepRunMap: ReadonlyMap<string, string>;
  readonly workspacePath: string;
  readonly dockerAvailable: boolean;
  readonly projectSecrets: Record<string, string>;
  /** Aborts when the run is cancelled */
  readonly signal: AbortSignal;
  /** Override APPROVAL_POLL_INTERVAL_MS (tests) */
  readonly approvalPollIntervalMs?: number;
}

export interface TaskSpec {
  readonly name: string;
  readonly config: PipelineTaskConfig | undefined;
  readonly taskRunId: string | undefined;
}

// ── Task execution ─────────────────────────────────────────────────

/**
 * Executes a task: approval gate (if required), steps, artifact upload,
 * deployment. Reports every status transition and never throws.
 */
export async function executeTask(
  run: RunContext,
  task: TaskSpec,
): Promise<TaskOutcome> {
  const steps = task.config?.steps ?? [];

  if (task.config?.approval_required) {
    const gate = await passApprovalGate(run, task);
    if (gate === "rejected") return rejectTask(run, task, steps);
    if (gate === "cancelled") return cancelTask(run, task, steps.map((s) => s.name));
  }

  // Mark task as running
  await reportSafe(run.client, run.job.run_id, {
    scope: "task",
    status: "running",
    task_name: task.name,
    started_at: new Date().toISOString(),
  });

  log(run, task, "info", `[task:${task.name}] Starting (${steps.length} step(s))`);

  try {
    const stepsOutcome = await runSteps(run, task, steps);
    if (stepsOutcome !== "success") return stepsOutcome;
    return await finishTask(run, task);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(run, task, "error", `[task:${task.name}] Unexpected error: ${msg}`);
    await reportTask(run, task, "failed");
    return "failed";
  }
}

async function passApprovalGate(
  run: RunContext,
  task: TaskSpec,
): Promise<ApprovalOutcome> {
  await reportSafe(run.client, run.job.run_id, {
    scope: "task",
    status: "awaiting_approval",
    task_name: task.name,
  });
  log(run, task, "info", `[task:${task.name}] Waiting for approval`);

  const outcome = await waitForApproval({
    client: run.client,
    runId: run.job.run_id,
    taskName: task.name,
    signal: run.signal,
    logStreamer: run.logStreamer,
    taskRunId: task.taskRunId,
    intervalMs: run.approvalPollIntervalMs,
  });

  if (outcome === "approved") {
    log(run, task, "info", `[task:${task.name}] Approved — continuing`);
  }
  return outcome;
}

async function rejectTask(
  run: RunContext,
  task: TaskSpec,
  steps: readonly StepConfig[],
): Promise<TaskOutcome> {
  log(run, task, "error", `[task:${task.name}] Approval rejected by reviewer — skipping ${steps.length} step(s)`);
  await skipSteps(run, task, steps, "approval rejected");
  await reportTask(run, task, "failed");
  return "failed";
}

async function cancelTask(
  run: RunContext,
  task: TaskSpec,
  stepNames: readonly string[],
): Promise<TaskOutcome> {
  log(run, task, "warn", `[task:${task.name}] Cancelled`);
  await reportCancelled(run.client, run.job.run_id, {
    taskName: task.name,
    stepNames,
    includeTask: true,
  });
  return "cancelled";
}

async function runSteps(
  run: RunContext,
  task: TaskSpec,
  steps: readonly StepConfig[],
): Promise<TaskOutcome> {
  for (let i = 0; i < steps.length; i++) {
    const remaining = steps.slice(i).map((s) => s.name);
    // Between steps: don't start new work once the run is cancelled
    if (run.signal.aborted) return cancelTask(run, task, remaining);

    const outcome = await executeStepWithReporting(run, task, steps[i]);
    if (outcome === "cancelled") return cancelTask(run, task, remaining);

    if (outcome === "failed") {
      await skipSteps(run, task, steps.slice(i + 1), "previous step failed");
      await reportTask(run, task, "failed");
      log(run, task, "error", `[task:${task.name}] Failed`);
      return "failed";
    }
  }
  return "success";
}

/**
 * Post-step work: artifact upload, then deployment if configured.
 */
async function finishTask(run: RunContext, task: TaskSpec): Promise<TaskOutcome> {
  const artifacts = task.config?.artifacts ?? [];
  if (artifacts.length > 0) {
    await uploadTaskArtifacts({
      client: run.client,
      runId: run.job.run_id,
      projectId: run.job.project_id,
      workspacePath: run.workspacePath,
      patterns: artifacts,
      logStreamer: run.logStreamer,
      taskName: task.name,
      taskRunId: task.taskRunId,
    });
  }

  const deployConfig = task.config?.deploy;
  if (deployConfig) {
    if (run.signal.aborted) return cancelTask(run, task, []);

    const deployed = await executeDeployment(run, {
      taskName: task.name,
      deployConfig,
      taskRunId: task.taskRunId,
    });
    if (!deployed) {
      await reportTask(run, task, "failed");
      log(run, task, "error", `[task:${task.name}] Deployment failed`);
      return "failed";
    }
  }

  await reportTask(run, task, "success");
  log(run, task, "info", `[task:${task.name}] Completed`);
  return "success";
}

// ── Step execution with reporting ──────────────────────────────────

/**
 * Executes a single step with status reporting. A cancelled step is not
 * reported here — the caller reports it together with the remaining steps.
 */
async function executeStepWithReporting(
  run: RunContext,
  task: TaskSpec,
  step: StepConfig,
): Promise<StepOutcome> {
  const stepRunId = run.stepRunMap.get(`${task.name}:${step.name}`);
  const ids = { task_run_id: task.taskRunId, step_run_id: stepRunId };

  // pending → failed isn't a valid transition, so always go through running
  await reportSafe(run.client, run.job.run_id, {
    scope: "step",
    status: "running",
    task_name: task.name,
    step_name: step.name,
    started_at: new Date().toISOString(),
  });

  // Check if step needs Docker but it's not available
  if (step.image && !run.dockerAvailable) {
    run.logStreamer.push({
      level: "error",
      message: `[step:${step.name}] Docker not available on this runner (required for image: ${step.image})`,
      ...ids,
    });
    await reportStep(run, task, step, "failed");
    return "failed";
  }

  // Resolve variables in the command
  const resolvedCommand = resolveVariables(step.command, run.variableContext);
  run.logStreamer.push({ level: "info", message: `[step:${step.name}] $ ${resolvedCommand}`, ...ids });

  const result = await executeStep({
    command: resolvedCommand,
    cwd: run.workspacePath,
    env: buildStepEnv(step, run.variableContext),
    timeoutSeconds: step.timeout_seconds,
    image: step.image,
    logStreamer: run.logStreamer,
    taskRunId: task.taskRunId,
    stepRunId,
    signal: run.signal,
  });

  if (result.cancelled) {
    run.logStreamer.push({ level: "warn", message: `[step:${step.name}] Cancelled`, ...ids });
    return "cancelled";
  }

  const failure = result.timedOut
    ? `Timed out after ${step.timeout_seconds}s`
    : result.exitCode !== 0 ? `Failed with exit code ${result.exitCode}` : null;

  run.logStreamer.push({
    level: failure ? "error" : "info",
    message: `[step:${step.name}] ${failure ?? "Completed (exit code 0)"}`,
    ...ids,
  });
  await reportStep(run, task, step, failure ? "failed" : "success", result.exitCode);
  return failure ? "failed" : "success";
}

/**
 * Step env overlays process env; values support ${{ }} interpolation.
 */
function buildStepEnv(
  step: StepConfig,
  variableContext: VariableContext,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(step.env ?? {}).map(([key, value]) => [
      key,
      resolveVariables(value, variableContext),
    ]),
  );
}

// ── Reporting helpers ──────────────────────────────────────────────

async function skipSteps(
  run: RunContext,
  task: TaskSpec,
  steps: readonly StepConfig[],
  reason: string,
): Promise<void> {
  for (const step of steps) {
    run.logStreamer.push({
      level: "warn",
      message: `[step:${step.name}] Skipped (${reason})`,
      task_run_id: task.taskRunId,
      step_run_id: run.stepRunMap.get(`${task.name}:${step.name}`),
    });
    await reportStep(run, task, step, "skipped");
  }
}

async function reportStep(
  run: RunContext,
  task: TaskSpec,
  step: StepConfig,
  status: "success" | "failed" | "skipped",
  exitCode?: number,
): Promise<void> {
  await reportSafe(run.client, run.job.run_id, {
    scope: "step",
    status,
    task_name: task.name,
    step_name: step.name,
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    finished_at: new Date().toISOString(),
  });
}

async function reportTask(
  run: RunContext,
  task: TaskSpec,
  status: "success" | "failed",
): Promise<void> {
  await reportSafe(run.client, run.job.run_id, {
    scope: "task",
    status,
    task_name: task.name,
    finished_at: new Date().toISOString(),
  });
}

function log(
  run: RunContext,
  task: TaskSpec,
  level: "info" | "warn" | "error",
  message: string,
): void {
  run.logStreamer.push({ level, message, task_run_id: task.taskRunId });
}
