import { readFile, realpath, stat } from "node:fs/promises";
import { basename, sep } from "node:path";
import { glob } from "tinyglobby";
import {
  ARTIFACT_ALLOWED_EXTENSIONS,
  ARTIFACT_MAX_FILES_PER_TASK,
  ARTIFACT_MAX_SIZE_BYTES,
  isSafeArtifactPattern,
} from "@deployx/shared";
import type { RunnerApiClient } from "../api-client";
import type { LogStreamer } from "../logging/log-streamer";

export interface UploadArtifactsOptions {
  readonly client: RunnerApiClient;
  readonly runId: string;
  readonly projectId: string;
  readonly workspacePath: string;
  /** Workspace-relative paths/globs from the task's `artifacts` config */
  readonly patterns: readonly string[];
  readonly logStreamer: LogStreamer;
  readonly taskName: string;
  readonly taskRunId?: string;
}

export interface UploadSummary {
  readonly uploaded: number;
  readonly failed: number;
  readonly skipped: number;
}

interface ArtifactFile {
  readonly path: string;
  readonly filename: string;
}

/**
 * Uploads the files matched by a task's artifact patterns. Files must
 * resolve (after following symlinks) inside the workspace, have an allowed
 * extension and fit the size limit. Per-file failures are logged and
 * skipped — artifact upload never fails the task. Never throws.
 */
export async function uploadTaskArtifacts(
  options: UploadArtifactsOptions,
): Promise<UploadSummary> {
  const log = (level: "info" | "warn" | "error", message: string) =>
    options.logStreamer.push({
      level,
      message: `[artifacts:${options.taskName}] ${message}`,
      task_run_id: options.taskRunId,
    });

  try {
    const workspaceRoot = await realpath(options.workspacePath);
    const { files, skipped } = await collectArtifactFiles(workspaceRoot, options.patterns, log);

    let uploaded = 0;
    for (const file of files) {
      if (await uploadOne(options, file, log)) uploaded++;
    }

    const failed = files.length - uploaded;
    log(failed > 0 ? "warn" : "info", `Uploaded ${uploaded}/${files.length} artifact(s)${skipped ? `, skipped ${skipped}` : ""}`);
    return { uploaded, failed, skipped };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `Artifact upload aborted: ${msg}`);
    return { uploaded: 0, failed: 0, skipped: 0 };
  }
}

/**
 * Expands patterns into a de-duplicated list of uploadable files.
 */
async function collectArtifactFiles(
  workspaceRoot: string,
  patterns: readonly string[],
  log: (level: "info" | "warn" | "error", message: string) => void,
): Promise<{ readonly files: readonly ArtifactFile[]; readonly skipped: number }> {
  const files: ArtifactFile[] = [];
  const seenPaths = new Set<string>();
  const seenNames = new Set<string>();
  let skipped = 0;

  for (const pattern of patterns) {
    if (!isSafeArtifactPattern(pattern)) {
      log("warn", `Ignoring pattern "${pattern}" (must be workspace-relative, no '..')`);
      continue;
    }

    const matches = await glob(pattern, {
      cwd: workspaceRoot,
      absolute: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      expandDirectories: false,
    });
    if (matches.length === 0) log("warn", `No files matched "${pattern}"`);

    for (const match of matches) {
      const verdict = await checkFile(workspaceRoot, match, seenPaths, seenNames, files.length);
      if (verdict.ok) {
        files.push(verdict.file);
        seenPaths.add(verdict.file.path);
        seenNames.add(verdict.file.filename);
      } else if (verdict.reason) {
        log("warn", `Skipping ${match}: ${verdict.reason}`);
        skipped++;
      }
    }
  }

  return { files, skipped };
}

type FileVerdict =
  | { readonly ok: true; readonly file: ArtifactFile }
  | { readonly ok: false; readonly reason: string | null };

async function checkFile(
  workspaceRoot: string,
  match: string,
  seenPaths: ReadonlySet<string>,
  seenNames: ReadonlySet<string>,
  acceptedCount: number,
): Promise<FileVerdict> {
  try {
    return await evaluateFile(workspaceRoot, match, seenPaths, seenNames, acceptedCount);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `cannot read file: ${msg}` };
  }
}

async function evaluateFile(
  workspaceRoot: string,
  match: string,
  seenPaths: ReadonlySet<string>,
  seenNames: ReadonlySet<string>,
  acceptedCount: number,
): Promise<FileVerdict> {
  // Resolve symlinks and refuse anything that lands outside the workspace
  const resolved = await realpath(match);
  if (!resolved.startsWith(workspaceRoot + sep)) {
    return { ok: false, reason: "resolves outside the workspace" };
  }
  if (seenPaths.has(resolved)) return { ok: false, reason: null };

  const filename = basename(resolved);
  if (!ARTIFACT_ALLOWED_EXTENSIONS.some((ext) => filename.toLowerCase().endsWith(ext))) {
    return { ok: false, reason: `extension not allowed (${ARTIFACT_ALLOWED_EXTENSIONS.join(", ")})` };
  }
  if (seenNames.has(filename)) {
    return { ok: false, reason: `another artifact named ${filename} was already selected` };
  }

  const stats = await stat(resolved);
  if (!stats.isFile()) return { ok: false, reason: "not a regular file" };
  if (stats.size > ARTIFACT_MAX_SIZE_BYTES) {
    return { ok: false, reason: `${stats.size} bytes exceeds the ${ARTIFACT_MAX_SIZE_BYTES}-byte limit` };
  }
  if (acceptedCount >= ARTIFACT_MAX_FILES_PER_TASK) {
    return { ok: false, reason: `per-task limit of ${ARTIFACT_MAX_FILES_PER_TASK} files reached` };
  }

  return { ok: true, file: { path: resolved, filename } };
}

async function uploadOne(
  options: UploadArtifactsOptions,
  file: ArtifactFile,
  log: (level: "info" | "warn" | "error", message: string) => void,
): Promise<boolean> {
  try {
    const content = await readFile(file.path);
    const { path } = await options.client.uploadArtifact(options.runId, {
      projectId: options.projectId,
      filename: file.filename,
      content,
    });
    log("info", `Uploaded ${file.filename} (${content.length} bytes) → ${path}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", `Failed to upload ${file.filename}: ${msg}`);
    return false;
  }
}
