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

"""Engine wiring of scraper_beautifulsoup: the source endpoint, the tools and the config mapping.

The pure modules have their own tests (test_fetch, test_extract,
test_sources). These cover the engine-facing classes: ``IEndpoint`` (scan,
render, lanes, close, failure), the tools through ``IInstance`` with a
stubbed fetcher, and ``build_fetcher``'s mapping of the node config.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

from engLib import IJson
import pytest

NODES_SRC = Path(__file__).resolve().parents[2] / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))

from scraper_beautifulsoup.IEndpoint import IEndpoint  # noqa: E402
from scraper_beautifulsoup.IGlobal import (  # noqa: E402
    DEFAULT_INTERVAL_MS,
    DEFAULT_MAX_BYTES_KB,
    DEFAULT_TIMEOUT_S,
    DEFAULT_USER_AGENT,
    build_fetcher,
)
from scraper_beautifulsoup.IInstance import IInstance, _fit_items  # noqa: E402
from scraper_beautifulsoup.scrape_fetch import FetchError, FetchResult  # noqa: E402

FEED = b"""<?xml version="1.0"?>
<rss version="2.0"><channel><title>T</title>
<item><title>One</title><link>https://news.example/1</link></item>
<item><title>Two</title><link>https://news.example/2</link></item>
</channel></rss>"""


class StubFetcher:
    """Serves canned responses by URL (bytes, or (content type, bytes)) and records the calls."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def fetch(self, url, *, method='GET', headers=None, params=None, json_body=None, raise_for_status=True):
        self.calls.append({'url': url, 'method': method, 'headers': headers, 'json_body': json_body})
        body = self.responses.get(url)
        if body is None:
            raise FetchError(f'{method} {url} returned HTTP 404')
        content_type = 'text/html'
        if isinstance(body, tuple):
            content_type, body = body
        return FetchResult(url=url, status=200, headers={'content-type': content_type}, content=body)


def make_endpoint(sources, **params):
    """An IEndpoint built without the engine, configured with ``sources``."""
    endpoint = IEndpoint.__new__(IEndpoint)
    endpoint.endpoint = MagicMock(name='endpoint')
    endpoint.endpoint.serviceConfig = {'parameters': {'sources': sources, **params}}
    return endpoint


def scan(endpoint):
    """Run scanObjects and return the reported object names."""
    names = []
    endpoint.scanObjects('', lambda entry: names.append(entry['name']) or 0)
    return names


# -- IEndpoint ------------------------------------------------------------


def test_scan_reports_one_object_per_enabled_source():
    endpoint = make_endpoint(
        [
            {'name': 'a', 'kind': 'feed', 'url': 'https://news.example/feed'},
            {'name': 'b', 'kind': 'feed', 'url': 'https://news.example/other', 'enabled': False},
        ]
    )
    assert scan(endpoint) == ['a']


def test_scan_stops_when_the_engine_asks():
    endpoint = make_endpoint(
        [
            {'name': 'a', 'kind': 'feed', 'url': 'https://news.example/a'},
            {'name': 'b', 'kind': 'feed', 'url': 'https://news.example/b'},
        ]
    )
    names = []
    endpoint.scanObjects('', lambda entry: names.append(entry['name']) or 1)
    assert names == ['a']


def test_render_sends_rows_on_answers_and_text_then_closes():
    endpoint = make_endpoint([{'name': 'a', 'kind': 'feed', 'url': 'https://news.example/feed'}])
    scan(endpoint)
    endpoint._fetcher = StubFetcher({'https://news.example/feed': ('application/rss+xml', FEED)})
    instance = MagicMock(name='instance')

    endpoint.renderSourceObject(SimpleNamespace(name='a'), instance)

    (answer,), _ = instance.sendAnswers.call_args
    rows = answer.getJson()
    assert [row['url'] for row in rows] == ['https://news.example/1', 'https://news.example/2']
    assert all(set(row) == set(rows[0]) for row in rows), 'every row carries the same columns'
    assert instance.sendText.call_count == 2
    assert 'One' in instance.sendText.call_args_list[0].args[0]
    instance.sendClose.assert_called_once()


def test_render_raises_when_every_url_fails_and_still_closes():
    endpoint = make_endpoint([{'name': 'a', 'kind': 'feed', 'url': 'https://news.example/gone'}])
    scan(endpoint)
    endpoint._fetcher = StubFetcher({})
    instance = MagicMock(name='instance')

    with pytest.raises(RuntimeError, match='every URL failed'):
        endpoint.renderSourceObject(SimpleNamespace(name='a'), instance)
    instance.sendAnswers.assert_not_called()
    instance.sendClose.assert_called_once()


def test_render_unknown_source_raises_and_closes():
    endpoint = make_endpoint([{'name': 'a', 'kind': 'feed', 'url': 'https://news.example/feed'}])
    scan(endpoint)
    instance = MagicMock(name='instance')
    with pytest.raises(ValueError, match='unknown source'):
        endpoint.renderSourceObject(SimpleNamespace(name='zzz'), instance)
    instance.sendClose.assert_called_once()


class _FakeResponse:
    status_code = 200
    headers = {'content-type': 'application/rss+xml'}
    raw = None

    def iter_content(self, chunk_size):
        return iter([FEED])

    def close(self):
        pass


class _RecordingSession:
    """Stands in for a pinned session; records when each request was sent."""

    def __init__(self, sent):
        self.sent = sent

    def request(self, method, url, **kwargs):
        self.sent.append((url, time.monotonic()))
        return _FakeResponse()

    def close(self):
        pass


def test_pacing_holds_between_sources_of_one_host():
    endpoint = make_endpoint(
        [
            {'name': 'a', 'kind': 'feed', 'url': 'https://news.example/a'},
            {'name': 'b', 'kind': 'feed', 'url': 'https://news.example/b'},
        ],
        requestIntervalMs=300,
    )
    scan(endpoint)
    sent = []
    endpoint._fetcher.resolve_url = lambda url: ('validated',)
    endpoint._fetcher.open_session = lambda addresses: _RecordingSession(sent)

    for name in ('a', 'b'):
        endpoint.renderSourceObject(SimpleNamespace(name=name), MagicMock(name='instance'))

    assert [url for url, _ in sent] == ['https://news.example/a', 'https://news.example/b']
    assert sent[1][1] - sent[0][1] >= 0.29, 'the second source waited out the per-host interval'


@pytest.mark.parametrize('allow_list', [[], [{'pattern': r'^https://news\.example/'}]])
def test_validate_and_scan_accept_engine_allow_list(allow_list):
    endpoint = make_endpoint(
        json.dumps([{'name': 'a', 'kind': 'feed', 'url': 'https://news.example/feed'}]),
        urlAllowList=allow_list,
    )
    endpoint.endpoint.serviceConfig = IJson(endpoint.endpoint.serviceConfig)

    endpoint.validateConfig(False)
    assert scan(endpoint) == ['a']
    assert [pattern.pattern for pattern in endpoint._fetcher.allow_patterns] == [row['pattern'] for row in allow_list]


def test_validate_config_rejects_an_unpinned_allow_list():
    endpoint = make_endpoint(
        json.dumps([{'name': 'a', 'kind': 'feed', 'url': 'https://news.example/feed'}]),
        urlAllowList=[{'pattern': r'news\.example'}],
    )
    endpoint.endpoint.serviceConfig = IJson(endpoint.endpoint.serviceConfig)

    with pytest.raises(ValueError, match='must start with a literal http:// or https:// scheme'):
        endpoint.validateConfig(False)


# -- tools through IInstance ----------------------------------------------


def make_instance(responses, max_body_chars=20000, max_tool_chars=20000):
    """An IInstance whose IGlobal holds a stub fetcher."""
    instance = IInstance.__new__(IInstance)
    instance.IGlobal = SimpleNamespace(
        fetcher=StubFetcher(responses), max_body_chars=max_body_chars, max_tool_chars=max_tool_chars
    )
    return instance


def test_fetch_page_returns_markdown():
    page = b'<html><head><title>Hi</title></head><body><main><h1>Title</h1><p>Body <a href="/x">link</a></p></main></body></html>'
    instance = make_instance({'https://site.example/': page})
    out = instance.fetch_page({'url': 'https://site.example/'})
    assert out['title'] == 'Hi'
    assert '# Title' in out['content']
    assert '[link](https://site.example/x)' in out['content']
    assert out['truncated'] is False


def test_fetch_page_refuses_a_binary_content_type():
    instance = make_instance({'https://site.example/a.pdf': ('application/pdf', b'%PDF-1.7')})
    with pytest.raises(ValueError, match='unsupported content type application/pdf'):
        instance.fetch_page({'url': 'https://site.example/a.pdf'})


def test_extract_refuses_a_binary_content_type():
    instance = make_instance({'https://site.example/i.png': ('image/png', b'\x89PNG')})
    with pytest.raises(ValueError, match='unsupported content type image/png'):
        instance.extract({'url': 'https://site.example/i.png', 'fields': {'title': 'h1'}})


@pytest.mark.parametrize('tool', ['fetch_page', 'fetch_json', 'fetch_feed'])
def test_tool_errors_omit_the_query_string(tool):
    url = 'https://api.example/data?api_key=SECRET'
    instance = make_instance({url: ('application/pdf', b'%PDF not json, not a feed')})
    with pytest.raises(ValueError) as exc_info:
        getattr(instance, tool)({'url': url})
    assert 'SECRET' not in str(exc_info.value)
    assert 'https://api.example/data' in str(exc_info.value)


def test_fetch_page_accepts_plain_text_and_a_missing_content_type():
    instance = make_instance(
        {'https://site.example/t': ('text/plain', b'hello'), 'https://site.example/n': ('', b'hi')}
    )
    assert 'hello' in instance.fetch_page({'url': 'https://site.example/t', 'format': 'text'})['content']
    assert 'hi' in instance.fetch_page({'url': 'https://site.example/n', 'format': 'text'})['content']


def test_fetch_json_maps_items_and_sends_the_body():
    body = json.dumps({'hits': [{'t': 'A', 'u': 'https://a'}, {'t': 'B', 'u': 'https://b'}]}).encode()
    instance = make_instance({'https://api.example/q': ('application/json', body)})
    out = instance.fetch_json(
        {
            'url': 'https://api.example/q',
            'method': 'POST',
            'body_json': {'q': 1},
            'items_path': 'hits',
            'fields': {'title': 't', 'url': 'u'},
            'limit': 1,
        }
    )
    assert out['items'] == [{'title': 'A', 'url': 'https://a'}]
    (call,) = instance.IGlobal.fetcher.calls
    assert call['method'] == 'POST' and call['json_body'] == {'q': 1}
    assert call['headers']['Accept'] == 'application/json'


def test_fetch_feed_returns_items():
    instance = make_instance({'https://news.example/feed': ('application/rss+xml', FEED)})
    out = instance.fetch_feed({'url': 'https://news.example/feed', 'limit': 1})
    assert [item['title'] for item in out['items']] == ['One']


def test_fetch_error_reaches_the_agent_as_value_error():
    instance = make_instance({})
    with pytest.raises(ValueError, match='HTTP 404'):
        instance.fetch_page({'url': 'https://site.example/missing'})


def test_tool_rejects_an_out_of_range_limit():
    instance = make_instance({'https://news.example/feed': ('application/rss+xml', FEED)})
    with pytest.raises(ValueError):
        instance.fetch_feed({'url': 'https://news.example/feed', 'limit': '3'})


# -- tool output ceiling (scraper.maxToolChars) ------------------------------

_BIG_ITEMS = [{'title': f'Item {n}', 'url': f'https://news.example/{n}', 'body': 'x' * 400} for n in range(40)]


def _assert_cut(items, max_chars):
    assert items, 'some items fit'
    assert len(items) < len(_BIG_ITEMS)
    assert len(json.dumps(items)) <= max_chars


def test_fetch_json_items_are_cut_to_max_chars():
    url = 'https://api.example/q'
    instance = make_instance({url: ('application/json', json.dumps({'hits': _BIG_ITEMS}).encode())})
    out = instance.fetch_json({'url': url, 'items_path': 'hits', 'max_chars': 2000, 'limit': 500})
    _assert_cut(out['items'], 2000)
    assert out['truncated'] is True


def test_extract_items_are_cut_to_max_chars():
    page = ''.join(f'<div class="r"><a href="/{n}">{"T" * 400}</a></div>' for n in range(40)).encode()
    instance = make_instance({'https://site.example/': page})
    out = instance.extract(
        {
            'url': 'https://site.example/',
            'item_selector': '.r',
            'fields': {'title': 'a', 'url': 'a@href'},
            'max_chars': 2000,
            'limit': 500,
        }
    )
    assert out['items'] and len(json.dumps(out['items'])) <= 2000
    assert out['truncated'] is True


def test_fetch_feed_items_are_cut_to_max_chars():
    items = ''.join(
        f'<item><title>Item {n}</title><link>https://news.example/{n}</link><description>{"x" * 400}</description></item>'
        for n in range(40)
    )
    feed = f'<rss version="2.0"><channel>{items}</channel></rss>'.encode()
    instance = make_instance({'https://news.example/feed': ('application/rss+xml', feed)})
    out = instance.fetch_feed({'url': 'https://news.example/feed', 'max_chars': 2000, 'limit': 500})
    assert out['items'] and len(json.dumps(out['items'])) <= 2000
    assert out['truncated'] is True


def _one_entry_feed(body):
    item = f'<item><title>Entry</title><link>https://news.example/1</link><description>{body}</description></item>'
    return f'<rss version="2.0"><channel>{item}</channel></rss>'.encode()


def test_a_feed_entry_longer_than_max_chars_comes_back_shortened():
    # maxBodyChars and maxToolChars both default to 20000: the entry alone is too big for the list.
    instance = make_instance({'https://news.example/feed': ('application/rss+xml', _one_entry_feed('x' * 20000))})
    out = instance.fetch_feed({'url': 'https://news.example/feed'})
    (entry,) = out['items']
    assert entry['url'] == 'https://news.example/1' and entry['title'] == 'Entry'
    assert entry['body'] == 'x' * len(entry['body']) and 19000 < len(entry['body']) < 20000
    assert len(json.dumps(out['items'], ensure_ascii=False)) <= 20000
    assert out['truncated'] is True


def test_a_non_ascii_entry_that_fits_in_characters_comes_back_whole():
    # 3400 Cyrillic characters: about 3500 characters of JSON, but over 20000 as \\uXXXX escapes.
    body = 'Привет мир ' * 309 + 'П'
    instance = make_instance({'https://news.example/feed': ('application/rss+xml', _one_entry_feed(body))})
    out = instance.fetch_feed({'url': 'https://news.example/feed'})
    assert [e['body'] for e in out['items']] == [body]
    assert out['truncated'] is False


def test_a_string_item_longer_than_max_chars_comes_back_shortened():
    data = {'hits': ['a' * 5000, 'b']}
    instance = make_instance({'https://api.example/': ('application/json', json.dumps(data).encode())})
    out = instance.fetch_json({'url': 'https://api.example/', 'items_path': 'hits', 'max_chars': 1000})
    (item,) = out['items']
    assert item == 'a' * len(item) and len(json.dumps(out['items'])) <= 1000
    assert out['truncated'] is True


def test_fit_items_shortens_through_json_escapes():
    # Quotes and newlines take two characters as JSON; the result must still fit.
    (item,), cut = _fit_items([{'body': '"\n' * 500, 'url': 'u'}], 300)
    assert cut is True and len(json.dumps([item], ensure_ascii=False)) <= 300 and item['url'] == 'u'


def test_fit_items_drops_an_item_with_no_string_to_shorten():
    assert _fit_items([[1] * 500], 100) == ([], True)


def test_fetch_page_links_are_cut_to_max_chars():
    page = ''.join(f'<a href="/page/{n}">{"L" * 100}</a>' for n in range(100)).encode()
    instance = make_instance({'https://site.example/': page})
    out = instance.fetch_page({'url': 'https://site.example/', 'format': 'links', 'max_chars': 1500})
    assert out['links'] and len(json.dumps(out['links'])) <= 1500
    assert out['truncated'] is True


def test_max_chars_cannot_exceed_the_operator_ceiling():
    page = b'<main>' + b'word ' * 10000 + b'</main>'
    instance = make_instance({'https://site.example/': page}, max_tool_chars=3000)
    out = instance.fetch_page({'url': 'https://site.example/', 'format': 'text', 'max_chars': 1_000_000})
    assert len(out['content']) == 3000
    assert out['truncated'] is True


def test_default_max_chars_follows_a_lower_ceiling():
    page = b'<main>' + b'word ' * 10000 + b'</main>'
    instance = make_instance({'https://site.example/': page}, max_tool_chars=1500)
    assert len(instance.fetch_page({'url': 'https://site.example/', 'format': 'text'})['content']) == 1500


def test_tool_without_a_fetcher_reports_it():
    instance = IInstance.__new__(IInstance)
    instance.IGlobal = SimpleNamespace(fetcher=None, max_body_chars=20000, max_tool_chars=20000)
    with pytest.raises(RuntimeError, match='not initialised'):
        instance.fetch_page({'url': 'https://site.example/'})


# -- build_fetcher config mapping -----------------------------------------


def test_build_fetcher_maps_units():
    fetcher = build_fetcher(
        {
            'timeout': 7,
            'maxResponseKB': 64,
            'requestIntervalMs': 1500,
            'userAgent': '  my-agent/2  ',
            'urlAllowList': [{'pattern': '^https://news\\.example/'}],
        }
    )
    assert fetcher.timeout == 7.0
    assert fetcher.max_bytes == 64 * 1024
    assert fetcher.min_interval == 1.5
    assert fetcher.user_agent == 'my-agent/2'
    assert [p.pattern for p in fetcher.allow_patterns] == ['^https://news\\.example/']
    assert fetcher.allow_match is not None
    assert fetcher.canonicalize is not None


def test_build_fetcher_defaults():
    fetcher = build_fetcher({})
    assert fetcher.timeout == float(DEFAULT_TIMEOUT_S)
    assert fetcher.max_bytes == DEFAULT_MAX_BYTES_KB * 1024
    assert fetcher.min_interval == DEFAULT_INTERVAL_MS / 1000.0
    assert fetcher.user_agent == DEFAULT_USER_AGENT
    assert fetcher.allow_patterns == []


def test_build_fetcher_clamps_out_of_range_values():
    fetcher = build_fetcher({'timeout': 9999, 'maxResponseKB': 1, 'requestIntervalMs': 999999})
    assert fetcher.timeout == 120.0
    assert fetcher.max_bytes == 16 * 1024
    assert fetcher.min_interval == 60.0


def test_build_fetcher_zero_interval_disables_pacing():
    assert build_fetcher({'requestIntervalMs': 0}).min_interval == 0.0
    assert build_fetcher({'requestIntervalMs': '0'}).min_interval == 0.0
    assert build_fetcher({'requestIntervalMs': -5}).min_interval == DEFAULT_INTERVAL_MS / 1000.0


def test_build_fetcher_rejects_an_unpinned_allow_list_row():
    with pytest.raises(ValueError):
        build_fetcher({'urlAllowList': [{'pattern': 'news\\.example'}]})
