import { describe, it, expect } from "vitest";
import {
  documentExpiry,
  documentStorageKey,
  publicDocumentUrl,
  versionsToPrune,
} from "../documents";

const v = (version: number, is_current = false) => ({
  id: `d${version}`,
  version,
  is_current,
  storage_key: `k${version}`,
});

describe("documentStorageKey", () => {
  it("scopes objects by org, then project", () => {
    expect(documentStorageKey("o", "p", "d")).toBe("o/p/d");
  });
});

describe("versionsToPrune", () => {
  it("keeps the newest versions and always the current one", () => {
    const versions = [v(1), v(2, true), v(3), v(4), v(5), v(6), v(7)];
    // keep 3: current (v2) + newest two others (v7, v6)
    expect(versionsToPrune(versions, 3).map((x) => x.version)).toEqual([5, 4, 3, 1]);
  });

  it("prunes nothing under the limit", () => {
    expect(versionsToPrune([v(1, true), v(2)], 5)).toEqual([]);
  });
});

describe("documentExpiry", () => {
  it("adds whole days, or returns null for no expiry", () => {
    const now = new Date("2026-10-21T00:00:00Z");
    expect(documentExpiry(2, now)).toBe("2026-10-23T00:00:00.000Z");
    expect(documentExpiry(null, now)).toBeNull();
  });
});

describe("publicDocumentUrl", () => {
  it("builds the /files/ link on the deployment URL", () => {
    expect(publicDocumentUrl("https://a.trycloudflare.com/", "guides/x.pdf")).toBe(
      "https://a.trycloudflare.com/files/guides/x.pdf",
    );
    expect(publicDocumentUrl(null, "x.pdf")).toBeNull();
  });
});
