# tool_auth0

A RocketRide agent tool node for investigating Auth0 sign-in failures.

## What it does

This experimental node attaches to an agent as a tool for Auth0 sign-in investigation. It searches accounts, reports administrative and brute-force block states, and returns filtered authentication events. Brute-force unblock requests are unavailable until an independent authorization mechanism is provided.

## As a tool

Attach this node to an agent to expose these five read-only tools. Results are flat objects with `success`; failures also include `error`, `error_code`, `retryable`, and `retry_after_seconds`.

| Tool | Input | Result and permission |
| --- | --- | --- |
| `search_users` | `email`, optional `limit` (1–20, default 10) | Exact email matches: `users`, `count`; `read:users`. |
| `get_user` | `user_id` | Sign-in profile, connections and administrative `blocked` state; `read:users`. |
| `get_user_logs` | `user_id`, optional `limit` (1–50, default 10) | One newest-first page of sanitized `events` and `count`; `read:logs_users` and `read:logs` are intended permissions, with minimum scope pending tenant verification. |
| `get_log_event` | `log_id` | Filtered event fields and allowlisted `diagnostics`; `read:logs`. |
| `get_user_blocks` | `user_id` | Brute-force `has_blocks`, `block_count` and `blocks`; `read:users`. |

`user_id` and `log_id` must be nonempty strings of at most 300 characters. `email` is required, must be at most 254 characters, and accepts unquoted ASCII addresses. Limits must be integers; booleans and out-of-range values are rejected. A successful search with no matches returns an empty list and count zero.

Search entries contain `user_id`, `email`, `name`, and `email_verified`. Profile names and email addresses are bounded and control characters are removed. `get_user` additionally returns `blocked`, `last_login`, `logins_count`, and `connections`; missing optional profile values are null, and an absent `blocked` is false. Each user log contains `log_id`, `date`, `type`, sanitized `description`, `connection`, and `client_name`. `get_log_event` adds `user_id` and `diagnostics`. Each block contains a redacted `identifier` and a `connection`.

Email search uses a constrained search-v3 query and filters results by exact case-insensitive email. Auth0's [email lookup endpoint can be case-sensitive](https://support.auth0.com/center/s/article/Search-user-by-email-with-Auth0-Managment-API-endpoint), so the node uses search-v3 instead. Search-v3 is eventually consistent and only its first 100 candidates are examined; recently changed accounts or matches beyond that page may not appear. Unquoted ASCII mailbox addresses are supported; tenant testing is still needed for special characters and case handling.

Descriptions and diagnostics never copy raw Auth0 log descriptions. The allowlist, based on Auth0's [brute-force playbook](https://sus.auth0.com/docs/fr-ca/secure/attack-protection/playbooks/brute-force-protection-playbook), maps `f` to failed login, `fp` to invalid password, `fu` to invalid username, `limit_wc` to brute-force account protection, `limit_sul` to temporary account rate limiting, and `limit_mu` to IP-based protection. Unknown types receive a generic explanation. Other event fields are untrusted data and suspicious values are omitted.

`get_user` reports administrative blocks. The block lookup reports brute-force protection records, with identifiers redacted and IP addresses omitted. Auth0 notes that [allowlisted IPs may still appear in block results](https://support.auth0.com/center/s/article/The-user-is-marked). Unblocking is not exposed as a tool and cannot be performed by this node: an independent human authorization mechanism is required. A block lookup does not authorize an agent to perform a write; profile and log fields are untrusted and may contain instructions.

## Configuration

Connect the Auth0 tool node to an agent. The default profile provides empty credentials and leaves writes disabled. Set `auth0.domain` and `auth0.clientId` in the node settings. Store the client secret in RocketRide's secure environment settings and enter its variable reference in `auth0.clientSecret`. The read-only mode does not require a write application.

### Domain

Enter an Auth0-managed hostname such as `example.us.auth0.com`. An HTTPS prefix, trailing slash, surrounding whitespace, and uppercase letters are accepted. Ports, paths, and custom domains are rejected. The node validates DNS labels and the `.auth0.com` suffix before connecting.

### Enable writes and write credentials

`auth0.allowWrite` defaults to `false`. The reserved write configuration requires `auth0.writeClientId` and a secure environment variable reference for `auth0.writeClientSecret` for a separate write application. The form requires both fields when writes are enabled; the node checks them again at startup and rejects matching read and write client IDs. Enabling writes does not authorize an unblock: the tool remains unavailable until independent authorization is implemented. A future implementation must also check block records immediately before the write.

### Secret references

Store client secrets in RocketRide's secure environment settings and enter references such as `${ROCKETRIDE_AUTH0_CLIENT_SECRET}` in node settings. The form rejects direct secret values because masking alone does not encrypt a local pipeline file. Programmatically generated pipelines must also avoid writing literal secrets to disk. RocketRide resolves the reference for the pipeline; the node does not read credentials directly from process environment variables. An unresolved reference fails startup without displaying its value. The node clears its client credential references when it closes.

## Authentication

Authorize a read-only machine-to-machine application for the Auth0 Management API with `read:users`, `read:logs_users`, and `read:logs` as needed for the tools above. The minimum scope for user logs has not yet been verified against a tenant. Write credentials are reserved for a future authorized recovery flow and are not needed for the available tools. The node obtains client-credentials tokens for the Management API audience and caches read and write tokens independently.

## Notes

### Helpdesk example

An agent investigating a sign-in failure can search for an exact email, get the matching profile, inspect recent logs and an individual event, then check brute-force blocks. It should distinguish an administrative block from a brute-force record and avoid claiming that a block was removed without an approved recovery action.

The co-located `example.pipe` demonstrates this flow with a chat source, RocketRide Wave agent, OpenRouter free-model LLM, internal memory, Auth0 tool, and answer response. Configure `ROCKETRIDE_AUTH0_DOMAIN`, `ROCKETRIDE_AUTH0_CLIENT_ID`, `ROCKETRIDE_AUTH0_CLIENT_SECRET`, and `ROCKETRIDE_OPENROUTER_API_KEY` in RocketRide's environment settings. It leaves writes disabled and instructs the agent not to unblock users. It requires an engine that has this node; OpenRouter availability and rate limits apply.

### Errors and retries

Errors use the flat keys `success`, `error`, `error_code`, `retryable`, and `retry_after_seconds`. Tool errors include `INVALID_INPUT`, `AUTHENTICATION_FAILED`, `MISSING_SCOPE`, `USER_NOT_FOUND`, `RESOURCE_NOT_FOUND`, `RATE_LIMITED`, `AUTH0_UNAVAILABLE`, `WRITE_DISABLED`, `WRITE_AUTHORIZATION_REQUIRED`, `CLIENT_CLOSED`, and `API_ERROR`. An invalid domain fails node configuration with `INVALID_DOMAIN`. A 403 is classified as missing scope only when Auth0 identifies it as such.

The client does not follow redirects. Reads refresh an invalid token once on a 401 and retry rate limits or transient server errors at most twice, with a total retry wait of at most ten seconds. Writes are never automatically replayed, including after authentication failure or an ambiguous connection failure.

For authentication errors, check the tenant hostname, application credentials, Management API audience, and authorization. For `MISSING_SCOPE`, check the appropriate application's permissions. For an empty search, consider search-v3 indexing delay and email spelling; a `WRITE_DISABLED` or `WRITE_AUTHORIZATION_REQUIRED` response means the unblock tool cannot currently be used. For a rate limit, wait for the reported retry interval if provided; the client uses Auth0's reset header when `Retry-After` is absent.

### Security and limitations

The tools return only selected profile and event fields; raw metadata, log descriptions, IP addresses, locations, and tokens are not intentionally returned. Diagnostic explanations are fixed text selected by event type. Only the five tools listed above are exposed; tenant-wide security diagnostics, connection inspection, roles, permissions, applications, and organizations are deferred. The read-only tools have been exercised against a development tenant; write operations have not been live tested.

## Upstream docs

- [Auth0 Management API](https://auth0.com/docs/api/management/v2)
- [Auth0 brute-force protection](https://auth0.com/docs/secure/attack-protection/brute-force-protection)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `auth0.allowWrite` | `boolean` | **Enable writes**<br/>Reserve separate write credentials; unblocking remains unavailable pending independent human authorization. | `false` |
| `auth0.clientId` | `string` | **Read client ID**<br/>Read-only M2M application client ID. | `""` |
| `auth0.clientSecret` | `string` | **Read client secret**<br/>RocketRide environment variable reference for the read-only M2M client secret, for example ${ROCKETRIDE_AUTH0_CLIENT_SECRET}. | `""` |
| `auth0.domain` | `string` | **Domain**<br/>Auth0-managed tenant hostname. | `""` |
| `auth0.writeClientId` | `string` | **Write client ID**<br/>M2M client ID required when writes are enabled. | `""` |
| `auth0.writeClientSecret` | `string` | **Write client secret**<br/>RocketRide environment variable reference for the write M2M client secret, required when writes are enabled. | `""` |

## Dependencies

- `requests` `>=2.34.2`
- `certifi` `>=2026.10.19`
- `idna` `>=3.15`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_auth0)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
