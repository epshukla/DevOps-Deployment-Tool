# 24 — Persistent volumes and resource limits

`deploy.volumes` and `deploy.resources` (docker_local, every strategy).

| YAML | Docker | Course concept |
|---|---|---|
| `volumes: [{ name, path, read_only }]` | named volume `deployx-<slug>-vol-<name>` mounted at `path` | Unit 2 block storage, persistent storage separate from compute |
| `resources.cpus` | `--cpus` (CFS quota) | Unit 3 virtual resources, Unit 4 resource allocation / QoS |
| `resources.memory_mb` | `--memory` = `--memory-swap` (hard cap, no swap) | same |
| `resources.pids` | `--pids-limit` | isolation (no fork bombs) |

- Validated by `DeployConfigSchema`: at most 5 volumes, with unique names and paths.
  Mount paths must be absolute and not `/` or a system directory, and host paths are
  never allowed (pipeline YAML must not reach into the runner's filesystem).
- The settings are stored on each app container as the `deployx.runtime` label
  (`apps/runner/src/deployers/app-runtime.ts`). Self-healing restarts and rollbacks
  recreate containers from that label, so they keep their volumes and limits.
- `stop` keeps volumes on purpose: data outlives the deployment.
- Verified live: `HostConfig.NanoCpus=500000000`, `Memory=MemorySwap=64MiB`,
  `PidsLimit=64`, and a file written by the blue container is read by green.
