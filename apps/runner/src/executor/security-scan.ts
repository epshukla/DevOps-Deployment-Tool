import { execa } from "execa";
import type { SecurityScanConfig } from "@deployx/shared";

export const TRIVY_IMAGE = "aquasec/trivy:0.65.0";
/** Vulnerability DB cache, reused between scans (Trivy downloads it once). */
const TRIVY_CACHE_VOLUME = "deployx-trivy-cache";

export interface ScanSummary {
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
  /** A few findings for the log: "CVE-… (pkg) CRITICAL" */
  readonly top: readonly string[];
}

interface TrivyReport {
  readonly Results?: ReadonlyArray<{
    readonly Vulnerabilities?: ReadonlyArray<{
      readonly VulnerabilityID?: string;
      readonly PkgName?: string;
      readonly Severity?: string;
    }> | null;
  }>;
}

/** Count Trivy's JSON findings by severity. */
export function summarizeTrivyReport(json: string): ScanSummary {
  const report = JSON.parse(json) as TrivyReport;
  const counts: Record<string, number> = {};
  const top: string[] = [];
  for (const result of report.Results ?? []) {
    for (const v of result.Vulnerabilities ?? []) {
      const severity = v.Severity ?? "UNKNOWN";
      counts[severity] = (counts[severity] ?? 0) + 1;
      if (top.length < 5) top.push(`${v.VulnerabilityID ?? "?"} (${v.PkgName ?? "?"}) ${severity}`);
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, total, top };
}

/**
 * Scan a local image with Trivy (run as a container against the Docker
 * socket, so nothing is installed on the runner). Only the configured
 * severities are reported.
 */
export async function scanImage(
  imageTag: string,
  config: Pick<SecurityScanConfig, "severity">,
): Promise<ScanSummary> {
  const result = await execa(
    "docker",
    [
      "run", "--rm",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-v", `${TRIVY_CACHE_VOLUME}:/root/.cache`,
      TRIVY_IMAGE,
      "image", "--quiet", "--scanners", "vuln", "--format", "json",
      "--severity", config.severity.join(","),
      imageTag,
    ],
    { reject: false, timeout: 15 * 60_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`trivy failed (exit ${result.exitCode}): ${String(result.stderr).slice(-500)}`);
  }
  return summarizeTrivyReport(String(result.stdout));
}
