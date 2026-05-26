# RocketRide Helm Chart

Production-ready Helm chart for deploying the RocketRide data processing engine on Kubernetes.

## Prerequisites

- Kubernetes 1.25+
- Helm 3.10+
- An external PostgreSQL instance (or deploy one separately — see `examples/`)

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

| Parameter                       | Default                 | Description                                      |
| ------------------------------- | ----------------------- | ------------------------------------------------ |
| `engine.replicaCount`           | `1`                     | Replica count (set to 2+ for HA)                 |
| `engine.image.tag`              | `""` (Chart appVersion) | Engine image tag                                 |
| `engine.resources`              | see values.yaml         | CPU/memory requests and limits                   |
| `engine.autoscaling.enabled`    | `false`                 | Enable HPA                                       |
| `engine.existingSecret`         | `""`                    | Name of a pre-existing Secret                    |
| `engine.existingSecretChecksum` | `""`                    | Manual rollout bump for external secret rotation |
| `ingress.enabled`               | `false`                 | Expose engine via Ingress                        |

## Managing Secrets

**Development** — set `engine.secrets` in your values file:

```yaml
engine:
  secrets:
    OPENAI_API_KEY: 'sk-...'
    POSTGRES_PASSWORD: 'my-password'
```

**Production (recommended)** — use `engine.existingSecret` to reference a Secret you manage externally (Vault, AWS Secrets Manager, Sealed Secrets, etc.):

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

For production high-availability deployments:

```yaml
engine:
  replicaCount: 2 # minimum for HA; use autoscaling for dynamic scaling
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: rocketride
          topologyKey: kubernetes.io/hostname
```

## Architecture

See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for a full description of the chart structure, design decisions, and extension points.

## Helm Test

```bash
helm test rocketride
```

Runs a connectivity pod that curls `/ping` on the engine service to verify it is reachable.
