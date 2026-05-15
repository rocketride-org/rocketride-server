# 0002: Persistent Memory Session Contract

## Status

Proposed

## Context

The persistent memory node stores conversation state across pipeline runs. Review
feedback on the initial implementation called out that the contract was not
explicit enough: a pipeline needs a stable `session_id`, the node needs to know
where that identifier comes from, and downstream nodes need predictable behavior
when the same logical conversation is resumed.

The node cannot rely on process-local state because pipeline runs may happen on
different workers. It also should not require callers to mutate the
`Question`/`Answer` schema for a feature that belongs to node configuration and
runtime metadata.

## Decision

The persistent memory node treats `session_id` as an explicit node input resolved
in this order:

1. A configured `session_id` field on the memory node, when set.
2. A runtime metadata value named `session_id`, when the engine provides it.
3. A deterministic fallback derived from the pipeline/task identity, only when
   the node is configured to allow fallback sessions.

The resolved `session_id` is used only as the key for the configured memory
backend. The node does not inject it into arbitrary question text and does not
depend on a hidden `Question.metadata` mutation for correctness. When a
`Question` or `Answer` object exposes metadata fields, the node may copy the
resolved `session_id` there for observability, but storage and retrieval are
driven by the resolved node/runtime value.

The node must make session behavior visible:

- If no session can be resolved, the node raises a configuration/runtime error
  instead of silently creating anonymous shared memory.
- If a fallback session is used, the node emits a warning so pipeline authors
  can decide whether to make the session explicit.
- If a backend reports an expired or missing session, the node returns the same
  missing-session shape across read, write, list, clear, and history paths.

## Consequences

### Positive

- Cross-run continuity is explicit and testable.
- The persistent memory feature does not require a schema migration before it
  can be reviewed.
- Pipeline authors can choose stable conversation keys without relying on
  process-local state.
- Backend behavior remains consistent when sessions expire.

### Negative

- Pipelines that want durable memory must provide or propagate a session
  identifier deliberately.
- Fallback sessions are useful for demos but should be treated as non-production
  behavior.
- If later schema-level metadata becomes the preferred engine contract, this ADR
  should be revisited and superseded with that common metadata channel.
