import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DOCUMENTS_URL_PREFIX,
  OBJECT_STORE_CONTAINER_NAME,
  OBJECT_STORE_PORT,
  documentsBucketName,
  isSafeDocumentPath,
  type DocumentManifest,
  type DocumentManifestEntry,
} from "@deployx/shared";
import type { ObjectStore, StoredObject } from "./object-store";

// ── Plan ────────────────────────────────────────────────────────

/** Checksums of what this runner last uploaded, per object key. */
export type SyncState = Readonly<Record<string, string>>;

export interface SyncPlan {
  readonly upload: readonly DocumentManifestEntry[];
  readonly remove: readonly string[];
}

/**
 * What to change so the bucket holds exactly the manifest: upload documents
 * that are missing or whose checksum changed, remove keys no longer listed.
 * Unsafe paths are ignored (the control plane validates them too).
 */
export function planDocumentSync(
  manifest: readonly DocumentManifestEntry[],
  stored: readonly StoredObject[],
  state: SyncState,
): SyncPlan {
  const wanted = manifest.filter((d) => isSafeDocumentPath(d.path));
  const storedKeys = new Set(stored.map((o) => o.key));
  const wantedKeys = new Set(wanted.map((d) => d.path));

  return {
    upload: wanted.filter((d) => !storedKeys.has(d.path) || state[d.path] !== d.sha256),
    remove: [...storedKeys].filter((key) => !wantedKeys.has(key)),
  };
}

// ── nginx ───────────────────────────────────────────────────────

export const DOCUMENTS_SNIPPET_NAME = "documents";

/**
 * The proxy location serving `/files/<path>` from the project's bucket. The
 * object store is resolved at request time (Docker DNS), so the proxy still
 * starts if it isn't running yet. Read-only: anything but GET/HEAD is denied.
 */
export function documentsNginxSnippet(bucket: string): string {
  const prefix = DOCUMENTS_URL_PREFIX; // "/files/"
  return `location = ${prefix} {
    return 404;
}

location ^~ ${prefix} {
    limit_except GET HEAD { deny all; }
    resolver 127.0.0.11 valid=30s ipv6=off;
    set $deployx_objstore ${OBJECT_STORE_CONTAINER_NAME}:${OBJECT_STORE_PORT};
    rewrite ^${prefix}(.+)$ /${bucket}/$1 break;
    proxy_pass http://$deployx_objstore;
    proxy_set_header Host $deployx_objstore;
    proxy_hide_header x-amz-request-id;
    proxy_hide_header x-amz-id-2;
    proxy_intercept_errors on;
    error_page 403 404 =404 /deployx-missing-file;
    add_header X-Content-Type-Options nosniff always;
    add_header Cache-Control "public, max-age=300" always;
}

location = /deployx-missing-file {
    internal;
    return 404;
}
`;
}

// ── Sync ────────────────────────────────────────────────────────

export interface ProxyOps {
  readonly isRunning: (proxyName: string) => Promise<boolean>;
  readonly readSnippet: (proxyName: string, name: string) => Promise<string | null>;
  readonly writeSnippet: (proxyName: string, name: string, content: string) => Promise<void>;
}

export interface SyncDeps {
  readonly store: ObjectStore;
  readonly proxy: ProxyOps;
  readonly fetch?: typeof fetch;
  readonly stateDir?: string;
  readonly tmpDir?: string;
}

export interface SyncResult {
  readonly bucket: string;
  readonly uploaded: number;
  readonly removed: number;
  readonly failed: number;
  readonly total: number;
  readonly errors: readonly string[];
}

function statePath(stateDir: string, bucket: string): string {
  return path.join(stateDir, `${bucket}.json`);
}

function loadState(stateDir: string, bucket: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(stateDir, bucket), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(stateDir: string, bucket: string, state: Record<string, string>): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(statePath(stateDir, bucket), JSON.stringify(state, null, 2));
}

/**
 * Download a document to a temp file and check it is exactly what the
 * control plane recorded (size + SHA-256) before it is published.
 */
async function downloadVerified(
  doc: DocumentManifestEntry,
  fetchFn: typeof fetch,
  tmpDir: string,
): Promise<string> {
  const response = await fetchFn(doc.url);
  if (!response.ok) throw new Error(`download failed (HTTP ${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== doc.size_bytes) {
    throw new Error(`size mismatch (${bytes.length} != ${doc.size_bytes})`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== doc.sha256) throw new Error("checksum mismatch");

  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `doc-${randomBytes(8).toString("hex")}`);
  fs.writeFileSync(file, bytes);
  return file;
}

/**
 * Mirror a project's public documents into the runner's object store and
 * make sure the project's proxy serves them under /files/. A project with
 * no documents never starts the object store. Per-file failures are
 * collected, not thrown.
 */
export async function syncProjectDocuments(
  manifest: DocumentManifest,
  proxyName: string,
  deps: SyncDeps,
): Promise<SyncResult> {
  const bucket = documentsBucketName(manifest.project_slug);
  const stateDir = deps.stateDir ?? path.join(os.homedir(), ".deployx", "objectstore");
  const tmpDir = deps.tmpDir ?? path.join(os.tmpdir(), "deployx-documents");
  const fetchFn = deps.fetch ?? fetch;
  const empty = { bucket, uploaded: 0, removed: 0, failed: 0, total: 0, errors: [] };

  if (manifest.documents.length === 0) {
    // Nothing to serve: only clean up if a bucket was populated earlier
    if (!(await deps.store.isRunning())) return empty;
    await deps.store.ensure();
    if (!(await deps.store.bucketExists(bucket))) return empty;
  } else {
    await deps.store.ensure();
    await deps.store.ensureBucket(bucket);
  }

  const state = loadState(stateDir, bucket);
  const plan = planDocumentSync(manifest.documents, await deps.store.list(bucket), state);
  const errors: string[] = [];
  let uploaded = 0;
  let removed = 0;

  for (const doc of plan.upload) {
    let file: string | null = null;
    try {
      file = await downloadVerified(doc, fetchFn, tmpDir);
      await deps.store.put(bucket, doc.path, file, doc.content_type);
      state[doc.path] = doc.sha256;
      uploaded++;
    } catch (err) {
      errors.push(`${doc.path}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (file) fs.rmSync(file, { force: true });
    }
  }

  for (const key of plan.remove) {
    try {
      await deps.store.remove(bucket, key);
      delete state[key];
      removed++;
    } catch (err) {
      errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  saveState(stateDir, bucket, state);

  if (manifest.documents.length > 0 && (await deps.proxy.isRunning(proxyName))) {
    const snippet = documentsNginxSnippet(bucket);
    if ((await deps.proxy.readSnippet(proxyName, DOCUMENTS_SNIPPET_NAME)) !== snippet) {
      try {
        await deps.proxy.writeSnippet(proxyName, DOCUMENTS_SNIPPET_NAME, snippet);
      } catch (err) {
        errors.push(`nginx: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    bucket,
    uploaded,
    removed,
    failed: errors.length,
    total: manifest.documents.length,
    errors,
  };
}
