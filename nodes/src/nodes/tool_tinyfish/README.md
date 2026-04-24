---
title: TinyFish
date: 2026-04-24
sidebar_position: 1
---

## What it does

Gives agents the ability to drive a real browser, run structured web searches, and fetch clean page content via the TinyFish API. Useful for agents that need to perform multi-step workflows on live sites (form fills, logins, extractions), discover results across the web, or pull rendered JavaScript-heavy pages.

## Tools

| Tool                 | Description                                                     |
| -------------------- | --------------------------------------------------------------- |
| `tinyfish.agent_run` | Run a multi-step browser automation and block until it finishes |
| `tinyfish.search`    | Run a structured web search and return ranked results           |
| `tinyfish.fetch`     | Fetch a URL (renders JavaScript) and return cleaned content     |

### tinyfish.agent_run

| Parameter   | Required | Description                                                                        |
| ----------- | -------- | ---------------------------------------------------------------------------------- |
| `url`       | yes      | URL for the agent to open                                                          |
| `goal`      | yes      | Plain-English description of the task (may include credentials, target JSON shape) |
| `timeout_s` | no       | Wall-clock timeout in seconds (defaults to the node's default_timeout_s)           |

Returns `{success, run_status, run_id, result, goal_status?, reason?, error?}`. Note: `run_status == "COMPLETED"` means the run finished; the goal can still have failed — check `goal_status == "failure"` and read `reason`.

### tinyfish.search

| Parameter  | Required | Description                                      |
| ---------- | -------- | ------------------------------------------------ |
| `query`    | yes      | Search query string                              |
| `location` | no       | Two-letter country code for geo-targeted results |
| `language` | no       | Two-letter language code                         |
| `limit`    | no       | Cap the number of results (applied client-side)  |

Returns `{success, query, total_results, results: [{position, site_name, title, snippet, url}]}`.

### tinyfish.fetch

| Parameter | Required | Description                           |
| --------- | -------- | ------------------------------------- |
| `url`     | yes      | URL to fetch                          |
| `format`  | no       | `markdown`, `html`, or `json`         |
| `links`   | no       | Include extracted links in the result |

Returns `{success, url, final_url, title, description, language, text, links?}` on success; `{success: false, url, error}` on failure.

## Configuration

| Field               | Description                                                      |
| ------------------- | ---------------------------------------------------------------- |
| API Key             | TinyFish API key (starts with `sk-tinyfish-`)                    |
| Base URL            | API base URL (leave default unless using a custom deployment)    |
| Default Timeout (s) | Wall-clock ceiling for `agent_run` when `timeout_s` is not given |

## Upstream docs

- [TinyFish documentation](https://docs.tinyfish.ai)
- [TinyFish cookbook](https://github.com/tinyfish-io/tinyfish-cookbook)
