---
title: Kubernetes
---

# Deploy on Kubernetes

The repository ships a Helm chart for clustered deployments at
[`deploy/helm/rocketride/`](https://github.com/rocketride-org/rocketride-server/tree/develop/deploy/helm/rocketride)
— a deployment, service, config/secret handling, HPA, and ingress, linted and
schema-validated in CI. The chart is not published to a chart registry:
install it from a checkout of the repository.

## Quickstart

```bash
git clone https://github.com/rocketride-org/rocketride-server.git
cd rocketride-server

# Preview what will be created
helm install rocketride deploy/helm/rocketride/ --values my-values.yaml --dry-run --debug

# Install
helm install rocketride deploy/helm/rocketride/ --values my-values.yaml
```

The chart refuses to render until credentials are configured — set
`engine.secrets` or `engine.existingSecret` in your values file first (see
the table below).

Upgrades and removal are standard Helm:

```bash
helm upgrade rocketride deploy/helm/rocketride/ --values my-values.yaml
helm uninstall rocketride
```

The chart deploys the same published engine image the
[Docker page](/operate/self-hosting/docker) documents
(`ghcr.io/rocketride-org/rocketride-engine`, tag defaults to the chart's
`appVersion`), serving the engine API on port 5565.

## The values that matter

| Value | What it does |
| --- | --- |
| `engine.image.repository` / `engine.image.tag` | Engine image; pin a version tag in production |
| `engine.env` | Plain environment for the pods (goes into a ConfigMap) — log level, worker threads, and any non-secret engine settings |
| `engine.secrets` | Provider credentials (`OPENAI_API_KEY`, …) — rendered into a Kubernetes Secret and referenced from node config as `${VAR}` |
| `engine.existingSecret` (+ `existingSecretChecksum`) | Use a secret you manage instead of chart-created; bump the checksum on rotation to force a rollout |
| `engine.resources` | Requests/limits (defaults: 250m/512Mi requested, 2 CPU/2Gi limit) |
| `engine.autoscaling` | Built-in HPA (off by default; CPU/memory targets) |
| `engine.gpu` | GPU requests plus GPU node selectors/tolerations |
| `ingress` | Expose the engine beyond the cluster — only behind TLS and auth |

Pods run hardened by default: non-root, read-only root filesystem, all
capabilities dropped.

## Example values files

Four ready-made examples under
[`deploy/helm/examples/`](https://github.com/rocketride-org/rocketride-server/tree/develop/deploy/helm/examples)
show the common setups:

- **`external-postgres.yaml`** — wire the engine to an external Postgres:

  ```bash
  helm install rocketride deploy/helm/rocketride/ -f deploy/helm/examples/external-postgres.yaml
  ```

- **`external-chroma.yaml`** — external Chroma vector store.
- **`gpu-values.yaml`** — GPU resource requests, node selection, tolerations.
- **`keda-gpu-scaling.yaml`** — autoscale GPU workloads with KEDA instead of
  the built-in HPA (CPU/memory HPA is a poor fit for GPU inference). Not a
  values file — a `ScaledObject` you `kubectl apply` alongside the release.

## Databases are external

The chart deliberately bundles no databases. Point pipelines at your own
Postgres, vector store, or graph database through `engine.env` /
`engine.secrets` — the [production topology page](/operate/self-hosting/production)
covers co-location and sizing.

## Health probes

The chart's default readiness/liveness/startup probes call `/ping` on 5565.
The engine's only public HTTP endpoint, however, is `/version` — `/ping` sits
behind the auth gate and returns 401 to the kubelet's unauthenticated probes
even when no API key is configured, which recycles healthy pods. Point all
three probes at the public version endpoint:

```yaml
engine:
  readinessProbe:
    httpGet: { path: /version, port: 5565 }
  livenessProbe:
    httpGet: { path: /version, port: 5565 }
  startupProbe:
    httpGet: { path: /version, port: 5565 }
```

## Next

- [Docker](/operate/self-hosting/docker): the image itself — tags, signing,
  persistence.
- [Production](/operate/self-hosting/production): topology and sizing.
- [Security](/operate/security): TLS, authentication, and exposure.
