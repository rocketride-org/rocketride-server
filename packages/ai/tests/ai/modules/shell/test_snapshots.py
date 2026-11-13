# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Crawler snapshots, their template context and the render and snapshot caches.

A crawler on a page that declares a ``snapshot`` gets that file from the
production version's build output, rendered through the restricted template
engine with ``assets`` (the version's URL base), under the page's head. A page
without a snapshot, or with an unreadable one, serves crawlers the shell
document; people always get the shell document. Rendered responses are cached
per (path, UA class) under a byte budget and cleared on every aggregate swap;
snapshot text is cached per store path under its own byte budget.
"""

from __future__ import annotations

import asyncio
import copy
import re
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai.modules.shell.pages as pages
import ai.modules.shell.public_pages as pp
import ai.modules.shell.shell as shell_mod
from ai.modules.shell.contract import MAX_SNAPSHOT_BYTES
from ai.modules.shell.pages import FALLBACK_PATH, public_page, snapshot_path
from ai.modules.shell.public_pages import Aggregate, Page
from ai.modules.shell.template import MAX_SECTION_DEPTH, render

from ai.account.store import StorageError, StorageNotFoundError

from .hostile_fixtures import (
    FILES,
    HOME_MANIFEST,
    HOSTILE_DESCRIPTION,
    HOSTILE_NAME,
    dist_of,
    file_info,
    hostile_account,
    install,
    read_file,
)

GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'
SHELL_BODY = '<div id="root">shell</div>'
PLATFORM = '00000000-platform'
DIST = dist_of(PLATFORM, 'rocketride.home', 3)
MIB = 1024 * 1024

SNAPSHOT = (
    '<!doctype html><html><head><title>snap</title></head><body><h1>Pricing plans</h1>'
    '<img src="{{assets}}/seo-assets/logo.svg" alt="RocketRide">'
    '<ul>{{#plans}}<li>{{name}}</li>{{/plans}}</ul></body></html>'
)

# Copies of home-ui's build output (apps/home-ui/public/pages/), as it ships.
HOME_UI = Path(__file__).parent / 'fixtures' / 'home-ui'


@pytest.fixture
def shell_root(tmp_path, monkeypatch):
    (tmp_path / 'index.html').write_text(f'<html><head><title>shell</title></head><body>{SHELL_BODY}</body></html>')
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path))
    return tmp_path


@pytest.fixture
def reads(monkeypatch):
    """Every store path the serving path reads, in order."""
    log = []

    async def counting(path):
        log.append(path)
        return await read_file(path)

    monkeypatch.setattr(pp, 'read_artifact_file', counting)
    return log


@pytest.fixture
def stats(monkeypatch):
    """Every store path the serving path stats, in order."""
    log = []

    async def counting(path):
        log.append(path)
        return await file_info(path)

    monkeypatch.setattr(pp, 'artifact_file_info', counting)
    return log


@pytest.fixture
def warned(monkeypatch):
    lines = []
    monkeypatch.setattr(pages, 'warning', lines.append)
    return lines


def _app():
    app = FastAPI()
    app.add_api_route('/', public_page, methods=['GET', 'HEAD'])
    app.add_api_route(FALLBACK_PATH, public_page, methods=['GET', 'HEAD'])
    return app


def _client():
    return TestClient(_app())


def _page(path='/pricing', snapshot='pages/pricing.html', **extra):
    fields = dict(
        path=path,
        app_id='rocketride.home',
        title='Pricing | RocketRide',
        description='Plans and prices.',
        snapshot=snapshot,
        data=('plans',),
        dist_dir=DIST,
        version=3,
    )
    fields.update(extra)
    return Page(**fields)


def _serve(*served):
    pp.swap(Aggregate(exact={p.path: p for p in served}))


def _seed(text=SNAPSHOT, name='pages/pricing.html', dist=DIST):
    FILES[f'{dist}/{name}'] = text.encode()


def _crawl(client, path='/pricing'):
    return client.get(path, headers={'User-Agent': GOOGLEBOT})


async def _crawl_at_once(count, path='/pricing'):
    """``count`` crawler requests for ``path``, all in flight together on one event loop."""
    transport = httpx.ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url='http://testserver') as client:
        return await asyncio.gather(*[client.get(path, headers={'User-Agent': GOOGLEBOT}) for _ in range(count)])


# ---------------------------------------------------------------------------
# What crawlers and people get
# ---------------------------------------------------------------------------


def test_crawler_gets_the_rendered_snapshot_and_people_get_the_shell_document(shell_root):
    _seed()
    _serve(_page())
    client = _client()
    crawler = _crawl(client)
    assert crawler.status_code == 200
    assert '<h1>Pricing plans</h1>' in crawler.text and SHELL_BODY not in crawler.text
    assert '<img src="/apps/rocketride.home/v3/seo-assets/logo.svg" alt="RocketRide">' in crawler.text
    assert '<title>Pricing | RocketRide</title>' in crawler.text and '<title>snap</title>' not in crawler.text
    assert '<meta name="description" content="Plans and prices.">' in crawler.text
    assert crawler.headers['cache-control'] == 'private, max-age=3600'
    assert crawler.headers['vary'] == 'User-Agent'
    human = client.get('/pricing', headers={'User-Agent': BROWSER})
    assert SHELL_BODY in human.text and 'Pricing plans' not in human.text
    assert '<title>Pricing | RocketRide</title>' in human.text
    assert human.headers['cache-control'] == 'private, no-cache'


def test_head_on_a_snapshot_page_answers_like_get(shell_root):
    _seed()
    _serve(_page())
    client = _client()
    get = _crawl(client)
    head = client.head('/pricing', headers={'User-Agent': GOOGLEBOT})
    assert head.status_code == 200 and head.content == b''
    assert head.headers['content-length'] == get.headers['content-length']
    assert head.headers['cache-control'] == get.headers['cache-control']


def test_an_unlisted_snapshot_page_stays_noindex(shell_root):
    _seed()
    _serve(_page(listed=False))
    resp = _crawl(_client())
    assert 'Pricing plans' in resp.text and '<meta name="robots" content="noindex">' in resp.text
    assert resp.headers['x-robots-tag'] == 'noindex'


def test_snapshot_assets_resolve_to_the_production_version(shell_root):
    _seed('<img src="{{assets}}/x.png">')
    _serve(_page())
    assert '<img src="/apps/rocketride.home/v3/x.png">' in _crawl(_client()).text
    # A new production version: its own build output, its own asset base.
    dist = dist_of(PLATFORM, 'rocketride.home', 4)
    _seed('<img src="{{assets}}/x.png">', dist=dist)
    _serve(_page(dist_dir=dist, version=4))
    text = _crawl(_client()).text
    assert '<img src="/apps/rocketride.home/v4/x.png">' in text and '/v3/' not in text


def test_data_sections_render_empty_until_their_source_is_bound(shell_root):
    _seed()
    _serve(_page())
    text = _crawl(_client()).text
    assert '<ul></ul>' in text and '{{' not in text


def test_a_page_without_a_snapshot_serves_crawlers_the_shell_document(shell_root, reads):
    _serve(_page(snapshot=''))
    resp = _crawl(_client())
    assert resp.status_code == 200 and SHELL_BODY in resp.text
    assert '<title>Pricing | RocketRide</title>' in resp.text
    # The shell document names the current build's bundles: no shared cache may keep it.
    assert resp.headers['cache-control'] == 'private, no-cache'
    assert reads == []


@pytest.mark.parametrize(
    'failure',
    [StorageNotFoundError('File not found'), StorageError('store down')],
    ids=['not-in-the-store', 'store-down'],
)
def test_a_failed_snapshot_read_is_served_uncached_and_warned(shell_root, monkeypatch, warned, failure):
    # No storage failure is final: a gated version's files may not be readable
    # yet, and a store recovers. Nothing downstream may keep the fallback.
    _seed()
    _serve(_page())

    async def failing(path):
        raise failure

    clock = [1000.0]
    monkeypatch.setattr(pp, 'read_artifact_file', failing)
    monkeypatch.setattr(pages, 'monotonic', lambda: clock[0])
    client = _client()
    resp = _crawl(client)
    assert resp.status_code == 200 and SHELL_BODY in resp.text
    assert '<title>Pricing | RocketRide</title>' in resp.text
    assert resp.headers['cache-control'] == 'private, no-cache'
    assert len(pages._render_cache) == 0
    assert any("'pages/pricing.html'" in line and '/pricing' in line and str(failure) in line for line in warned)
    # The read succeeds again: the first crawl after the backoff gets the snapshot.
    monkeypatch.setattr(pp, 'read_artifact_file', read_file)
    clock[0] += pages._STORAGE_BACKOFF_SECONDS
    resp = _crawl(client)
    assert 'Pricing plans' in resp.text and resp.headers['cache-control'] == 'private, max-age=3600'


def test_a_storage_failure_warns_once_per_store_path_per_interval(shell_root, monkeypatch, warned):
    # While the store is down each path is read again after every backoff; the log gets one line per path per interval.
    _seed()
    _seed(name='pages/other.html')
    _serve(_page(), _page('/other', snapshot='pages/other.html'))

    async def down(path):
        raise StorageError('store down')

    clock = [1000.0]
    monkeypatch.setattr(pp, 'artifact_file_info', down)
    monkeypatch.setattr(pages, 'monotonic', lambda: clock[0])
    client = _client()
    for _ in range(3):
        resp = _crawl(client)
        assert SHELL_BODY in resp.text and resp.headers['cache-control'] == 'private, no-cache'
    assert len(warned) == 1 and 'store down' in warned[0]
    _crawl(client, '/other')
    assert len(warned) == 2 and 'pages/other.html' in warned[1]
    clock[0] += pages._STORAGE_WARNING_INTERVAL - 1
    _crawl(client)
    assert len(warned) == 2
    clock[0] += pages._STORAGE_BACKOFF_SECONDS
    _crawl(client)
    assert len(warned) == 3 and "'pages/pricing.html'" in warned[2]
    assert len(pages._storage_warned) == 2 <= pages._storage_warned.max_entries


def test_a_programming_error_reading_a_snapshot_is_raised_not_served(shell_root, monkeypatch, warned):
    # Only storage failures fall back: a bug must surface, not be served as the shell document.
    _seed()
    _serve(_page())

    async def sizeless(path):
        return {'modified': 0.0}

    monkeypatch.setattr(pp, 'artifact_file_info', sizeless)
    with pytest.raises(KeyError):
        _crawl(_client())
    assert len(pages._render_cache) == 0 and warned == []


def test_a_store_that_does_not_answer_in_time_falls_back_uncached(shell_root, monkeypatch, warned):
    # The S3 store retries a failing read for minutes; a crawler waits at most
    # _SNAPSHOT_READ_SECONDS, then gets the shell document, uncached, and the
    # path backs off like after any storage failure.
    _seed()
    _serve(_page())

    async def hanging(path):
        await asyncio.sleep(60)

    clock = [1000.0]
    monkeypatch.setattr(pp, 'artifact_file_info', hanging)
    monkeypatch.setattr(pages, '_SNAPSHOT_READ_SECONDS', 0.05)
    monkeypatch.setattr(pages, 'monotonic', lambda: clock[0])
    client = _client()
    resp = _crawl(client)
    assert resp.status_code == 200 and SHELL_BODY in resp.text
    assert resp.headers['cache-control'] == 'private, no-cache'
    assert len(pages._render_cache) == 0 and len(pages._snapshot_cache) == 0
    assert len(warned) == 1 and 'did not answer within 0.05 s' in warned[0]
    # The store answers again: the first crawl after the backoff gets the snapshot.
    monkeypatch.setattr(pp, 'artifact_file_info', file_info)
    assert SHELL_BODY in _crawl(client).text
    clock[0] += pages._STORAGE_BACKOFF_SECONDS
    assert 'Pricing plans' in _crawl(client).text


def test_concurrent_crawler_misses_on_one_path_share_one_store_read(shell_root, monkeypatch, reads):
    # A crawler burst on a cold cache: one stat and one download, not one per request.
    _seed()
    _serve(_page())
    stats = []

    async def slow_stat(path):
        stats.append(path)
        await asyncio.sleep(0.05)  # every request arrives while the first read is in flight
        return await file_info(path)

    monkeypatch.setattr(pp, 'artifact_file_info', slow_stat)
    responses = asyncio.run(_crawl_at_once(20))
    assert all(resp.status_code == 200 and 'Pricing plans' in resp.text for resp in responses)
    path = snapshot_path(_page())
    assert stats == [path] and reads == [path]
    assert pages._snapshot_reads == {}


def test_a_crawler_that_stops_waiting_never_cancels_the_shared_read(shell_root, monkeypatch):
    # A request past its deadline, or cancelled, leaves the shared read running:
    # it caches what it reads for the next request instead of starting over.
    _seed()
    path = snapshot_path(_page())
    monkeypatch.setattr(pages, '_SNAPSHOT_READ_SECONDS', 0.05)

    async def scenario():
        release = asyncio.Event()

        async def gated_stat(stat_path):
            await release.wait()
            return await file_info(stat_path)

        monkeypatch.setattr(pp, 'artifact_file_info', gated_stat)
        late = asyncio.create_task(pages._snapshot_bytes(path))
        gone = asyncio.create_task(pages._snapshot_bytes(path))
        await asyncio.sleep(0)
        read = pages._snapshot_reads[path]
        gone.cancel()
        with pytest.raises(StorageError, match='did not answer within 0.05 s'):
            await late
        with pytest.raises(asyncio.CancelledError):
            await gone
        assert not read.done()
        release.set()
        return await read

    assert asyncio.run(scenario()) == SNAPSHOT.encode()
    assert pages._snapshot_cache.get(path) == SNAPSHOT.encode()
    assert pages._snapshot_reads == {}


def test_a_read_that_outlives_its_deadline_serves_the_next_crawl_in_the_backoff(shell_root, monkeypatch, warned):
    # The first crawler gives up and backs the path off; the read it started
    # still lands in the snapshot cache, which the backoff does not hide.
    _seed()
    _serve(_page())
    monkeypatch.setattr(pages, '_SNAPSHOT_READ_SECONDS', 0.05)

    async def slow_stat(path):
        await asyncio.sleep(0.2)
        return await file_info(path)

    monkeypatch.setattr(pp, 'artifact_file_info', slow_stat)

    async def scenario():
        [late] = await _crawl_at_once(1)
        await pages._snapshot_reads[snapshot_path(_page())]
        [after] = await _crawl_at_once(1)
        return late, after

    late, after = asyncio.run(scenario())
    assert SHELL_BODY in late.text and late.headers['cache-control'] == 'private, no-cache'
    assert len(warned) == 1 and 'did not answer within 0.05 s' in warned[0]
    assert 'Pricing plans' in after.text


def test_a_failing_path_is_not_read_again_within_the_backoff(shell_root, monkeypatch, warned):
    # While the store fails, crawlers cost one store call per path per backoff, not one per request.
    _seed()
    _seed(name='pages/other.html')
    _serve(_page(), _page('/other', snapshot='pages/other.html'))
    stats = []

    async def down(path):
        stats.append(path)
        raise StorageError('store down')

    clock = [1000.0]
    monkeypatch.setattr(pp, 'artifact_file_info', down)
    monkeypatch.setattr(pages, 'monotonic', lambda: clock[0])
    client = _client()
    for _ in range(3):
        resp = _crawl(client)
        assert SHELL_BODY in resp.text and resp.headers['cache-control'] == 'private, no-cache'
    assert stats == [snapshot_path(_page())]
    # The backoff is per path: another page still asks the store.
    _crawl(client, '/other')
    assert len(stats) == 2
    clock[0] += pages._STORAGE_BACKOFF_SECONDS - 1
    _crawl(client)
    assert len(stats) == 2
    clock[0] += 1
    _crawl(client)
    assert len(stats) == 3
    # The store recovers: the first crawl after the next backoff gets the snapshot.
    monkeypatch.setattr(pp, 'artifact_file_info', file_info)
    clock[0] += pages._STORAGE_BACKOFF_SECONDS
    assert 'Pricing plans' in _crawl(client).text
    assert len(warned) == 2


def test_a_snapshot_the_engine_refuses_falls_back_cacheably_and_warns_once(shell_root, reads, warned):
    # A version's snapshot never changes, so neither does the template error.
    _seed('{{#plans}}' * (MAX_SECTION_DEPTH + 1) + 'deep')
    _serve(_page())
    client = _client()
    for _ in range(2):
        resp = _crawl(client)
        assert resp.status_code == 200 and SHELL_BODY in resp.text
        assert resp.headers['cache-control'] == 'private, no-cache'
    assert len(pages._render_cache) == 1 and len(reads) == 1
    assert len(warned) == 1 and 'nest deeper' in warned[0]
    # A swap drops the cached response, not the memory of the bad version.
    _serve(_page(title='Renamed'))
    assert '<title>Renamed</title>' in _crawl(client).text
    assert len(reads) == 1 and len(warned) == 1


def test_a_snapshot_over_the_size_cap_is_never_read_and_falls_back_cacheably(shell_root, reads, stats, warned):
    _seed('x' * (MAX_SNAPSHOT_BYTES + 1))
    _serve(_page())
    client = _client()
    for _ in range(2):
        resp = _crawl(client)
        assert resp.status_code == 200 and SHELL_BODY in resp.text
        assert resp.headers['cache-control'] == 'private, no-cache'
    assert reads == [] and stats == [f'{DIST}/pages/pricing.html']
    assert len(pages._render_cache) == 1 and len(pages._snapshot_cache) == 0
    assert len(warned) == 1 and f'over the {MAX_SNAPSHOT_BYTES}-byte limit' in warned[0]
    _serve(_page(title='Renamed'))
    assert '<title>Renamed</title>' in _crawl(client).text
    assert reads == [] and len(stats) == 1 and len(warned) == 1


def test_a_snapshot_at_the_size_cap_renders(shell_root):
    filler = 'x' * (MAX_SNAPSHOT_BYTES - len(SNAPSHOT))
    _seed(SNAPSHOT.replace('</body>', f'{filler}</body>'))
    _serve(_page())
    assert 'Pricing plans' in _crawl(_client()).text


@pytest.mark.parametrize('snapshot', ['../escape.html', '/abs.html', 'pages/../../x.html', 'a\\b.html', ''])
def test_snapshot_paths_resolve_only_inside_the_artifact(snapshot):
    with pytest.raises(ValueError):
        snapshot_path(_page(snapshot=snapshot))


def test_a_snapshot_needs_its_production_version():
    for page in (_page(dist_dir=''), _page(version=None)):
        with pytest.raises(ValueError):
            snapshot_path(page)


def test_snapshot_path_inside_the_artifact():
    assert snapshot_path(_page()) == f'{DIST}/pages/pricing.html'


def test_a_malformed_snapshot_path_never_reads_and_falls_back_cacheably(shell_root, reads, warned):
    # A malformed path is final for this page, so the fallback is cached like any render.
    _serve(_page(snapshot='../../secrets.html'))
    client = _client()
    for _ in range(2):
        resp = _crawl(client)
        assert resp.status_code == 200 and SHELL_BODY in resp.text
        assert resp.headers['cache-control'] == 'private, no-cache'
    assert reads == [] and len(pages._render_cache) == 1 and len(warned) == 1


def test_the_shell_document_is_never_template_rendered(shell_root):
    (shell_root / 'index.html').write_text(
        '<html><head></head><body><script>var t="{{assets}}{{#plans}}";</script></body></html>'
    )
    _serve(_page(snapshot=''), _page('/missing', snapshot='pages/missing.html'))
    client = _client()
    for path in ('/pricing', '/missing'):
        for ua in (GOOGLEBOT, BROWSER):
            assert 'var t="{{assets}}{{#plans}}"' in client.get(path, headers={'User-Agent': ua}).text


def test_hostile_page_metadata_stays_escaped_in_the_snapshot_head(shell_root):
    _seed()
    _serve(_page(title=HOSTILE_NAME, description=HOSTILE_DESCRIPTION))
    text = _crawl(_client()).text
    head = text.split('</head>', 1)[0]
    assert '<script>alert' not in text and '<img src=x' not in text
    assert '&lt;script&gt;alert("n")&lt;/script&gt;' in head
    # Template syntax in manifest text is printed, never expanded.
    assert '{{#apps}}x{{/apps}}' in head


# ---------------------------------------------------------------------------
# home-ui's real snapshots
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('name', ['pricing.html', 'index.html'])
@pytest.mark.parametrize('context', [{}, {'plans': []}], ids=['plans-absent', 'plans-empty'])
def test_home_ui_snapshots_render_completely(name, context):
    source = (HOME_UI / name).read_text(encoding='utf-8')
    issues = []
    out = render(source, {'assets': '/apps/rocketride.home/v12', **context}, on_issue=issues.append)
    assert '{{' not in out and '}}' not in out
    assets = re.findall(r'(?:src|href|srcset)="([^"]*seo-assets[^"]*)"', out)
    assert len(assets) == source.count('{{assets}}') > 0
    for url in assets:
        assert url.startswith('/apps/rocketride.home/v12/seo-assets/'), url
    # The only issue an unbound page may log is its data section.
    assert all('plans' in issue for issue in issues), issues


# ---------------------------------------------------------------------------
# The render cache
# ---------------------------------------------------------------------------


def test_cache_hits_skip_rendering_and_are_keyed_by_ua_class(shell_root, reads):
    _seed()
    _serve(_page())
    client = _client()
    first = _crawl(client).text
    assert _crawl(client).text == first and len(reads) == 1
    assert client.get('/pricing', headers={'User-Agent': BROWSER}).text != first
    assert len(pages._render_cache) == 2


def test_an_aggregate_swap_clears_the_cache(shell_root):
    _seed()
    _serve(_page())
    _crawl(_client())
    _serve(_page(title='Renamed'))
    assert len(pages._render_cache) == 0
    assert '<title>Renamed</title>' in _crawl(_client()).text


def test_a_render_overtaken_by_a_swap_is_served_but_not_cached(shell_root, monkeypatch):
    _seed()
    _serve(_page())

    async def swapping_read(path):
        _serve(_page(title='Renamed'))
        return await read_file(path)

    monkeypatch.setattr(pp, 'read_artifact_file', swapping_read)
    client = _client()
    assert '<title>Pricing | RocketRide</title>' in _crawl(client).text
    assert len(pages._render_cache) == 0
    monkeypatch.setattr(pp, 'read_artifact_file', read_file)
    assert '<title>Renamed</title>' in _crawl(client).text


def _bulk(count, size):
    """``count`` pages, each with its own snapshot of about ``size`` bytes."""
    served = []
    for i in range(count):
        name = f'pages/p{i}.html'
        # Multi-byte text (2-byte é, 4-byte emoji) so byte and character counts differ.
        _seed(f'<html><head></head><body><p>page {i}</p>{"x" * size}é😀</body></html>', name=name)
        served.append(_page(f'/p{i}', snapshot=name))
    _serve(*served)
    return served


def test_oversize_body_is_served_but_not_cached(shell_root):
    # Snapshots are capped well under the render budget; a shell document is not.
    size = pages._RENDER_CACHE_MAX_BYTES + 1
    (shell_root / 'index.html').write_text(f'<html><head></head><body>{"x" * size}</body></html>')
    _serve(_page())
    resp = _client().get('/pricing', headers={'User-Agent': BROWSER})
    assert resp.status_code == 200 and len(resp.content) > size
    assert len(pages._render_cache) == 0 and pages._render_cache.total == 0


def test_snapshot_cache_evicts_fifo_under_budget(shell_root):
    _bulk(10, MAX_SNAPSHOT_BYTES - 1024)
    client = _client()
    for i in range(9):
        _crawl(client, f'/p{i}')
    # Eight snapshots near the cap fill 16 MiB; the ninth evicts the first one read.
    assert list(pages._snapshot_cache.keys()) == [f'{DIST}/pages/p{i}.html' for i in range(1, 9)]
    assert pages._snapshot_cache.total <= pages._SNAPSHOT_CACHE_MAX_BYTES == 16 * MIB
    _crawl(client, '/p9')
    assert list(pages._snapshot_cache.keys()) == [f'{DIST}/pages/p{i}.html' for i in range(2, 10)]


def test_a_crawler_sweep_keeps_both_caches_under_their_byte_budgets(shell_root):
    count = 700
    _bulk(count, 50 * 1024)
    client = _client()
    for i in range(count):
        resp = _crawl(client, f'/p{i}')
        assert resp.status_code == 200 and f'<p>page {i}</p>' in resp.text
    assert pages._snapshot_cache.total <= pages._SNAPSHOT_CACHE_MAX_BYTES
    assert pages._render_cache.total <= pages._RENDER_CACHE_MAX_BYTES
    # Both budgets were reached (the sweep is larger than either), and each
    # cache kept its newest entries.
    assert len(pages._snapshot_cache) < len(pages._render_cache) < count
    assert f'{DIST}/pages/p{count - 1}.html' in pages._snapshot_cache
    assert f'{DIST}/pages/p0.html' not in pages._snapshot_cache
    # What each cache counts is what it holds: encoded bytes.
    snapshots = [pages._snapshot_cache.get(key) for key in pages._snapshot_cache.keys()]
    bodies = [pages._render_cache.get(key)[0] for key in pages._render_cache.keys()]
    for held, cache in ((snapshots, pages._snapshot_cache), (bodies, pages._render_cache)):
        assert all(isinstance(value, bytes) for value in held)
        assert sum(map(len, held)) == cache.total


# ---------------------------------------------------------------------------
# The real engine: snapshot assets reach anonymous crawlers
# ---------------------------------------------------------------------------

ASSET = b'<svg xmlns="http://www.w3.org/2000/svg"/>'


@pytest.fixture
def engine(monkeypatch, shell_root):
    """``initModule`` + ``register_public_pages`` behind the server's auth, built from a public home-ui at v3."""
    server_mod = pytest.importorskip('ai.web.server', reason='requires engine-native module stubs')
    from ai.account.store import Store
    from ai.modules.shell import initModule, register_public_pages

    home = copy.deepcopy(HOME_MANIFEST)
    home['publicPages'][1]['snapshot'] = 'pages/pricing.html'
    install(monkeypatch, hostile_account(home=home, home_version=3))
    _seed()
    FILES[f'{DIST}/seo-assets/logo.svg'] = ASSET
    FILES[f'{dist_of(PLATFORM, "rocketride.preview")}/seo-assets/logo.svg'] = ASSET
    store = SimpleNamespace(_store=SimpleNamespace(read_bytes=read_file))
    monkeypatch.setattr(Store, 'instance', classmethod(lambda cls: store))
    monkeypatch.setattr(shell_mod, '_version_dir_cache', {})
    monkeypatch.setattr(shell_mod, '_app_auth_cache', {})
    server = server_mod.WebServer(config={'port': 0, 'host': '127.0.0.1'})
    initModule(server, {})
    asyncio.run(register_public_pages(server))
    assert pp.current().exact['/pricing'].version == 3
    return TestClient(server.app, follow_redirects=False)


def test_snapshot_assets_are_served_to_anonymous_crawlers(engine):
    page = engine.get('/pricing', headers={'User-Agent': GOOGLEBOT})
    assert page.status_code == 200 and 'Pricing plans' in page.text
    urls = re.findall(r'(?:src|href)="(/apps/[^"]*)"', page.text)
    assert urls == ['/apps/rocketride.home/v3/seo-assets/logo.svg']
    for url in urls:
        resp = engine.get(url, headers={'User-Agent': GOOGLEBOT})
        assert resp.status_code == 200 and resp.content == ASSET, url
        assert resp.headers['content-type'] == 'image/svg+xml'
    # Only the version the public rung serves, of an app it serves.
    assert engine.get('/apps/rocketride.home/v2/seo-assets/logo.svg').status_code == 404
    assert engine.get('/apps/rocketride.preview/v1/seo-assets/logo.svg').status_code == 404
