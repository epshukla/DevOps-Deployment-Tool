import { describe, it, expect } from "vitest";
import { summarizeTrivyReport } from "../security-scan";
import { rateLimitConf } from "../../deployers/rate-limit";
import { chooseDeployTarget } from "@deployx/shared";

describe("summarizeTrivyReport", () => {
  it("counts findings by severity across results", () => {
    const report = JSON.stringify({
      Results: [
        {
          Vulnerabilities: [
            { VulnerabilityID: "CVE-1", PkgName: "openssl", Severity: "CRITICAL" },
            { VulnerabilityID: "CVE-2", PkgName: "zlib", Severity: "HIGH" },
          ],
        },
        { Vulnerabilities: null },
        { Vulnerabilities: [{ VulnerabilityID: "CVE-3", PkgName: "x", Severity: "HIGH" }] },
      ],
    });
    const summary = summarizeTrivyReport(report);
    expect(summary.counts).toEqual({ CRITICAL: 1, HIGH: 2 });
    expect(summary.total).toBe(3);
    expect(summary.top[0]).toBe("CVE-1 (openssl) CRITICAL");
  });

  it("handles a clean image", () => {
    expect(summarizeTrivyReport(JSON.stringify({ Results: [] })).total).toBe(0);
    expect(summarizeTrivyReport("{}").total).toBe(0);
  });
});

describe("rateLimitConf", () => {
  it("keys clients by CF-Connecting-IP and returns 429 over the limit", () => {
    const conf = rateLimitConf({ requests_per_second: 5, burst: 10 });
    expect(conf).toContain("map $http_cf_connecting_ip $deployx_client");
    expect(conf).toContain("rate=5r/s");
    expect(conf).toContain("burst=10 nodelay");
    expect(conf).toContain("limit_req_status 429;");
  });
});

describe("chooseDeployTarget (cloud broker)", () => {
  const all = ["docker_local", "railway", "fly_io"] as const;

  it("prefers the local runner when Docker is available", () => {
    expect(chooseDeployTarget(all, { dockerAvailable: true, secrets: {} }).target).toBe("docker_local");
  });

  it("falls back to the first cloud with credentials, explaining skips", () => {
    const decision = chooseDeployTarget(all, { dockerAvailable: false, secrets: { FLY_API_TOKEN: "t" } });
    expect(decision.target).toBe("fly_io");
    expect(decision.reasons).toHaveLength(2);
  });

  it("honours the preference order and reports when nothing fits", () => {
    expect(
      chooseDeployTarget(["railway", "docker_local"], {
        dockerAvailable: true,
        secrets: { RAILWAY_PROJECT_TOKEN: "t" },
      }).target,
    ).toBe("railway");
    expect(chooseDeployTarget(["fly_io"], { dockerAvailable: true, secrets: {} }).target).toBeNull();
  });
});
