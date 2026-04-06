# RocketRide Helm Chart Examples

This directory contains example value files for common deployment scenarios.

## External Services

This Helm chart does **not** bundle databases or vector stores. You are expected to provision these separately using managed services or dedicated Helm charts.

| File                     | Description                                           |
| ------------------------ | ----------------------------------------------------- |
| `external-postgres.yaml` | Connect to an external PostgreSQL (pgvector) instance |
| `external-chroma.yaml`   | Connect to an external ChromaDB instance              |
| `gpu-values.yaml`        | Deploy with NVIDIA GPU support                        |
| `keda-gpu-scaling.yaml`  | KEDA ScaledObject for GPU-aware autoscaling           |

## Usage

Combine example files with your own overrides:

```bash
helm install rocketride deploy/helm/rocketride \
  -f deploy/helm/examples/external-postgres.yaml \
  -f my-values.yaml
```

Values in later `-f` files take precedence, so put your overrides last.

## Secrets

Never put real credentials in value files. Use Kubernetes Secrets:

```bash
# Create a secret with your credentials
kubectl create secret generic rocketride-secrets \
  --from-literal=OPENAI_API_KEY='sk-...' \
  --from-literal=POSTGRES_PASSWORD='...'

# Reference it in your values
# engine:
#   existingSecret: 'rocketride-secrets'
```
