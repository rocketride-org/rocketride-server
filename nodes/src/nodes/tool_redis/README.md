# tool_redis

An experimental RocketRide tool node for namespaced key/value utilities in Redis and Valkey: cache entries, temporary app state and explicit counters.

## About Redis

Redis and Valkey are networked data stores supporting key/value operations and expiration. Applications use them for shared caches and short-lived state.

## What it does

This tool-only node attaches to an agent through its Tool control connection, or to a Tools source for direct SDK calls. It has no data lanes. It exposes seven explicit operations; the app or agent decides when to call them. It does not automatically cache answers, maintain conversation history or implement a rate limiter.

## As a tool

Bare tool IDs below are used with `client.tool(token=token, tool=..., node_id='redis_1', input={...})`. Arguments must be an object, including an empty object for a default SCAN. JSON-encoded objects and model argument objects are normalized through the shared helper; malformed JSON, arrays, scalars and null are rejected. Every input object rejects unknown fields and null values. `key` means a nonempty logical UTF-8 key; the namespace is always prepended, and the complete key must fit in 256 UTF-8 bytes. Values are strings only. All serialized tool results are capped at 128 KiB using ASCII-escaped JSON size.

| Tool | Inputs | Success result | Redis command / access |
|---|---|---|---|
| `redis_get` | Required `key` | `key`, `found`, `value` (string or null), `ttl_seconds` | GETRANGE + TTL in MULTI/EXEC; read |
| `redis_set` | Required `key`, `value` (up to configured cap, at most 64 KiB UTF-8); optional integer `ttl_seconds` 0–2147483647 and `condition` NX or XX | `key`, `stored`, `requested_ttl_seconds` | SET with EX/NX/XX; write |
| `redis_ttl` | Required `key` | `key`, `exists`, `has_expiry`, `ttl_seconds` | TTL; read |
| `redis_expire` | Required `key`, integer `ttl_seconds` 1–2147483647 | `key`, `updated`, `requested_ttl_seconds` | EXPIRE; write |
| `redis_incr` | Required `key`; optional `amount`, a signed 64-bit decimal string, default `"1"` | `key`, `value_decimal` (string) | INCRBY; write |
| `redis_scan` | Optional unsigned 64-bit decimal string `cursor`, default `"0"`; integer `count` 1–500, default 100 | `cursor`, `keys` (logical names), `done` | One SCAN MATCH namespace* COUNT per call; read |
| `redis_delete` | Required `keys`, an array of 1–100 explicit logical keys; wildcard syntax is rejected | `deleted_count` | DEL; write |

Every successful result also has `success: true`. Errors have `success: false`, `error_code`, sanitized `error`, and `outcome` (`not_applied` or `unknown`). Codes include invalid_input, invalid_encoding, value_too_large, result_too_large, invalid_operation, permission_denied, authentication_error, connection_error, invalid_host and not_initialized. Missing keys and conditional SET refusal are successful outcomes, not exceptions. Error messages never echo passwords or raw server exceptions. A connection failure on a mutation has unknown outcome: it may already have executed. No command is automatically retried; inspect state before deciding to retry, especially for INCR.

GET distinguishes an empty string from a missing key. It fetches at most the value cap plus one byte and checks overflow before UTF-8 decoding. Binary, wrong-type, oversized values and oversized serialized results produce explicit errors. TTL is -2 for missing, -1 for persistent, otherwise remaining seconds. These are observations, not promises that a later call sees the same state.

SET defaults to a 3600-second expiry; 0 means persistent. A successful overwrite replaces the previous value and expiry and can replace another Redis data type. NX means only if absent, XX only if present; `stored: false` means the condition skipped the write. EXPIRE accepts positive seconds only; `updated: false` means missing. Reported requested TTL values are intent, not measured remaining lifetime.

INCRBY is atomic, preserves an existing expiry and creates a persistent key if missing. It does not attach an expiry automatically; a separate EXPIRE call is not atomic with INCR. Both input amount and output value use decimal strings to preserve signed 64-bit precision across JavaScript. Wrong types, malformed integers and overflow return errors without changing the value.

SCAN returns one complete server page, never a silently truncated page. COUNT is a work hint, not a hard key-count limit; pages can be empty before completion, contain duplicates, and vary during concurrent writes. Only cursor `"0"` means finished. The node validates every returned namespace and strips exactly one prefix. Foreign malformed/binary/oversized keys and results over 128 KiB return errors; retrying with a smaller count may help, but is not guaranteed. SCAN can still cause the client to receive a larger server reply before the serialized-result check. Use a dedicated namespace and Redis ACLs; a prefix is not per-user authorization.

## Configuration

Targets standalone Redis 7.0+ or Valkey 7.2+. Cluster, Sentinel, custom CA/mTLS fields, streams, compare-and-set, publish, listeners, dashboard and worker orchestration are outside v1. The engine passes no caller identity to this node, so it cannot promise per-user isolation.

### Host

Use a hostname/IP plus Port (1–65535), or `rediss://host:port` to enable TLS. URL credentials, paths, query strings and fragments are rejected; configure username/password/database in their own fields. Local engines can use localhost or private networks. On hosted/shared engines, TLS is required and every DNS result must be public. DNS is checked initially and for every new connection. Connections use the validated numeric addresses, and the connected peer is checked before the TLS handshake or Redis authentication. The original hostname is restored for TLS certificate and hostname verification. No user-configurable switch bypasses hosted checks. Network egress controls remain recommended.

### Key prefix

Required, 1–128 literal ASCII characters from `[A-Za-z0-9:_-]`. Choose an app/environment namespace such as `rr:answer-cache:dev:`. With `rr:demo:` configured, logical `item` means `rr:demo:item`; logical `rr:demo:item` means `rr:demo:rr:demo:item`. No prefix is auto-stripped from input.

### Allow writes

Defaults to false. SET, EXPIRE, INCR and DELETE all enforce this guard, including direct SDK invocation. Read tools remain available. There is no arbitrary command interface or approval workflow in the node.

### Default TTL (seconds)

Defaults to 3600; 0 deliberately creates persistent SET values. Eviction and server persistence are separate deployment choices. INCR does not inherit this default.

### Maximum value bytes

Can reduce the 64 KiB UTF-8 cap; cannot increase it. Serialize structured values as JSON explicitly. A 128 KiB serialized-result cap applies independently, so heavy JSON escaping can reject a valid-size stored value on GET.

### Use TLS

Requires certificate and hostname verification against the Python/OpenSSL trust store. No insecure bypass is exposed. For a local test CA, configure the engine process trust store before launch; do not disable verification.

A single owned connection pool is reused per node/pipeline: connect timeout 3 seconds, socket timeout 5 seconds, max_connections 10. Timeouts are per socket operation, not a total wall-clock deadline. An exhausted pool fails rather than waiting indefinitely. Startup PING checks connectivity; configuration-only opens install nothing and never connect. Both client and pool are closed on shutdown or failed startup.

## Authentication

Supply an optional Redis ACL username and the password in the secure configuration field, optionally using `${ROCKETRIDE_REDIS_PASSWORD}` as a RocketRide secret reference. The node does not read credential environment variables directly. Resolve secrets through the platform. Test harness environment variables are separate from runtime credential handling.

Grant PING for startup; GETRANGE, TTL, MULTI and EXEC for GET; SCAN for discovery; SET, EXPIRE, INCRBY and DEL only for the mutations the account needs. Restrict key access to the intended namespace and avoid broad administrator permissions. SCAN visibility is not a replacement for server-level access policy. Passwords are excluded from settings repr and sanitized errors.

## Notes

### Development and CI

Disable writes when checking an unverified agent/model. Zero client retries
does not prevent an agent from selecting the same tool more than once: each
successful `redis_incr` call increments again. A local `qwen2.5:3b` walkthrough
reported four separate increments for one request and repeated reads until the
reasoning limit. This remains an agent/model integration issue, not an
exactly-once guarantee from this node. Use direct SDK calls for a controlled
write demonstration and review the agent behavior before enabling its writes.

The supplied `example.pipe` is a read-only Tools-source example with `mode: Source` for the Development panel. Enable writes explicitly for local exercises, or attach the node to an agent and provide an LLM. SDK engine tests call all seven tools without a model; agent-driven testing requires your own model credentials.

For a local agent walkthrough, [agent-example.pipe](agent-example.pipe) connects
Chat, LlamaIndex, Gemini Flash and Redis using catalog nodes. It uses
`models/gemini-3.6-flash` with `${ROCKETRIDE_GEMINI_KEY}`, explicit one-operation
instructions, and read-only Redis access by default. Copy
`nodes/test/tool_redis/gemini.env.example` to `.env.gemini.local` at the repository
root, paste your key there, then run `sh nodes/test/tool_redis/start_gemini_demo.sh`.
See `nodes/test/tool_redis/README.md` for engine paths and acceptance testing.
The optional [agent-ollama-example.pipe](agent-ollama-example.pipe) preserves the
previous local Qwen setup. For disposable write tests, choose a unique prefix,
configure the test port and enable writes explicitly.
The agent bridge must carry the real input schemas in its Tool Args metadata.
The earlier 3B walkthrough is not evidence that an arbitrary model is suitable
for writes, and successful local examples do not guarantee every future plan.

Unit tests extend `nodes/test/mocks/redis_fake`; there is no mock package named redis. Live tests skip unless `REDIS_TEST_URL` is set. Use disposable Valkey 8.1.11 and unique namespaced test keys. Tests remove only their own keys. Authentication/TLS tests additionally require REDIS_AUTH_TEST_URL, REDIS_TLS_TEST_URL and REDIS_TLS_CA_FILE. See `nodes/test/tool_redis/README.md` for commands and the proposed CI job.

`services.json` declares configuration cases plus tool-call metadata consumed by `test_live.py`. The generic lane framework alone only smoke-tests pure-tool configuration; the dedicated engine test provides real tool-dispatch assertions. The proposed Valkey CI job needs reviewer approval. Local passing tests are not CI execution evidence.

## Upstream docs

- [Redis SCAN](https://redis.io/docs/latest/commands/scan/)
- [Redis INCRBY](https://redis.io/docs/latest/commands/incrby/)
- [Redis EXPIRE](https://redis.io/docs/latest/commands/expire/)
- [Redis SET](https://redis.io/docs/latest/commands/set/)
- [Redis TTL](https://redis.io/docs/latest/commands/ttl/)
- [redis-py connections](https://redis.io/docs/latest/develop/clients/redis-py/connect/)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `tool_redis.allow_writes` | `boolean` | **Allow writes**<br/>Enable SET, EXPIRE, INCR and DELETE. Read-only by default; every mutation checks this setting. | `false` |
| `tool_redis.db` | `integer` | **Database**<br/>Standalone logical database index; must exist on the server. | `0` |
| `tool_redis.default_ttl_seconds` | `integer` | **Default TTL (seconds)**<br/>Expiry when SET omits ttl_seconds; 0 means persistent. SET replaces an existing expiry. | `3600` |
| `tool_redis.host` | `string` | **Host**<br/>Redis host reachable from the engine, or rediss://host:port for TLS. Cloud requires TLS and exclusively public addresses; local engines allow localhost. | `"localhost"` |
| `tool_redis.key_prefix` | `string` | **Key prefix**<br/>Required literal app/environment namespace using letters, digits, colon, underscore or hyphen. Always prepended; not per-user authorization. | `"rr:"` |
| `tool_redis.max_connections` | `integer` | **Maximum connections**<br/>Finite pool size per node/pipeline; exhausted pools return an error rather than waiting indefinitely. | `10` |
| `tool_redis.max_value_bytes` | `integer` | **Maximum value bytes**<br/>UTF-8 payload cap, at most 64 KiB. Serialized results are additionally capped at 128 KiB. | `65536` |
| `tool_redis.password` | `string` | **Password**<br/>Redis password or a RocketRide secret reference. Stored as a secure credential field. | `""` |
| `tool_redis.port` | `integer` | **Port**<br/>Redis endpoint port. | `6379` |
| `tool_redis.socket_connect_timeout` | `number` | **Connect timeout (seconds)**<br/>Maximum time for a connection attempt. | `3` |
| `tool_redis.socket_timeout` | `number` | **Socket timeout (seconds)**<br/>Maximum socket wait per command. No automatic command retries. | `5` |
| `tool_redis.use_tls` | `boolean` | **Use TLS**<br/>Enable TLS with required certificate and hostname verification. | `false` |
| `tool_redis.username` | `string` | **Username**<br/>Optional Redis ACL username. | `""` |

## Dependencies

- `redis` `>=7.1,<8`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_redis)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
