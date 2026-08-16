# trust_boundary

A RocketRide filter node that mitigates Excessive Agency and Insecure Output Handling by intercepting tool invocations and enforcing permission-scoped authorization policies.

## What it does

Functions as a context-aware middleware gate for multi-agent frameworks (CrewAI). It:

1. **Intercepts** tool calls at the PRE_TOOL_CALL lifecycle boundary
2. **Evaluates** each call against configured permission scopes (allow/deny lists with glob patterns)
3. **Enforces** rate limits, argument schema validation, and run-level payload policies
4. **Logs** all authorization decisions for security audit

Uses default-deny semantics: any tool/agent not explicitly scoped is blocked. Deny lists always take precedence over allow lists.

---

## Configuration

### Lanes

| Lane in     | Lane out    | Description                                   |
|-------------|-------------|-----------------------------------------------|
| `questions` | `questions` | Forwarded to downstream nodes                 |

### Fields

| Field | Type | Description | Default |
|---|---|---|---|
| `enable_tool_interception` | boolean | Intercept tool calls for authorization | `true` |
| `enable_run_policy` | boolean | Validate execution payloads at run start | `false` |
| `abort_on_unauthorized` | boolean | Block unauthorized calls (false = log only) | `true` |
| `audit_log` | boolean | Log all auth decisions with timestamps | `true` |
| `permission_scopes` | array | List of scope objects (max 50) | `[]` |
| `payload_schema` | object | JSON Schema for payload validation (optional) | `null` |

---

## Profiles

| Profile | Behaviour |
|---------|-----------|
| Default | Intercept + audit, no run policy. |
| Strict | All enforcement enabled (interception + run policy + abort). |
| Audit Only | Log decisions without blocking. |

---

## Permission scopes

Each scope object defines:

| Field | Type | Description |
|---|---|---|
| `scope_id` | string | Unique identifier |
| `allowed_tools` | array | Glob patterns for permitted tools (`*`, `?` wildcards) |
| `denied_tools` | array | Glob patterns for explicitly denied tools (takes precedence) |
| `allowed_agents` | array | Agent IDs covered by this scope (`"*"` = all agents) |
| `max_calls_per_run` | number | Max authorized calls per run (0 = unlimited) |
| `require_args_schema` | object | JSON Schema that tool args must satisfy (optional) |

**Evaluation order**: denied_tools → allowed_tools → rate limit → args schema.

---

## Run-level policy

When `enable_run_policy` is true and `payload_schema` is set:

1. Unknown keys are stripped recursively from the execution payload
2. Sanitized payload is validated against the JSON Schema
3. If validation fails, `HookAborted` is raised and execution does not proceed

---

## Graceful degradation

- If `jsonschema` is not available: run-level policy enforcement is disabled (warning logged)
- If `crewai` is not available: falls back to passthrough mode with audit-only logging

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
