import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DEPLOYER_NETWORK_NAME,
  OBJECT_STORE_CONTAINER_NAME,
  OBJECT_STORE_DRIVES,
  OBJECT_STORE_HOST_PORT,
  OBJECT_STORE_IMAGE,
  OBJECT_STORE_NONCURRENT_EXPIRY_DAYS,
  OBJECT_STORE_PORT,
} from "@deployx/shared";
import {
  ensureNetwork,
  isContainerRunning,
  removeContainerIfExists,
  runContainer,
  runOnce,
  type RunContainerOptions,
  type VolumeMount,
} from "../deployers/container-manager";

/**
 * The runner's object store: one S3-compatible, open-source server (RustFS
 * by default) per runner machine, on the deployx network. Project nginx
 * proxies read public documents from it over that network; the runner
 * writes through the S3 API on 127.0.0.1 only, so it is never reachable from
 * outside the machine.
 *
 * It runs on OBJECT_STORE_DRIVES volumes, so the server erasure-codes every
 * object across them (data + parity shards, like RAID 5/6) and keeps serving
 * if a drive is lost. Buckets get versioning, an anonymous read-only policy
 * (GetObject, no listing) and a lifecycle rule for old versions.
 */

export interface StoredObject {
  readonly key: string;
  readonly size: number;
}

export interface Credentials {
  readonly user: string;
  readonly password: string;
}

/** Docker operations, injectable for tests. */
export interface ObjectStoreDocker {
  readonly isRunning: (name: string) => Promise<boolean>;
  readonly remove: (name: string) => Promise<void>;
  readonly run: (options: RunContainerOptions) => Promise<void>;
  /** Give the (root-owned) volumes to the image's unprivileged user */
  readonly prepareVolumes: (image: string, volumes: readonly VolumeMount[]) => Promise<void>;
  readonly ensureNetwork: (name: string) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
}

/** The subset of S3Client the store uses (injectable for tests). */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

const defaultDocker: ObjectStoreDocker = {
  isRunning: isContainerRunning,
  remove: removeContainerIfExists,
  run: async (options) => {
    await runContainer(options);
  },
  prepareVolumes: (image, volumes) =>
    runOnce({
      image,
      entrypoint: "sh",
      user: "0",
      volumes,
      command: ["-c", `chown -R rustfs:rustfs ${volumes.map((v) => v.target).join(" ")} 2>/dev/null || true`],
    }),
  ensureNetwork,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The volumes the store erasure-codes across: deployx-objectstore-d1…dN. */
export function objectStoreVolumes(drives: number = OBJECT_STORE_DRIVES) {
  return Array.from({ length: drives }, (_, i) => ({
    source: `${OBJECT_STORE_CONTAINER_NAME}-d${i + 1}`,
    target: `/data${i + 1}`,
  }));
}

/**
 * The store's root credentials, generated once per machine and kept in
 * ~/.deployx/objectstore.json: the server ties stored config to them, so
 * they must not change between container restarts.
 */
export function loadOrCreateCredentials(
  file: string = path.join(os.homedir(), ".deployx", "objectstore.json"),
): Credentials {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof parsed.user === "string" && typeof parsed.password === "string") {
      return { user: parsed.user, password: parsed.password };
    }
  } catch {
    // Not created yet (or unreadable) — make a new one below
  }
  const creds = { user: `deployx${randomBytes(4).toString("hex")}`, password: randomBytes(24).toString("hex") };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  return creds;
}

/** Anonymous read of single objects; no ListBucket, so contents can't be enumerated. */
export function publicReadPolicy(bucket: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DeployxPublicRead",
        Effect: "Allow",
        Principal: { AWS: ["*"] },
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  });
}

const AUTH_ERRORS = new Set(["InvalidAccessKeyId", "SignatureDoesNotMatch", "AccessDenied"]);

function errorName(err: unknown): string {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name ?? String(e?.$metadata?.httpStatusCode ?? "");
}

export class ObjectStore {
  private readonly docker: ObjectStoreDocker;
  private readonly credentials: () => Credentials;
  private readonly image: string;
  private readonly name = OBJECT_STORE_CONTAINER_NAME;
  private s3: S3Like | null;

  constructor(options: {
    readonly docker?: ObjectStoreDocker;
    readonly credentials?: () => Credentials;
    readonly s3?: S3Like;
    readonly image?: string;
  } = {}) {
    this.docker = options.docker ?? defaultDocker;
    this.credentials = options.credentials ?? (() => loadOrCreateCredentials());
    this.s3 = options.s3 ?? null;
    this.image = options.image ?? process.env.DEPLOYX_OBJECT_STORE_IMAGE ?? OBJECT_STORE_IMAGE;
  }

  isRunning(): Promise<boolean> {
    return this.docker.isRunning(this.name);
  }

  private client(): S3Like {
    if (!this.s3) {
      const { user, password } = this.credentials();
      this.s3 = new S3Client({
        endpoint: `http://127.0.0.1:${OBJECT_STORE_HOST_PORT}`,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: { accessKeyId: user, secretAccessKey: password },
      });
    }
    return this.s3;
  }

  /** Start the store if needed and wait until its S3 API answers. */
  async ensure(timeoutMs = 90_000): Promise<void> {
    let started = false;
    if (!(await this.docker.isRunning(this.name))) {
      await this.start();
      started = true;
    }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.client().send(new ListBucketsCommand({}));
        return;
      } catch (err) {
        // A store started with other credentials (e.g. objectstore.json was
        // deleted): restart it with the current ones; the data volumes stay.
        if (!started && AUTH_ERRORS.has(errorName(err))) {
          console.warn("[documents] object store credentials changed; restarting it");
          await this.start();
          started = true;
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Object store did not become ready: ${err instanceof Error ? err.message : err}`);
        }
        await this.docker.sleep(2_000);
      }
    }
  }

  private async start(): Promise<void> {
    await this.docker.ensureNetwork(DEPLOYER_NETWORK_NAME);
    await this.docker.remove(this.name);
    const { user, password } = this.credentials();
    const volumes = objectStoreVolumes();
    // The image declares VOLUME /data; mounting a named volume there stops
    // Docker creating (and leaking) an anonymous one on every restart.
    const mounts = [...volumes, { source: `${OBJECT_STORE_CONTAINER_NAME}-meta`, target: "/data" }];
    await this.docker.prepareVolumes(this.image, mounts);
    await this.docker.run({
      name: this.name,
      image: this.image,
      network: DEPLOYER_NETWORK_NAME,
      ports: [{ hostIp: "127.0.0.1", host: OBJECT_STORE_HOST_PORT, container: OBJECT_STORE_PORT }],
      env: {
        RUSTFS_ACCESS_KEY: user,
        RUSTFS_SECRET_KEY: password,
        RUSTFS_ADDRESS: `:${OBJECT_STORE_PORT}`,
        // Log to stdout (`docker logs deployx-objectstore`), not a file in the container
        RUSTFS_OBS_LOG_DIRECTORY: "",
        // The drives are Docker volumes on the runner's one disk: erasure
        // coding still shards every object across them (and survives losing
        // a volume) but can't protect against that disk failing. RustFS
        // refuses that layout unless told it's deliberate.
        RUSTFS_UNSAFE_BYPASS_DISK_CHECK: "true",
        // MinIO-compatible servers read these instead
        MINIO_ROOT_USER: user,
        MINIO_ROOT_PASSWORD: password,
      },
      labels: { "deployx.role": "objectstore" },
      volumes: mounts,
      command: ["rustfs", "server", ...volumes.map((v) => v.target)],
      detach: true,
      restart: "unless-stopped",
    });
  }

  async bucketExists(bucket: string): Promise<boolean> {
    try {
      await this.client().send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    } catch (err) {
      const name = errorName(err);
      if (name === "NotFound" || name === "NoSuchBucket" || name === "404") return false;
      throw err;
    }
  }

  /** Create a project bucket: versioned, anonymous read-only, old versions expire. */
  async ensureBucket(bucket: string): Promise<void> {
    if (await this.bucketExists(bucket)) return;
    const s3 = this.client();

    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (err) {
      const name = errorName(err);
      if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
    }
    await s3.send(new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: "Enabled" },
    }));
    await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: publicReadPolicy(bucket) }));
    // Lifecycle is best-effort: documents still serve without it
    try {
      await s3.send(new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: [{
            ID: "expire-noncurrent-versions",
            Status: "Enabled",
            Filter: { Prefix: "" },
            NoncurrentVersionExpiration: { NoncurrentDays: OBJECT_STORE_NONCURRENT_EXPIRY_DAYS },
          }],
        },
      }));
    } catch (err) {
      console.warn(`[documents] lifecycle rule not applied to ${bucket}: ${errorName(err)}`);
    }
  }

  async list(bucket: string): Promise<readonly StoredObject[]> {
    const objects: StoredObject[] = [];
    let token: string | undefined;
    do {
      const page = (await this.client().send(new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: token,
      }))) as { Contents?: { Key?: string; Size?: number }[]; NextContinuationToken?: string };
      for (const o of page.Contents ?? []) {
        if (o.Key) objects.push({ key: o.Key, size: o.Size ?? 0 });
      }
      token = page.NextContinuationToken;
    } while (token);
    return objects;
  }

  async put(bucket: string, key: string, hostFile: string, contentType: string): Promise<void> {
    await this.client().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.readFileSync(hostFile),
      ContentType: contentType || "application/octet-stream",
    }));
  }

  async remove(bucket: string, key: string): Promise<void> {
    await this.client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}
