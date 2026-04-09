---
title: HTTP Request
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>HTTP Request - RocketRide Documentation</title>
</head>

## What it does

Gives agents the ability to make HTTP requests to external APIs and services. Supports all common HTTP methods with flexible authentication, body types, and configurable guardrails for rate limiting, URL whitelisting, and method restrictions.

## Tools

| Tool                | Description                                  |
| ------------------- | -------------------------------------------- |
| `http.http_request` | Make an HTTP request and return the response |

### http.http_request

**Required:**

| Parameter | Description                                                   |
| --------- | ------------------------------------------------------------- |
| `url`     | Full URL to call                                              |
| `method`  | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, or `OPTIONS` |

**Convenience shortcuts:**

| Parameter      | Description                                                                |
| -------------- | -------------------------------------------------------------------------- |
| `bearer_token` | Bearer token — added as `Authorization: Bearer ...` header                 |
| `basic_auth`   | `{username, password}` for HTTP basic auth                                 |
| `body_json`    | Object or array — serialized as JSON with `Content-Type: application/json` |

**Optional:**

| Parameter      | Description                                                              |
| -------------- | ------------------------------------------------------------------------ |
| `query_params` | Key-value pairs appended as query string                                 |
| `headers`      | Custom request headers                                                   |
| `path_params`  | Replaces `:param` placeholders in the URL                                |
| `timeout`      | Request timeout in seconds (default: 30, max: 300)                       |
| `auth`         | Advanced auth config — bearer, basic, or API key (header or query param) |
| `body`         | Advanced body config — raw, form_data, or x_www_form_urlencoded          |

**Response:**

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

`json` is populated automatically when the response content type is JSON.

## Configuration

| Field                   | Description                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Tool Namespace          | Prefix for the tool name (default: `http`)                                          |
| Allowed Methods         | Toggle GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS on/off                          |
| URL Whitelist           | List of regex patterns — restricts which URLs the agent can call. Empty allows all. |
| Rate Limit (per second) | Token-bucket refill rate per second (default: 10)                                   |
| Rate Limit (per minute) | Token-bucket refill rate per minute (default: 100)                                  |
| Max Concurrent Requests | Maximum simultaneous in-flight requests (default: 5)                                |

Set all rate limit values to `0` to disable rate limiting entirely.
