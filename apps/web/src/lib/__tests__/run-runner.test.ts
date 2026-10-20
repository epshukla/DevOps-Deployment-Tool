import { describe, it, expect } from "vitest";
import { describeRunRunner } from "../run-runner";

const names = { r1: "eshan-laptop", r2: "ayush-pc" };

describe("describeRunRunner", () => {
  it("names the runner that claimed the run", () => {
    expect(describeRunRunner({ runner_id: "r1", target_runner_id: null, status: "running" }, names)).toEqual({
      label: "eshan-laptop",
      state: "assigned",
    });
  });

  it("says which runner a pinned, unclaimed run is waiting for", () => {
    expect(describeRunRunner({ runner_id: null, target_runner_id: "r2", status: "queued" }, names)).toEqual({
      label: "Waiting for ayush-pc",
      state: "waiting",
    });
  });

  it("says any runner may take an unpinned queued run", () => {
    expect(describeRunRunner({ runner_id: null, target_runner_id: null, status: "queued" }, names)).toEqual({
      label: "Any available runner",
      state: "waiting",
    });
  });

  it("handles runners that were since removed", () => {
    expect(describeRunRunner({ runner_id: "gone", target_runner_id: null, status: "success" }, names)).toEqual({
      label: "Removed runner",
      state: "assigned",
    });
  });

  it("is empty for runs that never reached a runner", () => {
    expect(describeRunRunner({ runner_id: null, target_runner_id: null, status: "cancelled" }, names)).toEqual({
      label: "—",
      state: "none",
    });
  });
});
