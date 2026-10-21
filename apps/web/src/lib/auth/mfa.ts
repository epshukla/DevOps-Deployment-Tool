import { hasMinRole } from "@deployx/shared";

export type MfaDecision = "ok" | "verify" | "enroll";

export interface AssuranceLevel {
  readonly currentLevel: string | null;
  readonly nextLevel: string | null;
}

/**
 * Whether the session may proceed:
 * - "verify": the user has a verified TOTP factor but this session hasn't
 *   used it yet (AAL1) — always required once enrolled.
 * - "enroll": the org requires MFA for Owners/Admins and this one has none.
 */
export function mfaDecision(
  aal: AssuranceLevel | null,
  options: { readonly orgRequiresMfa: boolean; readonly role: string },
): MfaDecision {
  if (aal?.nextLevel === "aal2" && aal.currentLevel !== "aal2") return "verify";
  if (options.orgRequiresMfa && hasMinRole(options.role, "admin") && aal?.nextLevel !== "aal2") {
    return "enroll";
  }
  return "ok";
}
