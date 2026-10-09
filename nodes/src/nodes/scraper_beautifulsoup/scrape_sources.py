# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Source specifications and row normalization for scraper_beautifulsoup.

A *source* is one configured endpoint family (a JSON API, a set of feeds, or
an HTML listing page). Running a source yields normalized *rows* with a
stable column set so they can be loaded straight into a SQL table:

    source, platform, url, url_hash, title, author, published_at,
    score, comments, body, fetched_at  (+ any ``extra`` static fields)

``url_hash`` is ``sha256(url.strip().lower())`` and is the dedup key.

No engine imports: unit-testable standalone.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

try:
    from .scrape_extract import extract_html_items, extract_json_items, html_to_text, parse_feed
    from .scrape_fetch import Fetcher, FetchError
except ImportError:  # imported standalone (unit tests put this folder on sys.path)
    from scrape_extract import extract_html_items, extract_json_items, html_to_text, parse_feed
    from scrape_fetch import Fetcher, FetchError

KINDS = ('json', 'feed', 'html')
STANDARD_FIELDS = ('title', 'url', 'author', 'published', 'score', 'comments', 'body')
ROW_COLUMNS = (
    'source',
    'platform',
    'url',
    'url_hash',
    'title',
    'author',
    'published_at',
    'score',
    'comments',
    'body',
    'fetched_at',
)
DEFAULT_MAX_ITEMS = 100
DEFAULT_MAX_BODY_CHARS = 20000
_TEMPLATE = re.compile(r'\{(today|now|(?:unix_)?(?:days|hours)_ago:\d+|per_url|max)\}')
_RESERVED = set(ROW_COLUMNS)


@dataclass
class UrlEntry:
    """One request within a source; ``name`` overrides the row ``source`` label."""

    url: str
    name: Optional[str] = None
    extra: Dict[str, Any] = field(default_factory=dict)


@dataclass
class SourceSpec:
    name: str
    kind: str
    urls: List[UrlEntry]
    platform: Optional[str] = None
    method: str = 'GET'
    headers: Dict[str, str] = field(default_factory=dict)
    body: Any = None
    items_path: str = ''
    item_selector: str = ''
    fields: Dict[str, Any] = field(default_factory=dict)
    max_items: int = DEFAULT_MAX_ITEMS
    extra: Dict[str, Any] = field(default_factory=dict)
    enabled: bool = True


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def parse_sources(raw: Any, default_max_items: int = DEFAULT_MAX_ITEMS) -> List[SourceSpec]:
    """Parse the ``sources`` config (JSON text or already-decoded list)."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(f'sources is not valid JSON: {e}') from e
    if isinstance(raw, dict):
        raw = raw.get('sources', [raw])
    if not isinstance(raw, list):
        raise ValueError('sources must be a JSON array of source objects')

    specs = []
    names = set()
    for i, item in enumerate(raw):
        spec = _parse_one(item, i, default_max_items)
        if spec.name in names:
            raise ValueError(f'Duplicate source name: {spec.name!r}')
        names.add(spec.name)
        specs.append(spec)
    return specs


def _parse_one(item: Any, index: int, default_max_items: int) -> SourceSpec:
    where = f'sources[{index}]'
    if not isinstance(item, dict):
        raise ValueError(f'{where} must be an object')
    name = str(item.get('name') or '').strip()
    if not name:
        raise ValueError(f'{where}.name is required')
    where = f'source {name!r}'

    kind = str(item.get('kind') or '').strip().lower()
    if kind not in KINDS:
        raise ValueError(f'{where}: kind must be one of {", ".join(KINDS)}')

    raw_urls = item.get('urls', item.get('url'))
    if isinstance(raw_urls, (str, dict)):
        raw_urls = [raw_urls]
    if not raw_urls or not isinstance(raw_urls, list):
        raise ValueError(f'{where}: url or urls is required')
    urls = []
    for u in raw_urls:
        if isinstance(u, str):
            urls.append(UrlEntry(url=u))
        elif isinstance(u, dict) and u.get('url'):
            urls.append(UrlEntry(url=str(u['url']), name=u.get('name'), extra=dict(u.get('extra') or {})))
        else:
            raise ValueError(f'{where}: each url must be a string or an object with "url"')

    method = str(item.get('method') or 'GET').upper()
    if method not in ('GET', 'POST'):
        raise ValueError(f'{where}: method must be GET or POST')
    if kind != 'json' and method != 'GET':
        raise ValueError(f'{where}: only json sources may use POST')

    fields = item.get('fields') or {}
    if not isinstance(fields, dict):
        raise ValueError(f'{where}: fields must be an object')
    if kind == 'json' and 'url' not in fields:
        raise ValueError(f'{where}: json sources need a fields.url path')
    if kind == 'html':
        if not item.get('itemSelector'):
            raise ValueError(f'{where}: html sources need itemSelector')
        if 'url' not in fields:
            raise ValueError(f'{where}: html sources need a fields.url selector (e.g. "a@href")')

    extra = dict(item.get('extra') or {})
    clash = _RESERVED.intersection(extra)
    if clash:
        raise ValueError(f'{where}: extra cannot override reserved columns {sorted(clash)}')

    headers = item.get('headers') or {}
    if not isinstance(headers, dict):
        raise ValueError(f'{where}: headers must be an object')

    try:
        max_items = int(item.get('maxItems') or default_max_items)
    except (TypeError, ValueError) as e:
        raise ValueError(f'{where}: maxItems must be an integer') from e

    return SourceSpec(
        name=name,
        kind=kind,
        urls=urls,
        platform=item.get('platform'),
        method=method,
        headers={str(k): str(v) for k, v in headers.items()},
        body=item.get('body'),
        items_path=str(item.get('itemsPath') or ''),
        item_selector=str(item.get('itemSelector') or ''),
        fields=fields,
        max_items=max(1, max_items),
        extra=extra,
        enabled=bool(item.get('enabled', True)),
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def expand_template(value: Any, now: datetime, per_url: int, max_items: int) -> Any:
    """Expand ``{today}``, ``{now}``, ``{days_ago:N}``, ``{hours_ago:N}``, ``{per_url}``, ``{max}``.

    ``{unix_days_ago:N}`` / ``{unix_hours_ago:N}`` give epoch seconds (for APIs
    such as Algolia's ``numericFilters=created_at_i>...``).

    Applied recursively to strings inside dicts / lists (for POST bodies).
    """
    if isinstance(value, dict):
        return {k: expand_template(v, now, per_url, max_items) for k, v in value.items()}
    if isinstance(value, list):
        return [expand_template(v, now, per_url, max_items) for v in value]
    if not isinstance(value, str):
        return value

    def repl(m: re.Match) -> str:
        token = m.group(1)
        if token == 'today':
            return now.date().isoformat()
        if token == 'now':
            return now.isoformat()
        if token == 'per_url':
            return str(per_url)
        if token == 'max':
            return str(max_items)
        unit, _, n = token.partition(':')
        epoch = unit.startswith('unix_')
        unit = unit.removeprefix('unix_')
        delta = timedelta(days=int(n)) if unit == 'days_ago' else timedelta(hours=int(n))
        stamp = now - delta
        if epoch:
            return str(int(stamp.timestamp()))
        return stamp.date().isoformat() if unit == 'days_ago' else stamp.isoformat()

    return _TEMPLATE.sub(repl, value)


def hash_url(url: str) -> str:
    return hashlib.sha256(url.strip().lower().encode('utf-8')).hexdigest()


def parse_date(value: Any) -> Optional[str]:
    """Normalize epoch seconds/ms, ISO-8601 or RFC-2822 dates to ISO-8601 UTC."""
    if value is None or value == '':
        return None
    dt: Optional[datetime] = None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) or (isinstance(value, str) and re.fullmatch(r'\d{9,13}(\.\d+)?', value)):
        num = float(value)
        if num > 1e12:
            num /= 1000.0
        try:
            dt = datetime.fromtimestamp(num, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    elif isinstance(value, str):
        text = value.strip()
        try:
            dt = datetime.fromisoformat(text.replace('Z', '+00:00'))
        except ValueError:
            try:
                dt = parsedate_to_datetime(text)
            except (TypeError, ValueError, IndexError):
                return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _to_int(value: Any) -> Optional[int]:
    if value is None or value == '' or isinstance(value, bool):
        return None
    try:
        return int(float(str(value).replace(',', '')))
    except (TypeError, ValueError):
        return None


def _to_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        value = json.dumps(value)
    text = str(value).strip()
    return text or None


def normalize_row(
    raw: Dict[str, Any],
    *,
    source: str,
    platform: Optional[str],
    base_url: str,
    fetched_at: str,
    extra: Dict[str, Any],
    max_body_chars: int = DEFAULT_MAX_BODY_CHARS,
) -> Optional[Dict[str, Any]]:
    """Map a raw extracted item onto the stable row shape; ``None`` if it has no usable URL."""
    url = _to_text(raw.get('url'))
    if not url:
        return None
    url = urljoin(base_url, url)
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        return None

    title = html_to_text(_to_text(raw.get('title')) or '') or None
    body = _to_text(raw.get('body'))
    body = html_to_text(body) if body else None
    if body and len(body) > max_body_chars:
        body = body[:max_body_chars]

    row: Dict[str, Any] = {
        'source': source,
        'platform': platform,
        'url': url,
        'url_hash': hash_url(url),
        'title': title,
        'author': _to_text(raw.get('author')),
        'published_at': parse_date(raw.get('published')),
        'score': _to_int(raw.get('score')),
        'comments': _to_int(raw.get('comments')),
        'body': body or title,
        'fetched_at': fetched_at,
    }
    # Custom mapped fields beyond the standard set pass through as-is.
    for key, value in raw.items():
        if key not in STANDARD_FIELDS and key not in row:
            row[key] = value if isinstance(value, (int, float, bool)) or value is None else _to_text(value)
    for key, value in extra.items():
        row.setdefault(key, value)
    return row


# ---------------------------------------------------------------------------
# Running a source
# ---------------------------------------------------------------------------


@dataclass
class SourceResult:
    source: str
    rows: List[Dict[str, Any]]
    errors: List[str]


def run_source(
    spec: SourceSpec,
    fetcher: Fetcher,
    *,
    now: Optional[datetime] = None,
    max_body_chars: int = DEFAULT_MAX_BODY_CHARS,
) -> SourceResult:
    """Fetch every URL in ``spec`` and return deduplicated normalized rows.

    Per-URL failures are collected in ``errors`` rather than raised, so one
    dead feed does not sink the whole source.
    """
    now = now or datetime.now(timezone.utc)
    fetched_at = now.isoformat()
    per_url = max(1, math.ceil(spec.max_items / len(spec.urls)))
    rows: List[Dict[str, Any]] = []
    errors: List[str] = []
    seen = set()

    for entry in spec.urls:
        url = expand_template(entry.url, now, per_url, spec.max_items)
        label = entry.name or spec.name
        try:
            raw_items, base = _fetch_items(spec, fetcher, url, now, per_url)
        except (FetchError, ValueError) as e:
            errors.append(f'{label}: {e}')
            continue

        extra = {**spec.extra, **entry.extra}
        count = 0
        for raw in raw_items:
            row = normalize_row(
                raw,
                source=label,
                platform=spec.platform,
                base_url=base,
                fetched_at=fetched_at,
                extra=extra,
                max_body_chars=max_body_chars,
            )
            if row is None or row['url_hash'] in seen:
                continue
            seen.add(row['url_hash'])
            rows.append(row)
            count += 1
            if count >= per_url:
                break

    return SourceResult(source=spec.name, rows=rows[: spec.max_items], errors=errors)


def _fetch_items(
    spec: SourceSpec, fetcher: Fetcher, url: str, now: datetime, per_url: int
) -> Tuple[List[Dict[str, Any]], str]:
    headers = expand_template(spec.headers, now, per_url, spec.max_items)
    if spec.kind == 'json':
        headers.setdefault('Accept', 'application/json')
        body = expand_template(spec.body, now, per_url, spec.max_items) if spec.body is not None else None
        result = fetcher.fetch(url, method=spec.method, headers=headers, json_body=body)
        try:
            data = result.json()
        except ValueError as e:
            raise ValueError(f'response is not JSON: {e}') from e
        return extract_json_items(data, spec.items_path, spec.fields), result.url

    result = fetcher.fetch(url, headers=headers)
    if spec.kind == 'feed':
        items = parse_feed(result.content)
        if spec.fields:
            # Allow renaming / dropping feed fields, e.g. {"url": "url", "body": "title"}.
            items = [{k: it.get(v) if isinstance(v, str) else None for k, v in spec.fields.items()} for it in items]
        return items, result.url

    return extract_html_items(result.content, result.url, spec.item_selector, spec.fields), result.url


def row_columns(specs: List[SourceSpec]) -> List[str]:
    """The full column set every source's rows share: standard columns, then extras.

    SQL ``answers`` ingestion creates the table from the first row's keys and
    drops unknown keys later, so every row must carry the same keys no
    matter which source renders first.
    """
    extras = set()
    for spec in specs:
        extras.update(k for k in spec.fields if k not in STANDARD_FIELDS)
        extras.update(spec.extra)
        for entry in spec.urls:
            extras.update(entry.extra)
        if spec.kind == 'feed' and not spec.fields:
            extras.add('categories')
    return list(ROW_COLUMNS) + sorted(extras - _RESERVED)


def pad_rows(rows: List[Dict[str, Any]], columns: List[str]) -> List[Dict[str, Any]]:
    """Give every row exactly ``columns`` (in order), filling gaps with ``None``."""
    return [{c: r.get(c) for c in columns} for r in rows]


def rows_to_text(rows: List[Dict[str, Any]]) -> List[str]:
    """Render rows as plain-text documents (one per item) for the text lane."""
    out = []
    for r in rows:
        header = r.get('title') or r['url']
        meta = ' | '.join(str(x) for x in (r.get('source'), r.get('author'), r.get('published_at')) if x)
        parts = [header, r['url']]
        if meta:
            parts.append(meta)
        if r.get('body') and r.get('body') != r.get('title'):
            parts.append('')
            parts.append(r['body'])
        out.append('\n'.join(parts))
    return out
