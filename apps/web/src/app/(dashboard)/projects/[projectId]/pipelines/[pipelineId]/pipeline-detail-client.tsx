"use client";

import Link from "next/link";
import { StatusBadge } from "@/components/ui/status-badge";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { TriggerPipelineButton } from "@/components/projects/trigger-pipeline-button";
import type { RunnerOption } from "@/lib/runner-options";
import { formatDate, formatDateShort } from "@/lib/format-date";
import { hasMinRole } from "@deployx/shared";
import { tryParsePipelineYaml } from "@deployx/pipeline-engine";
import {
  updatePipelineDefinitionVersion,
  restorePipelineVersion,
} from "../actions";

interface ProjectData {
  readonly id: string;
  readonly name: string;
}

interface DefinitionData {
  readonly id: string;
  readonly name: string;
  readonly current_version_id: string | null;
  readonly project_id: string;
}

interface VersionData {
  readonly id: string;
  readonly version: number;
  readonly created_at: string;
  readonly created_by: string;
  readonly created_by_name: string | null;
  readonly yaml_source: string;
}

interface RunData {
  readonly id: string;
  readonly status: string;
  readonly trigger_type: string;
  readonly git_branch: string | null;
  readonly git_sha: string | null;
  readonly duration_ms: number | null;
  readonly created_at: string;
}

interface PipelineDetailClientProps {
  readonly project: ProjectData;
  readonly definition: DefinitionData;
  readonly versions: readonly VersionData[];
  readonly recentRuns: readonly RunData[];
  readonly currentRole: string;
  readonly runners: readonly RunnerOption[];
}


export function PipelineDetailClient({
  project,
  definition,
  versions,
  recentRuns,
  currentRole,
  runners,
}: PipelineDetailClientProps) {
  const router = useRouter();
  const canEdit = hasMinRole(currentRole, "developer");

  // `null` means "show whatever is current" — this way, once a save or
  // restore makes a new version current, the view follows it automatically
  // without needing an effect to resync from props after a router.refresh().
  const [manualVersionId, setManualVersionId] = useState<string | null>(null);
  const effectiveVersionId = manualVersionId ?? definition.current_version_id ?? versions[0]?.id ?? null;
  const selectedVersion =
    versions.find((v) => v.id === effectiveVersionId) ?? versions[0] ?? null;

  const [isEditing, setIsEditing] = useState(false);
  const [yamlDraft, setYamlDraft] = useState("");
  const [yamlPreview, setYamlPreview] = useState<string | null>(null);

  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [isRestoring, startRestoreTransition] = useTransition();

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveFieldError, setSaveFieldError] = useState<string | null>(null);
  // Saving is only offered for YAML that parses and validates
  const [yamlValid, setYamlValid] = useState(true);
  const [isSaving, startSaveTransition] = useTransition();

  const handleStartEdit = () => {
    setYamlDraft(selectedVersion?.yaml_source ?? "");
    setYamlPreview(null);
    setIsEditing(true);
  };

  const handleYamlChange = (value: string) => {
    setYamlDraft(value);
    if (!value.trim()) {
      setYamlPreview(null);
      setYamlValid(false);
      return;
    }
    const result = tryParsePipelineYaml(value);
    setYamlValid(result.success);
    setYamlPreview(
      result.success
        ? `Valid — ${Object.keys(result.data.tasks).length} task(s)`
        : result.error,
    );
  };

  const handleRestore = (versionId: string) => {
    setRestoreError(null);
    startRestoreTransition(async () => {
      const result = await restorePipelineVersion(project.id, definition.id, versionId);
      if (result.error) {
        setRestoreError(result.error);
      } else {
        setManualVersionId(null);
        router.refresh();
      }
    });
  };

  const handleSave = (formData: FormData) => {
    setSaveError(null);
    setSaveFieldError(null);
    startSaveTransition(async () => {
      const result = await updatePipelineDefinitionVersion(
        project.id,
        definition.id,
        {},
        formData,
      );
      if (result.error) {
        setSaveError(result.error);
      } else if (result.fieldErrors?.yaml_source) {
        setSaveFieldError(result.fieldErrors.yaml_source[0]);
      } else if (result.success) {
        setIsEditing(false);
        setManualVersionId(null);
        router.refresh();
      }
    });
  };

  return (
    <>
      <TopBar
        breadcrumbs={[
          { label: "Projects", href: "/projects" },
          { label: project.name, href: `/projects/${project.id}` },
          { label: "Pipelines", href: `/projects/${project.id}/pipelines` },
          { label: definition.name },
        ]}
      />
      <div className="px-4 py-6 md:px-6 max-w-[1400px] mx-auto">
        <div className="relative z-20 flex items-end justify-between mb-8">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-on-surface">
              {definition.name}
            </h2>
            <p className="text-on-surface-variant text-sm mt-1">
              {selectedVersion
                ? `Viewing version ${selectedVersion.version}${
                    selectedVersion.id === definition.current_version_id ? " (current)" : ""
                  }`
                : "No versions yet"}
            </p>
          </div>
          <div className="flex gap-3">
            <TriggerPipelineButton
              projectId={project.id}
              pipelines={[definition]}
              runners={runners}
              label="Run Pipeline"
            />
            {!isEditing && (
              <button
                onClick={handleStartEdit}
                disabled={!canEdit}
                title={canEdit ? undefined : "You have the viewer role — read-only access"}
                className="px-4 py-2.5 border border-outline-variant/30 hover:bg-surface-container-highest text-on-surface font-bold rounded-md transition-all flex items-center gap-2 text-sm disabled:opacity-50"
              >
                <span aria-hidden="true" className="material-symbols-outlined text-sm">edit</span>
                Edit
              </button>
            )}
          </div>
        </div>

        {restoreError && (
          <div className="mb-4 bg-error/10 border border-error/30 rounded-md p-3 text-xs text-error">
            {restoreError}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Version History Sidebar */}
          <div className="lg:col-span-3">
            <div className="bg-surface-container-low rounded-lg p-4 border border-outline-variant">
              <h3 className="text-xs font-bold text-on-surface-variant mb-3 px-1">
                Version History
              </h3>
              {versions.length === 0 ? (
                <p className="text-xs text-on-surface-variant/60 px-1">No versions yet</p>
              ) : (
                <div className="space-y-1">
                  {versions.map((v) => {
                    const isCurrent = v.id === definition.current_version_id;
                    const isSelected = v.id === selectedVersion?.id;
                    return (
                      <div key={v.id}>
                        <button
                          onClick={() => {
                            setManualVersionId(v.id);
                            setIsEditing(false);
                          }}
                          className={`w-full text-left px-3 py-2 rounded-md transition-colors ${
                            isSelected
                              ? "bg-primary/10 ring-1 ring-primary/20"
                              : "hover:bg-surface-container-high"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-bold text-on-surface">
                              v{v.version}
                            </span>
                            {isCurrent && (
                              <span className="text-[11px] font-bold uppercase text-tertiary bg-tertiary/10 px-1.5 py-0.5 rounded-sm">
                                Current
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-on-surface-variant mt-0.5">
                            {formatDateShort(v.created_at)}
                            {v.created_by_name ? ` by ${v.created_by_name}` : ""}
                          </p>
                        </button>
                        {!isCurrent && canEdit && (
                          <button
                            onClick={() => handleRestore(v.id)}
                            disabled={isRestoring}
                            className="w-full text-left px-3 py-1 text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
                          >
                            Restore this version
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* YAML / Editor */}
          <div className="lg:col-span-9 space-y-6">
            <div className="bg-surface-container rounded-lg overflow-hidden shadow-xl border border-outline-variant/10">
              <div className="px-6 py-3 border-b border-outline-variant/10 flex items-center justify-between">
                <h3 className="text-xs font-bold text-on-surface-variant">
                  {isEditing ? "Edit YAML — saves as a new version" : "Pipeline YAML"}
                </h3>
                {isEditing && (
                  <button
                    onClick={() => setIsEditing(false)}
                    className="text-xs text-on-surface-variant hover:text-on-surface transition-colors"
                  >
                    Cancel
                  </button>
                )}
              </div>

              {isEditing ? (
                <form action={handleSave} className="p-6 space-y-4">
                  {saveError && (
                    <div className="bg-error/10 border border-error/30 rounded-md p-3 text-xs text-error">
                      {saveError}
                    </div>
                  )}
                  <textarea
                    name="yaml_source"
                    required
                    rows={20}
                    value={yamlDraft}
                    onChange={(e) => handleYamlChange(e.target.value)}
                    className="w-full bg-surface-container-lowest border-none rounded-md px-4 py-3 text-sm text-on-surface focus:ring-2 focus:ring-primary transition-all font-mono leading-relaxed resize-y"
                    spellCheck={false}
                  />
                  {yamlPreview && (
                    <p
                      className={`text-xs ${
                        yamlPreview.startsWith("Valid") ? "text-tertiary" : "text-error"
                      }`}
                    >
                      {yamlPreview}
                    </p>
                  )}
                  {saveFieldError && (
                    <p className="text-xs text-error whitespace-pre-wrap">{saveFieldError}</p>
                  )}
                  <div className="flex justify-end gap-3">
                    <button
                      type="submit"
                      disabled={isSaving || !yamlValid}
                      className="px-5 py-2 bg-primary text-on-primary text-sm font-bold rounded-md hover:bg-primary-container active:scale-95 disabled:opacity-50 transition-all flex items-center gap-2"
                    >
                      {isSaving && (
                        <span aria-hidden="true" className="material-symbols-outlined text-sm animate-spin">
                          progress_activity
                        </span>
                      )}
                      {isSaving ? "Saving..." : "Save as New Version"}
                    </button>
                  </div>
                </form>
              ) : (
                <pre className="p-6 text-sm font-mono leading-relaxed text-on-surface overflow-auto max-h-[600px] whitespace-pre-wrap">
                  {selectedVersion?.yaml_source ?? "No YAML available"}
                </pre>
              )}
            </div>

            {/* Recent Runs */}
            <div className="bg-surface-container-low rounded-lg border border-outline-variant overflow-hidden">
              <div className="px-6 py-4 border-b border-outline-variant/10">
                <h3 className="text-xs font-bold text-on-surface-variant">
                  Recent Runs
                </h3>
              </div>
              {recentRuns.length === 0 ? (
                <div className="px-6 py-8 text-center text-sm text-on-surface-variant">
                  No runs yet for this pipeline
                </div>
              ) : (
                <div>
                  {recentRuns.map((run) => {
                    return (
                      <Link
                        key={run.id}
                        href={`/projects/${project.id}/runs/${run.id}`}
                        className="flex items-center justify-between px-6 py-3 border-b border-outline-variant/5 last:border-0 hover:bg-surface-container-high/50 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <StatusBadge status={run.status} />
                          <span className="text-xs text-on-surface-variant">
                            {run.git_branch ?? "—"}
                          </span>
                          {run.git_sha && (
                            <span className="text-xs font-mono text-primary">
                              {run.git_sha.slice(0, 7)}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-on-surface-variant">
                          {formatDate(run.created_at)}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
