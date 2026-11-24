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
stubbed fetcher and the call's settings, ``IGlobal``'s fetcher cache,
``build_fetcher``'s mapping of the node config, and the definitions and
``IValidator`` through the engine-resolved schema.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from rocketlib.config import ConfigError

NODES_SRC = Path(__file__).resolve().parents[2] / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))

from scraper_beautifulsoup.IEndpoint import IEndpoint  # noqa: E402
from scraper_beautifulsoup.IGlobal import (  # noqa: E402
    DEFAULT_INTERVAL_MS,
    DEFAULT_MAX_BYTES_KB,
    DEFAULT_TIMEOUT_S,
    DEFAULT_USER_AGENT,
    MAX_CACHED_FETCHERS,
    IGlobal,
    build_fetcher,
)
from scraper_beautifulsoup.IInstance import IInstance, _fit_items  # noqa: E402
from scraper_beautifulsoup.IValidator import IValidator  # noqa: E402
from scraper_beautifulsoup.scrape_fetch import FetchError, FetchResult  # noqa: E402

# The allow-list check and its warning live beside the validator
scraper_validator = sys.modules[IValidator.__module__]
NODE_DIR = NODES_SRC / 'scraper_beautifulsoup'

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


def test_render_does_not_fail_a_source_whose_other_url_answered_empty():
    empty = b'<rss version="2.0"><channel><title>T</title></channel></rss>'
    endpoint = make_endpoint(
        [{'name': 'a', 'kind': 'feed', 'urls': ['https://news.example/empty', 'https://news.example/gone']}]
    )
    scan(endpoint)
    endpoint._fetcher = StubFetcher({'https://news.example/empty': ('application/rss+xml', empty)})
    instance = MagicMock(name='instance')

    # One URL failed, the other answered with no items: no rows, but not "every URL failed".
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


def test_validate_config_rejects_an_unpinned_allow_list():
    endpoint = make_endpoint(
        [{'name': 'a', 'kind': 'feed', 'url': 'https://news.example/feed'}],
        urlAllowList=['news\\.example'],
    )
    with pytest.raises(ValueError):
        endpoint.validateConfig(False)


# -- tools through IInstance ----------------------------------------------


class StubGlobal:
    """Stands in for the control's IGlobal: hands every call the same stub fetcher."""

    def __init__(self, stub):
        self.stub = stub

    def fetcher(self, settings):
        return self.stub


def make_instance(responses, max_body_chars=20000, max_tool_chars=20000):
    """An IInstance whose IGlobal hands out a stub fetcher, with the call's settings set."""
    instance = IInstance.__new__(IInstance)
    instance.IGlobal = StubGlobal(StubFetcher(responses))
    # The call's settings (IInstanceBase.settings serves them once set)
    instance._settings = {'maxBodyChars': max_body_chars, 'maxToolChars': max_tool_chars}
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
    (call,) = instance.IGlobal.stub.calls
    assert call['method'] == 'POST' and call['json_body'] == {'q': 1}
    assert call['headers']['Accept'] == 'application/json'


def test_fetch_feed_returns_items():
    instance = make_instance({'https://news.example/feed': ('application/rss+xml', FEED)})
    out = instance.fetch_feed({'url': 'https://news.example/feed', 'limit': 1})
    assert [item['title'] for item in out['items']] == ['One']


def test_fetch_feed_keeps_the_literal_text_of_an_atom_title():
    atom = (
        b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Use &lt;draft&gt;</title>'
        b'<link href="https://news.example/1"/></entry></feed>'
    )
    instance = make_instance({'https://news.example/atom': ('application/atom+xml', atom)})
    (item,) = instance.fetch_feed({'url': 'https://news.example/atom'})['items']
    assert item['title'] == 'Use <draft>' and item['body'] == 'Use <draft>'


# 'Ã©' in windows-1252 is the same two bytes as 'é' in UTF-8.
_CP1252_PAGE = '<html><body><main><p class="r"><a href="/x">Ã©</a></p></main></body></html>'.encode('cp1252')


@pytest.mark.parametrize('fmt', ['text', 'markdown', 'links'])
def test_fetch_page_decodes_by_the_declared_charset(fmt):
    instance = make_instance({'https://site.example/': ('text/html; charset=windows-1252', _CP1252_PAGE)})
    out = instance.fetch_page({'url': 'https://site.example/', 'format': fmt})
    text = out['links'][0]['text'] if fmt == 'links' else out['content']
    assert 'Ã©' in text and 'é' not in text


def test_extract_decodes_by_the_declared_charset():
    instance = make_instance({'https://site.example/': ('text/html; charset=windows-1252', _CP1252_PAGE)})
    out = instance.extract({'url': 'https://site.example/', 'item_selector': '.r', 'fields': {'title': ''}})
    assert out['items'] == [{'title': 'Ã©'}]


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


def test_fetch_page_links_past_the_extractor_limit_are_reported_truncated():
    # The extractor keeps 200 links; the 201st is dropped even though the list fits in max_chars.
    page = ''.join(f'<a href="/{n}">{n}</a>' for n in range(201)).encode()
    instance = make_instance({'https://site.example/': page})
    out = instance.fetch_page({'url': 'https://site.example/', 'format': 'links'})
    assert len(out['links']) == 200
    assert out['truncated'] is True


def test_fetch_page_links_within_the_extractor_limit_are_not_truncated():
    page = ''.join(f'<a href="/{n}">{n}</a>' for n in range(200)).encode()
    out = make_instance({'https://site.example/': page}).fetch_page({'url': 'https://site.example/', 'format': 'links'})
    assert len(out['links']) == 200 and out['truncated'] is False


def test_fetch_page_bounds_the_title_and_description_too():
    long = 'T' * 5000
    page = (
        f'<html><head><title>{long}</title><meta name="description" content="{long}"></head>'
        '<body><main>Body</main></body></html>'
    ).encode()
    instance = make_instance({'https://site.example/': page})
    out = instance.fetch_page({'url': 'https://site.example/', 'format': 'text', 'max_chars': 1000})
    assert len(out['title']) == 1000 and len(out['description']) == 1000
    assert out['content'] == 'Body'
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
    instance.IGlobal = IGlobal.__new__(IGlobal)  # beginGlobal never ran
    instance._settings = {}
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


def refusals(pattern):
    """The messages of the save-time check, the source's fetcher and a tool call for one allow-list pattern."""
    messages = []
    for check in (
        scraper_validator.allow_patterns,
        build_fetcher,
        started_global().fetcher,
    ):
        try:
            check({'urlAllowList': [{'allowPattern': pattern}]})
        except ValueError as e:
            messages.append(str(e))
    return messages


@pytest.mark.parametrize(
    'pattern',
    [
        r'^https://news\.example/',
        r'^http://\[::1\]:8080/',
        r'\Ahttps://api\.example(?=/|$)',
        # Any host, said on purpose: the documented form (README, "or [^/]+ for any host")
        '^https://[^/]+/',
    ],
)
def test_the_documented_allow_list_grammar_is_accepted_at_all_three_checks(pattern):
    assert refusals(pattern) == []


@pytest.mark.parametrize('pattern', [r'news\.example', r'^https://news\.example', '^[^/]+://news\\.example/'])
def test_a_pattern_that_does_not_pin_scheme_and_host_is_refused_at_all_three_checks(pattern):
    # The same rule, with the same message, when the node is saved, for the source and for a tool call
    messages = refusals(pattern)
    assert len(messages) == 3 and len(set(messages)) == 1


# -- IGlobal: one fetcher per distinct set of network settings -------------


def started_global():
    """An IGlobal after beginGlobal, built without the engine."""
    control = IGlobal.__new__(IGlobal)
    control.beginGlobal()
    return control


def test_calls_with_the_same_settings_share_one_fetcher():
    control = started_global()
    first = control.fetcher({'requestIntervalMs': 300})
    assert control.fetcher({'requestIntervalMs': 300}) is first, 'pacing holds across calls'
    assert control.fetcher({'requestIntervalMs': 500}) is not first


def test_the_fetcher_cache_is_bounded():
    control = started_global()
    first = control.fetcher({'timeout': 1})
    for seconds in range(2, MAX_CACHED_FETCHERS + 2):
        control.fetcher({'timeout': seconds})
    assert control.fetcher({'timeout': 1}) is not first, 'the oldest fetcher was dropped'


def test_a_call_with_an_unpinned_allow_list_fails():
    control = started_global()
    with pytest.raises(ValueError):
        control.fetcher({'urlAllowList': [{'allowPattern': 'news\\.example'}]})


def test_end_global_drops_the_fetchers():
    control = started_global()
    control.fetcher({})
    control.endGlobal()
    with pytest.raises(RuntimeError, match='not initialised'):
        control.fetcher({})


# -- the call's settings through the engine-resolved schema -----------------


def control_for(config, logical_type='scraper_beautifulsoup', node_id='scraper_beautifulsoup_1'):
    """A started IGlobal for ``config`` (the stored, path-addressed tree), resolved by the engine's schema."""
    control = IGlobal()
    control.glb = SimpleNamespace(connConfig=config, logicalType=logical_type, id=node_id)
    control.beginGlobal()
    return control


def call_on(control, params=None):
    """One call of ``control``; ``params`` are the caller's parameters for this node."""
    instance = IInstance()
    instance.IGlobal = control
    if params is not None:
        instance._caller = {'params': {control.glb.id: params}}
    return instance


def test_settings_come_from_the_stored_config_and_the_defaults():
    instance = call_on(control_for({'maxToolChars': 1500, 'requestIntervalMs': 0}))
    assert instance._max_chars({}) == 1500
    assert instance._max_body_chars() == 20000
    fetcher = instance.IGlobal.fetcher(instance.settings)
    assert fetcher.timeout == float(DEFAULT_TIMEOUT_S)
    assert fetcher.min_interval == 0.0


def test_a_call_sets_its_own_values_through_parameters():
    control = control_for({})
    assert call_on(control, {'maxToolChars': 1500})._max_chars({}) == 1500
    assert call_on(control)._max_chars({}) == 20000


def test_the_control_config_refuses_a_parameter():
    with pytest.raises(ConfigError):
        control_for({}).config.maxToolChars


# -- the definitions ---------------------------------------------------------


def load_definition(name):
    return json.loads((NODE_DIR / name).read_text(encoding='utf-8'))


def test_definitions_use_the_current_format():
    for name in ('services.source.json', 'services.tool.json'):
        definition = load_definition(name)
        assert not {'preconfig', 'fields', 'shape'} & set(definition), name
        assert definition['path'] == 'nodes.scraper_beautifulsoup'


def test_tool_settings_are_parameters_an_agent_cannot_set():
    definition = load_definition('services.tool.json')
    leaves = definition['propertyDefinitions']
    for name in definition['properties'][1:]:
        assert leaves[name]['param'] is True and leaves[name]['tool'] is False, name
    # A member of an array item may not be a parameter; the whole array is one
    assert 'param' not in leaves['scraper.allowPattern']


def test_source_settings_are_configuration_in_the_parameters_group():
    definition = load_definition('services.source.json')
    # IEndpoint reads serviceConfig['parameters']: leaves listed at the root never reach it
    assert definition['properties'][0] == 'type'
    (group,) = definition['properties'][1:]
    assert group['name'] == 'parameters'
    assert set(group['properties']) == set(definition['propertyDefinitions']) - {'scraper.allowPattern'}
    assert not any(leaf.get('param') for leaf in definition['propertyDefinitions'].values())


# -- IValidator: the allow-list grammar at save time --------------------------


def validator_for(config, logical_type='scraper_beautifulsoup'):
    """The IValidator the engine builds in CONFIG mode for ``config``."""
    validator = IValidator()
    validator.glb = SimpleNamespace(connConfig=config, logicalType=logical_type)
    return validator


@pytest.mark.parametrize(
    'logical_type,config',
    [
        ('scraper_beautifulsoup', {'urlAllowList': [{'allowPattern': 'news\\.example'}]}),
        ('scraper_beautifulsoup_source', {'parameters': {'urlAllowList': [{'allowPattern': 'news\\.example'}]}}),
    ],
)
def test_validator_warns_about_an_unpinned_allow_list(monkeypatch, logical_type, config):
    warnings = []
    monkeypatch.setattr(scraper_validator, 'warning', warnings.append)
    validator_for(config, logical_type).validateConfig()
    assert len(warnings) == 1 and 'must start with a literal' in warnings[0]


def test_validator_accepts_a_pinned_allow_list(monkeypatch):
    warnings = []
    monkeypatch.setattr(scraper_validator, 'warning', warnings.append)
    validator_for({'urlAllowList': [{'allowPattern': '^https://news\\.example/'}]}).validateConfig()
    assert warnings == []
