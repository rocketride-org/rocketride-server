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

## Parameter token key

When the engine validates or saves a pipeline, it encrypts each node's secure
parameters into a token (`secureParameters.token` in the node's config). Set
`RR_PARAM_TOKEN_SECRET` in the engine's environment to give your deployment its
own key for these tokens:

- New tokens are encrypted with AES-256-GCM under a key the engine derives
  from the value (HKDF-SHA256), and are marked with a format version. A token
  that was changed after it was written fails to load with an error; it never
  decrypts into other values.
- Tokens saved before you set it still load. They move to the new key the
  next time the engine encrypts that pipeline's parameters, for example when
  the pipeline is validated and saved again.
- Use a random value of at least 32 bytes, for example
  `python -c "import secrets; print(secrets.token_urlsafe(32))"`. Store it the
  way you store provider credentials.
- Give every engine replica the same value and keep it. A token written with
  one value cannot be read without it, so pipelines saved under a lost or
  changed value need their secure parameters entered again.
- Pipeline tasks never receive it. The engine decodes a pipeline's tokens
  before it starts the task.

Without the variable, tokens use the original format, which every engine
reads.

## Public pages

An engine that serves a public site builds its page map from the
`publicPages` of published platform apps (see
[Public pages](/guides/apps#public-pages-platform-apps)).

| Variable              | Effect                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RR_APP_URL`          | The public origin, such as `https://cloud.rocketride.ai`: canonical links, absolute sitemap and feed URLs, and a robots.txt that allows crawling. Unset, every response is `noindex, nofollow` and robots.txt disallows crawling, which suits local and staging engines. |
| `RR_PUBLIC_ROOT_APPS` | The app ids allowed to declare pages, separated by commas. Default `rocketride.home`. An id outside the `rocketride` developer namespace never may, even when it is listed.                                                                                              |
| `RR_INDEXNOW_KEY`     | The IndexNow key: 8 to 128 letters, digits and `-`. With an `https://` `RR_APP_URL`, the engine serves it at `/<key>.txt` and, whenever the page map changes, submits the listed pages that changed to IndexNow. Unset or malformed, it serves and submits nothing.      |

## Related

- [Self-hosting overview](/operate/self-hosting): install and run the engine.
- [Security](/operate/security): credentials, ports, and TLS before you expose anything.
- [Performance](/guides/performance): tuning levers inside the pipeline.
