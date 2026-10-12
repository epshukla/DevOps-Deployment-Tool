import { describe, it, expect } from "vitest";
import { buildRunnerSystemEvents, isRunnerAuditEvent } from "../system-events";
import type { AuditEventRow, RunnerRow } from "../system-events";

function makeAuditEvent(overrides: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    id: "evt-1",
    action: "create",
    resource_type: "runner_registration",
    resource_id: "runner-1",
    details: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRunner(overrides: Partial<RunnerRow> = {}): RunnerRow {
  return {
    id: "runner-1",
    name: "build-box",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("isRunnerAuditEvent", () => {
  it("matches runner and runner_registration resource types", () => {
    expect(isRunnerAuditEvent({ resource_type: "runner" })).toBe(true);
    expect(isRunnerAuditEvent({ resource_type: "runner_registration" })).toBe(true);
  });

  it("rejects unrelated resource types", () => {
    expect(isRunnerAuditEvent({ resource_type: "project" })).toBe(false);
  });
});

describe("buildRunnerSystemEvents", () => {
  it("filters out non-runner audit events", () => {
    const events = buildRunnerSystemEvents(
      [makeAuditEvent({ resource_type: "project" })],
      [],
    );
    expect(events).toHaveLength(0);
  });

  it("describes a create event using the runner name from details", () => {
    const events = buildRunnerSystemEvents(
      [makeAuditEvent({ action: "create", details: { name: "build-box" } })],
      [],
    );
    expect(events[0].label).toBe('Registration token generated for "build-box"');
  });

  it("describes a non-forced delete event", () => {
    const events = buildRunnerSystemEvents(
      [makeAuditEvent({ action: "delete", details: { name: "build-box", forced: false } })],
      [],
    );
    expect(events[0].label).toBe('Runner "build-box" revoked');
  });

  it("describes a forced delete event", () => {
    const events = buildRunnerSystemEvents(
      [makeAuditEvent({ action: "delete", details: { name: "build-box", forced: true } })],
      [],
    );
    expect(events[0].label).toBe('Runner "build-box" force-revoked');
  });

  it("includes synthetic registration events derived from runner created_at", () => {
    const events = buildRunnerSystemEvents([], [makeRunner({ name: "edge-01" })]);
    expect(events[0].label).toBe('Runner "edge-01" registered');
    expect(events[0].kind).toBe("registered");
  });

  it("merges audit and registration events sorted newest-first", () => {
    const events = buildRunnerSystemEvents(
      [
        makeAuditEvent({
          id: "old-audit",
          created_at: "2026-01-01T00:00:00.000Z",
          details: { name: "old" },
        }),
      ],
      [makeRunner({ id: "runner-2", name: "new-runner", created_at: "2026-02-01T00:00:00.000Z" })],
    );

    expect(events).toHaveLength(2);
    expect(events[0].label).toBe('Runner "new-runner" registered');
    expect(events[1].label).toContain("old");
  });

  it("caps the merged list at the given limit", () => {
    const runners = Array.from({ length: 20 }, (_, i) =>
      makeRunner({ id: `r${i}`, name: `runner-${i}`, created_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }),
    );

    const events = buildRunnerSystemEvents([], runners, 15);
    expect(events).toHaveLength(15);
  });
});
