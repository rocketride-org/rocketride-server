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
Compatibility with the saas half (home-ui build): the server-readable
manifest ships as ``dist/app-manifest.json`` ({publicPages, site}) next to
``pages/*.html``; apps.json's field whitelist keeps the sections out of
``metadata.manifest``. The loader and the gate prefer the emitted file and
fall back to metadata.manifest.

A home-ui manifest written for a later engine (more page and site fields)
must still validate here: unknown keys are ignored, never rejected.
"""

from __future__ import annotations

import json

import pytest

import ai.modules.shell.public_pages as pp
from ai.modules.shell.contract import check_manifest
from ai.modules.shell.legacy_manifest import legacy_page_manifest
from ai.modules.shell.public_pages import load_published

from .hostile_fixtures import FILES, HostileAccount, dist_of

PLATFORM = '00000000-platform'


def _emitted():
    """The saas emitter's output for home-ui: the legacy 25 paths, named data entries, the pricing snapshot."""
    pages = []
    for page in legacy_page_manifest()['publicPages']:
        page = dict(page)
        if page['path'] == '/pricing':
            page.update(data=['plans:rocketride.pipeBuilder'], snapshot='pages/pricing.html')
        if page['path'] == '/':
            page.update(data=['app:rocketride.pipeBuilder'])
        pages.append(page)
    return {'publicPages': pages, 'site': dict(legacy_page_manifest()['site'])}


def _newer():
    """``_emitted()`` from a later contract: blog-ready page fields, redirects, image, feeds, organization, notFound."""
    manifest = _emitted()
    manifest['publicPages'].append(
        {
            'path': '/blog/launch',
            'title': 'Launch',
            'description': 'We launched.',
            'image': '/og/launch.png',
            'published': '2026-11-09',
            'modified': '2026-11-10T09:00:00Z',
            'authors': [{'name': 'Ansh', 'url': 'https://rocketride.ai/team/ansh'}],
        }
    )
    manifest['site'].update(
        redirects=[{'from': '/terms', 'to': '/legal/terms'}, {'from': '/terms/', 'to': '/legal/terms'}],
        image='https://rocketride.ai/og.png',
        feeds=[{'path': '/blog/feed.xml', 'prefix': '/blog/', 'title': 'RocketRide blog'}],
        organization={'name': 'RocketRide', 'url': 'https://rocketride.ai', 'sameAs': ['https://x.example/rr']},
        notFound='pages/404.html',
    )
    return manifest


def test_the_saas_emitted_manifest_validates_cleanly():
    pages, site, errors = check_manifest('rocketride.home', _emitted())
    assert errors == []
    assert len(pages) == 25 and site['title'] == 'RocketRide'
    # The legacy redirect map passes the same validator a manifest's does.
    assert site['redirects']['/terms'] == '/legal/terms' and len(site['redirects']) == 6
    by_path = {p.path: p for p in pages}
    assert by_path['/pricing'].data == ('plans:rocketride.pipeBuilder',)
    assert by_path['/'].data == ('app:rocketride.pipeBuilder',)


def test_a_newer_home_ui_manifest_still_validates():
    newer = _newer()
    pages, site, errors = check_manifest('rocketride.home', newer)
    assert errors == []
    assert len(pages) == 26
    assert site == {
        **{k: newer['site'][k] for k in ('title', 'blurb', 'docsUrl', 'image', 'organization')},
        'redirects': {'/terms': '/legal/terms', '/terms/': '/legal/terms'},
        'feeds': {'/blog/feed.xml': {'path': '/blog/feed.xml', 'prefix': '/blog/', 'title': 'RocketRide blog'}},
    }
    launch = {p.path: p for p in pages}['/blog/launch']
    assert (launch.image, launch.published, launch.modified) == ('/og/launch.png', '2026-11-09', '2026-11-10T09:00:00Z')
    assert launch.authors == (('Ansh', 'https://rocketride.ai/team/ansh'),)


async def test_loader_prefers_the_emitted_file_over_metadata():
    acct = HostileAccount()
    acct.add(PLATFORM, 'rocketride.home', {'name': 'Home', **_emitted()}, emit=True)
    [pub] = await load_published(acct)
    assert set(pub.manifest) == {'publicPages', 'site'} and len(pub.manifest['publicPages']) == 25
    assert 'publicPages' not in acct.artifacts[(PLATFORM, 'rocketride.home', 1)]['metadata']['manifest']


async def test_loader_falls_back_to_metadata_manifest_without_the_file():
    acct = HostileAccount()
    acct.add(PLATFORM, 'rocketride.home', {'name': 'Home', 'publicPages': [{'path': '/', 'title': 'H'}]})
    [pub] = await load_published(acct)
    assert pub.manifest['publicPages'] == [{'path': '/', 'title': 'H'}]


async def test_malformed_emitted_file_contributes_nothing():
    acct = HostileAccount()
    acct.add(PLATFORM, 'rocketride.home', {'name': 'Home', 'publicPages': [{'path': '/', 'title': 'H'}]})
    FILES[f'{dist_of(PLATFORM, "rocketride.home")}/app-manifest.json'] = b'not json'
    assert await load_published(acct) == []


async def test_store_errors_other_than_not_found_skip_the_app_or_fail_the_gate(monkeypatch):
    acct = HostileAccount()
    acct.add(PLATFORM, 'rocketride.home', {'name': 'Home', **_emitted()}, emit=True)

    async def broken(path):
        raise OSError('store down')

    monkeypatch.setattr(pp, 'read_artifact_file', broken)
    assert await load_published(acct) == []  # aggregate: skipped, never a partial manifest
    with pytest.raises(RuntimeError, match='rocketride.home: store down'):
        await load_published(acct, strict=True)  # the gate: fail closed, naming the app


async def test_a_newer_home_ui_manifest_still_publishes():
    # The emitted file of a later home-ui build, gated on this engine: the
    # fields it does not know cost nothing, and the snapshot it names exists.
    from ai.modules.shell.public_pages import gate_errors

    dist = dist_of(PLATFORM, 'rocketride.home')
    FILES[f'{dist}/app-manifest.json'] = json.dumps(_newer()).encode()
    FILES[f'{dist}/pages/pricing.html'] = b'<html></html>'
    assert await gate_errors('rocketride.home', {'name': 'Home'}, dist, HostileAccount()) == []
