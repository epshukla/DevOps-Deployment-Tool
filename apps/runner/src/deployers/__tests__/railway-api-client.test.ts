import { describe, it, expect, vi, beforeEach } from "vitest";
import { RailwayApiClient } from "../clients/railway-api-client";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const ENDPOINT = "https://backboard.railway.com/graphql/v2";

beforeEach(() => {
  mockFetch.mockReset();
});

function mockResponse(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function mockData(data: unknown) {
  mockResponse({ data });
}

function createClient(options?: { endpoint?: string; tokenType?: "account" | "project" }) {
  return new RailwayApiClient({ apiToken: "test-token", ...options });
}

function lastRequest(): { url: string; init: RequestInit; body: { query: string; variables: Record<string, unknown> } } {
  const [url, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return { url, init, body: JSON.parse(init.body as string) };
}

const projectData = {
  project: {
    id: "proj-1",
    name: "my-project",
    services: { edges: [{ node: { id: "svc-1", name: "web" } }] },
    environments: { edges: [{ node: { id: "env-1", name: "production" } }] },
  },
};

describe("RailwayApiClient", () => {
  it("POSTs GraphQL to the backboard endpoint with Bearer auth for account tokens", async () => {
    mockData(projectData);

    await createClient().getProject("proj-1");

    const { url, init, body } = lastRequest();
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(expect.objectContaining({
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    }));
    expect(body.query).toContain("project(id: $id)");
    expect(body.variables).toEqual({ id: "proj-1" });
  });

  it("uses the Project-Access-Token header for project tokens", async () => {
    mockData(projectData);

    await createClient({ tokenType: "project" }).getProject("proj-1");

    const headers = lastRequest().init.headers as Record<string, string>;
    expect(headers["Project-Access-Token"]).toBe("test-token");
    expect(headers.Authorization).toBeUndefined();
  });

  it("getProject flattens service and environment connections", async () => {
    mockData(projectData);

    const project = await createClient().getProject("proj-1");

    expect(project).toEqual({
      id: "proj-1",
      name: "my-project",
      services: [{ id: "svc-1", name: "web", projectId: "proj-1" }],
      environments: [{ id: "env-1", name: "production" }],
    });
  });

  it("getProject throws when the project is null", async () => {
    mockData({ project: null });

    await expect(createClient().getProject("missing")).rejects.toThrow(
      /project missing not found/,
    );
  });

  it("listServices returns the project's services", async () => {
    mockData(projectData);

    const services = await createClient().listServices("proj-1");

    expect(services).toEqual([{ id: "svc-1", name: "web", projectId: "proj-1" }]);
  });

  it("createService sends serviceCreate with an image source", async () => {
    mockData({ serviceCreate: { id: "svc-3", name: "worker" } });

    const result = await createClient().createService("proj-1", "worker", "ghcr.io/o/a:1");

    expect(result).toEqual({ id: "svc-3", name: "worker", projectId: "proj-1" });
    const { body } = lastRequest();
    expect(body.query).toContain("serviceCreate(input: $input)");
    expect(body.variables).toEqual({
      input: { projectId: "proj-1", name: "worker", source: { image: "ghcr.io/o/a:1" } },
    });
  });

  it("connectServiceImage sends serviceConnect with the image", async () => {
    mockData({ serviceConnect: { id: "svc-1" } });

    await createClient().connectServiceImage("svc-1", "ghcr.io/o/a:2");

    const { body } = lastRequest();
    expect(body.query).toContain("serviceConnect(id: $id, input: $input)");
    expect(body.variables).toEqual({ id: "svc-1", input: { image: "ghcr.io/o/a:2" } });
  });

  it("updateServiceInstance sends serviceInstanceUpdate with region", async () => {
    mockData({ serviceInstanceUpdate: true });

    await createClient().updateServiceInstance("svc-1", "env-1", { region: "us-west1" });

    const { body } = lastRequest();
    expect(body.query).toContain("serviceInstanceUpdate(");
    expect(body.variables).toEqual({
      serviceId: "svc-1",
      environmentId: "env-1",
      input: { region: "us-west1" },
    });
  });

  it("upsertVariables sends variableCollectionUpsert", async () => {
    mockData({ variableCollectionUpsert: true });

    await createClient().upsertVariables(
      { projectId: "proj-1", environmentId: "env-1", serviceId: "svc-1" },
      { NODE_ENV: "production" },
    );

    const { body } = lastRequest();
    expect(body.query).toContain("variableCollectionUpsert(input: $input)");
    expect(body.variables).toEqual({
      input: {
        projectId: "proj-1",
        environmentId: "env-1",
        serviceId: "svc-1",
        variables: { NODE_ENV: "production" },
      },
    });
  });

  it("deployServiceInstance returns the deployment id from serviceInstanceDeployV2", async () => {
    mockData({ serviceInstanceDeployV2: "dep-1" });

    const id = await createClient().deployServiceInstance("svc-1", "env-1");

    expect(id).toBe("dep-1");
    const { body } = lastRequest();
    expect(body.query).toContain("serviceInstanceDeployV2(");
    expect(body.variables).toEqual({ serviceId: "svc-1", environmentId: "env-1" });
  });

  it("getDeployment returns the deployment", async () => {
    const deployment = { id: "dep-2", status: "SUCCESS", url: null, staticUrl: "app.up.railway.app" };
    mockData({ deployment });

    const result = await createClient().getDeployment("dep-2");

    expect(result).toEqual(deployment);
    expect(lastRequest().body.variables).toEqual({ id: "dep-2" });
  });

  it("cancelDeployment and stopDeployment send their mutations", async () => {
    mockData({ deploymentCancel: true });
    await createClient().cancelDeployment("dep-3");
    expect(lastRequest().body.query).toContain("deploymentCancel(id: $id)");

    mockData({ deploymentStop: true });
    await createClient().stopDeployment("dep-3");
    expect(lastRequest().body.query).toContain("deploymentStop(id: $id)");
  });

  it("getDeploymentLogs queries deploymentLogs with a limit", async () => {
    const logs = [
      { timestamp: "2025-01-01T00:00:00Z", message: "Starting...", severity: "info" },
    ];
    mockData({ deploymentLogs: logs });

    const result = await createClient().getDeploymentLogs("dep-1", 50);

    expect(result).toEqual(logs);
    expect(lastRequest().body.variables).toEqual({ deploymentId: "dep-1", limit: 50 });
  });

  it("throws on non-200 response with operation and status", async () => {
    mockResponse({ error: "Unauthorized" }, 401);

    await expect(createClient().getProject("proj-1")).rejects.toThrow(
      /Railway API project failed \(401\)/,
    );
  });

  it("surfaces GraphQL errors as thrown errors", async () => {
    mockResponse({ data: null, errors: [{ message: "Not Authorized" }, { message: "Bad input" }] });

    await expect(createClient().deployServiceInstance("svc-1", "env-1")).rejects.toThrow(
      "Railway API serviceInstanceDeployV2 returned errors: Not Authorized; Bad input",
    );
  });

  it("uses a custom endpoint", async () => {
    mockData(projectData);

    await createClient({ endpoint: "https://custom.example/graphql" }).getProject("proj-1");

    expect(lastRequest().url).toBe("https://custom.example/graphql");
  });
});
