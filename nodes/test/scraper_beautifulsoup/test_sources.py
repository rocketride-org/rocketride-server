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

"""Unit tests for scraper_beautifulsoup source specs, row normalization and runs."""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

pytest.importorskip('bs4')
pytest.importorskip('requests')

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'scraper_beautifulsoup'))

from scrape_fetch import FetchError, FetchResult  # noqa: E402
from scrape_sources import (  # noqa: E402
    ROW_COLUMNS,
    expand_template,
    hash_url,
    normalize_row,
    pad_rows,
    parse_date,
    parse_sources,
    row_columns,
    rows_to_text,
    run_source,
)

NOW = datetime(2026, 9, 24, 12, 0, tzinfo=timezone.utc)


class StubFetcher:
    """Serves canned responses by URL and records requests."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def fetch(self, url, *, method='GET', headers=None, params=None, json_body=None, raise_for_status=True):
        self.calls.append({'url': url, 'method': method, 'headers': headers, 'json_body': json_body})
        body = self.responses.get(url)
        if body is None:
            raise FetchError(f'{method} {url} returned HTTP 404')
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        if isinstance(body, str):
            body = body.encode()
        return FetchResult(url=url, status=200, headers={}, content=body)


# ---------------------------------------------------------------------------
# parse_sources
# ---------------------------------------------------------------------------


class TestParseSources:
    def test_json_text_and_defaults(self):
        specs = parse_sources(
            json.dumps(
                [{'name': 'HN', 'kind': 'json', 'url': 'https://x', 'itemsPath': 'hits', 'fields': {'url': 'url'}}]
            ),
            default_max_items=42,
        )
        (spec,) = specs
        assert spec.name == 'HN' and spec.kind == 'json' and spec.max_items == 42
        assert spec.urls[0].url == 'https://x'

    def test_urls_forms(self):
        (spec,) = parse_sources(
            [
                {
                    'name': 'R',
                    'kind': 'feed',
                    'urls': ['https://a', {'url': 'https://b', 'name': 'B', 'extra': {'category': 'lab'}}],
                }
            ]
        )
        assert [u.url for u in spec.urls] == ['https://a', 'https://b']
        assert spec.urls[1].name == 'B' and spec.urls[1].extra == {'category': 'lab'}

    def test_wrapped_object(self):
        assert len(parse_sources({'sources': [{'name': 'a', 'kind': 'feed', 'url': 'https://a'}]})) == 1

    def test_empty(self):
        assert parse_sources('') == []
        assert parse_sources(None) == []

    @pytest.mark.parametrize(
        'item, message',
        [
            ({'kind': 'feed', 'url': 'https://a'}, 'name is required'),
            ({'name': 'a', 'kind': 'xml', 'url': 'https://a'}, 'kind must be'),
            ({'name': 'a', 'kind': 'feed'}, 'url or urls'),
            ({'name': 'a', 'kind': 'json', 'url': 'https://a', 'fields': {}}, 'fields.url'),
            ({'name': 'a', 'kind': 'html', 'url': 'https://a', 'fields': {'url': 'a@href'}}, 'itemSelector'),
            ({'name': 'a', 'kind': 'feed', 'url': 'https://a', 'method': 'POST'}, 'only json'),
            ({'name': 'a', 'kind': 'feed', 'url': 'https://a', 'extra': {'url_hash': 'x'}}, 'reserved'),
            ({'name': 'a', 'kind': 'feed', 'url': 'https://a', 'maxItems': 'lots'}, 'maxItems'),
        ],
    )
    def test_validation_errors(self, item, message):
        with pytest.raises(ValueError, match=message):
            parse_sources([item])

    def test_duplicate_names(self):
        item = {'name': 'a', 'kind': 'feed', 'url': 'https://a'}
        with pytest.raises(ValueError, match='Duplicate'):
            parse_sources([item, item])

    def test_bad_json(self):
        with pytest.raises(ValueError, match='not valid JSON'):
            parse_sources('[{')


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


class TestHelpers:
    def test_expand_template(self):
        assert (
            expand_template('q=pushed:>{days_ago:7}&n={per_url}&m={max}', NOW, 5, 20) == 'q=pushed:>2026-09-17&n=5&m=20'
        )
        assert expand_template({'query': ['{today}']}, NOW, 1, 1) == {'query': ['2026-09-24']}
        assert expand_template('{hours_ago:2}', NOW, 1, 1).startswith('2026-09-24T10:00')
        assert expand_template(7, NOW, 1, 1) == 7
        assert (
            expand_template('created_at_i>{unix_days_ago:1}', NOW, 1, 1)
            == f'created_at_i>{int(NOW.timestamp()) - 86400}'
        )
        assert expand_template('{unix_hours_ago:1}', NOW, 1, 1) == str(int(NOW.timestamp()) - 3600)

    @pytest.mark.parametrize(
        'value, expected',
        [
            (1717401600, '2024-06-03T08:00:00+00:00'),
            (1717401600000, '2024-06-03T08:00:00+00:00'),
            ('1717401600', '2024-06-03T08:00:00+00:00'),
            ('2024-06-03T08:00:00Z', '2024-06-03T08:00:00+00:00'),
            ('2024-06-03', '2024-06-03T00:00:00+00:00'),
            ('Mon, 03 Jun 2024 08:00:00 GMT', '2024-06-03T08:00:00+00:00'),
            ('2024-06-03T10:00:00+02:00', '2024-06-03T08:00:00+00:00'),
            ('not a date', None),
            (None, None),
            (True, None),
        ],
    )
    def test_parse_date(self, value, expected):
        assert parse_date(value) == expected

    def test_hash_matches_pulsar(self):
        # Same canonicalisation as Pulsar's scraper dedup: sha256(trim + lowercase).
        assert hash_url(' https://Example.com/A ') == hashlib.sha256(b'https://example.com/a').hexdigest()


class TestNormalizeRow:
    def base(self, raw, **kw):
        args = dict(source='S', platform='p', base_url='https://www.reddit.com/r/x/hot.json', fetched_at='t', extra={})
        args.update(kw)
        return normalize_row(raw, **args)

    def test_stable_columns_and_types(self):
        row = self.base(
            {'url': 'https://a.com/x', 'title': '<b>Hi</b>', 'score': '1,204', 'comments': 3.0, 'published': 1717401600}
        )
        assert tuple(row)[: len(ROW_COLUMNS)] == ROW_COLUMNS
        assert row['title'] == 'Hi'
        assert row['score'] == 1204 and row['comments'] == 3
        assert row['published_at'] == '2024-06-03T08:00:00+00:00'
        assert row['body'] == 'Hi'  # body falls back to title
        assert row['url_hash'] == hash_url('https://a.com/x')

    def test_relative_url_resolved(self):
        assert self.base({'url': '/r/x/comments/1/post/'})['url'] == 'https://www.reddit.com/r/x/comments/1/post/'

    def test_unusable_urls_dropped(self):
        assert self.base({'url': None}) is None
        assert self.base({'url': 'mailto:a@b'}) is None
        assert self.base({'url': 'javascript:alert(1)'}) is None

    def test_body_html_stripped_and_trimmed(self):
        row = self.base({'url': 'https://a', 'body': '<p>' + 'x' * 500 + '</p>'}, max_body_chars=200)
        assert row['body'] == 'x' * 200

    def test_extra_and_custom_fields(self):
        row = self.base({'url': 'https://a', 'language': 'Rust', 'stars': 5}, extra={'category': 'ai-lab'})
        assert row['language'] == 'Rust' and row['stars'] == 5 and row['category'] == 'ai-lab'


# ---------------------------------------------------------------------------
# run_source — Pulsar-style presets against canned responses
# ---------------------------------------------------------------------------


def test_hackernews_json_preset():
    (spec,) = parse_sources(
        [
            {
                'name': 'Hacker News',
                'kind': 'json',
                'platform': 'hackernews',
                'url': 'https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage={per_url}',
                'itemsPath': 'hits',
                'maxItems': 10,
                'fields': {
                    'title': 'title',
                    'url': 'url',
                    'author': 'author',
                    'published': 'created_at',
                    'score': 'points',
                    'comments': 'num_comments',
                    'body': 'story_text',
                },
            }
        ]
    )
    hits = [
        {
            'title': 'A',
            'url': 'https://a.com',
            'author': 'u',
            'created_at': '2026-09-24T01:00:00Z',
            'points': 10,
            'num_comments': 2,
        },
        {'title': 'Ask HN', 'url': None, 'author': 'v', 'created_at': '2026-09-24T02:00:00Z', 'points': 1},
        {'title': 'A again', 'url': 'https://A.com', 'points': 3},
    ]
    fetcher = StubFetcher({'https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=10': {'hits': hits}})
    result = run_source(spec, fetcher, now=NOW)
    assert result.errors == []
    assert [r['title'] for r in result.rows] == ['A']  # no-url dropped, case-insensitive duplicate dropped
    row = result.rows[0]
    assert row['source'] == 'Hacker News' and row['platform'] == 'hackernews'
    assert row['score'] == 10 and row['comments'] == 2
    assert row['fetched_at'] == NOW.isoformat()


def test_reddit_multi_url_split_and_names():
    (spec,) = parse_sources(
        [
            {
                'name': 'Reddit',
                'kind': 'json',
                'platform': 'reddit',
                'urls': [
                    {'url': 'https://www.reddit.com/r/rust/hot.json?limit={per_url}', 'name': 'r/rust'},
                    {'url': 'https://www.reddit.com/r/golang/hot.json?limit={per_url}', 'name': 'r/golang'},
                ],
                'headers': {'User-Agent': 'pulsar-scraper/0.1'},
                'itemsPath': 'data.children',
                'maxItems': 4,
                'fields': {
                    'title': 'data.title',
                    'url': ['data.url', 'data.permalink'],
                    'score': 'data.score',
                    'published': 'data.created_utc',
                },
            }
        ]
    )

    def listing(prefix):
        return {
            'data': {
                'children': [
                    {
                        'data': {
                            'title': f'{prefix}{i}',
                            'url': f'/r/{prefix}/{i}',
                            'score': i,
                            'created_utc': 1717401600,
                        }
                    }
                    for i in range(5)
                ]
            }
        }

    fetcher = StubFetcher(
        {
            'https://www.reddit.com/r/rust/hot.json?limit=2': listing('rust'),
            'https://www.reddit.com/r/golang/hot.json?limit=2': listing('go'),
        }
    )
    result = run_source(spec, fetcher, now=NOW)
    assert [r['source'] for r in result.rows] == ['r/rust', 'r/rust', 'r/golang', 'r/golang']
    assert result.rows[0]['url'] == 'https://www.reddit.com/r/rust/0'
    assert fetcher.calls[0]['headers']['User-Agent'] == 'pulsar-scraper/0.1'


def test_graphql_post_body_templated():
    (spec,) = parse_sources(
        [
            {
                'name': 'Hashnode',
                'kind': 'json',
                'method': 'POST',
                'url': 'https://gql.hashnode.com',
                'body': {'query': 'query { feed(first: {max}) { edges { node { title url } } } }'},
                'itemsPath': 'data.feed.edges',
                'maxItems': 3,
                'fields': {'title': 'node.title', 'url': 'node.url'},
            }
        ]
    )
    fetcher = StubFetcher(
        {'https://gql.hashnode.com': {'data': {'feed': {'edges': [{'node': {'title': 'T', 'url': 'https://t'}}]}}}}
    )
    result = run_source(spec, fetcher, now=NOW)
    assert fetcher.calls[0]['method'] == 'POST'
    assert 'first: 3' in fetcher.calls[0]['json_body']['query']
    assert result.rows[0]['title'] == 'T'


def test_feed_source_with_extra_and_partial_failure():
    rss = b'<rss><channel><item><title>Post</title><link>https://lab.ai/p</link><pubDate>Mon, 03 Jun 2024 08:00:00 GMT</pubDate></item></channel></rss>'
    (spec,) = parse_sources(
        [
            {
                'name': 'AI labs',
                'kind': 'feed',
                'platform': 'rss',
                'urls': [{'url': 'https://lab.ai/rss', 'name': 'Lab'}, {'url': 'https://dead.ai/rss', 'name': 'Dead'}],
                'extra': {'category': 'ai-lab'},
            }
        ]
    )
    result = run_source(spec, StubFetcher({'https://lab.ai/rss': rss}), now=NOW)
    assert len(result.rows) == 1
    assert result.rows[0]['category'] == 'ai-lab'
    assert result.rows[0]['published_at'] == '2024-06-03T08:00:00+00:00'
    assert len(result.errors) == 1 and result.errors[0].startswith('Dead:')


def test_html_source():
    html = b'<div class="r"><a href="/one">One</a></div><div class="r"><a href="/two">Two</a></div>'
    (spec,) = parse_sources(
        [
            {
                'name': 'Blog',
                'kind': 'html',
                'url': 'https://blog.dev/',
                'itemSelector': '.r',
                'fields': {'title': 'a', 'url': 'a@href'},
            }
        ]
    )
    result = run_source(spec, StubFetcher({'https://blog.dev/': html}), now=NOW)
    assert [r['url'] for r in result.rows] == ['https://blog.dev/one', 'https://blog.dev/two']


def test_non_json_response_is_error():
    (spec,) = parse_sources([{'name': 'X', 'kind': 'json', 'url': 'https://x', 'fields': {'url': 'u'}}])
    result = run_source(spec, StubFetcher({'https://x': '<html>'}), now=NOW)
    assert result.rows == [] and 'not JSON' in result.errors[0]


def test_rows_to_text():
    rows = [{'title': 'T', 'url': 'https://t', 'source': 'S', 'author': None, 'published_at': 'd', 'body': 'Body'}]
    assert rows_to_text(rows) == ['T\nhttps://t\nS | d\n\nBody']


def test_invalid_html_selector_is_source_error():
    (spec,) = parse_sources(
        [{'name': 'H', 'kind': 'html', 'url': 'https://h', 'itemSelector': 'div[', 'fields': {'url': 'a@href'}}]
    )
    result = run_source(spec, StubFetcher({'https://h': '<div><a href="/x">x</a></div>'}), now=NOW)
    assert result.rows == [] and 'Invalid CSS selector' in result.errors[0]


def test_row_columns_union_is_stable_across_sources():
    specs = parse_sources(
        [
            {
                'name': 'J',
                'kind': 'json',
                'url': 'https://j',
                'fields': {'url': 'u', 'stars': 's'},
                'extra': {'lang': 'en'},
            },
            {
                'name': 'R',
                'kind': 'json',
                'urls': [{'url': 'https://r', 'extra': {'subreddit': 'ai'}}],
                'fields': {'url': 'u'},
            },
            {'name': 'F', 'kind': 'feed', 'url': 'https://f'},
        ]
    )
    columns = row_columns(specs)
    assert columns[: len(ROW_COLUMNS)] == list(ROW_COLUMNS)
    assert columns[len(ROW_COLUMNS) :] == ['categories', 'lang', 'stars', 'subreddit']
    # Order of sources does not change the column set.
    assert row_columns(list(reversed(specs))) == columns

    padded = pad_rows([{'url': 'https://r/1', 'subreddit': 'ai'}], columns)
    assert list(padded[0]) == columns
    assert padded[0]['subreddit'] == 'ai' and padded[0]['stars'] is None
