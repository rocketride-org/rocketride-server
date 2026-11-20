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
``site.organization``: the root owner's Organization (and WebSite) JSON-LD for crawlers.

Crawlers get the Organization node, ``@id`` ``<organization.url>#organization``,
on ``/`` and on every page whose JSON-LD references that ``@id`` (a dated
page's BlogPosting names it as publisher, and as author when it has none), so
the reference resolves on the page itself. ``/`` also carries a WebSite node
for the ``RR_APP_URL`` origin published by it. People get neither.
"""

from __future__ import annotations

import asyncio
import copy
import json
import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai.modules.shell.public_pages as pp
import ai.modules.shell.shell as shell_mod
from ai.modules.shell.pages import FALLBACK_PATH, public_page
from ai.modules.shell.public_pages import Published, build_aggregate, check_manifest

from .hostile_fixtures import hostile_account, install

GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'
APP_URL = 'https://cloud.acme.example'
ORG = {
    'name': 'Acme',
    'url': 'https://acme.example/',
    'logo': 'https://acme.example/logo.png',
    'description': 'We make things.',
    'sameAs': ['https://github.com/acme', 'https://www.linkedin.com/company/acme'],
}
ORG_ID = 'https://acme.example/#organization'
HOME = {
    'id': 'rocketride.home',
    'name': 'Acme Cloud',
    'publicPages': [
        {'path': '/', 'title': 'Acme Cloud'},
        {'path': '/pricing', 'title': 'Pricing | Acme Cloud'},
        {'path': '/blog/launch', 'title': 'Launch | Acme Cloud', 'published': '2026-11-09'},
        {
            'path': '/blog/team',
            'title': 'Team | Acme Cloud',
            'published': '2026-11-10',
            'authors': [{'name': 'Ansh'}],
        },
    ],
    'site': {'title': 'Acme Cloud', 'organization': ORG},
}

_LD = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)


@pytest.fixture(autouse=True)
def _shell_root(monkeypatch, tmp_path):
    (tmp_path / 'index.html').write_text('<html><head><title>shell</title></head><body>SPA</body></html>')
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path))


def _serve(monkeypatch, organization=ORG):
    """Publish ``HOME`` with ``organization`` (absent when None) through the real loader."""
    home = copy.deepcopy(HOME)
    if organization is None:
        del home['site']['organization']
    else:
        home['site']['organization'] = organization
    install(monkeypatch, hostile_account(home=home))
    assert asyncio.run(pp.rebuild())
    app = FastAPI()
    app.get('/')(public_page)
    app.get(FALLBACK_PATH)(public_page)
    return TestClient(app)


def _blocks(text):
    return [json.loads(b) for b in _LD.findall(text)]


def _by_type(text):
    return {b['@type']: b for b in _blocks(text)}


def test_root_carries_organization_and_website(monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    text = _serve(monkeypatch).get('/', headers={'User-Agent': GOOGLEBOT}).text
    assert _blocks(text) == [
        {'@context': 'https://schema.org', '@type': 'Organization', '@id': ORG_ID, **ORG},
        {
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            '@id': f'{APP_URL}/#website',
            'url': f'{APP_URL}/',
            'name': 'Acme Cloud',
            'publisher': {'@id': ORG_ID},
        },
    ]


def test_a_dated_page_carries_the_organization_its_blogposting_references(monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    client = _serve(monkeypatch)
    # Without authors the organization is publisher and author; with authors, publisher only.
    for path in ('/blog/launch', '/blog/team'):
        nodes = _by_type(client.get(path, headers={'User-Agent': GOOGLEBOT}).text)
        assert set(nodes) == {'BlogPosting', 'Organization'}, path
        assert nodes['BlogPosting']['publisher'] == {'@id': nodes['Organization']['@id']} == {'@id': ORG_ID}
        assert nodes['Organization'] == {
            '@context': 'https://schema.org',
            '@type': 'Organization',
            '@id': ORG_ID,
            **ORG,
        }
    launch = _by_type(client.get('/blog/launch', headers={'User-Agent': GOOGLEBOT}).text)
    assert launch['BlogPosting']['author'] == {'@id': ORG_ID}


def test_other_pages_and_people_get_no_organization(monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    client = _serve(monkeypatch)
    assert _blocks(client.get('/pricing', headers={'User-Agent': GOOGLEBOT}).text) == []
    for path in ('/', '/pricing', '/blog/launch'):
        assert _blocks(client.get(path, headers={'User-Agent': BROWSER}).text) == [], path


def test_no_website_node_without_rr_app_url(monkeypatch):
    monkeypatch.delenv('RR_APP_URL', raising=False)
    client = _serve(monkeypatch)
    assert [b['@type'] for b in _blocks(client.get('/', headers={'User-Agent': GOOGLEBOT}).text)] == ['Organization']


def test_without_an_organization_nothing_is_added(monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    client = _serve(monkeypatch, organization=None)
    assert _blocks(client.get('/', headers={'User-Agent': GOOGLEBOT}).text) == []
    # The BlogPosting's publisher is inline instead, with no node to reference.
    [post] = _blocks(client.get('/blog/launch', headers={'User-Agent': GOOGLEBOT}).text)
    assert post['publisher'] == {'@type': 'Organization', 'name': 'Acme Cloud', 'url': f'{APP_URL}/'}


def test_only_the_root_owner_supplies_it():
    root = Published('rocketride.home', HOME, published_at=1)
    other = Published(
        'rocketride.other',
        {'publicPages': [{'path': '/other', 'title': 'O'}], 'site': {'organization': {**ORG, 'name': 'Evil'}}},
        published_at=0,
    )
    assert build_aggregate([other, root]).site['organization']['name'] == 'Acme'


def test_unknown_organization_keys_are_ignored():
    _, site, errors = check_manifest('rocketride.home', {**HOME, 'site': {'organization': {**ORG, 'founder': 'X'}}})
    assert errors == [] and site['organization'] == ORG


@pytest.mark.parametrize(
    'organization,field',
    [
        ('Acme', 'site.organization'),
        ({'url': 'https://a.example'}, 'site.organization.name'),
        ({'name': ' ', 'url': 'https://a.example'}, 'site.organization.name'),
        ({'name': 'x' * 301, 'url': 'https://a.example'}, 'site.organization.name'),
        ({'name': 'A\ud83d', 'url': 'https://a.example'}, 'site.organization.name'),
        ({'name': 'A'}, 'site.organization.url'),
        ({'name': 'A', 'url': 'http://a.example'}, 'site.organization.url'),
        ({'name': 'A', 'url': '/about'}, 'site.organization.url'),
        # The url anchors the @id <url>#organization: a fragment or query would break that IRI.
        ({'name': 'A', 'url': 'https://a.example/#about'}, 'site.organization.url'),
        ({'name': 'A', 'url': 'https://a.example/?ref=x'}, 'site.organization.url'),
        ({'name': 'A', 'url': 'https://a.example', 'logo': 'javascript:x'}, 'site.organization.logo'),
        ({'name': 'A', 'url': 'https://a.example', 'logo': '/logo.png'}, 'site.organization.logo'),
        ({'name': 'A', 'url': 'https://a.example', 'sameAs': 'https://x.example'}, 'site.organization.sameAs'),
        ({'name': 'A', 'url': 'https://a.example', 'sameAs': ['ftp://x']}, 'site.organization.sameAs'),
        (
            {'name': 'A', 'url': 'https://a.example', 'sameAs': [f'https://x.example/{i}' for i in range(21)]},
            'site.organization.sameAs',
        ),
        ({'name': 'A', 'url': 'https://a.example', 'description': 7}, 'site.organization.description'),
        ({'name': 'A', 'url': 'https://a.example', 'description': 'x' * 1001}, 'site.organization.description'),
        ({'name': 'A', 'url': 'https://a.example', 'description': 'A\udc00'}, 'site.organization.description'),
    ],
)
def test_invalid_organization_fails_with_the_field_named(organization, field):
    _, site, errors = check_manifest('rocketride.home', {**HOME, 'site': {'title': 'T', 'organization': organization}})
    assert site is None and len(errors) == 1 and errors[0].startswith(f'{field}:'), errors


def test_the_largest_valid_organization_is_kept():
    organization = {
        'name': 'x' * 300,
        'url': 'https://a.example',
        'description': 'y' * 1000,
        'sameAs': [f'https://x.example/{i}' for i in range(20)],
    }
    _, site, errors = check_manifest('rocketride.home', {**HOME, 'site': {'organization': organization}})
    assert errors == [] and site['organization'] == organization


def test_hostile_organization_values_are_inert(monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    hostile = '</script><script>alert(1)</script><!--&]]>'
    client = _serve(monkeypatch, organization={**ORG, 'name': hostile, 'description': hostile})
    for path in ('/', '/blog/launch'):
        text = client.get(path, headers={'User-Agent': GOOGLEBOT}).text
        assert '<script>alert' not in text and '<!--' not in text
        assert not set('<>&') & set(''.join(_LD.findall(text)))
        assert _by_type(text)['Organization']['name'] == hostile
