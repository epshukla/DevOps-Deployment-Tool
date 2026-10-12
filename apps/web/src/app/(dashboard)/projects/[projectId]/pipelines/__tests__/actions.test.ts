import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────

const { mockSupabase, mockUser, mockOrg, mockRole } = vi.hoisted(() => ({
  mockSupabase: { from: vi.fn() },
  mockUser: { id: "user-1" },
  mockOrg: { id: "org-1" },
  mockRole: "developer",
}));

vi.mock("@/lib/auth/session", () => ({
  requireUserWithOrg: vi.fn().mockResolvedValue({
    supabase: mockSupabase,
    user: mockUser,
    org: mockOrg,
    role: mockRole,
  }),
}));

const { mockRecordAuditEvent } = vi.hoisted(() => ({
  mockRecordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audit", () => ({
  recordAuditEvent: mockRecordAuditEvent,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

import {
  updatePipelineDefinitionVersion,
  restorePipelineVersion,
} from "../actions";

// ── Helpers ────────────────────────────────────────────────────

const VALID_YAML = `name: my-pipeline
tasks:
  build:
    steps:
      - name: Compile
        command: npm run build
`;

function makeFormData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    fd.set(k, v);
  }
  return fd;
}

interface DefinitionChainOptions {
  readonly definitionFound?: boolean;
  readonly latestVersion?: number | null;
  readonly insertError?: boolean;
  readonly updateError?: boolean;
  readonly sourceVersion?: { version: number; config_json: unknown; yaml_source: string } | null;
}

function buildMocks(options: DefinitionChainOptions = {}) {
  const {
    definitionFound = true,
    latestVersion = 2,
    insertError = false,
    updateError = false,
    sourceVersion,
  } = options;

  // pipeline_definitions chain: select().eq().eq().single()  +  update().eq()
  const definitionSingle = vi.fn().mockResolvedValue({
    data: definitionFound ? { id: "pipeline-1" } : null,
    error: null,
  });
  const definitionEq2 = vi.fn().mockReturnValue({ single: definitionSingle });
  const definitionEq1 = vi.fn().mockReturnValue({ eq: definitionEq2 });
  const definitionSelect = vi.fn().mockReturnValue({ eq: definitionEq1 });

  const definitionUpdateEq = vi.fn().mockResolvedValue({
    error: updateError ? new Error("update failed") : null,
  });
  const definitionUpdate = vi.fn().mockReturnValue({ eq: definitionUpdateEq });

  const definitionsChain = { select: definitionSelect, update: definitionUpdate };

  // pipeline_definition_versions chain — two distinct select() shapes:
  //  (a) sourceVersion lookup: select("version, config_json, yaml_source").eq().eq().single()
  //  (b) latestVersion lookup: select("version").eq().order().limit().maybeSingle()
  const sourceVersionSingle = vi.fn().mockResolvedValue({
    data: sourceVersion ?? null,
    error: null,
  });
  const latestVersionMaybeSingle = vi.fn().mockResolvedValue({
    data: latestVersion != null ? { version: latestVersion } : null,
    error: null,
  });
  const latestVersionLimit = vi.fn().mockReturnValue({ maybeSingle: latestVersionMaybeSingle });
  const latestVersionOrder = vi.fn().mockReturnValue({ limit: latestVersionLimit });
  const latestVersionEq = vi.fn().mockReturnValue({ order: latestVersionOrder });

  const versionsSelect = vi.fn().mockImplementation((columns: string) => {
    if (columns.includes("config_json")) {
      return {
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ single: sourceVersionSingle }),
        }),
      };
    }
    return { eq: latestVersionEq };
  });

  const insertSingle = vi.fn().mockResolvedValue({
    data: insertError ? null : { id: "version-new" },
    error: insertError ? new Error("insert failed") : null,
  });
  const insertSelect = vi.fn().mockReturnValue({ single: insertSingle });
  const versionsInsert = vi.fn().mockReturnValue({ select: insertSelect });

  const versionsChain = { select: versionsSelect, insert: versionsInsert };

  mockSupabase.from.mockImplementation((table: string) =>
    table === "pipeline_definitions" ? definitionsChain : versionsChain,
  );

  return {
    definitionsChain,
    versionsChain,
    definitionUpdate,
    definitionUpdateEq,
    versionsInsert,
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe("Pipeline version server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordAuditEvent.mockResolvedValue(undefined);
  });

  describe("updatePipelineDefinitionVersion", () => {
    it("rejects empty YAML with a field error", async () => {
      buildMocks();
      const fd = makeFormData({ yaml_source: "" });

      const result = await updatePipelineDefinitionVersion("project-1", "pipeline-1", {}, fd);

      expect(result.fieldErrors?.yaml_source).toBeDefined();
    });

    it("rejects invalid YAML with a field error", async () => {
      buildMocks();
      const fd = makeFormData({ yaml_source: "not: [valid, pipeline" });

      const result = await updatePipelineDefinitionVersion("project-1", "pipeline-1", {}, fd);

      expect(result.fieldErrors?.yaml_source).toBeDefined();
    });

    it("saves a new incremented version and marks it current", async () => {
      const { versionsInsert, definitionUpdate, definitionUpdateEq } = buildMocks({
        latestVersion: 2,
      });
      const fd = makeFormData({ yaml_source: VALID_YAML });

      const result = await updatePipelineDefinitionVersion("project-1", "pipeline-1", {}, fd);

      expect(result).toEqual({ success: true });
      expect(versionsInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          pipeline_definition_id: "pipeline-1",
          version: 3,
          yaml_source: VALID_YAML.trim(),
          created_by: mockUser.id,
        }),
      );
      expect(definitionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ current_version_id: "version-new" }),
      );
      expect(definitionUpdateEq).toHaveBeenCalledWith("id", "pipeline-1");
      expect(mockRecordAuditEvent).toHaveBeenCalled();
    });

    it("starts at version 1 when there are no prior versions", async () => {
      const { versionsInsert } = buildMocks({ latestVersion: null });
      const fd = makeFormData({ yaml_source: VALID_YAML });

      await updatePipelineDefinitionVersion("project-1", "pipeline-1", {}, fd);

      expect(versionsInsert).toHaveBeenCalledWith(
        expect.objectContaining({ version: 1 }),
      );
    });

    it("returns an error when the pipeline definition is not found", async () => {
      buildMocks({ definitionFound: false });
      const fd = makeFormData({ yaml_source: VALID_YAML });

      const result = await updatePipelineDefinitionVersion("project-1", "pipeline-1", {}, fd);

      expect(result).toEqual({ error: "Pipeline definition not found" });
    });

    it("returns an error when the version insert fails", async () => {
      buildMocks({ insertError: true });
      const fd = makeFormData({ yaml_source: VALID_YAML });

      const result = await updatePipelineDefinitionVersion("project-1", "pipeline-1", {}, fd);

      expect(result).toEqual({ error: "Failed to save pipeline version" });
    });
  });

  describe("restorePipelineVersion", () => {
    it("copies the source version's YAML into a new, current version", async () => {
      const { versionsInsert, definitionUpdate } = buildMocks({
        latestVersion: 5,
        sourceVersion: { version: 2, config_json: { tasks: {} }, yaml_source: VALID_YAML },
      });

      const result = await restorePipelineVersion("project-1", "pipeline-1", "version-2");

      expect(result).toEqual({ success: true });
      expect(versionsInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          pipeline_definition_id: "pipeline-1",
          version: 6,
          yaml_source: VALID_YAML,
        }),
      );
      expect(definitionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ current_version_id: "version-new" }),
      );
      expect(mockRecordAuditEvent).toHaveBeenCalled();
    });

    it("returns an error when the source version is not found", async () => {
      buildMocks({ sourceVersion: null });

      const result = await restorePipelineVersion("project-1", "pipeline-1", "missing-version");

      expect(result).toEqual({ error: "Pipeline version not found" });
    });

    it("returns an error when the pipeline definition is not found", async () => {
      buildMocks({ definitionFound: false, sourceVersion: null });

      const result = await restorePipelineVersion("project-1", "pipeline-1", "version-2");

      expect(result).toEqual({ error: "Pipeline definition not found" });
    });
  });
});
