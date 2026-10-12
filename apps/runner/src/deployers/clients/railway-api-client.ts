// Railway's public API is GraphQL-only (https://docs.railway.com/reference/public-api).
// Operations below mirror the documented queries/mutations in
// https://docs.railway.com/integrations/api/manage-services and
// https://docs.railway.com/integrations/api/manage-deployments.

// ── Types ───────────────────────────────────────────────────────

export interface RailwayService {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
}

export interface RailwayEnvironment {
  readonly id: string;
  readonly name: string;
}

export interface RailwayProject {
  readonly id: string;
  readonly name: string;
  readonly services: readonly RailwayService[];
  readonly environments: readonly RailwayEnvironment[];
}

export interface RailwayDeployment {
  readonly id: string;
  readonly status: string;
  readonly staticUrl?: string | null;
  readonly url?: string | null;
}

export interface RailwayDeploymentLog {
  readonly timestamp: string;
  readonly message: string;
  readonly severity?: string;
}

export interface RailwayServiceInstanceInput {
  readonly region?: string;
  readonly healthcheckPath?: string;
}

/**
 * "account" covers account and workspace tokens (Authorization: Bearer),
 * "project" covers project tokens (Project-Access-Token header).
 */
export type RailwayTokenType = "account" | "project";

export interface RailwayApiClientOptions {
  readonly apiToken: string;
  readonly tokenType?: RailwayTokenType;
  readonly endpoint?: string;
}

interface GraphQLResponse<T> {
  readonly data?: T | null;
  readonly errors?: readonly { readonly message: string }[];
}

interface Connection<T> {
  readonly edges: readonly { readonly node: T }[];
}

// ── Operations ──────────────────────────────────────────────────

const PROJECT_QUERY = `query project($id: String!) {
  project(id: $id) {
    id
    name
    services { edges { node { id name } } }
    environments { edges { node { id name } } }
  }
}`;

const SERVICE_CREATE_MUTATION = `mutation serviceCreate($input: ServiceCreateInput!) {
  serviceCreate(input: $input) { id name }
}`;

const SERVICE_CONNECT_MUTATION = `mutation serviceConnect($id: String!, $input: ServiceConnectInput!) {
  serviceConnect(id: $id, input: $input) { id }
}`;

const SERVICE_INSTANCE_UPDATE_MUTATION = `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
}`;

const VARIABLE_COLLECTION_UPSERT_MUTATION = `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
  variableCollectionUpsert(input: $input)
}`;

const SERVICE_INSTANCE_DEPLOY_MUTATION = `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
  serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
}`;

const DEPLOYMENT_QUERY = `query deployment($id: String!) {
  deployment(id: $id) { id status url staticUrl }
}`;

const DEPLOYMENT_CANCEL_MUTATION = `mutation deploymentCancel($id: String!) {
  deploymentCancel(id: $id)
}`;

const DEPLOYMENT_STOP_MUTATION = `mutation deploymentStop($id: String!) {
  deploymentStop(id: $id)
}`;

const DEPLOYMENT_LOGS_QUERY = `query deploymentLogs($deploymentId: String!, $limit: Int) {
  deploymentLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity }
}`;

// ── Client ──────────────────────────────────────────────────────

const DEFAULT_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const REQUEST_TIMEOUT_MS = 30_000;

export class RailwayApiClient {
  private readonly apiToken: string;
  private readonly tokenType: RailwayTokenType;
  private readonly endpoint: string;

  constructor(options: RailwayApiClientOptions) {
    this.apiToken = options.apiToken;
    this.tokenType = options.tokenType ?? "account";
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  }

  // ── Projects ────────────────────────────────────────────────

  async getProject(projectId: string): Promise<RailwayProject> {
    const data = await this.graphql<{
      project: {
        id: string;
        name: string;
        services: Connection<{ id: string; name: string }>;
        environments: Connection<RailwayEnvironment>;
      } | null;
    }>("project", PROJECT_QUERY, { id: projectId });

    if (!data.project) {
      throw new Error(`Railway project ${projectId} not found`);
    }

    return {
      id: data.project.id,
      name: data.project.name,
      services: data.project.services.edges.map(({ node }) => ({
        id: node.id,
        name: node.name,
        projectId,
      })),
      environments: data.project.environments.edges.map(({ node }) => node),
    };
  }

  // ── Services ────────────────────────────────────────────────

  async listServices(projectId: string): Promise<readonly RailwayService[]> {
    const project = await this.getProject(projectId);
    return project.services;
  }

  async createService(
    projectId: string,
    name: string,
    image?: string,
  ): Promise<RailwayService> {
    const data = await this.graphql<{ serviceCreate: { id: string; name: string } }>(
      "serviceCreate",
      SERVICE_CREATE_MUTATION,
      {
        input: {
          projectId,
          name,
          ...(image ? { source: { image } } : {}),
        },
      },
    );
    return { ...data.serviceCreate, projectId };
  }

  /** Points an existing service at a (new) Docker image source. */
  async connectServiceImage(serviceId: string, image: string): Promise<void> {
    await this.graphql("serviceConnect", SERVICE_CONNECT_MUTATION, {
      id: serviceId,
      input: { image },
    });
  }

  async updateServiceInstance(
    serviceId: string,
    environmentId: string,
    input: RailwayServiceInstanceInput,
  ): Promise<void> {
    await this.graphql("serviceInstanceUpdate", SERVICE_INSTANCE_UPDATE_MUTATION, {
      serviceId,
      environmentId,
      input,
    });
  }

  async upsertVariables(
    target: {
      readonly projectId: string;
      readonly environmentId: string;
      readonly serviceId: string;
    },
    variables: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.graphql("variableCollectionUpsert", VARIABLE_COLLECTION_UPSERT_MUTATION, {
      input: { ...target, variables },
    });
  }

  // ── Deployments ─────────────────────────────────────────────

  /** Triggers a deployment of the service instance and returns its deployment ID. */
  async deployServiceInstance(
    serviceId: string,
    environmentId: string,
  ): Promise<string> {
    const data = await this.graphql<{ serviceInstanceDeployV2: string }>(
      "serviceInstanceDeployV2",
      SERVICE_INSTANCE_DEPLOY_MUTATION,
      { serviceId, environmentId },
    );
    return data.serviceInstanceDeployV2;
  }

  async getDeployment(deploymentId: string): Promise<RailwayDeployment> {
    const data = await this.graphql<{ deployment: RailwayDeployment | null }>(
      "deployment",
      DEPLOYMENT_QUERY,
      { id: deploymentId },
    );
    if (!data.deployment) {
      throw new Error(`Railway deployment ${deploymentId} not found`);
    }
    return data.deployment;
  }

  async cancelDeployment(deploymentId: string): Promise<void> {
    await this.graphql("deploymentCancel", DEPLOYMENT_CANCEL_MUTATION, {
      id: deploymentId,
    });
  }

  async stopDeployment(deploymentId: string): Promise<void> {
    await this.graphql("deploymentStop", DEPLOYMENT_STOP_MUTATION, {
      id: deploymentId,
    });
  }

  // ── Logs ────────────────────────────────────────────────────

  async getDeploymentLogs(
    deploymentId: string,
    limit = 100,
  ): Promise<readonly RailwayDeploymentLog[]> {
    const data = await this.graphql<{ deploymentLogs: readonly RailwayDeploymentLog[] | null }>(
      "deploymentLogs",
      DEPLOYMENT_LOGS_QUERY,
      { deploymentId, limit },
    );
    return data.deploymentLogs ?? [];
  }

  // ── GraphQL Layer ───────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    return this.tokenType === "project"
      ? { "Project-Access-Token": this.apiToken }
      : { "Authorization": `Bearer ${this.apiToken}` };
  }

  private async graphql<T>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Railway API ${operation} failed (${response.status}): ${text}`,
        );
      }

      const body = (await response.json()) as GraphQLResponse<T>;
      if (body.errors && body.errors.length > 0) {
        const messages = body.errors.map((e) => e.message).join("; ");
        throw new Error(`Railway API ${operation} returned errors: ${messages}`);
      }
      if (!body.data) {
        throw new Error(`Railway API ${operation} returned no data`);
      }

      return body.data;
    } finally {
      clearTimeout(timeout);
    }
  }
}
