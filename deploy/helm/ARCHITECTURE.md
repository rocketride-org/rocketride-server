# RocketRide Helm Chart Architecture

## Purpose

This Helm chart is designed for **open-source community self-hosting** of the RocketRide data processing engine. It provides a production-ready Kubernetes deployment for users who want to run RocketRide on their own infrastructure.

## What This Chart Deploys

- **Engine Deployment** -- the core RocketRide data processing server (C++ engine with Python node runtime)
- **Service** -- ClusterIP service exposing the engine API on port 5565
- **ConfigMap** -- non-sensitive environment configuration
- **Secret** -- API keys and credentials (optional, supports `existingSecret`)
- **ServiceAccount** -- dedicated service account with minimal permissions
- **Ingress** -- optional ingress resource for external access
- **HPA** -- optional Horizontal Pod Autoscaler for CPU/memory-based scaling

## What This Chart Does NOT Deploy

Databases and vector stores are **not bundled**. Users are expected to provision these separately:

- **PostgreSQL (pgvector)** -- use a managed service (AWS RDS, Cloud SQL, Aiven) or a dedicated Helm chart (Bitnami PostgreSQL)
- **ChromaDB** -- use Chroma Cloud or deploy via the community Helm chart
- **Milvus** -- add the official Milvus Helm chart as a subchart dependency

See `deploy/helm/examples/` for configuration examples.

## SaaS vs Community Helm Chart

RocketRide's internal SaaS deployment uses a different set of Kubernetes patterns. This chart intentionally avoids SaaS-specific tooling to keep the self-hosted experience simple and portable.

| Capability     | Community Helm Chart                | SaaS Deployment                         |
| -------------- | ----------------------------------- | --------------------------------------- |
| Orchestration  | Helm + kubectl                      | ArgoCD GitOps                           |
| Autoscaling    | HPA (CPU/memory)                    | KEDA (queue depth, GPU utilization)     |
| Networking     | Standard Ingress (nginx, traefik)   | Cilium Gateway API                      |
| Secrets        | Kubernetes Secrets / existingSecret | External Secrets Operator + Vault       |
| Observability  | User-provided (Prometheus, Grafana) | Integrated Datadog/Grafana stack        |
| GPU scheduling | nodeSelector + tolerations          | NVIDIA GPU Operator + MIG profiles      |
| Databases      | External (managed services)         | Dedicated RDS/CloudSQL per tenant       |
| Multi-tenancy  | Single namespace per install        | Namespace-per-tenant with NetworkPolicy |

## Design Decisions

1. **No bundled databases** -- stateful services are better managed by dedicated operators or cloud providers. Bundling them creates upgrade and backup complexity that does not belong in an application chart.

2. **No CRDs** -- the chart uses only standard Kubernetes resources so it works on any cluster without requiring operator pre-installation.

3. **Security defaults** -- pods run as non-root with read-only root filesystem, dropped capabilities, and no privilege escalation. These can be relaxed for specific use cases.

4. **GPU as opt-in** -- GPU support is available via `engine.gpu.enabled` but off by default. CPU/memory HPA is not suitable for GPU workloads; see `deploy/helm/examples/keda-gpu-scaling.yaml` for GPU-aware scaling.
