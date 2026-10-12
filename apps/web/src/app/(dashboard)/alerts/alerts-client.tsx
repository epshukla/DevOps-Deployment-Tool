"use client";

import { useState, useActionState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/top-bar";
import {
  createAlertRule,
  updateAlertRule,
  toggleAlertRule,
  deleteAlertRule,
} from "./actions";
import { hasMinRole } from "@deployx/shared";
import { formatDate } from "@/lib/format-date";

interface AlertRuleData {
  readonly id: string;
  readonly name: string;
  readonly metric: string;
  readonly operator: string;
  readonly threshold: number;
  readonly severity: string;
  readonly is_active: boolean;
  readonly cooldown_minutes: number;
  readonly project_id: string | null;
  readonly last_triggered_at: string | null;
  readonly created_at: string;
}

interface ProjectRef {
  readonly id: string;
  readonly name: string;
}

interface AlertsClientProps {
  readonly alertRules: readonly AlertRuleData[];
  readonly projects: readonly ProjectRef[];
  readonly currentRole: string;
}

const SEVERITY_BADGE: Record<string, string> = {
  info: "bg-info/10 text-info",
  warning: "bg-warning/10 text-warning",
  critical: "bg-error/10 text-error",
};

const METRIC_LABEL: Record<string, string> = {
  success_rate: "Success rate (%)",
  avg_duration_ms: "Avg duration (ms)",
  health_check_failure_rate: "Health check failure rate (%)",
  deployment_health: "Unhealthy deployments",
};

const OPERATOR_LABEL: Record<string, string> = {
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
  eq: "=",
};

export function AlertsClient({
  alertRules,
  projects,
  currentRole,
}: AlertsClientProps) {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const isAdmin = hasMinRole(currentRole, "admin");
  const projectName = new Map(projects.map((p) => [p.id, p.name]));

  function runRuleAction(action: (id: string) => Promise<{ error?: string }>, ruleId: string) {
    setActionError(null);
    startTransition(async () => {
      const result = await action(ruleId);
      if (result.error) setActionError(result.error);
      router.refresh();
    });
  }

  // Two-click delete: first click arms, second click (within the row) deletes
  function handleDelete(rule: AlertRuleData) {
    if (confirmDeleteId !== rule.id) {
      setConfirmDeleteId(rule.id);
      return;
    }
    setConfirmDeleteId(null);
    runRuleAction(deleteAlertRule, rule.id);
  }

  return (
    <>
      <TopBar breadcrumbs={[{ label: "Alerts" }]} />

      <div className="px-4 py-6 md:px-6 max-w-[1400px] mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold text-on-surface">Alert Rules</h2>
            <p className="text-sm text-on-surface-variant/60 mt-1">
              Configure threshold-based alerts for your pipelines and deployments
            </p>
          </div>
          {isAdmin && (
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-lg">add</span>
              Create Rule
            </button>
          )}
        </div>

        {showCreateForm && (
          <AlertRuleForm
            title="New Alert Rule"
            submitLabel="Create"
            action={createAlertRule}
            projects={projects}
            onDone={() => setShowCreateForm(false)}
          />
        )}

        {actionError && (
          <p className="text-error text-sm mb-4">{actionError}</p>
        )}

        {alertRules.length === 0 ? (
          <div className="border border-outline-variant/10 rounded-lg p-12 text-center">
            <span aria-hidden="true" className="material-symbols-outlined text-4xl text-on-surface-variant/30 mb-3 block">
              notifications_active
            </span>
            <p className="text-on-surface-variant/50 text-sm">
              No alert rules configured
            </p>
            <p className="text-on-surface-variant/30 text-xs mt-1">
              Create alert rules to get notified when metrics cross thresholds
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {alertRules.map((rule) => (
              <div key={rule.id}>
              <div
                className={`border border-outline-variant/10 rounded-lg p-4 flex items-center gap-4 ${
                  !rule.is_active ? "opacity-50" : ""
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-on-surface">
                      {rule.name}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-semibold uppercase ${
                        SEVERITY_BADGE[rule.severity] ?? SEVERITY_BADGE.info
                      }`}
                    >
                      {rule.severity}
                    </span>
                  </div>
                  <p className="text-xs text-on-surface-variant/60">
                    {METRIC_LABEL[rule.metric] ?? rule.metric}{" "}
                    {OPERATOR_LABEL[rule.operator] ?? rule.operator}{" "}
                    {rule.threshold}
                    <span className="ml-2 text-on-surface-variant/40">
                      ·{" "}
                      {rule.project_id
                        ? (projectName.get(rule.project_id) ?? "Unknown project")
                        : "All projects"}{" "}
                      · cooldown {rule.cooldown_minutes}m
                    </span>
                    {rule.last_triggered_at && (
                      <span className="ml-2 text-on-surface-variant/40">
                        Last triggered:{" "}
                        {formatDate(rule.last_triggered_at)}
                      </span>
                    )}
                  </p>
                </div>
                {isAdmin && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() =>
                        setEditingRuleId(editingRuleId === rule.id ? null : rule.id)
                      }
                      disabled={isPending}
                      className="p-1.5 hover:bg-surface-container-high rounded-md transition-colors"
                      title="Edit"
                    >
                      <span aria-hidden="true" className="material-symbols-outlined text-lg text-on-surface-variant/60">
                        edit
                      </span>
                    </button>
                    <button
                      onClick={() => runRuleAction(toggleAlertRule, rule.id)}
                      disabled={isPending}
                      className="p-1.5 hover:bg-surface-container-high rounded-md transition-colors"
                      title={rule.is_active ? "Disable" : "Enable"}
                    >
                      <span aria-hidden="true" className="material-symbols-outlined text-lg text-on-surface-variant/60">
                        {rule.is_active ? "toggle_on" : "toggle_off"}
                      </span>
                    </button>
                    <button
                      onClick={() => handleDelete(rule)}
                      onBlur={() => setConfirmDeleteId(null)}
                      disabled={isPending}
                      className={`p-1.5 rounded-md transition-colors flex items-center gap-1 ${
                        confirmDeleteId === rule.id
                          ? "bg-error/15 text-error"
                          : "hover:bg-error/10"
                      }`}
                      title={confirmDeleteId === rule.id ? "Click again to delete" : "Delete"}
                    >
                      <span aria-hidden="true" className="material-symbols-outlined text-lg text-error/60">
                        delete
                      </span>
                      {confirmDeleteId === rule.id && (
                        <span className="text-xs font-semibold">Confirm</span>
                      )}
                    </button>
                  </div>
                )}
              </div>
              {editingRuleId === rule.id && (
                <AlertRuleForm
                  title={`Edit "${rule.name}"`}
                  submitLabel="Save"
                  action={updateAlertRule.bind(null, rule.id)}
                  projects={projects}
                  initial={rule}
                  onDone={() => setEditingRuleId(null)}
                />
              )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ── Create / edit form ──

interface AlertFormState {
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
  readonly success?: boolean;
}

const INPUT_CLASS =
  "w-full bg-surface-container-low border border-outline-variant/20 rounded-md px-3 py-2 text-sm text-on-surface";

function FieldError({ errors }: { readonly errors?: readonly string[] }) {
  if (!errors?.length) return null;
  return <p className="text-error text-xs mt-1">{errors[0]}</p>;
}

function AlertRuleForm({
  title,
  submitLabel,
  action,
  projects,
  initial,
  onDone,
}: {
  readonly title: string;
  readonly submitLabel: string;
  readonly action: (prev: AlertFormState, formData: FormData) => Promise<AlertFormState>;
  readonly projects: readonly ProjectRef[];
  readonly initial?: AlertRuleData;
  readonly onDone: () => void;
}) {
  const [state, formAction, isPending] = useActionState(action, {});

  useEffect(() => {
    if (state.success) onDone();
  }, [state.success, onDone]);

  return (
    <form
      action={formAction}
      className="border border-outline-variant/20 rounded-lg p-6 my-3 bg-surface-container"
    >
      <h3 className="text-sm font-semibold text-on-surface mb-4">{title}</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-on-surface-variant/60 mb-1">Name</label>
          <input
            name="name"
            required
            defaultValue={initial?.name}
            className={INPUT_CLASS}
            placeholder="High failure rate alert"
          />
          <FieldError errors={state.fieldErrors?.name} />
        </div>
        <div>
          <label className="block text-xs text-on-surface-variant/60 mb-1">Metric</label>
          <select
            name="metric"
            required
            defaultValue={initial?.metric ?? "success_rate"}
            className={INPUT_CLASS}
          >
            {Object.entries(METRIC_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <FieldError errors={state.fieldErrors?.metric} />
        </div>
        <div>
          <label className="block text-xs text-on-surface-variant/60 mb-1">Operator</label>
          <select
            name="operator"
            required
            defaultValue={initial?.operator ?? "lt"}
            className={INPUT_CLASS}
          >
            <option value="lt">&lt; (less than)</option>
            <option value="lte">&lt;= (less or equal)</option>
            <option value="gt">&gt; (greater than)</option>
            <option value="gte">&gt;= (greater or equal)</option>
            <option value="eq">= (equal)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-on-surface-variant/60 mb-1">Threshold</label>
          <input
            name="threshold"
            type="number"
            step="any"
            required
            defaultValue={initial?.threshold}
            className={INPUT_CLASS}
            placeholder="80"
          />
          <FieldError errors={state.fieldErrors?.threshold} />
        </div>
        <div>
          <label className="block text-xs text-on-surface-variant/60 mb-1">Severity</label>
          <select
            name="severity"
            defaultValue={initial?.severity ?? "warning"}
            className={INPUT_CLASS}
          >
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-on-surface-variant/60 mb-1">
            Project (optional)
          </label>
          <select
            name="project_id"
            defaultValue={initial?.project_id ?? ""}
            className={INPUT_CLASS}
          >
            <option value="">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-on-surface-variant/60 mb-1">
            Cooldown (minutes)
          </label>
          <input
            name="cooldown_minutes"
            type="number"
            min={1}
            max={1440}
            defaultValue={initial?.cooldown_minutes ?? 15}
            className={INPUT_CLASS}
          />
          <FieldError errors={state.fieldErrors?.cooldown_minutes} />
        </div>
      </div>
      {state.error && <p className="text-error text-sm mt-3">{state.error}</p>}
      <div className="flex gap-3 mt-4">
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {isPending ? "Saving..." : submitLabel}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="px-4 py-2 text-on-surface-variant text-sm hover:bg-surface-container-high rounded-lg transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
