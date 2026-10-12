"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "./user-context";

const SEARCH_DEBOUNCE_MS = 200;
const RESULTS_PER_KIND = 5;

interface SearchResult {
  readonly kind: "project" | "pipeline" | "runner";
  readonly id: string;
  readonly label: string;
  readonly sublabel: string;
  readonly href: string;
}

const KIND_ICON: Record<SearchResult["kind"], string> = {
  project: "folder",
  pipeline: "account_tree",
  runner: "memory",
};

/** Escape PostgREST `ilike` wildcards so user input is matched literally. */
function toIlikePattern(term: string): string {
  return `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

async function runSearch(
  term: string,
  orgId: string | null,
): Promise<readonly SearchResult[]> {
  const supabase = createClient();
  const pattern = toIlikePattern(term);

  let projectsQuery = supabase
    .from("projects")
    .select("id, name, slug")
    .ilike("name", pattern)
    .limit(RESULTS_PER_KIND);
  let pipelinesQuery = supabase
    .from("pipeline_definitions")
    .select("id, name, project_id, projects!inner(name, org_id)")
    .ilike("name", pattern)
    .limit(RESULTS_PER_KIND);
  let runnersQuery = supabase
    .from("runner_registrations")
    .select("id, name, status")
    .ilike("name", pattern)
    .limit(RESULTS_PER_KIND);

  if (orgId) {
    projectsQuery = projectsQuery.eq("org_id", orgId);
    pipelinesQuery = pipelinesQuery.eq("projects.org_id", orgId);
    runnersQuery = runnersQuery.eq("org_id", orgId);
  }

  const [projects, pipelines, runners] = await Promise.all([
    projectsQuery,
    pipelinesQuery,
    runnersQuery,
  ]);

  return [
    ...(projects.data ?? []).map((p) => ({
      kind: "project" as const,
      id: p.id,
      label: p.name,
      sublabel: p.slug,
      href: `/projects/${p.id}`,
    })),
    ...(pipelines.data ?? []).map((p) => {
      const project = p.projects as unknown as { name: string } | null;
      return {
        kind: "pipeline" as const,
        id: p.id,
        label: p.name,
        sublabel: project?.name ?? "Pipeline",
        href: `/projects/${p.project_id}/pipelines/${p.id}`,
      };
    }),
    ...(runners.data ?? []).map((r) => ({
      kind: "runner" as const,
      id: r.id,
      label: r.name,
      sublabel: r.status,
      href: "/runners",
    })),
  ];
}

export function GlobalSearch() {
  const router = useRouter();
  const { activeOrgId } = useUser();
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<readonly SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // "/" focuses the search box from anywhere (except while typing in a field)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    function onClickOutside(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onClickOutside);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onClickOutside);
    };
  }, []);

  useEffect(() => {
    const trimmed = term.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const found = await runSearch(trimmed, activeOrgId);
        if (!cancelled) {
          setResults(found);
          setHighlight(0);
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, activeOrgId]);

  function go(result: SearchResult) {
    setOpen(false);
    setTerm("");
    inputRef.current?.blur();
    router.push(result.href);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && results[highlight]) {
      e.preventDefault();
      go(results[highlight]);
    }
  }

  const showPanel = open && term.trim().length >= 2;

  return (
    <div ref={containerRef} className="relative flex items-center group">
      <span aria-hidden="true" className="material-symbols-outlined pointer-events-none absolute left-2.5 text-[18px] text-on-surface-variant">
        search
      </span>
      <kbd className="pointer-events-none absolute right-2 rounded border border-outline-variant px-1 font-mono text-xs text-on-surface-variant">
        /
      </kbd>
      <input
        ref={inputRef}
        type="text"
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onInputKeyDown}
        placeholder="Search"
        aria-label="Search projects, pipelines and runners"
        className="h-8 w-60 rounded-md border border-outline-variant bg-surface-container-low pl-9 pr-8 text-[13px] text-on-surface placeholder:text-on-surface-variant/60 transition-colors focus:border-outline focus:outline-none"
      />
      {showPanel && (
        <div className="absolute top-full right-0 mt-2 w-80 bg-surface-container rounded-lg shadow-2xl border border-outline-variant overflow-hidden z-50">
          {loading && results.length === 0 ? (
            <p className="px-4 py-3 text-xs text-on-surface-variant/60">
              Searching…
            </p>
          ) : results.length === 0 ? (
            <p className="px-4 py-3 text-xs text-on-surface-variant/60">
              No projects, pipelines or runners match “{term.trim()}”
            </p>
          ) : (
            <ul role="listbox">
              {results.map((r, i) => (
                <li key={`${r.kind}-${r.id}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === highlight}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => go(r)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                      i === highlight
                        ? "bg-surface-container-highest"
                        : "hover:bg-surface-container-highest"
                    }`}
                  >
                    <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-primary">
                      {KIND_ICON[r.kind]}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-semibold text-on-surface truncate">
                        {r.label}
                      </span>
                      <span className="block text-xs text-on-surface-variant/60 truncate">
                        {r.kind} · {r.sublabel}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
