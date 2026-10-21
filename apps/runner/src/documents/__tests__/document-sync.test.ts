import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DocumentManifestEntry } from "@deployx/shared";
import {
  documentsNginxSnippet,
  planDocumentSync,
  syncProjectDocuments,
  type ProxyOps,
} from "../document-sync";
import type { ObjectStore, StoredObject } from "../object-store";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function entry(p: string, body: string): DocumentManifestEntry {
  return {
    path: p,
    sha256: sha(body),
    size_bytes: Buffer.byteLength(body),
    content_type: "application/pdf",
    url: `https://storage.test/${p}`,
  };
}

describe("planDocumentSync", () => {
  it("uploads new and changed documents and removes stale keys", () => {
    const manifest = [entry("a.pdf", "A"), entry("b.pdf", "B2"), entry("c.pdf", "C")];
    const stored: StoredObject[] = [
      { key: "a.pdf", size: 1 },
      { key: "b.pdf", size: 1 },
      { key: "old.pdf", size: 1 },
    ];
    const state = { "a.pdf": sha("A"), "b.pdf": sha("B1") };

    const plan = planDocumentSync(manifest, stored, state);

    expect(plan.upload.map((d) => d.path)).toEqual(["b.pdf", "c.pdf"]);
    expect(plan.remove).toEqual(["old.pdf"]);
  });

  it("re-uploads an object missing from the store even if state says it was sent", () => {
    const plan = planDocumentSync([entry("a.pdf", "A")], [], { "a.pdf": sha("A") });
    expect(plan.upload).toHaveLength(1);
  });

  it("ignores unsafe paths", () => {
    const plan = planDocumentSync([entry("../etc/passwd", "x")], [], {});
    expect(plan.upload).toEqual([]);
  });
});

describe("documentsNginxSnippet", () => {
  it("proxies /files/ to the project bucket, read-only", () => {
    const snippet = documentsNginxSnippet("docs-my-app");
    expect(snippet).toContain("location ^~ /files/ {");
    expect(snippet).toContain("rewrite ^/files/(.+)$ /docs-my-app/$1 break;");
    expect(snippet).toContain("limit_except GET HEAD { deny all; }");
    expect(snippet).toContain("set $deployx_objstore deployx-objectstore:9000;");
    expect(snippet).toContain("resolver 127.0.0.11");
  });
});

describe("syncProjectDocuments", () => {
  let dir: string;
  let store: {
    isRunning: ReturnType<typeof vi.fn>;
    ensure: ReturnType<typeof vi.fn>;
    bucketExists: ReturnType<typeof vi.fn>;
    ensureBucket: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  let proxy: { [K in keyof ProxyOps]: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "deployx-sync-test-"));
    store = {
      isRunning: vi.fn().mockResolvedValue(true),
      ensure: vi.fn().mockResolvedValue(undefined),
      bucketExists: vi.fn().mockResolvedValue(true),
      ensureBucket: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      put: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    proxy = {
      isRunning: vi.fn().mockResolvedValue(true),
      readSnippet: vi.fn().mockResolvedValue(null),
      writeSnippet: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deps = (fetchFn: typeof fetch) => ({
    store: store as unknown as ObjectStore,
    proxy: proxy as unknown as ProxyOps,
    fetch: fetchFn,
    stateDir: path.join(dir, "state"),
    tmpDir: path.join(dir, "tmp"),
  });

  const fetchBodies = (bodies: Record<string, string>) =>
    vi.fn(async (url: string) => {
      const key = url.replace("https://storage.test/", "");
      return new Response(bodies[key] ?? "", { status: bodies[key] ? 200 : 404 });
    }) as unknown as typeof fetch;

  it("uploads verified documents, installs the nginx snippet and remembers checksums", async () => {
    const manifest = { project_slug: "my-app", documents: [entry("guide.pdf", "hello")] };

    const result = await syncProjectDocuments(manifest, "deployx-proxy-my-app", deps(fetchBodies({ "guide.pdf": "hello" })));

    expect(result).toMatchObject({ bucket: "docs-my-app", uploaded: 1, removed: 0, failed: 0, total: 1 });
    expect(store.ensureBucket).toHaveBeenCalledWith("docs-my-app");
    expect(store.put).toHaveBeenCalledWith("docs-my-app", "guide.pdf", expect.any(String), "application/pdf");
    expect(proxy.writeSnippet).toHaveBeenCalledWith(
      "deployx-proxy-my-app",
      "documents",
      documentsNginxSnippet("docs-my-app"),
    );

    const state = JSON.parse(fs.readFileSync(path.join(dir, "state", "docs-my-app.json"), "utf-8"));
    expect(state).toEqual({ "guide.pdf": sha("hello") });
    // The temp download is cleaned up
    expect(fs.readdirSync(path.join(dir, "tmp"))).toEqual([]);
  });

  it("refuses a download whose checksum doesn't match", async () => {
    const manifest = { project_slug: "my-app", documents: [entry("guide.pdf", "hello")] };

    const result = await syncProjectDocuments(manifest, "p", deps(fetchBodies({ "guide.pdf": "HELLO" })));

    expect(result.uploaded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain("checksum mismatch");
    expect(store.put).not.toHaveBeenCalled();
  });

  it("does not start the object store for a project without documents", async () => {
    store.isRunning.mockResolvedValue(false);

    const result = await syncProjectDocuments({ project_slug: "x", documents: [] }, "p", deps(fetchBodies({})));

    expect(result.total).toBe(0);
    expect(store.ensure).not.toHaveBeenCalled();
    expect(proxy.writeSnippet).not.toHaveBeenCalled();
  });

  it("removes everything once the last document is deleted", async () => {
    store.list.mockResolvedValue([{ key: "gone.pdf", size: 3 }]);

    const result = await syncProjectDocuments({ project_slug: "x", documents: [] }, "p", deps(fetchBodies({})));

    expect(store.remove).toHaveBeenCalledWith("docs-x", "gone.pdf");
    expect(result.removed).toBe(1);
  });

  it("leaves an up-to-date snippet alone", async () => {
    proxy.readSnippet.mockResolvedValue(documentsNginxSnippet("docs-my-app"));
    const manifest = { project_slug: "my-app", documents: [entry("a.txt", "a")] };

    await syncProjectDocuments(manifest, "p", deps(fetchBodies({ "a.txt": "a" })));

    expect(proxy.writeSnippet).not.toHaveBeenCalled();
  });
});
