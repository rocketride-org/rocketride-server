# tool_http_request

A RocketRide tool node that lets an AI agent make guarded HTTP requests to public API endpoints.

## About HTTP

HTTP is the request-and-response protocol used by web APIs. An HTTP request names a URL,
method, headers, credentials, and optional body, while a response carries status, headers,
and content.

## What it does

This node provides one controlled HTTP client for an agent and has no pipeline lanes. Pick
it when the agent must call a public API endpoint directly; use a product-specific tool when
that service already has a dedicated node and richer operations. Method switches, URL
patterns, the network boundary, and rate limits are enforced before every request.

## As a tool

The hidden server-name setting defaults to `http`, so the registered function is
`http.http_request` by default.

| Function | Description |
| --- | --- |
| `http.http_request` | Makes one guarded HTTP request and returns its completed response. |

`url` and `method` are required. The method must be one of GET, POST, PUT, PATCH,
DELETE, HEAD, or OPTIONS and must be enabled in configuration. Optional inputs include
headers, query parameters, path parameters, timeout, advanced authentication and body
objects, plus `body_json`, `bearer_token`, and `basic_auth` shortcuts. A completed
response—including a non-2xx HTTP response—returns `status_code`, `status_text`,
`headers`, `body`, `json`, `elapsed_ms`, and `content_type`.

Invalid input, disabled methods, whitelist rejection, rate-limit rejection, and transport
errors raise tool errors. A parsed JSON field is null when the response type is not JSON-like
or cannot be parsed; the raw text remains in `body`.

## Configuration

Use the default method set for a broad but controlled API agent, then limit endpoints and
throughput for the services it is allowed to reach. The server name changes the function
namespace and should be stable once an agent prompt refers to it.

### Allowed methods

GET, POST, PUT, PATCH, and DELETE are enabled by default; HEAD and OPTIONS are disabled.
Enable only methods that the intended API flow needs, especially before giving an agent
access to a URL where mutation is possible.

### URL Whitelist

An empty whitelist allows every public URL; non-public network destinations remain blocked
either way. Non-empty patterns are matched against the request URL, so anchor them when the
endpoint scope must be exact, for example `^https://api.example.com/`. Path-parameter
replacements are percent-encoded to remain a single URL path segment.

### Network boundary

Private, loopback, link-local, and multicast destination addresses are blocked. Redirects
are returned to the agent as 3xx responses and are not followed automatically. There is no
private-network override: localhost and internal endpoints are intentionally unsupported.

### Rate limits

The defaults are 10 requests per second, 100 per minute, and five concurrent requests.
The token buckets and concurrency limit reject immediately rather than queue, so an agent
must retry later after a limit error. Set all three values explicitly to zero to disable
limiting; otherwise each configured value is clamped to at least one.

## Authentication

This node has no stored service credential: provide credentials per request. The simple
shortcuts set bearer or Basic authentication when the equivalent advanced object is absent.
Advanced authentication supports `none`, `basic`, `bearer`, and an API key placed in a
header or query parameter.

## Notes

### Request bodies and timeout

`body_json` serializes objects and arrays as JSON; a string is used verbatim. The advanced
body supports raw content, multipart form data, and URL-encoded form data. Timeout defaults
to 30 seconds, caps positive values at 300 seconds, and treats zero or negative values as
the default.

## Upstream docs

- [HTTP documentation at MDN](https://developer.mozilla.org/docs/Web/HTTP)

<!-- Legacy pre-schema prose retained below only while the generated documentation is preserved. -->

### What it does

Exposes a single agent-callable tool, `http_request`, registered as
`<serverName>.http_request` (default: `http.http_request`). The agent provides the full
request (method, URL, headers, query/path parameters, auth, and body) and receives a
structured response containing status, headers, body text, parsed JSON, and timing.

Uses the **requests** library to execute calls. The node has no lanes; it is attached to
an agent purely as a tool.

Four security guardrails are enforced before every request:

- **Allowed methods**: per-method toggles. `GET`, `POST`, `PUT`, `PATCH`, `DELETE` are
  enabled by default; `HEAD` and `OPTIONS` are disabled by default.
- **URL whitelist**: regex patterns the request URL must match. **Empty by default,
  which allows all public URLs** (config validation emits a warning when the whitelist is
  empty).
- **Network boundary**: private, loopback, link-local, and multicast destination addresses
  are blocked. Redirects are returned to the agent as 3xx responses and are not followed
  automatically. There is no private-network override: localhost and internal endpoints are
  intentionally unsupported.
- **Rate limiting**: token-bucket limits per second and per minute, plus a concurrency
  cap. On by default (10/s, 100/min, 5 concurrent).

---

### Configuration


| Field | Type | Description |
|---|---|---|
| `serverName` | string | Default "http". Namespace prefix for the tool: <serverName>.http_request |
| `allowGET` | boolean | Default true.  |
| `allowPOST` | boolean | Default true.  |
| `allowPUT` | boolean | Default true.  |
| `allowPATCH` | boolean | Default true.  |
| `allowDELETE` | boolean | Default true.  |
| `allowHEAD` | boolean | Default false.  |
| `allowOPTIONS` | boolean | Default false.  |
| `whitelistPattern` | string | Default empty.  |
| `urlWhitelist` | array | Regex patterns for allowed public URLs. A request URL must match at least one pattern. If empty, all public URLs are allowed; non-public network destinations remain blocked. |
| `rateLimitPerSecond` | number | Default 10. Maximum number of HTTP requests allowed per second. Uses a token-bucket algorithm for smooth enforcement. |
| `rateLimitPerMinute` | number | Default 100. Maximum number of HTTP requests allowed per minute. Provides a broader throttle beyond the per-second limit. |
| `maxConcurrentRequests` | number | Default 5. Maximum number of HTTP requests that can be in-flight simultaneously. |


The node ships one profile, **Default**, which sets `serverName` to `http`.

An invalid non-empty whitelist regex now fails configuration validation rather than being
skipped, so a typo can no longer silently widen the restriction. Blank or whitespace-only
placeholder rows are ignored; a whitelist made only of them allows all public destinations.

---

### Available tools


| Tool | Description |
|---|---|---|
| `http_request` | Make an HTTP request. Required: "url" and "method". For JSON bodies, pass "body_json" as a JSON object (e.g. {"name": "foo"}), it is serialized automatically. For bearer auth, pass "bearer_token" as a string. For basic auth, pass "basic_auth": {"username": "...", "password": "..."}. Optional: "headers", "query_params", "path_params", "timeout" (seconds, default 30, max 300). |


### Required parameters

| Parameter | Description                                                   |
|-----------|---------------------------------------------------------------|
| `url`     | Full URL, e.g. `https://api.example.com/users/1`              |
| `method`  | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, or `OPTIONS` |

### Convenience shortcuts

These cover the common cases without the verbose `auth` / `body` objects. Each shortcut
is only applied when the corresponding advanced field is not also set.

| Parameter      | Description                                                                 |
|----------------|-----------------------------------------------------------------------------|
| `body_json`    | JSON object or array, passed directly, serialized automatically and sent as raw `application/json` |
| `bearer_token` | Token string, sent as an `Authorization: Bearer ...` header                |
| `basic_auth`   | `{username, password}` for HTTP basic auth                                  |

### Optional parameters

| Parameter      | Description                                                              |
|----------------|---------------------------------------------------------------------------|
| `query_params` | Key-value pairs appended to the URL as the query string                  |
| `headers`      | Custom request headers                                                   |
| `path_params`  | Replacements for `:name` placeholders in the URL (e.g. `{"id": "123"}` replaces `:id`) |
| `timeout`      | Request timeout in seconds. Default `30`, capped at `300`.               |
| `auth`         | Advanced auth config (see Authentication below). Prefer the shortcuts.   |
| `body`         | Advanced body config (see Request bodies below). Prefer `body_json`.     |

### Response

```json
{
  "status_code": 200,
  "status_text": "OK",
  "headers": { ... },
  "body": "...",
  "json": { ... },
  "elapsed_ms": 142,
  "content_type": "application/json"
}
```

`json` is populated automatically when the response `Content-Type` contains `json` (or
`javascript`) and the body parses; otherwise it is `null` and the raw text is in `body`.
`elapsed_ms` is wall-clock request time in milliseconds.

---

### Authentication

The `auth` object supports `type`: `none`, `basic`, `bearer`, or `api_key`.

| Type      | Fields                                            | Effect                                                       |
|-----------|---------------------------------------------------|--------------------------------------------------------------|
| `basic`   | `basic: {username, password}`                     | HTTP basic auth                                              |
| `bearer`  | `bearer: {token}`                                 | `Authorization: Bearer <token>` header                       |
| `api_key` | `api_key: {key, value, add_to}`                   | Adds `key: value` as a header (`add_to: "header"`, the default) or query parameter (`add_to: "query_param"`) |

For the common cases, the `bearer_token` and `basic_auth` shortcuts are simpler and
expand to the same thing.

---

### Request bodies

The `body` object supports `type`: `none`, `raw`, `form_data`, or `x_www_form_urlencoded`.

| Type                     | Fields                          | Effect                                                                |
|--------------------------|---------------------------------|------------------------------------------------------------------------|
| `raw`                    | `raw: {content, content_type}`  | Sends `content` as-is. `content_type` must be one of `application/json` (default), `application/xml`, `text/html`, `text/javascript`, `text/plain`; it becomes the `Content-Type` header unless one is already set. |
| `form_data`              | `form_data: {key: value, ...}`  | Sent as a `multipart/form-data` envelope                              |
| `x_www_form_urlencoded`  | `urlencoded: {key: value, ...}` | Sent as URL-encoded form fields                                       |

For JSON payloads, prefer the `body_json` shortcut, pass the object directly and it is
serialized and wrapped as raw `application/json` automatically.

---

### Rate limiting

Three independent limits are enforced per node (shared across all calls):

- **Per-second**: token bucket, capacity and refill rate equal to `rateLimitPerSecond`.
- **Per-minute**: token bucket, capacity `rateLimitPerMinute`, refilling continuously.
- **Concurrency**: semaphore capped at `maxConcurrentRequests` in-flight requests.

The limiter does **not** queue or block: when a limit is hit the tool call fails
immediately with an error telling the agent to retry after a short delay (or to wait
for an in-flight request, for the concurrency limit). The concurrency check runs first
so a rejected request never consumes rate tokens.

To disable rate limiting entirely, set **all three** values to `0`. Otherwise each
non-zero value is clamped to a minimum of `1`.

---

-->

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `http_request.allowDELETE` | `boolean` | **DELETE** | `true` |
| `http_request.allowGET` | `boolean` | **GET** | `true` |
| `http_request.allowHEAD` | `boolean` | **HEAD** | `false` |
| `http_request.allowOPTIONS` | `boolean` | **OPTIONS** | `false` |
| `http_request.allowPATCH` | `boolean` | **PATCH** | `true` |
| `http_request.allowPOST` | `boolean` | **POST** | `true` |
| `http_request.allowPUT` | `boolean` | **PUT** | `true` |
| `http_request.maxConcurrentRequests` | `number` | **Max concurrent requests**<br/>Maximum number of HTTP requests that can be in-flight simultaneously. | `5` |
| `http_request.rateLimitPerMinute` | `number` | **Max requests per minute**<br/>Maximum number of HTTP requests allowed per minute. Provides a broader throttle beyond the per-second limit. | `100` |
| `http_request.rateLimitPerSecond` | `number` | **Max requests per second**<br/>Maximum number of HTTP requests allowed per second. Uses a token-bucket algorithm for smooth enforcement. | `10` |
| `http_request.serverName` | `string` | **Server name**<br/>Namespace prefix for the tool: <serverName>.http_request | `"http"` |
| `http_request.urlWhitelist` | `array` | **URL Whitelist**<br/>Python regex patterns applied with match() to the final canonical URL after path substitution, regular query parameters, and query-based API-key auth. A request-time source recognizer accepts only exact literal/escaped hosts with supported numeric-port forms, or a deliberate [^/] whole-authority form, followed by an explicit authority boundary. Unsupported or ambiguous authority syntax fails closed even when the regex matches. [] or only blank placeholder rows allows all public destinations; non-public destinations remain blocked. Blank rows mixed with valid patterns are ignored; invalid non-empty regexes, non-string values, and malformed entries fail closed. |  |
| `http_request.whitelistPattern` | `string` | **URL Pattern (regex)**<br/>Applied with Python regex match() to the final canonical URL after path substitution, regular query parameters, and query-based API-key auth. After matching, a fail-closed source grammar requires a literal HTTP(S) scheme; an exact literal/escaped DNS, IPv4, or bracketed-IPv6 host with an optional exact or [0-9]-based port policy, or a whole-authority [^/] policy; and an explicit path, query, or end boundary. Unsupported or ambiguous authority regex syntax is denied at request time. Example: ^https://api\.example\.com(?::[0-9]+)?(?:/\|$). Scheme-only prefixes are denied; use an empty whitelist to allow all public destinations. Blank placeholder rows are ignored. | `""` |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_http_request)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
