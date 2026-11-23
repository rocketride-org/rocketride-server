# tool_auth0

A RocketRide agent tool node for investigating Auth0 sign-in failures.

## What it does

This experimental node attaches to an agent as a read-only Auth0 tool. It looks up user accounts, reports administrative and brute-force block states, and returns filtered authentication events.

## As a tool

Attach this node to an agent to expose five read-only tools. Each tool returns a flat object with a `success` flag. On success, the result fields appear at the top level. On failure, the object includes `error`, `error_code`, `retryable`, and `retry_after_seconds`.

| Tool | Input | Result and permission |
| --- | --- | --- |
| `search_users` | `email`, optional `limit` (1–20, default 10) | Exact, case-sensitive email matches: `users`, `count`; `read:users`. |
| `get_user` | `user_id` | Sign-in profile, connections and administrative `blocked` state; `read:users`. |
| `get_user_logs` | `user_id`, optional `limit` (1–50, default 10) | One newest-first page of sanitized `events` and `count`; `read:logs_users` or `read:logs`. |
| `get_log_event` | `log_id` | Filtered event fields and allowlisted `diagnostics`; `read:logs`. |
| `get_user_blocks` | `user_id` | Brute-force `has_blocks`, `block_count` and `blocks`; `read:users`. |

`user_id` and `log_id` must be nonempty strings of at most 300 characters. Identifiers consisting only of whitespace, `.` or `..` are rejected. `email` is required, must be at most 254 characters, and accepts unquoted ASCII addresses. Limits must be integers within the stated range. A successful search with no matches returns an empty list and count zero.

Search entries contain `user_id`, `email`, `name`, and `email_verified`. Profile names and email addresses are bounded and control characters are removed. `get_user` additionally returns `blocked`, `last_login`, `logins_count`, and `connections`; missing optional profile values are null, and an absent `blocked` is false. Each user log contains `log_id`, `date`, `type`, sanitized `description`, `connection`, and `client_name`. `get_log_event` adds `user_id` and `diagnostics`. Each block contains a redacted `identifier` and a `connection`.

Connection names come from at most 100 identities and are limited to 300 printable characters. Tool arguments must be objects with only the properties listed in the tool schema. Malformed arguments return `INVALID_INPUT`.

Email lookup uses Auth0's [`GET /users-by-email` endpoint](https://auth0.com/docs/api/management/v2/users-by-email/get-users-by-email). Enter the email with the capitalization stored in Auth0. When Auth0 is the identity provider, it stores email addresses in lowercase. The tool applies `limit` to the matches returned by Auth0.

Descriptions and diagnostics never copy raw Auth0 log descriptions. The allowlist maps `f` to failed login, `fp` to invalid password, `fu` to invalid username, `limit_sul` to temporary account rate limiting, and `limit_mu` to IP-based protection. In [Auth0's tenant log reference](https://auth0.com/docs/tenant-logs), `limit_wc` indicates that brute-force protection blocked logins from an IP address after repeated failures against one account. Check the profile's `blocked` field separately for an administrative block. Unknown types receive a generic explanation. Other event fields are untrusted data and suspicious values are omitted.

`get_user` reports administrative blocks. The block lookup reports brute-force protection records, with identifiers redacted and IP addresses omitted. Auth0 notes that [allowlisted IPs may still appear in block results](https://support.auth0.com/center/s/article/The-user-is-marked). The node is read-only. Treat profile and log fields as untrusted data.

## Configuration

Connect the Auth0 tool node to an agent. The default profile provides empty credentials. Create an Auth0 machine-to-machine application, authorize it for the Management API with the permissions needed by the chosen tools, and set `auth0.domain` and `auth0.clientId` in the node settings. Store the client secret in RocketRide's secure environment settings and enter its variable reference in `auth0.clientSecret`.

### Domain

Enter an Auth0-managed hostname such as `example.us.auth0.com`. An HTTPS prefix, trailing slash, surrounding whitespace, and uppercase letters are accepted. Ports, paths, and custom domains are rejected. The node validates DNS labels and the `.auth0.com` suffix before connecting.

### Secret references

Store client secrets in RocketRide's secure environment settings and use references such as `${ROCKETRIDE_AUTH0_CLIENT_SECRET}` in pipeline configuration. The form rejects direct secret values because masking alone does not encrypt a local pipeline file. Programmatically generated pipelines must also avoid writing literal secrets to disk. The reference must remain visible in the pipeline configuration for RocketRide's environment substitution: if it is stored inside a `secureParameters` token, decoding occurs after substitution and the reference remains unresolved. This includes configurations where the editor or validation wraps the reference in a token; use a pipeline configuration that retains the plain reference. The node does not read credentials directly from process environment variables, and an unresolved reference fails startup without displaying its value. The node clears its client credential references when it closes.

## Authentication

Authorize a read-only machine-to-machine application for the Auth0 Management API. Grant `read:users` for account and block lookups, `read:logs_users` for recent user events, and `read:logs` for individual log events. The node obtains and caches a client-credentials token for the Management API audience. Live testing has yet to establish whether `read:logs_users` alone is sufficient for recent user events.

## Notes

### Helpdesk example

An agent investigating a sign-in failure can search for an exact email, get the matching profile, inspect recent logs and an individual event, then check brute-force blocks. It should distinguish an administrative block from a brute-force record and avoid claiming that a block was removed without an approved recovery action.

The co-located `example.pipe` uses a chat source, RocketRide Wave agent, Ollama model, internal memory, Auth0 tool, and answer response. The model receives the conversation, including the user's email, and summaries of selected Auth0 profile, log, and block data in later prompts. Use a self-hosted Ollama server and a model your organization has approved to process this tenant data.

1. Open the pipeline with a RocketRide engine that includes this node. In the Ollama node's **Custom** profile, set **LLM URL** to the approved Ollama server and **Model** to a model installed on that server. The example ships with both fields empty. If Ollama runs on the same host as the RocketRide engine, use its loopback address.
2. Configure `ROCKETRIDE_AUTH0_DOMAIN`, `ROCKETRIDE_AUTH0_CLIENT_ID`, and `ROCKETRIDE_AUTH0_CLIENT_SECRET` in RocketRide's environment settings for the tenant's read-only Auth0 application.
3. Verify the endpoint and model settings with sample data before entering a real user's email.

### Errors and retries

Errors use the flat keys `success`, `error`, `error_code`, `retryable`, and `retry_after_seconds`. Tool errors include `INVALID_INPUT`, `AUTHENTICATION_FAILED`, `MISSING_SCOPE`, `USER_NOT_FOUND`, `RESOURCE_NOT_FOUND`, `RATE_LIMITED`, `AUTH0_UNAVAILABLE`, `CLIENT_CLOSED`, and `API_ERROR`. An invalid domain fails node configuration with `INVALID_DOMAIN`. A 403 is classified as missing scope only when Auth0 identifies it as such.

The client does not follow redirects. Management API reads refresh an invalid token once on a 401 and retry HTTP 429 or 5xx responses at most twice, with a total retry wait of at most ten seconds. Network exceptions and token-acquisition failures are returned without those request retries.

For authentication errors, check the tenant hostname, application credentials, Management API audience, and authorization. For `MISSING_SCOPE`, check the appropriate application's permissions. If a lookup returns no matches, check the email spelling and capitalization. For a rate limit, wait for the reported retry interval if provided. The client uses Auth0's reset header when `Retry-After` is absent.

### Security and limitations

Email and user detail lookups ask Auth0 for specific response fields. The user detail request includes `identities` to extract connection names. Keep the machine-to-machine application's grants limited to the scopes listed above. Auth0 can include identity-provider tokens in user details when the application has `read:user_idp_tokens`.

The tools return selected profile, authentication-event, and block fields. Diagnostic explanations use fixed text for each recognized event type. The live verification guide records the development-tenant results and pending checks.

## Upstream docs

- [Auth0 Management API](https://auth0.com/docs/api/management/v2)
- [Auth0 brute-force protection](https://auth0.com/docs/secure/attack-protection/brute-force-protection)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `auth0.clientId` | `string` | **Client ID**<br/>Read-only M2M application client ID. | `""` |
| `auth0.clientSecret` | `string` | **Client secret**<br/>Enter a RocketRide variable reference such as ${ROCKETRIDE_AUTH0_CLIENT_SECRET} to keep the read-only M2M client secret out of the pipeline file. | `""` |
| `auth0.domain` | `string` | **Domain**<br/>Auth0-managed tenant hostname. | `""` |

## Dependencies

- `requests`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_auth0)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
