"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DOCUMENTS_BUCKET,
  DOCUMENT_MAX_SIZE_BYTES,
  DOCUMENT_MAX_VERSIONS,
  normalizeDocumentPath,
} from "@deployx/shared";
import { createClient } from "@/lib/supabase/client";
import { publicDocumentUrl } from "@/lib/documents";
import { formatDate } from "@/lib/format-date";
import { usePermissions } from "@/components/layout/user-context";
import {
  createDocumentUpload,
  deleteDocument,
  finalizeDocumentUpload,
  getDocumentDownloadUrl,
  restoreDocumentVersion,
  setDocumentVisibility,
} from "@/app/(dashboard)/projects/[projectId]/documents/actions";

export interface DocumentData {
  readonly id: string;
  readonly path: string;
  readonly version: number;
  readonly is_current: boolean;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly visibility: string;
  readonly expires_at: string | null;
  readonly created_at: string;
  /** Set by the verify-document edge function after re-hashing the upload */
  readonly verification?: string | null;
}

interface DocumentsSectionProps {
  readonly projectId: string;
  readonly documents: readonly DocumentData[];
  /** Public URL of the live deployment, if it has one */
  readonly publicUrl: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A file name turned into a valid document path (spaces etc. become hyphens). */
function suggestPath(fileName: string): string {
  return normalizeDocumentPath(fileName.replace(/[^A-Za-z0-9._/-]+/g, "-")).replace(/^[._-]+/, "");
}

export function DocumentsSection({ projectId, documents, publicUrl }: DocumentsSectionProps) {
  const { canEdit, readOnlyReason } = usePermissions();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // One entry per path: the current version plus its history
  const byPath = useMemo(() => {
    const groups = new Map<string, DocumentData[]>();
    for (const doc of documents) {
      groups.set(doc.path, [...(groups.get(doc.path) ?? []), doc]);
    }
    return [...groups.entries()]
      .map(([path, versions]) => ({
        path,
        versions: [...versions].sort((a, b) => b.version - a.version),
        current: versions.find((v) => v.is_current) ?? null,
      }))
      .filter((g) => g.current)
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [documents]);

  const run = (fn: () => Promise<{ error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.error) setError(result.error);
      else router.refresh();
    });
  };

  const download = (documentId: string) => {
    startTransition(async () => {
      const result = await getDocumentDownloadUrl(projectId, documentId);
      if (result.url) window.open(result.url, "_blank", "noopener");
      else setError(result.error ?? "Download failed");
    });
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setError("Couldn't copy to the clipboard");
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-surface-container-low rounded-lg border border-outline-variant overflow-hidden">
        <div className="px-6 py-4 border-b border-outline-variant/10">
          <h3 className="text-sm font-bold text-on-surface">Documents</h3>
          <p className="text-xs text-on-surface-variant mt-0.5">
            Public documents are served on the deployment&apos;s URL under{" "}
            <span className="font-mono">/files/</span>. Private ones are only reachable through
            short-lived links from this page. Up to {DOCUMENT_MAX_VERSIONS} versions are kept per path.
          </p>
          {!publicUrl && (
            <p className="text-xs text-on-surface-variant/60 mt-1">
              No live public URL right now — documents appear on it after the next local deployment.
            </p>
          )}
        </div>

        {error && (
          <div role="alert" className="px-6 py-3 bg-error/10 text-xs text-error border-b border-outline-variant/10">
            {error}
          </div>
        )}

        <UploadForm
          projectId={projectId}
          disabled={!canEdit}
          disabledReason={readOnlyReason}
          onError={setError}
          onDone={() => router.refresh()}
        />

        {byPath.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <span aria-hidden="true" className="material-symbols-outlined text-4xl text-on-surface-variant/20 mb-3 block">
              folder_open
            </span>
            <p className="text-sm text-on-surface-variant">No documents yet</p>
          </div>
        ) : (
          <div className="divide-y divide-outline-variant/5">
            {byPath.map(({ path, versions, current }) => {
              if (!current) return null;
              const link = current.visibility === "public" ? publicDocumentUrl(publicUrl, path) : null;
              return (
                <div key={path} className="px-6 py-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <span aria-hidden="true" className="material-symbols-outlined text-on-surface-variant/50">description</span>
                    <div className="flex-1 min-w-[12rem]">
                      <p className="text-sm font-mono text-on-surface break-all">{path}</p>
                      <p className="text-xs text-on-surface-variant/60">
                        v{current.version} · {formatBytes(current.size_bytes)} · {formatDate(current.created_at)}
                        {current.expires_at && ` · expires ${formatDate(current.expires_at)}`}
                      </p>
                      {link && (
                        <a href={link} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-primary hover:underline break-all">
                          {link}
                        </a>
                      )}
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                        current.visibility === "public" ? "bg-tertiary/10 text-tertiary" : "bg-on-surface-variant/10 text-on-surface-variant"
                      }`}
                    >
                      {current.visibility}
                    </span>
                    {current.verification && (
                      <span
                        title={current.verification === "ok" ? "Checksum verified server-side" : `Verification: ${current.verification}`}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          current.verification === "ok" ? "bg-tertiary/10 text-tertiary" : "bg-error/10 text-error"
                        }`}
                      >
                        {current.verification === "ok" ? "verified" : current.verification}
                      </span>
                    )}
                    <IconButton icon="download" label="Download" onClick={() => download(current.id)} disabled={isPending} />
                    {link && (
                      <IconButton
                        icon={copied === link ? "check" : "content_copy"}
                        label="Copy public link"
                        onClick={() => copyLink(link)}
                        disabled={isPending}
                      />
                    )}
                    <IconButton
                      icon={current.visibility === "public" ? "lock" : "public"}
                      label={current.visibility === "public" ? "Make private" : "Make public"}
                      disabled={isPending || !canEdit}
                      title={canEdit ? undefined : readOnlyReason}
                      onClick={() =>
                        run(() => setDocumentVisibility(projectId, path, current.visibility === "public" ? "private" : "public"))
                      }
                    />
                    <IconButton
                      icon="history"
                      label={`Versions (${versions.length})`}
                      onClick={() => setExpanded(expanded === path ? null : path)}
                    />
                    <IconButton
                      icon="delete"
                      label="Delete all versions"
                      danger
                      disabled={isPending || !canEdit}
                      title={canEdit ? undefined : readOnlyReason}
                      onClick={() => {
                        if (window.confirm(`Delete ${path} and all its versions?`)) {
                          run(() => deleteDocument(projectId, path));
                        }
                      }}
                    />
                  </div>

                  {expanded === path && (
                    <ul className="mt-3 ml-9 space-y-1">
                      {versions.map((v) => (
                        <li key={v.id} className="flex items-center gap-3 text-xs text-on-surface-variant">
                          <span className="font-mono w-8">v{v.version}</span>
                          <span className="w-16">{formatBytes(v.size_bytes)}</span>
                          <span className="flex-1">{formatDate(v.created_at)}</span>
                          <span className="font-mono text-on-surface-variant/40" title={v.sha256}>
                            {v.sha256.slice(0, 12)}
                          </span>
                          {v.is_current ? (
                            <span className="text-tertiary font-bold">current</span>
                          ) : (
                            <button
                              type="button"
                              disabled={isPending || !canEdit}
                              title={canEdit ? undefined : readOnlyReason}
                              onClick={() => run(() => restoreDocumentVersion(projectId, v.id))}
                              className="text-primary hover:underline disabled:opacity-40"
                            >
                              Restore
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => download(v.id)}
                            className="text-primary hover:underline"
                          >
                            Download
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function IconButton({
  icon,
  label,
  onClick,
  disabled,
  danger,
  title,
}: {
  readonly icon: string;
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
      className={`p-1.5 rounded-md transition-colors disabled:opacity-40 ${danger ? "hover:bg-error/10" : "hover:bg-primary/10"}`}
    >
      <span aria-hidden="true" className={`material-symbols-outlined text-sm ${danger ? "text-error/70" : "text-primary"}`}>
        {icon}
      </span>
    </button>
  );
}

function UploadForm({
  projectId,
  disabled,
  disabledReason,
  onError,
  onDone,
}: {
  readonly projectId: string;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly onError: (message: string | null) => void;
  readonly onDone: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const busy = status !== null;

  const upload = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) return;
    onError(null);

    if (file.size > DOCUMENT_MAX_SIZE_BYTES) {
      onError(`File exceeds ${DOCUMENT_MAX_SIZE_BYTES / (1024 * 1024)} MB`);
      return;
    }

    try {
      setStatus("Computing checksum…");
      const sha256 = await sha256Hex(file);

      setStatus("Preparing upload…");
      const ticket = await createDocumentUpload(projectId, {
        path: path || suggestPath(file.name),
        size_bytes: file.size,
        content_type: file.type || "application/octet-stream",
        sha256,
        visibility,
        expires_in_days: expiresInDays ? Number(expiresInDays) : null,
      });
      if (ticket.error || !ticket.documentId || !ticket.storageKey || !ticket.token) {
        onError(ticket.error ?? "Failed to start upload");
        return;
      }

      setStatus("Uploading…");
      const { error: uploadError } = await createClient()
        .storage.from(DOCUMENTS_BUCKET)
        .uploadToSignedUrl(ticket.storageKey, ticket.token, file, {
          contentType: file.type || "application/octet-stream",
        });
      if (uploadError) {
        onError(`Upload failed: ${uploadError.message}`);
        return;
      }

      setStatus("Publishing…");
      const result = await finalizeDocumentUpload(projectId, ticket.documentId);
      if (result.error) {
        onError(result.error);
        return;
      }

      setFile(null);
      setPath("");
      setExpiresInDays("");
      (event.target as HTMLFormElement).reset();
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setStatus(null);
    }
  };

  return (
    <form onSubmit={upload} className="px-6 py-4 border-b border-outline-variant/10 bg-surface-container/40">
      <fieldset disabled={disabled || busy} title={disabled ? disabledReason : undefined} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-on-surface-variant">
          File
          <input
            type="file"
            required
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null;
              setFile(picked);
              if (picked && !path) setPath(suggestPath(picked.name));
            }}
            className="text-xs text-on-surface file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-primary/10 file:text-primary"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-on-surface-variant flex-1 min-w-[10rem]">
          Path
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="guides/setup.pdf"
            className="bg-surface-container-highest border border-outline-variant rounded px-2 py-1.5 text-xs font-mono text-on-surface"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-on-surface-variant">
          Visibility
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as "public" | "private")}
            className="bg-surface-container-highest border border-outline-variant rounded px-2 py-1.5 text-xs text-on-surface"
          >
            <option value="public">Public (on site URL)</option>
            <option value="private">Private</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-on-surface-variant">
          Expires after (days)
          <input
            type="number"
            min={1}
            max={365}
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
            placeholder="never"
            className="w-24 bg-surface-container-highest border border-outline-variant rounded px-2 py-1.5 text-xs text-on-surface"
          />
        </label>
        <button
          type="submit"
          disabled={!file}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded bg-primary text-on-primary hover:bg-primary/90 disabled:opacity-40"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-sm">upload</span>
          {status ?? "Upload"}
        </button>
      </fieldset>
    </form>
  );
}
