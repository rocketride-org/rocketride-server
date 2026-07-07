---
title: Firecrawl
sidebar_position: 3
---

# Firecrawl

The `tool_firecrawl` node exposes Firecrawl web-scraping operations to an AI
agent. It gives an agent the ability to scrape live web pages and map website
structures using the Firecrawl API — useful when an agent needs to read current
web content or discover URLs across a site.

This is a pure tool node: it has no pipeline lanes and is invoked by an agent
node, not wired into data lanes.

## When to use Firecrawl

- **Live web reading** — let an agent fetch and read a page's content on demand.
- **Site discovery** — map a site's structure to find URLs before scraping
  specific pages.
- **Research agents** — combine scraping with other tools in a reasoning loop.

## Configuration

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `apikey` | string | `""` | Firecrawl API key. Required — startup fails if empty. |

The node ships a single `default` profile and uses the `firecrawl-py` SDK
(`FirecrawlApp`). The client is created once when the pipeline starts. All
Firecrawl calls are wrapped with automatic retry handling: rate-limit responses
(HTTP 429) retry indefinitely with a 5-second sleep between attempts, and server
errors (HTTP 5xx) retry up to 5 times with the same delay before the error is
raised.

## Agent tools

Tools are registered under the `firecrawl` prefix.

| Tool | What it does |
| --- | --- |
| `scrape_url` | Scrape a single web page and return its content. Returns `{ success, content, metadata }`; falls back to `markdown` content if the requested format is unavailable. |
| `map_url` | Map a website's structure from a root `url` and return all discovered URLs as `{ success, links }`. |

## Authentication

Set `apikey` to a Firecrawl API key (created at
[firecrawl.dev](https://www.firecrawl.dev)). The key is passed directly to
`FirecrawlApp`; no other credentials are needed.

## Related

- [`tool_firecrawl` node reference](/nodes/tool_firecrawl)
- [Firecrawl documentation](https://docs.firecrawl.dev)
- [Concepts: Agents & Tools](/concepts/agents-tools-skills)
