import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkHealthViaDocker } from "../health-checker";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

describe("checkHealthViaDocker", () => {
  let mockExeca: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("execa");
    mockExeca = mod.execa as unknown as ReturnType<typeof vi.fn>;
  });

  it("passes with a null statusCode since wget's exit code doesn't carry it", async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

    const result = await checkHealthViaDocker("app-blue", 3000, "/health", 5000);

    expect(result.passed).toBe(true);
    expect(result.statusCode).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it("extracts the HTTP status code from wget's error output on failure", async () => {
    mockExeca.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "wget: server returned error: HTTP/1.1 503 Service Unavailable",
    });

    const result = await checkHealthViaDocker("app-blue", 3000, "/health", 5000);

    expect(result.passed).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.error).toContain("503");
  });

  it("returns a null statusCode when the failure has no HTTP status", async () => {
    mockExeca.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "wget: can't connect to remote host: Connection refused",
    });

    const result = await checkHealthViaDocker("app-blue", 3000, "/health", 5000);

    expect(result.passed).toBe(false);
    expect(result.statusCode).toBeNull();
  });

  it("returns a null statusCode when docker exec throws", async () => {
    mockExeca.mockRejectedValue(new Error("spawn docker ENOENT"));

    const result = await checkHealthViaDocker("app-blue", 3000, "/health", 5000);

    expect(result.passed).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).toBe("spawn docker ENOENT");
  });
});
