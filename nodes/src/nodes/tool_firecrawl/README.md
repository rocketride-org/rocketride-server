---
title: Firecrawl
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Firecrawl - RocketRide Documentation</title>
</head>

## What it does

Gives agents the ability to scrape web pages and map website structures using the Firecrawl API. Useful for agents that need to read live web content or discover URLs across a site.

## Tools

| Tool                   | Description                                     |
| ---------------------- | ----------------------------------------------- |
| `firecrawl.scrape_url` | Scrape a single web page and return its content |
| `firecrawl.map_url`    | Discover all URLs within a website              |

### firecrawl.scrape_url

| Parameter | Required | Description                    |
| --------- | -------- | ------------------------------ |
| `url`     | yes      | URL to scrape                  |
| `format`  | no       | `markdown` (default) or `html` |

Returns the page content and metadata.

### firecrawl.map_url

| Parameter | Required | Description     |
| --------- | -------- | --------------- |
| `url`     | yes      | Root URL to map |

Returns an array of discovered links across the site.

## Configuration

| Field   | Description       |
| ------- | ----------------- |
| API Key | Firecrawl API key |

## Upstream docs

- [Firecrawl documentation](https://docs.firecrawl.dev)
