import type { RunnerApiClient, JobPayload, ClaimedJob } from "../api-client";
import { resolveDAG } from "@deployx/pipeline-engine";
import { createWorkspace, getHeadSha } from "./workspace";
import type { VariableContext } from "./variable-resolver";
import { LogStreamer } from "../logging/log-streamer";
import { checkDocker } from "../docker/docker-client";
import { CancellationWatcher } from "./cancellation-watcher";
import { reportSafe, reportCancelled } from "./status-reporter";
import {
  executeTask,
  type PipelineTaskConfig,
  type RunContext,
  type TaskOutcome,
} from "./task-executor";

export interface PipelineContext {
  readonly client: RunnerApiClient;
  readonly job: JobPayload;
  readonly claimed: ClaimedJob;
  /** Override poll intervals (tests); defaults come from @deployx/shared */
  readonly pollIntervals?: {
    readonly cancelMs?: number;
    readonly approvalMs?: number;
  };
}

type TaskMap = Readonly<Record<string, PipelineTaskConfig>>;

/**
 * Executes a full pipeline run:
 * 1. Clone repo into temp workspace
 * 2. Resolve DAG
 * 3. Walk groups sequentially, tasks in parallel
 * 4. Execute each step via execa with log streaming
 * 5. Handle failures (skip downstream tasks)
 * 6. Watch for cancellation: kill in-flight steps, mark the rest cancelled,
 *    and leave the pipeline status alone (the control plane set it)
 * 7. Always clean up workspace
 */
export async function executePipeline(ctx: PipelineContext): Promise<void> {
  const { client, job, claimed } = ctx;
  const config = claimed.config_json as { tasks?: Record<string, PipelineTaskConfig> } | null;
  const tasks: TaskMap = config?.tasks ?? {};

  if (Object.keys(tasks).length === 0) {
    console.log("No tasks in pipeline — marking as success.");
    await client.reportStatus(job.run_id, {
      scope: "pipeline",
      status: "success",
      finished_at: new Date().toISOString(),
    });
    return;
  }

  // Resolve DAG
  const dag = resolveDAG(tasks);
  console.log(`DAG resolved: ${dag.groups.length} group(s), ${dag.order.length} task(s)`);

  const logStreamer = new LogStreamer({ client, runId: job.run_id });
  const watcher = new CancellationWatcher({
    client,
    runId: job.run_id,
    intervalMs: ctx.pollIntervals?.cancelMs,
  });

  logStreamer.push({
    level: "info",
    message: `Cloning ${job.git_repo_url} (branch: ${job.git_branch})...`,
  });

  let cleanupFn: (() => Promise<void>) | null = null;

  try {
    const workspace = await createWorkspace({
      runId: job.run_id,
      gitRepoUrl: job.git_repo_url,
      gitBranch: job.git_branch,
      gitSha: job.git_sha,
      gitCloneToken: job.git_clone_token,
    });
    cleanupFn = workspace.cleanup;
    logStreamer.push({ level: "info", message: `Workspace ready: ${workspace.path}` });

    watcher.start();
    const run = await prepareRunContext(ctx, logStreamer, workspace.path, watcher.signal);
    const taskRunIds = new Map(claimed.task_runs.map((tr) => [tr.task_name, tr.id] as const));
    const outcomes = await executeGroups(run, { tasks, groups: dag.groups, taskRunIds }, watcher);

    await logStreamer.shutdown();

    // If cancelled, the status was already set by the cancel action — skip reporting
    if (watcher.cancelled) {
      console.log(`Job ${job.run_id} cancelled`);
      return;
    }

    const failed = [...outcomes.values()].some((o) => o !== "success");
    const pipelineStatus = failed ? "failed" : "success";
    await client.reportStatus(job.run_id, {
      scope: "pipeline",
      status: pipelineStatus,
      finished_at: new Date().toISOString(),
    });
    console.log(`Job ${job.run_id} completed: ${pipelineStatus}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStreamer.push({ level: "error", message: `Pipeline failed: ${msg}` });
    await logStreamer.shutdown();

    if (!watcher.cancelled) {
      await reportSafe(client, job.run_id, {
        scope: "pipeline",
        status: "failed",
        finished_at: new Date().toISOString(),
      });
    }

    throw err;
  } finally {
    watcher.stop();
    if (cleanupFn) {
      await cleanupFn().catch((cleanupErr) => {
        console.error(`Workspace cleanup failed: ${cleanupErr}`);
      });
    }
  }
}

// ── Run setup ──────────────────────────────────────────────────────

async function prepareRunContext(
  ctx: PipelineContext,
  logStreamer: LogStreamer,
  workspacePath: string,
  signal: AbortSignal,
): Promise<RunContext> {
  const { client, job, claimed } = ctx;

  // Get the actual HEAD SHA
  const headSha = await getHeadSha(workspacePath);
  const shortSha = headSha.slice(0, 7);
  logStreamer.push({ level: "info", message: `HEAD at ${shortSha}` });

  const projectSecrets = await loadProjectSecrets(client, job.run_id, logStreamer);

  // Build variable context for ${{ }} interpolation
  // Project secrets override process.env (more specific wins)
  const variableContext: VariableContext = {
    git: { sha: headSha, short_sha: shortSha, branch: job.git_branch },
    project: { name: job.project_name, slug: job.project_slug },
    env: { ...process.env, ...projectSecrets } as Record<string, string | undefined>,
  };

  // Lookup map: "taskName:stepName" → step_run id
  const stepRunMap = new Map(
    claimed.task_runs.flatMap((tr) =>
      tr.step_runs.map((sr) => [`${tr.task_name}:${sr.step_name}`, sr.id] as const),
    ),
  );

  return {
    client,
    job,
    logStreamer,
    variableContext,
    stepRunMap,
    workspacePath,
    dockerAvailable: await checkDocker(),
    projectSecrets,
    signal,
    approvalPollIntervalMs: ctx.pollIntervals?.approvalMs,
  };
}

async function loadProjectSecrets(
  client: RunnerApiClient,
  runId: string,
  logStreamer: LogStreamer,
): Promise<Record<string, string>> {
  try {
    const secrets = await client.getSecrets(runId);
    logStreamer.push({
      level: "info",
      message: `Loaded ${Object.keys(secrets).length} project secret(s)`,
    });
    return secrets;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStreamer.push({
      level: "warn",
      message: `Failed to fetch project secrets: ${msg} — continuing without`,
    });
    return {};
  }
}

// ── Group execution ────────────────────────────────────────────────

/**
 * Walks DAG groups sequentially, running each group's tasks in parallel.
 * Returns the outcome of every task that was started or skipped. Once the
 * run is cancelled, no further groups start and every task that never
 * reached a terminal state is reported cancelled.
 */
async function executeGroups(
  run: RunContext,
  plan: {
    readonly tasks: TaskMap;
    readonly groups: readonly (readonly string[])[];
    readonly taskRunIds: ReadonlyMap<string, string>;
  },
  watcher: CancellationWatcher,
): Promise<ReadonlyMap<string, TaskOutcome | "skipped">> {
  const { tasks, groups, taskRunIds } = plan;
  const outcomes = new Map<string, TaskOutcome | "skipped">();

  for (const group of groups) {
    // Check for cancellation before each group
    if (await watcher.check()) break;

    const blocked = (name: string) =>
      (tasks[name]?.depends_on ?? []).some((dep) => {
        const o = outcomes.get(dep);
        return o !== undefined && o !== "success";
      });

    for (const name of group.filter(blocked)) {
      await skipTask(run, name, tasks[name], taskRunIds.get(name));
      outcomes.set(name, "skipped");
    }

    // Tasks in a group run in parallel — an approval wait only blocks its own task
    const runnable = group.filter((name) => !blocked(name));
    const results = await Promise.all(
      runnable.map((name) =>
        executeTask(run, { name, config: tasks[name], taskRunId: taskRunIds.get(name) }),
      ),
    );
    runnable.forEach((name, i) => outcomes.set(name, results[i]));
  }

  if (watcher.cancelled) {
    await cancelUnstartedTasks(run, tasks, groups.flat(), outcomes);
  }
  return outcomes;
}

async function skipTask(
  run: RunContext,
  name: string,
  config: PipelineTaskConfig | undefined,
  taskRunId: string | undefined,
): Promise<void> {
  const finishedAt = new Date().toISOString();
  run.logStreamer.push({
    level: "warn",
    message: `[task:${name}] Skipped (dependency failed)`,
    task_run_id: taskRunId,
  });

  await reportSafe(run.client, run.job.run_id, {
    scope: "task",
    status: "skipped",
    task_name: name,
    finished_at: finishedAt,
  });

  // Skip all steps in this task too
  for (const step of config?.steps ?? []) {
    await reportSafe(run.client, run.job.run_id, {
      scope: "step",
      status: "skipped",
      task_name: name,
      step_name: step.name,
      finished_at: finishedAt,
    });
  }
}

async function cancelUnstartedTasks(
  run: RunContext,
  tasks: TaskMap,
  order: readonly string[],
  outcomes: ReadonlyMap<string, TaskOutcome | "skipped">,
): Promise<void> {
  const unstarted = order.filter((name) => !outcomes.has(name));
  if (unstarted.length === 0) return;

  run.logStreamer.push({
    level: "warn",
    message: `Run cancelled by user — ${unstarted.length} task(s) not started`,
  });

  for (const name of unstarted) {
    await reportCancelled(run.client, run.job.run_id, {
      taskName: name,
      stepNames: (tasks[name]?.steps ?? []).map((s) => s.name),
      includeTask: true,
    });
  }
}
