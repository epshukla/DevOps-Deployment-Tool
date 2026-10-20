import { describe, it, expect } from "vitest";
import { activeRole, permissionsFor } from "../permissions";

const orgs = [
  { id: "a", role: "viewer" },
  { id: "b", role: "admin" },
];

describe("activeRole", () => {
  it("is the caller's role in the active org", () => {
    expect(activeRole(orgs, "b")).toBe("admin");
  });

  it("falls back to the first org when none is marked active", () => {
    expect(activeRole(orgs, null)).toBe("viewer");
  });

  it("is viewer when the role can't be determined (read-only is the safe default)", () => {
    expect(activeRole([], null)).toBe("viewer");
    expect(activeRole(orgs, "missing")).toBe("viewer");
  });
});

describe("permissionsFor", () => {
  it.each([
    ["viewer", false, false, false],
    ["developer", true, false, false],
    ["admin", true, true, false],
    ["owner", true, true, true],
  ])("%s → canEdit %s, canAdmin %s, isOwner %s", (role, canEdit, canAdmin, isOwner) => {
    expect(permissionsFor(role)).toMatchObject({ role, canEdit, canAdmin, isOwner });
  });

  it("explains why an action is unavailable to viewers", () => {
    expect(permissionsFor("viewer").readOnlyReason).toMatch(/viewer/i);
    expect(permissionsFor("developer").readOnlyReason).toBeUndefined();
  });
});
