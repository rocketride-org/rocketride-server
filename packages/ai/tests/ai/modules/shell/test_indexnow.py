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
IndexNow: each real build submits the listed pages whose content changed.

IndexNow is on only with a valid ``RR_INDEXNOW_KEY`` and an ``https://``
``RR_APP_URL``; otherwise it serves no key file and submits nothing. A page's
content is its manifest entry plus the sha256 of its snapshot, so a new
production version alone submits nothing. Pages listed in the last real build
and now gone or unlisted are submitted too. The first real build is a
baseline, the legacy list is ignored, and an app missing from one build keeps
its pages. Submissions run in one background task, bounded by timeouts; any
failure is a warning. The HTTP client is always a fake: no test reaches the
network.
"""

from __future__ import annotations

import asyncio
import copy
from dataclasses import replace
from itertools import islice
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import ai.modules.shell.indexnow as indexnow
import ai.modules.shell.public_pages as pp
from ai.modules.shell.public_pages import Aggregate, Page, legacy_aggregate

from .hostile_fixtures import FILES, HOME_MANIFEST, dist_of, hostile_account, install, read_file

BASE = 'https://cloud.example'
KEY = 'indexnow-test-key'
PLATFORM = '00000000-platform'
EMPTY = Aggregate(exact={})


class FakeClient:
    """An ``httpx.AsyncClient`` stand-in that records each POST and answers ``status``."""

    def __init__(self, sent, *, status=202, error=None, delay=0.0):
        self.sent, self.status, self.error, self.delay = sent, status, error, delay

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None):
        await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        self.sent.append((url, json))
        return type('Response', (), {'status_code': self.status})()


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    """No baseline, no queued build and no worker carried over from another test."""
    monkeypatch.setattr(indexnow, '_last', None)
    monkeypatch.setattr(indexnow, '_pending', None)
    monkeypatch.setattr(indexnow, '_worker', None)
    monkeypatch.setattr(indexnow, '_failed', set())


@pytest.fixture
def sent(monkeypatch):
    """Enable IndexNow on an https origin; returns the list of (url, payload) the fake client receives."""
    monkeypatch.setenv('RR_INDEXNOW_KEY', KEY)
    monkeypatch.setenv('RR_APP_URL', BASE + '/')
    out = []
    monkeypatch.setattr(indexnow, '_client', lambda: FakeClient(out))
    return out


@pytest.fixture
def warnings(monkeypatch):
    out = []
    monkeypatch.setattr(indexnow, 'warning', out.append)
    return out


@pytest.fixture
def reads(monkeypatch):
    """Every store path IndexNow reads, in order."""
    log = []

    async def counting(path):
        log.append(path)
        return await read_file(path)

    monkeypatch.setattr(pp, 'read_artifact_file', counting)
    return log


def _page(path, version=1, app_id='rocketride.home', **fields):
    """A page as the loader builds it: on ``app_id``'s production ``version``."""
    fields.setdefault('title', path)
    dist = dist_of(PLATFORM, app_id, version)
    return Page(path, app_id, dist_dir=dist, version=version, published_at=float(version), **fields)


def _snapshot(app_id, version, name, text):
    FILES[f'{dist_of(PLATFORM, app_id, version)}/{name}'] = text.encode()


def _version(version, pricing='<h1>Pricing</h1>', *extra, app_id='rocketride.home'):
    """``app_id`` at ``version``: ``/`` and ``/pricing`` (with a snapshot), plus ``extra`` pages."""
    _snapshot(app_id, version, 'pages/pricing.html', pricing)
    return [
        _page('/', version, app_id),
        _page('/pricing', version, app_id, snapshot='pages/pricing.html'),
        *(_page(p, version, app_id) for p in extra),
    ]


async def _build(*pages, legacy=False):
    """Swap in an aggregate of ``pages`` and wait for IndexNow to finish with it."""
    indexnow.on_swap(EMPTY, legacy_aggregate() if legacy else Aggregate(exact={p.path: p for p in pages}))
    if indexnow._worker is not None:
        await indexnow._worker


def _urls(sent):
    return [payload['urlList'] for _, payload in sent]


async def test_the_first_real_build_is_a_baseline_and_the_payload_names_the_key(sent):
    await _build(*_version(1))
    assert sent == []
    await _build(*_version(2), _page('/blog', 2))
    assert sent == [
        (
            'https://api.indexnow.org/indexnow',
            {
                'host': 'cloud.example',
                'key': KEY,
                'keyLocation': f'{BASE}/{KEY}.txt',
                'urlList': [f'{BASE}/blog'],
            },
        )
    ]


async def test_publishing_one_new_page_submits_only_that_url(sent):
    await _build(*_version(1, '<h1>Pricing</h1>', '/about'))
    await _build(*_version(2, '<h1>Pricing</h1>', '/about', '/blog/launch'))
    assert _urls(sent) == [[f'{BASE}/blog/launch']]


async def test_an_unchanged_republish_submits_nothing(sent):
    await _build(*_version(1))
    await _build(*_version(2))
    await _build(*_version(3))
    assert sent == []


async def test_a_changed_snapshot_submits_that_page(sent):
    await _build(*_version(1))
    await _build(*_version(2, '<h1>Pricing, now cheaper</h1>'))
    assert _urls(sent) == [[f'{BASE}/pricing']]


async def test_a_changed_manifest_field_submits_that_page(sent):
    await _build(*_version(1))
    home, pricing = _version(2)
    await _build(home, replace(pricing, description='New plans.'))
    assert _urls(sent) == [[f'{BASE}/pricing']]


async def test_pages_gone_or_unlisted_since_the_last_build_are_submitted(sent):
    await _build(*_version(1, '<h1>Pricing</h1>', '/a', '/b', '/c'))
    await _build(*_version(2), _page('/a', 2, listed=False), _page('/c', 2))
    assert _urls(sent) == [[f'{BASE}/a', f'{BASE}/b']]
    # Unlisted pages are never submitted as new or changed.
    await _build(*_version(3), _page('/a', 3, listed=False, description='changed'), _page('/c', 3))
    assert len(sent) == 1


async def test_a_build_on_the_legacy_list_is_ignored_and_the_next_real_one_diffs_the_last(sent):
    await _build(*_version(1))
    await _build(legacy=True)  # the store failed for the root app: no page survived
    await _build(*_version(1))  # recovered, unchanged
    assert sent == []
    await _build(legacy=True)
    await _build(*_version(2, '<h1>New prices</h1>'))
    assert _urls(sent) == [[f'{BASE}/pricing']]


async def test_an_app_missing_from_one_build_keeps_its_pages(sent):
    # A second root app skipped by a transient store error: its pages are not
    # reported gone, and its recovery is not reported new.
    other = [_page('/docs', 1, 'rocketride.docs'), _page('/docs/start', 1, 'rocketride.docs')]
    await _build(*_version(1), *other)
    await _build(*_version(1))
    await _build(*_version(1), *other)
    assert sent == []
    await _build(*_version(1), other[0])  # the app is back without one page: that page is gone
    assert _urls(sent) == [[f'{BASE}/docs/start']]


async def test_a_snapshot_read_failure_counts_as_changed(sent, warnings):
    await _build(*_version(1))
    home, pricing = _version(2)
    del FILES[f'{pricing.dist_dir}/pages/pricing.html']
    await _build(home, pricing)
    assert _urls(sent) == [[f'{BASE}/pricing']]
    assert len(warnings) == 1 and "'pages/pricing.html'" in warnings[0] and '/pricing' in warnings[0]
    # Still unreadable in the next build: still counted as changed.
    home, pricing = _version(3)
    del FILES[f'{pricing.dist_dir}/pages/pricing.html']
    await _build(home, pricing)
    assert _urls(sent) == [[f'{BASE}/pricing']] * 2


async def test_a_snapshot_page_without_a_production_version_is_not_resubmitted(sent, warnings, reads):
    await _build(*_version(1))
    # Declares a snapshot, but there is no production build to read it from.
    unversioned = Page('/draft', 'rocketride.home', 'Draft', snapshot='pages/draft.html')
    await _build(*_version(1), unversioned)
    await _build(*_version(1), unversioned)
    assert _urls(sent) == [[f'{BASE}/draft']]
    assert indexnow._last['/draft'].digest == '' and warnings == [] and len(reads) == 1


async def test_a_snapshot_is_read_once_per_version(sent, reads):
    pages = _version(1)
    await _build(*pages)
    assert len(reads) == 1
    await _build(*pages, _page('/blog', 1))  # same version: nothing re-read
    assert len(reads) == 1 and _urls(sent) == [[f'{BASE}/blog']]
    await _build(*_version(2), _page('/blog', 2))
    assert len(reads) == 2 and len(sent) == 1


async def test_a_snapshot_over_the_size_cap_is_statted_never_read(sent, warnings, reads, monkeypatch):
    monkeypatch.setattr(indexnow, 'MAX_SNAPSHOT_BYTES', len('<h1>Pricing</h1>'))
    await _build(*_version(1))  # at the cap: read
    assert len(reads) == 1
    await _build(*_version(2, '<h1>Pricing, now longer</h1>'))  # over it: crawlers get the shell
    await _build(*_version(2, '<h1>Pricing, now longer</h1>'))  # same version: not even statted again
    assert len(reads) == 1 and warnings == []
    assert indexnow._last['/pricing'].digest == ''
    assert _urls(sent) == [[f'{BASE}/pricing']]


@pytest.fixture
def hang(monkeypatch):
    """Once ``hang.arm()`` is called, the next snapshot read hangs past ``READ_SECONDS``; ``hang.started`` is then set."""
    state = SimpleNamespace(armed=False, started=asyncio.Event())
    state.arm = lambda: setattr(state, 'armed', True)

    async def read(path):
        if state.armed:
            state.armed = False
            state.started.set()
            await asyncio.Event().wait()
        return await read_file(path)

    monkeypatch.setattr(pp, 'read_artifact_file', read)
    monkeypatch.setattr(indexnow, 'READ_SECONDS', 0.05)
    monkeypatch.setattr(indexnow, 'RETRY_SECONDS', 0.01)
    return state


async def test_a_read_timeout_is_retried_without_a_new_swap(sent, warnings, hang):
    await _build(*_version(1))
    hang.arm()
    await _build(*_version(2, '<h1>Changed</h1>'), _page('/blog', 2))  # no swap after this one
    assert _urls(sent) == [[f'{BASE}/blog', f'{BASE}/pricing']]
    assert len(warnings) == 1 and 'timed out' in warnings[0]


async def test_a_baseline_timeout_keeps_the_next_builds_changes(sent, hang):
    hang.arm()
    indexnow.on_swap(EMPTY, Aggregate(exact={p.path: p for p in _version(1)}))
    await hang.started.wait()  # the baseline's read is in flight
    indexnow.on_swap(EMPTY, Aggregate(exact={p.path: p for p in [*_version(2), _page('/blog', 2)]}))
    await indexnow._worker
    # The baseline was retried first, so the next build's new page is still a change.
    assert _urls(sent) == [[f'{BASE}/blog']]


async def test_a_later_build_supersedes_a_timed_out_one(sent, hang):
    await _build(*_version(1))
    hang.arm()
    indexnow.on_swap(EMPTY, Aggregate(exact={p.path: p for p in _version(2, '<h1>Changed</h1>')}))
    await hang.started.wait()
    indexnow.on_swap(EMPTY, Aggregate(exact={p.path: p for p in [*_version(3, '<h1>Changed</h1>'), _page('/b', 3)]}))
    await indexnow._worker
    # One submission, of everything changed since the last build that was read.
    assert _urls(sent) == [[f'{BASE}/b', f'{BASE}/pricing']]


def test_retries_back_off_doubling_up_to_a_cap():
    waits = list(islice(indexnow._backoff(), 8))
    assert waits == [30.0, 60.0, 120.0, 240.0, 480.0, 600.0, 600.0, 600.0]
    assert (indexnow.RETRY_SECONDS, indexnow.MAX_RETRY_SECONDS) == (30.0, 600.0)


async def test_snapshot_reads_run_at_most_max_concurrent_reads_at_a_time(sent, monkeypatch):
    in_flight, peak = [0], [0]

    async def read(path):
        in_flight[0] += 1
        peak[0] = max(peak[0], in_flight[0])
        await asyncio.sleep(0.005)
        in_flight[0] -= 1
        return await read_file(path)

    monkeypatch.setattr(pp, 'read_artifact_file', read)
    pages = []
    for i in range(20):
        _snapshot('rocketride.home', 1, f'pages/p{i}.html', f'<h1>{i}</h1>')
        pages.append(_page(f'/p{i}', 1, snapshot=f'pages/p{i}.html'))
    await _build(*pages)
    assert indexnow.MAX_CONCURRENT_READS == 8 and peak[0] == 8 and len(indexnow._last) == 20


async def test_more_urls_than_the_protocols_cap_go_in_several_submissions(sent, monkeypatch):
    assert indexnow._MAX_URLS == 10000
    monkeypatch.setattr(indexnow, '_MAX_URLS', 2)
    await _build(*_version(1))
    await _build(*_version(2), *(_page(p, 2) for p in ('/v', '/w', '/x', '/y', '/z')))
    assert _urls(sent) == [[f'{BASE}/v', f'{BASE}/w'], [f'{BASE}/x', f'{BASE}/y'], [f'{BASE}/z']]


@pytest.mark.parametrize('value', ['', 'short', 'has space in it', 'x' * 129, 'bad/slash00', 'line\nbreak0'])
async def test_disabled_without_a_valid_key(sent, monkeypatch, value):
    monkeypatch.setenv('RR_INDEXNOW_KEY', value)
    assert indexnow.key() == '' and not indexnow.enabled()
    await _build(*_version(1))
    await _build(*_version(2), _page('/blog', 2))
    assert sent == [] and indexnow._worker is None


@pytest.mark.parametrize('app_url', [None, '', 'http://cloud.example', 'cloud.example'])
async def test_disabled_without_an_https_rr_app_url(sent, monkeypatch, app_url):
    if app_url is None:
        monkeypatch.delenv('RR_APP_URL', raising=False)
    else:
        monkeypatch.setenv('RR_APP_URL', app_url)
    assert not indexnow.enabled()
    await _build(*_version(1))
    await _build(*_version(2), _page('/blog', 2))
    assert sent == [] and indexnow._worker is None


@pytest.mark.parametrize(
    'client,expected',
    [
        (lambda: FakeClient([], error=OSError('connection refused')), 'connection refused'),
        (lambda: FakeClient([], status=403), 'HTTP 403'),
        (lambda: FakeClient([], status=429), 'HTTP 429'),
        (lambda: FakeClient([], delay=10.0), 'timed out'),
    ],
)
async def test_failures_and_refusals_are_warnings_never_raised(sent, warnings, monkeypatch, client, expected):
    await _build(*_version(1))
    monkeypatch.setattr(indexnow, '_client', client)
    monkeypatch.setattr(indexnow, 'TIMEOUT_SECONDS', 0.01)
    await _build(*_version(2), _page('/blog', 2))
    assert len(warnings) == 1 and expected in warnings[0] and '1 URL' in warnings[0]


@pytest.mark.parametrize('failure', [{'error': OSError('connection refused')}, {'status': 429}])
async def test_a_failed_or_refused_batch_goes_out_with_the_next_submission(sent, warnings, monkeypatch, failure):
    await _build(*_version(1))
    monkeypatch.setattr(indexnow, '_client', lambda: FakeClient([], **failure))
    await _build(*_version(2), _page('/blog', 2))
    assert sent == [] and indexnow._failed == {'/blog'}
    # Healthy again: the next swap submits the lost path with its own change.
    monkeypatch.setattr(indexnow, '_client', lambda: FakeClient(sent))
    await _build(*_version(3), _page('/blog', 2), _page('/news', 3))
    assert _urls(sent) == [[f'{BASE}/blog', f'{BASE}/news']]
    assert indexnow._failed == set()
    # A success clears them: nothing is submitted again.
    await _build(*_version(4), _page('/blog', 2), _page('/news', 3))
    assert len(sent) == 1


async def test_the_failed_paths_are_bounded(sent, warnings, monkeypatch):
    monkeypatch.setattr(indexnow, '_MAX_FAILED', 2)
    await _build(*_version(1))
    monkeypatch.setattr(indexnow, '_client', lambda: FakeClient([], status=500))
    await _build(*_version(2), *(_page(p, 2) for p in ('/a', '/b', '/c')))
    assert indexnow._failed == {'/a', '/b'}
    assert any('dropped' in w for w in warnings)


async def test_an_accepted_submission_is_no_warning(sent, warnings):
    await _build(*_version(1))
    await _build(*_version(2), _page('/blog', 2))
    assert len(sent) == 1 and warnings == []


async def test_the_swap_never_waits_and_builds_arriving_meanwhile_coalesce(sent, monkeypatch):
    await _build(*_version(1))
    gate = asyncio.Event()

    class Slow(FakeClient):
        async def post(self, url, json=None):
            await gate.wait()
            return await super().post(url, json)

    monkeypatch.setattr(indexnow, '_client', lambda: Slow(sent))
    indexnow.on_swap(EMPTY, Aggregate(exact={p.path: p for p in [*_version(2), _page('/a', 2)]}))
    await asyncio.sleep(0.01)  # the worker is now blocked in the POST
    assert sent == [] and not indexnow._worker.done()
    # Two more builds while it waits: only the last one is diffed, once.
    indexnow.on_swap(EMPTY, Aggregate(exact={p.path: p for p in [*_version(3), _page('/a', 3), _page('/b', 3)]}))
    indexnow.on_swap(EMPTY, Aggregate(exact={p.path: p for p in [*_version(4), _page('/a', 4), _page('/c', 4)]}))
    gate.set()
    await indexnow._worker
    assert _urls(sent) == [[f'{BASE}/a'], [f'{BASE}/c']]


def test_a_republish_through_the_real_rebuild_submits_only_its_changes(sent, monkeypatch):
    home = copy.deepcopy(HOME_MANIFEST)
    pricing = next(p for p in home['publicPages'] if p['path'] == '/pricing')
    pricing['snapshot'] = 'pages/pricing.html'

    async def publish(version, snapshot):
        _snapshot('rocketride.home', version, 'pages/pricing.html', snapshot)
        install(monkeypatch, hostile_account(home=home, home_version=version))
        assert await pp.rebuild()
        if indexnow._worker is not None:
            await indexnow._worker

    async def run():
        pp.on_swap(indexnow.on_swap)
        await publish(1, '<h1>Pricing</h1>')  # legacy -> first real build: the baseline
        await publish(2, '<h1>Pricing</h1>')  # unchanged republish
        assert sent == []
        home['publicPages'].append({'path': '/blog', 'title': 'Blog'})
        await publish(3, '<h1>Pricing</h1>')
        await publish(4, '<h1>New prices</h1>')

    asyncio.run(run())
    assert _urls(sent) == [[f'{BASE}/blog'], [f'{BASE}/pricing']]


def _engine(monkeypatch):
    server_mod = pytest.importorskip('ai.web.server', reason='requires engine-native module stubs')
    from ai.modules.shell import initModule, register_public_pages

    async def no_rebuild(acct=None):
        return True

    monkeypatch.setattr(pp.page_map, 'rebuild', no_rebuild)
    server = server_mod.WebServer(config={'port': 0, 'host': '127.0.0.1'})
    initModule(server, {})
    asyncio.run(register_public_pages(server))
    return TestClient(server.app)


def test_the_key_file_and_submissions_are_wired_when_enabled(monkeypatch):
    monkeypatch.setenv('RR_INDEXNOW_KEY', KEY)
    monkeypatch.setenv('RR_APP_URL', BASE)
    client = _engine(monkeypatch)
    resp = client.get(f'/{KEY}.txt')
    # Registered ahead of the catch-all, and served without credentials.
    assert resp.status_code == 200 and resp.text == KEY
    assert resp.headers['content-type'].startswith('text/plain')
    # HEAD answers like GET, as the crawler files do.
    head = client.head(f'/{KEY}.txt')
    assert head.status_code == 200 and head.content == b''
    for name in ('content-type', 'content-length'):
        assert head.headers.get(name) == resp.headers.get(name), name
    assert indexnow.on_swap in pp.page_map.listeners


@pytest.mark.parametrize('key,app_url', [(KEY, None), (KEY, 'http://cloud.example'), ('bad key', BASE)])
def test_no_key_file_and_no_submissions_unless_enabled(monkeypatch, key, app_url):
    monkeypatch.setenv('RR_INDEXNOW_KEY', key)
    if app_url is None:
        monkeypatch.delenv('RR_APP_URL', raising=False)
    else:
        monkeypatch.setenv('RR_APP_URL', app_url)
    client = _engine(monkeypatch)
    assert client.get(f'/{key}.txt').status_code == 404
    assert client.head(f'/{key}.txt').status_code == 404
    assert indexnow.on_swap not in pp.page_map.listeners
