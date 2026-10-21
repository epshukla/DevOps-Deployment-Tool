import { describe, it, expect } from "vitest";
import { mfaDecision } from "../mfa";

const aal = (currentLevel: string, nextLevel: string) => ({ currentLevel, nextLevel });

describe("mfaDecision", () => {
  it("asks an enrolled user to verify on an AAL1 session", () => {
    expect(mfaDecision(aal("aal1", "aal2"), { orgRequiresMfa: false, role: "viewer" })).toBe("verify");
  });

  it("lets a verified session through", () => {
    expect(mfaDecision(aal("aal2", "aal2"), { orgRequiresMfa: true, role: "owner" })).toBe("ok");
  });

  it("requires admins and owners to enroll when the org demands MFA", () => {
    expect(mfaDecision(aal("aal1", "aal1"), { orgRequiresMfa: true, role: "admin" })).toBe("enroll");
    expect(mfaDecision(aal("aal1", "aal1"), { orgRequiresMfa: true, role: "owner" })).toBe("enroll");
  });

  it("does not force developers or viewers, or anyone when the policy is off", () => {
    expect(mfaDecision(aal("aal1", "aal1"), { orgRequiresMfa: true, role: "developer" })).toBe("ok");
    expect(mfaDecision(aal("aal1", "aal1"), { orgRequiresMfa: false, role: "owner" })).toBe("ok");
    expect(mfaDecision(null, { orgRequiresMfa: false, role: "owner" })).toBe("ok");
  });
});
