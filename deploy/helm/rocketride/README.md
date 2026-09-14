# RocketRide Helm Chart

Production-ready Helm chart for deploying the RocketRide data processing engine on Kubernetes.

## Prerequisites

- Kubernetes 1.25+
- Helm 3.10+
- An external PostgreSQL instance (or deploy one separately, see `examples/`)

## Quick Start

```bash
# Add no repository needed — install directly from the source
helm install rocketride deploy/helm/rocketride/

# With custom values
helm install rocketride deploy/helm/rocketride/ --values my-values.yaml

# Dry-run to preview manifests
helm install rocketride deploy/helm/rocketride/ --dry-run --debug
```

## Upgrade

```bash
helm upgrade rocketride deploy/helm/rocketride/ --values my-values.yaml
```

## Uninstall

```bash
helm uninstall rocketride
# PVCs are not deleted automatically — remove manually if needed:
# kubectl delete pvc -l app.kubernetes.io/instance=rocketride
```

## Configuration

See [`values.yaml`](values.yaml) for the full list of configurable parameters with inline documentation.

Key parameters:

| Parameter                        | Default                 | Description                                                    |
| -------------------------------- | ----------------------- | -------------------------------------------------------------- |
| `engine.replicaCount`            | `1`                     | Replica count (2+ requires a shared store — see HA Tuning)     |
| `engine.image.tag`               | `""` (Chart appVersion) | Engine image tag                                               |
| `engine.resources`               | see values.yaml         | CPU/memory requests and limits                                 |
| `engine.autoscaling.enabled`     | `false`                 | Enable HPA (also requires a shared store — see HA Tuning)      |
| `engine.env.RR_STORE_URL`        | unset                   | Shared file store backend; required before scaling past 1 pod  |
| `engine.sharedStoreConfigured`   | `false`                 | Acknowledge `RR_STORE_URL` injected outside the chart's view   |
| `engine.service.sessionAffinity` | `None`                  | Set `ClientIP` to pin a client to one pod (stopgap, not a fix) |
| `engine.existingSecret`          | `""`                    | Name of a pre-existing Secret                                  |
| `engine.existingSecretChecksum`  | `""`                    | Manual rollout bump for external secret rotation               |
| `ingress.enabled`                | `false`                 | Expose engine via Ingress                                      |

## Managing Secrets

**Development**: set `engine.secrets` in your values file:

```yaml
engine:
  secrets:
    OPENAI_API_KEY: 'sk-...'
    POSTGRES_PASSWORD: 'my-password'
```

**Production (recommended)**: use `engine.existingSecret` to reference a Secret you manage externally (Vault, AWS Secrets Manager, Sealed Secrets, etc.):

```yaml
engine:
  existingSecret: 'rocketride-credentials'
  existingSecretChecksum: '2026-04-09-rotation-1'
```

The chart will mount the named Secret as environment variables and will not create its own Secret resource. For chart-managed secrets (`engine.secrets`), the pod checksum changes automatically when the rendered Secret changes. For externally managed secrets (`engine.existingSecret`), bump `engine.existingSecretChecksum` when the external Secret rotates to force a rollout.

## Examples

Pre-built value overlays are in [`../examples/`](../examples/):

| File                     | Purpose                                               |
| ------------------------ | ----------------------------------------------------- |
| `external-postgres.yaml` | Connect to an external PostgreSQL / pgvector instance |
| `external-chroma.yaml`   | Connect to an external ChromaDB instance              |
| `gpu-values.yaml`        | Enable GPU resource requests (NVIDIA)                 |
| `keda-gpu-scaling.yaml`  | KEDA-based autoscaling for GPU inference workloads    |

Apply an example overlay:

```bash
helm install rocketride deploy/helm/rocketride/ -f deploy/helm/examples/external-postgres.yaml
```

## HA Tuning

**Scaling out requires a shared file store first.** The engine is not stateless: with `RR_STORE_URL` unset it keeps account files on a container-local filesystem path, so every pod would hold its own private copy — a file written through one pod is absent when the next request lands on another. On that same backend the engine also mints a per-process URL-signing key, so signed download URLs issued by one pod return 401 on every other.

Point `RR_STORE_URL` at `s3://` or `azureblob://` (the engine also accepts `azure://` as an alias for the latter) and both problems go away at once: those backends are shared by construction and presign natively, so no signing key is involved. The chart **refuses to render** a multi-replica release without one.

For production high-availability deployments:

```yaml
engine:
  replicaCount: 2 # minimum for HA; use autoscaling for dynamic scaling
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
  env:
    # Required before replicas > 1 — see above
    RR_STORE_URL: 's3://my-bucket/rocketride'
  secrets:
    RR_STORE_SECRET_KEY: '{"access_key_id": "...", "secret_access_key": "..."}'
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: rocketride
          topologyKey: kubernetes.io/hostname
```

If `RR_STORE_URL` reaches the pods from outside this chart (for example through `engine.existingSecret`, whose contents the chart cannot read), set `engine.sharedStoreConfigured: true` to acknowledge it and allow the render.

### Staying on the filesystem backend

A single-replica deployment may keep the default filesystem store. Two things to know:

- Set `engine.secrets.RR_SIGNING_KEY` explicitly. Without it the engine generates an ephemeral key at startup, so every download URL it has handed out stops verifying as soon as the pod restarts.
- The chart mounts no PersistentVolume, so the store does not survive a pod restart at all. Mount your own through `engine.volumes` / `engine.volumeMounts` and point `RR_STORE_URL` at the mount path.

`engine.service.sessionAffinity: ClientIP` pins a client to one pod, which is a stopgap for a filesystem-backed deployment — it does not make state shared, and it does not survive rescheduling.

## Architecture

See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for a full description of the chart structure, design decisions, and extension points.

## Helm Test

```bash
helm test rocketride
```

Runs a connectivity pod that curls `/ping` on the engine service to verify it is reachable.
