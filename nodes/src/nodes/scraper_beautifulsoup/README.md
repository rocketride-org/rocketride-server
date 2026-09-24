# scraper_beautifulsoup

A RocketRide web scraping node built on BeautifulSoup. Use it as a run-once pipeline source that pulls public JSON APIs, RSS/Atom feeds, and HTML pages into rows, or as a set of page-reading tools for an agent. It needs no API key or paid service.

## About BeautifulSoup

BeautifulSoup is a widely used open-source Python library for parsing HTML and XML. It turns messy real-world markup into a navigable tree that can be searched with CSS selectors, which makes it a standard building block for web scraping.

## What it does

Two services share this node's code:

| Service | Protocol | Role |
|---|---|---|
| **Web Scraper Source** | `scraper_beautifulsoup_source://` | pipeline source that fetches configured sources and emits normalized rows |
| **Web Scraper** | `scraper_beautifulsoup://` | agent tools: read a page, extract items, read a feed, call a JSON API |

The source needs no input, so it can start a **scheduled deployment**: each fire fetches every enabled source once and then completes. Wire its `answers` lane into a SQL node such as `rocketride_sql` or `db_postgres` to load a table with no LLM in between. Each row carries a `url_hash` so you can deduplicate across runs. Choose the tool service when an agent should decide what to read. Choose `tool_firecrawl` instead when you need JavaScript-rendered pages, and a search node (`tool_tavily`, `tool_exa_search`) when you need to find pages rather than read known ones.

## Lanes

Web Scraper Source (`scraper_beautifulsoup_source://`):

| Lane in | Lane out | Description |
| --- | --- | --- |
| `_source` | `answers` | One JSON answer per configured source, holding all of its normalized rows (a list of objects). |
| `_source` | `text` | One plain-text document per item: title, URL, source/author/date line, then the body. |

Every row has the same columns:
- `source`: the source name, or the per-URL `name`
- `platform`
- `url`: absolute
- `url_hash`: `sha256(url.strip().lower())`
- `title`
- `author`
- `published_at`: ISO-8601 in UTC
- `score`: integer
- `comments`: integer
- `body`: HTML stripped, capped, and falls back to the title
- `fetched_at`

Rows also include any custom mapped fields and any `extra` static fields.

## As a tool

The Web Scraper service exposes four tools. Each tool's name is prefixed with the node id; an agent sees `scraper_beautifulsoup_1.fetch_page`.

| Function | Description |
|---|---|
| `fetch_page` | Fetch a page and return it as `markdown` (default), `text`, raw `html`, or `links`. Required: `url`. Optional: `format`, `selector` (CSS region to keep; defaults to `<main>`, `<article>`, or `<body>`), `max_chars` (default 20000). Returns `{url, status, title, description, content, truncated}`, or `{url, status, links: [{url, text}]}` for `links`. |
| `extract` | Pull repeated items out of a page with CSS selectors. Required: `url`, `fields` (output name → `"selector"` for element text or `"selector@attr"` for an attribute; `"@href"` reads the item element itself). Optional: `item_selector`, `limit` (default 50). Returns `{url, items}`; `href`/`src` values are made absolute. |
| `fetch_feed` | Read an RSS 2.0, RSS 1.0 or Atom feed. Required: `url`. Optional: `limit`. Returns `{url, items: [{title, url, author, published_at, body}]}`. |
| `fetch_json` | Call a public JSON API with GET or POST. Required: `url`. Optional: `method`, `body_json`, `headers`, `items_path` (dot path to the item list), `fields` (output name → dot path in each item), `limit`, `max_chars`. Without `items_path` it returns the raw `data` (truncated to `max_chars` as text if large). |

A blocked or failed request raises an error that names the reason: a non-public host, a URL not on the allow-list, an HTTP error status, or too many redirects.

## Configuration

### Web Scraper Source (`scraper_beautifulsoup_source://`)

Most of the work is the **Sources (JSON)** field. The network fields below it have safe defaults.

#### Sources (JSON)

This field holds a JSON array of sources. Each source becomes one pipeline object and produces one `answers` batch.

| Key | Applies to | Meaning |
|---|---|---|
| `name` | all | Unique source name; the default `source` column value. |
| `kind` | all | `json`, `feed` (RSS/Atom), or `html`. |
| `url` / `urls` | all | One URL, or a list of URLs. Each entry may be a string or `{url, name, extra}`. |
| `platform` | all | Value for the `platform` column. |
| `maxItems` | all | Item cap for the source, split evenly across its URLs (default: **Max items per source**). |
| `headers` | all | Request headers. Put secrets in `${ROCKETRIDE_*}` variables here. |
| `extra` | all | Static columns added to every row (for example `{"category": "ai-lab"}`); reserved column names are rejected. |
| `enabled` | all | `false` skips the source. |
| `method`, `body` | json | Use `POST` with a JSON `body`, for example a GraphQL query. |
| `itemsPath` | json | Dot path to the item list (`hits`, `data.children`, `data.feed.edges`). |
| `fields` | json, html | Output field → where to find it. For JSON: a dot path, or a list of fallback paths. For HTML: `"selector"` or `"selector@attr"`. `url` is required. Keys outside the standard set pass through as extra columns. |
| `itemSelector` | html | CSS selector for each repeated item. |

URLs, headers, and bodies can use these template tokens:
- `{today}`
- `{now}`
- `{days_ago:N}`
- `{hours_ago:N}`
- `{unix_days_ago:N}` and `{unix_hours_ago:N}`, which give epoch seconds
- `{per_url}`: the item cap for one URL
- `{max}`

```json
[
  {"name": "Hacker News", "kind": "json", "platform": "hackernews",
   "url": "https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>{unix_days_ago:1}&hitsPerPage={per_url}",
   "itemsPath": "hits",
   "fields": {"title": "title", "url": "url", "author": "author", "published": "created_at",
              "score": "points", "comments": "num_comments", "body": "story_text"}},
  {"name": "Labs", "kind": "feed", "platform": "rss",
   "urls": [{"url": "https://openai.com/news/rss.xml", "name": "OpenAI"}],
   "extra": {"category": "ai-lab"}},
  {"name": "Blog", "kind": "html", "url": "https://example.com/blog",
   "itemSelector": "article", "fields": {"title": "h2", "url": "h2 a@href", "published": "time@datetime"}}
]
```

If one URL of a source fails, a warning is logged and the rows from the other URLs are still emitted. If every URL of a source fails, that object is marked failed.

Every row from every source carries the same columns: the standard set (`source`, `platform`, `url`, `url_hash`, `title`, `author`, `published_at`, `score`, `comments`, `body`, `fetched_at`), followed by every `extra` key and custom `fields` key used by any source, in alphabetical order. Missing values are `null`. This matters because SQL `answers` ingestion creates the table from the first row it sees, and later drops any key the table does not have.

When loading into `rocketride_sql` or `db_postgres`, it is best to create the target table yourself with `TEXT` columns. An auto-created table sizes text columns from the first batch only, so it can pick `VARCHAR(255)`, and a longer `title`, `url` or `body` later makes that batch's insert fail. The SQL node only logs that failure. It does not upsert, so deduplicate on `url_hash` when you copy rows out of the table.

#### Network limits

The source and the tools share these fields:
- **Timeout**: per request.
- **Max response size**: the body is read up to this size and the rest is dropped.
- **Delay between requests to one host**: politeness pacing, 250 ms by default.
- **User agent**: some sites, such as Reddit, reject generic agents.
- **URL allow-list**: optional regex patterns. When any are set, every URL and every redirect target must match one.

### Web Scraper (`scraper_beautifulsoup://`)

Leave the defaults for general page reading. Add allow-list patterns when an agent should only reach a fixed set of sites. The tool service has no **Sources (JSON)** field.

## Notes

### Network safety

Only public hosts can be reached. For every request, and every redirect hop, the host is resolved once and every address must be public. Private, loopback, link-local, CGNAT, and IPv6 forms that embed a private IPv4 address are rejected, as is anything that does not resolve. The connection then goes only to those validated addresses, so a second DNS answer cannot point it somewhere else (no DNS rebinding). Environment proxies are ignored. Redirects are followed manually so that each `Location` is re-checked against the validator and the allow-list; after five redirects the request fails. A redirect to a different origin (scheme, host, or port) drops every request header except `User-Agent`, `Accept`, and `Accept-Language`, so credentials in `headers` never leave the host they were meant for. Only GET and POST are supported. Feeds whose DTD declares entities are refused before parsing; a bare `<!DOCTYPE>` (such as RSS 0.91's) is fine. An invalid CSS selector fails the URL with a clear error instead of crashing the source.

### What it does not do

The node does not run JavaScript, log in, or solve CAPTCHAs. Pages that build their content in the browser return little text; use `tool_firecrawl` for those. Respect each site's terms and rate limits.

### Running the tests

```bash
pytest nodes/test/scraper_beautifulsoup
```

The unit tests need `beautifulsoup4` and `requests`; they use a local HTTP server and canned responses, not the network.

## Upstream docs

- [Beautiful Soup documentation](https://www.crummy.com/software/BeautifulSoup/bs4/doc/)
- [Soup Sieve CSS selectors](https://facelessuser.github.io/soupsieve/)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
