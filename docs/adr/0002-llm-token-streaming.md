# 0002: LLM Token Streaming Activation Contract

## Status

Proposed

## Context

The LLM token streaming PR adds infrastructure for relaying provider token
chunks through server-sent events (SSE). Review feedback correctly noted that
the initial branch is mostly a skeleton: no provider node owns the activation
contract yet, and readers cannot tell when streaming should be enabled, who
decides, or what happens when no SSE listener is attached.

Existing LLM nodes must keep their current non-streaming behavior unless a
pipeline author explicitly opts into streaming and the runtime can deliver the
events.

## Decision

Token streaming is opt-in at the node configuration boundary. A provider LLM
node may attempt streaming only when all of these are true:

1. The node config has `streaming: true` or `stream: true`.
2. The provider adapter is listed as streaming-capable.
3. The engine instance exposes an SSE transport for the current run.

The provider node owns the final decision because it knows the provider SDK
shape and whether a streaming response can be converted into the normal
`Answer` object. Shared streaming helpers may provide common chunk extraction,
event emission, and fallback behavior, but they should not globally change the
base LLM lifecycle for every provider at once.

When no SSE listener or SSE transport is available, the node must fall back to a
normal non-streaming call and still return a complete `Answer`. Missing
listeners are not an error because pipelines should remain runnable from CLI,
tests, and non-interactive clients. If streaming starts and then fails, the node
must emit an error event when possible and fall back to the non-streaming path;
if the fallback also fails, the original provider error is propagated.

Streaming events should be best-effort observability. The accumulated final
answer remains the source of truth for downstream pipeline nodes.

## Consequences

### Positive

- Existing LLM nodes keep backward-compatible behavior by default.
- Provider teams can adopt streaming incrementally instead of changing every
  LLM node in one shared base class change.
- CLI and test runs without SSE clients continue to work.
- Downstream nodes receive the same final `Answer` shape whether streaming was
  used or not.

### Negative

- Each provider adapter needs a small integration step before users can stream
  from that provider.
- Token usage metadata may vary by provider and may be approximate until each
  SDK integration is hardened.
- The shared helper API may need another ADR if the team later decides to move
  streaming into the common LLM base class.
