import { describe, it, expect, vi } from "vitest";
import {
  ObjectStore,
  objectStoreVolumes,
  publicReadPolicy,
  type ObjectStoreDocker,
  type S3Like,
} from "../object-store";

type FakeDocker = { [K in keyof ObjectStoreDocker]: ReturnType<typeof vi.fn> };

function fakeDocker(overrides: Partial<FakeDocker> = {}): FakeDocker {
  return {
    isRunning: vi.fn().mockResolvedValue(false),
    remove: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(undefined),
    prepareVolumes: vi.fn().mockResolvedValue(undefined),
    ensureNetwork: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Records S3 commands by class name; `respond` may throw to simulate errors. */
function fakeS3(respond: (name: string, input: Record<string, unknown>) => unknown = () => ({})) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const s3: S3Like = {
    send: vi.fn(async (command: unknown) => {
      const c = command as { constructor: { name: string }; input: Record<string, unknown> };
      sent.push({ name: c.constructor.name, input: c.input });
      return respond(c.constructor.name, c.input);
    }),
  };
  return { s3, sent };
}

const credentials = () => ({ user: "deployx", password: "secret" });

function store(docker: FakeDocker, s3: S3Like) {
  return new ObjectStore({
    docker: docker as unknown as ObjectStoreDocker,
    s3,
    credentials,
    image: "rustfs/rustfs:1.0.3",
  });
}

describe("objectStoreVolumes", () => {
  it("creates one volume per erasure-coded drive", () => {
    expect(objectStoreVolumes(4).map((v) => `${v.source}:${v.target}`)).toEqual([
      "deployx-objectstore-d1:/data1",
      "deployx-objectstore-d2:/data2",
      "deployx-objectstore-d3:/data3",
      "deployx-objectstore-d4:/data4",
    ]);
  });
});

describe("publicReadPolicy", () => {
  it("allows anonymous GetObject only", () => {
    const policy = JSON.parse(publicReadPolicy("docs-x"));
    expect(policy.Statement).toEqual([
      expect.objectContaining({
        Effect: "Allow",
        Action: ["s3:GetObject"],
        Resource: ["arn:aws:s3:::docs-x/*"],
      }),
    ]);
  });
});

describe("ObjectStore.ensure", () => {
  it("starts the store on four drives, S3 API bound to loopback only", async () => {
    const docker = fakeDocker();
    const { s3, sent } = fakeS3();

    await store(docker, s3).ensure();

    const options = docker.run.mock.calls[0][0];
    expect(options.name).toBe("deployx-objectstore");
    expect(options.network).toBe("deployx-net");
    expect(options.image).toBe("rustfs/rustfs:1.0.3");
    expect(options.ports).toEqual([{ hostIp: "127.0.0.1", host: 19000, container: 9000 }]);
    expect(options.command).toEqual(["rustfs", "server", "/data1", "/data2", "/data3", "/data4"]);
    expect(options.env).toMatchObject({ RUSTFS_ACCESS_KEY: "deployx", RUSTFS_SECRET_KEY: "secret" });
    expect(sent.map((c) => c.name)).toEqual(["ListBucketsCommand"]);
    expect(docker.prepareVolumes).toHaveBeenCalledWith("rustfs/rustfs:1.0.3", expect.any(Array));
  });

  it("reuses a running store and retries until the API answers", async () => {
    const docker = fakeDocker({ isRunning: vi.fn().mockResolvedValue(true) });
    let calls = 0;
    const { s3 } = fakeS3(() => {
      if (calls++ === 0) throw new Error("ECONNREFUSED");
      return {};
    });

    await store(docker, s3).ensure();

    expect(docker.run).not.toHaveBeenCalled();
    expect(docker.sleep).toHaveBeenCalledTimes(1);
  });
});

describe("ObjectStore.ensure (credentials changed)", () => {
  it("restarts a running store that rejects the current credentials", async () => {
    const docker = fakeDocker({ isRunning: vi.fn().mockResolvedValue(true) });
    let calls = 0;
    const { s3 } = fakeS3(() => {
      if (calls++ === 0) throw Object.assign(new Error("bad key"), { name: "InvalidAccessKeyId" });
      return {};
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await store(docker, s3).ensure();

    expect(docker.run).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("ObjectStore.ensureBucket", () => {
  it("creates a versioned, public-read bucket with a lifecycle rule", async () => {
    const { s3, sent } = fakeS3((name) => {
      if (name === "HeadBucketCommand") throw Object.assign(new Error("nf"), { name: "NotFound" });
      return {};
    });

    await store(fakeDocker(), s3).ensureBucket("docs-x");

    expect(sent.map((c) => c.name)).toEqual([
      "HeadBucketCommand",
      "CreateBucketCommand",
      "PutBucketVersioningCommand",
      "PutBucketPolicyCommand",
      "PutBucketLifecycleConfigurationCommand",
    ]);
    expect(sent[2].input).toMatchObject({ VersioningConfiguration: { Status: "Enabled" } });
  });

  it("does nothing for an existing bucket", async () => {
    const { s3, sent } = fakeS3();
    await store(fakeDocker(), s3).ensureBucket("docs-x");
    expect(sent.map((c) => c.name)).toEqual(["HeadBucketCommand"]);
  });

  it("still serves when the server rejects lifecycle rules", async () => {
    const { s3 } = fakeS3((name) => {
      if (name === "HeadBucketCommand") throw Object.assign(new Error("nf"), { name: "NotFound" });
      if (name === "PutBucketLifecycleConfigurationCommand") throw new Error("NotImplemented");
      return {};
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(store(fakeDocker(), s3).ensureBucket("docs-x")).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe("ObjectStore.list", () => {
  it("follows continuation tokens", async () => {
    const { s3 } = fakeS3((_name, input) =>
      input.ContinuationToken
        ? { Contents: [{ Key: "b", Size: 2 }] }
        : { Contents: [{ Key: "a", Size: 1 }], NextContinuationToken: "t" },
    );
    expect(await store(fakeDocker(), s3).list("docs-x")).toEqual([
      { key: "a", size: 1 },
      { key: "b", size: 2 },
    ]);
  });
});
