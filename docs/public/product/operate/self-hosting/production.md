---
title: Production
---

# Production

Guidance for running the engine as a production workload. This page grows with
the self-hosting docs; deployment topology is the load-bearing decision today.

## Deployment topology

- **Local**: engine and nodes on the same machine. Zero network latency between
  nodes; API calls to LLM/vector store providers cross the internet normally.
- **Self-hosted**: engine in Docker or Kubernetes, co-located with vector store.
  Reduces vector store latency significantly.
- **Cloud**: managed engine. Best for production — automatic scaling, managed
  auth, no infrastructure to operate.

For high-throughput workloads, run the vector store and embedding service on the
same network as the engine to minimise round-trip latency on the embedding and
upsert steps.

## Related

- [Self-hosting overview](/operate/self-hosting): install and run the engine.
- [Security](/operate/security): credentials, ports, and TLS before you expose anything.
- [Performance](/guides/performance): tuning levers inside the pipeline.
