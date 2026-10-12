import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RunnerApiClient } from "../api-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RunnerApiClient", () => {
  let client: RunnerApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    client = new RunnerApiClient({
      runner_id: "r1",
      token: "tok-123",
      control_plane_url: "https://cp.example.com/",
      name: "runner",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("getApprovalStatus", () => {
    it("GETs the approvals endpoint with an encoded task name and bearer token", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ status: "pending" }));

      const result = await client.getApprovalStatus("run-1", "deploy prod");

      expect(result).toEqual({ status: "pending" });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://cp.example.com/api/runner/jobs/run-1/approvals?task_name=deploy%20prod");
      expect(init.method).toBe("GET");
      expect(init.headers.Authorization).toBe("Bearer tok-123");
    });

    it.each(["approved", "rejected"])("returns %s", async (status) => {
      fetchMock.mockResolvedValue(jsonResponse({ status }));
      await expect(client.getApprovalStatus("run-1", "t")).resolves.toEqual({ status });
    });

    it("throws on an unexpected status value", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ status: "maybe" }));
      await expect(client.getApprovalStatus("run-1", "t")).rejects.toThrow(
        /Unexpected approval status/,
      );
    });

    it("throws with the API error message on non-2xx", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: "Task not found" }, 404));
      await expect(client.getApprovalStatus("run-1", "t")).rejects.toThrow(
        "API error 404: Task not found",
      );
    });
  });

  describe("uploadArtifact", () => {
    it("POSTs multipart form data with file, filename and project_id", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ path: "org/p/run-1/app.zip" }, 201));

      const result = await client.uploadArtifact("run-1", {
        projectId: "proj-1",
        filename: "app.zip",
        content: Buffer.from("zipdata"),
      });

      expect(result).toEqual({ path: "org/p/run-1/app.zip" });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://cp.example.com/api/runner/jobs/run-1/artifacts");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer tok-123");
      // fetch sets the multipart boundary itself
      expect(init.headers["Content-Type"]).toBeUndefined();
      const form = init.body as FormData;
      expect(form.get("filename")).toBe("app.zip");
      expect(form.get("project_id")).toBe("proj-1");
      const file = form.get("file") as File;
      expect(file.name).toBe("app.zip");
      expect(await file.text()).toBe("zipdata");
    });

    it("stringifies structured validation errors", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ error: { filename: ["File extension must be one of: .zip"] } }, 400),
      );

      await expect(
        client.uploadArtifact("run-1", {
          projectId: "p",
          filename: "a.exe",
          content: Buffer.from("x"),
        }),
      ).rejects.toThrow(/API error 400: .*File extension must be one of/);
    });
  });
});
