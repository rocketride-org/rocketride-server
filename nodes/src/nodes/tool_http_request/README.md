# tool_http_request

A RocketRide tool node that lets an AI agent make HTTP requests to public API endpoints, like curl for agents.

## What it does

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
  which allows all public URLs** (config validation emits a warning when the whitelist is empty).
- **Network boundary**: loopback, private, link-local, shared, reserved, unspecified,
  and multicast destination addresses are blocked. Redirects are returned to the agent
  as 3xx responses and are not followed automatically. There is no private-network
  override: localhost and internal API endpoints are intentionally unsupported.
- **Rate limiting**: token-bucket limits per second and per minute, plus a concurrency
  cap. On by default (10/s, 100/min, 5 concurrent).

---

## Configuration


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

Whitelist regexes are applied with Python `pattern.match()` to the final canonical URL after
path parameters, regular query parameters, and query-based API-key auth are applied. The
configured regex is never rewritten, so normal Python regex syntax retains its usual meaning.
A nonmatch is denied.

After a successful match, a fail-closed source recognizer proves the regex's authority policy.
It accepts an optional `^` or `\A`, a literal `http://` or `https://`, then one of:

- an exact DNS, IPv4, or escaped-bracket IPv6 host written with literal characters and escaped
  dots, optionally followed by an exact numeric port, a decimal port language such as
  `:[0-9]+` or `:[0-9]{3,4}`, or the optional form `(?::[0-9]+)?`; or
- the whole-authority form `[^/]` with a nonempty `+` or brace bound, such as `[^/]+` or
  `[^/]{1,20}`.

The authority policy must be followed immediately by a proven boundary: a consuming `/` or
`\?`, the narrow boundary forms `(?=/|$)` or `(?:/|$)` (and their query variants), or a terminal
`$`, `\Z`, or `\z` on Python versions that support it. Arbitrary Python regex syntax may follow
a proven consuming path or query delimiter; top-level alternatives remain unsupported because
they can hide a different authority policy. A `$` authority boundary is unsupported with
`re.MULTILINE` because it would no longer prove the end of the authority; that flag remains
available to regex syntax after a consuming delimiter.

Any other authority syntax fails closed at request time even if Python's regex engine matches
the URL. This includes wildcard, character-class, lookaround, possessive, subdomain-language,
or alternation syntax before the boundary. For example, use
`^https://api\.example\.com(?::[0-9]+)?(?:/|$)` for an exact host with an optional numeric port,
or `^https://[^/]+(?:/|$)` for a deliberately broad authority. A scheme-only prefix such as
`^https://` is denied. Use an empty whitelist for the documented allow-all-public mode.

The configuration author is trusted; request URLs are attacker-controlled. The restricted
grammar prevents an accidental hostname or port prefix from being interpreted across URL
authority fields. It is not intended to defend against an administrator who deliberately
configures a broad policy.

An empty `urlWhitelist` (`[]`), or a list containing only blank or whitespace-only UI
placeholder rows, means no whitelist patterns and therefore allows all public destinations;
non-public destinations remain blocked. Blank rows mixed with valid patterns are ignored.
Invalid non-empty regexes, non-string values, and malformed entries fail configuration
validation.

### Compatibility and whitelist migration

Whitelist matching previously used search-anywhere semantics and accepted unrestricted regex
syntax in the authority. It now starts at the beginning of the canonical URL and accepts only
the authority grammar above; configuring a whitelist emits a startup migration warning.
Patterns written for a raw, noncanonical URL or with unsupported authority constructs now fail
closed. Migrate them to the canonical form, preferably anchor them with `^` or `\A`, and express
host/port intent with one of the supported exact or whole-authority forms.

The node connects directly to the validated destination and does not use environment
proxies or implicit `.netrc` credentials. `REQUESTS_CA_BUNDLE` and `CURL_CA_BUNDLE`
remain supported for custom HTTPS certificate authorities. A caller-supplied `Host`
header is rejected because it could route an allowlisted URL to a different virtual host.
URLs containing userinfo or credentials are rejected, including an empty userinfo delimiter
before `@`. The network classifier requires Python `3.10.15+`, `3.11.10+`, `3.12.4+`, or
`3.13+`. The transport verifies the required `requests` and `urllib3` connection capabilities
at startup; behavior tests cover the supported dependency combinations.

Keep an outbound firewall or equivalent egress policy around the engine as a second
boundary. RFC 6052 permits operator-chosen NAT64 prefixes that cannot be identified from
an IPv6 address alone; the egress boundary must also block translated access to private
networks.

---

## Available tools


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
| `headers`      | Custom request headers. `Host` cannot be overridden.                     |
| `path_params`  | Replacements for `:name` placeholders in the URL path only (e.g. `{"id": "123"}` replaces `:id`) |
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
`elapsed_ms` is wall-clock request time, including DNS validation, in milliseconds.

---

## Authentication

The `auth` object supports `type`: `none`, `basic`, `bearer`, or `api_key`.

| Type      | Fields                                            | Effect                                                       |
|-----------|---------------------------------------------------|--------------------------------------------------------------|
| `basic`   | `basic: {username, password}`                     | HTTP basic auth                                              |
| `bearer`  | `bearer: {token}`                                 | `Authorization: Bearer <token>` header                       |
| `api_key` | `api_key: {key, value, add_to}`                   | Adds `key: value` as a header (`add_to: "header"`, the default) or query parameter (`add_to: "query_param"`) |

For the common cases, the `bearer_token` and `basic_auth` shortcuts are simpler and
expand to the same thing.

---

## Request bodies

The `body` object supports `type`: `none`, `raw`, `form_data`, or `x_www_form_urlencoded`.

| Type                     | Fields                          | Effect                                                                |
|--------------------------|---------------------------------|------------------------------------------------------------------------|
| `raw`                    | `raw: {content, content_type}`  | Sends `content` as-is. `content_type` must be one of `application/json` (default), `application/xml`, `text/html`, `text/javascript`, `text/plain`; it becomes the `Content-Type` header unless one is already set. |
| `form_data`              | `form_data: {key: value, ...}`  | Sent as a `multipart/form-data` envelope                              |
| `x_www_form_urlencoded`  | `urlencoded: {key: value, ...}` | Sent as URL-encoded form fields                                       |

For JSON payloads, prefer the `body_json` shortcut, pass the object directly and it is
serialized and wrapped as raw `application/json` automatically.

---

## Rate limiting

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
