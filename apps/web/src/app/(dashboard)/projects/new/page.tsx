"use client";

import Link from "next/link";
import { useActionState } from "react";

import { TopBar } from "@/components/layout/top-bar";
import { createProject, type ActionState } from "../actions";

const initialState: ActionState = {};

export default function NewProjectPage() {
  const [state, formAction, pending] = useActionState(createProject, initialState);

  return (
    <>
      <TopBar
        breadcrumbs={[
          { label: "Projects", href: "/projects" },
          { label: "New Project" },
        ]}
      />
      <section className="flex-1 flex items-center justify-center p-8 relative">
        {/* Background glow */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-primary/5 blur-[120px] rounded-full -z-10" />

        <div className="w-full max-w-2xl">
          <div className="mb-8">
            <h2 className="text-3xl font-extrabold tracking-tight text-on-surface mb-2">
              Create New Project
            </h2>
            <p className="text-on-surface-variant text-sm">
              Spin up a new deployment pipeline from your existing Git
              repository.
            </p>
          </div>

          <div className="bg-surface-container rounded-xl overflow-hidden shadow-2xl border border-outline-variant/10">
            <form action={formAction} className="p-8 space-y-8">
              {/* Top-level error */}
              {state.error && (
                <div className="bg-error/10 border border-error/30 rounded-md p-3 text-xs text-error">
                  {state.error}
                </div>
              )}

              {/* Identity Section */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-on-surface-variant/60 uppercase tracking-widest ml-1">
                    Project Name
                  </label>
                  <input
                    name="name"
                    type="text"
                    required
                    placeholder="e.g. monolith-api"
                    className="w-full bg-surface-container-lowest border-none rounded-md px-4 py-3 text-sm text-on-surface focus:ring-2 focus:ring-primary transition-all placeholder:text-on-surface-variant/30"
                  />
                  <FieldError errors={state.fieldErrors?.name} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-on-surface-variant/60 uppercase tracking-widest ml-1">
                    Deploy Target
                  </label>
                  <div className="relative">
                    <select
                      name="deploy_target"
                      className="w-full appearance-none bg-surface-container-lowest border-none rounded-md px-4 py-3 text-sm text-on-surface focus:ring-2 focus:ring-primary transition-all"
                    >
                      <option value="docker_local">Docker Local</option>
                      <option value="railway">Railway</option>
                      <option value="fly_io">Fly.io</option>
                    </select>
                    <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-on-surface-variant/50">
                      expand_more
                    </span>
                  </div>
                  <FieldError errors={state.fieldErrors?.deploy_target} />
                  <DeployTargetHint />
                </div>
              </div>

              {/* Source Control */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-on-surface-variant/60 uppercase tracking-widest ml-1">
                  Git Repository URL
                </label>
                <div className="relative group">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 flex items-center pr-3 border-r border-outline-variant/20">
                    <span className="material-symbols-outlined text-on-surface-variant/40 group-focus-within:text-primary transition-colors">
                      link
                    </span>
                  </div>
                  <input
                    name="git_repo_url"
                    type="url"
                    required
                    placeholder="https://github.com/org/repo"
                    className="w-full bg-surface-container-lowest border-none rounded-md pl-14 pr-4 py-3 text-sm text-on-surface focus:ring-2 focus:ring-primary transition-all placeholder:text-on-surface-variant/30"
                  />
                </div>
                <FieldError errors={state.fieldErrors?.git_repo_url} />
              </div>

              {/* Advanced Config */}
              <div className="pt-4 border-t border-outline-variant/10 grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest ml-1">
                    Default Branch
                  </label>
                  <div className="flex items-center bg-surface-container-lowest rounded-md px-3 py-2">
                    <span className="material-symbols-outlined text-xs text-on-surface-variant/50 mr-2">
                      account_tree
                    </span>
                    <input
                      name="default_branch"
                      type="text"
                      defaultValue="main"
                      className="bg-transparent border-none p-0 text-xs text-on-surface w-full focus:ring-0 font-mono"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest ml-1">
                    Dockerfile Path
                  </label>
                  <div className="flex items-center bg-surface-container-lowest rounded-md px-3 py-2">
                    <span className="material-symbols-outlined text-xs text-on-surface-variant/50 mr-2">
                      description
                    </span>
                    <input
                      name="dockerfile_path"
                      type="text"
                      defaultValue="./Dockerfile"
                      className="bg-transparent border-none p-0 text-xs text-on-surface w-full focus:ring-0 font-mono"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest ml-1">
                    Build Context
                  </label>
                  <div className="flex items-center bg-surface-container-lowest rounded-md px-3 py-2">
                    <span className="material-symbols-outlined text-xs text-on-surface-variant/50 mr-2">
                      folder
                    </span>
                    <input
                      name="build_context"
                      type="text"
                      defaultValue="."
                      className="bg-transparent border-none p-0 text-xs text-on-surface w-full focus:ring-0 font-mono"
                    />
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-4 pt-6">
                <Link
                  href="/projects"
                  className="px-6 py-2.5 rounded-md text-sm font-medium text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest transition-all"
                >
                  Cancel
                </Link>
                <button
                  type="submit"
                  disabled={pending}
                  className="px-8 py-2.5 rounded-md text-sm font-bold bg-gradient-to-br from-primary to-primary-container text-on-primary-container shadow-lg shadow-primary/10 hover:opacity-90 active:scale-95 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {pending ? (
                    <span className="material-symbols-outlined text-sm animate-spin">
                      progress_activity
                    </span>
                  ) : (
                    <span className="material-symbols-outlined text-sm">
                      add
                    </span>
                  )}
                  {pending ? "Creating..." : "Create Project"}
                </button>
              </div>
            </form>
          </div>

          {/* Repository requirements */}
          <details className="mt-6 group">
            <summary className="flex items-center gap-3 px-4 py-3 bg-tertiary-container/10 rounded-md border border-tertiary-container/20 cursor-pointer select-none hover:bg-tertiary-container/15 transition-colors">
              <span className="material-symbols-outlined text-tertiary text-sm">
                info
              </span>
              <span className="text-xs text-tertiary/80 font-semibold">
                Repository Requirements
              </span>
              <span className="material-symbols-outlined text-tertiary/50 text-sm ml-auto transition-transform group-open:rotate-180">
                expand_more
              </span>
            </summary>
            <div className="mt-2 px-4 py-3 bg-surface-container-low rounded-md border border-outline-variant/10 space-y-3">
              <p className="text-xs text-on-surface-variant leading-relaxed">
                Your Git repository needs:
              </p>
              <ul className="text-xs text-on-surface-variant/80 space-y-2 ml-1">
                <li className="flex items-start gap-2">
                  <span className="material-symbols-outlined text-tertiary text-sm mt-0.5">check_circle</span>
                  <span>A <code className="text-primary font-mono text-[11px]">Dockerfile</code> at the configured path (default: <code className="font-mono text-[11px]">./Dockerfile</code>)</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="material-symbols-outlined text-tertiary text-sm mt-0.5">check_circle</span>
                  <span>A health check endpoint at <code className="text-primary font-mono text-[11px]">GET /health</code> returning HTTP 200</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="material-symbols-outlined text-tertiary text-sm mt-0.5">check_circle</span>
                  <span>App reads port from <code className="text-primary font-mono text-[11px]">PORT</code> environment variable</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="material-symbols-outlined text-tertiary text-sm mt-0.5">check_circle</span>
                  <span>Graceful shutdown on <code className="text-primary font-mono text-[11px]">SIGTERM</code> signal</span>
                </li>
              </ul>
              <p className="text-[10px] text-on-surface-variant/50 mt-2">
                See <code className="font-mono">examples/demo-app/</code> in the DeployX repo for a working reference.
              </p>
            </div>
          </details>
        </div>
      </section>
    </>
  );
}

function FieldError({ errors }: { readonly errors?: readonly string[] }) {
  if (!errors?.length) return null;
  return (
    <p className="text-xs text-error mt-1 ml-1">{errors[0]}</p>
  );
}

const DEPLOY_TARGET_HINTS: Record<string, string> = {
  docker_local: "Deploys to Docker on the runner machine",
  railway: "Requires RAILWAY_API_TOKEN and RAILWAY_PROJECT_ID project secrets",
  fly_io: "Requires FLY_API_TOKEN project secret",
};

function DeployTargetHint() {
  return (
    <p className="text-[10px] text-on-surface-variant/50 mt-1 ml-1">
      {Object.values(DEPLOY_TARGET_HINTS).map((hint, i) => (
        <span key={i} className="block">{["Docker Local", "Railway", "Fly.io"][i]}: {hint}</span>
      ))}
    </p>
  );
}
