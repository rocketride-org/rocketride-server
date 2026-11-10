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
Page data sources, bound into crawler snapshots and JSON-LD.

A page's ``data`` entries bind ``plans`` (the declaring app's plans, or a named
app's) and ``app`` (one named app) under their source names. A named app is
checked when it is bound and contributes nothing unless anonymous store callers
may see it. Store text stays text; the one URL a source exposes is the page's
canonical URL, and only when it is ``https://``. A crawler response bound to a
source is dropped from the render cache when that source is invalidated, and
expires after the sources' TTL.
"""

from __future__ import annotations

import json
import math
import re
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai.modules.shell.data_sources as ds
import ai.modules.shell.pages as pages
import ai.modules.shell.public_pages as pp
import ai.modules.shell.shell as shell_mod
from ai.modules.shell.pages import FALLBACK_PATH, public_page
from ai.modules.shell.public_pages import Aggregate, Page

from .hostile_fixtures import (
    FILES,
    HOSTILE_NAME,
    assert_no_leak,
    dist_of,
    hostile_account,
    install,
)

GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'
APP_URL = 'https://cloud.example'
PLATFORM = '00000000-platform'
DIST = dist_of(PLATFORM, 'rocketride.home', 3)
HOME_UI = Path(__file__).parent / 'fixtures' / 'home-ui'

SNAPSHOT = (
    '<!doctype html><html><head><title>snap</title></head><body><h1>Pricing</h1>'
    '{{#app}}<h2>{{name}}</h2>{{/app}}'
    '<ul>{{#plans}}<li>{{name}}: {{price}} {{currency}}</li>{{/plans}}</ul></body></html>'
)

PLANS = [
    {
        'id': 'price_builder',
        'name': 'Builder',
        'price': '29',
        'currency': 'usd',
        'period': 'month',
        'features': ['Unlimited pipelines', 'Email support'],
    },
    {'id': 'price_pro', 'name': 'Pro', 'price': '99.50', 'currency': 'USD', 'period': 'month', 'features': []},
]

# Apps anonymous store callers never see, each for its own reason (see hostile_fixtures).
HIDDEN = (
    'rocketride.secret',
    'rocketride.review',
    'rocketride.building',
    'rocketride.gated',
    'rocketride.preview',
    'acme.private',
    'acme.orgonly',
    'acme.unpublished',
    'acme.unlisted',
    'acme.dbhidden',
    'acme.inreview',
    'acme.permgated',
    'nope',
)


@pytest.fixture
def acct(monkeypatch):
    monkeypatch.setenv('RR_APP_URL', APP_URL)
    return install(monkeypatch, hostile_account())


@pytest.fixture
def shell_root(tmp_path, monkeypatch):
    (tmp_path / 'index.html').write_text('<html><head><title>shell</title></head><body>SPA</body></html>')
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path))
    return tmp_path


@pytest.fixture
def warned(monkeypatch):
    lines = []
    monkeypatch.setattr(pages, 'warning', lines.append)
    return lines


def _client():
    app = FastAPI()
    app.add_api_route('/', public_page, methods=['GET', 'HEAD'])
    app.add_api_route(FALLBACK_PATH, public_page, methods=['GET', 'HEAD'])
    return TestClient(app)


def _crawl(client, path='/pricing'):
    return client.get(path, headers={'User-Agent': GOOGLEBOT})


def _jsonld(html):
    return [json.loads(m) for m in re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.S)]


def _page(path, data, snapshot='pages/pricing.html'):
    return Page(
        path=path,
        app_id='rocketride.home',
        title='Pricing',
        snapshot=snapshot,
        data=tuple(data),
        dist_dir=DIST,
        version=3,
    )


def _serve(*served):
    pp.swap(Aggregate(exact={p.path: p for p in served}))


def _seed(text=SNAPSHOT, name='pages/pricing.html'):
    FILES[f'{DIST}/{name}'] = text.encode()


# ---------------------------------------------------------------------------
# Binding
# ---------------------------------------------------------------------------


async def test_named_plans_bind_named_app(acct):
    acct.plans['rocketride.home'] = [{'name': 'Home', 'price': '1'}]
    acct.plans['acme.brandy'] = PLANS
    named = await ds.bind(_page('/pricing', ['plans:acme.brandy']), f'{APP_URL}/pricing')
    assert list(named) == ['plans'] and [p['name'] for p in named['plans']] == ['Builder', 'Pro']
    own = await ds.bind(_page('/pricing', ['plans']), f'{APP_URL}/pricing')
    assert [p['name'] for p in own['plans']] == ['Home']
    # Each entry binds its source name, whatever its argument.
    both = await ds.bind(_page('/', ['app:acme.brandy', 'plans:acme.brandy']), f'{APP_URL}/')
    assert set(both) == {'app', 'plans'} and both['app']['name'] == 'Brandy'


async def test_private_named_app_yields_nothing(acct):
    # A binding that says public: false hides the app without its manifest being read.
    del acct.artifacts[('org-acme', 'acme.unlisted', 1)]
    for app_id in HIDDEN:
        acct.plans[app_id] = [{'name': f'{app_id} plan', 'price': '5', 'currency': 'usd'}]
        context = await ds.bind(_page('/pricing', [f'plans:{app_id}', f'app:{app_id}']), f'{APP_URL}/pricing')
        assert context == {'plans': [], 'app': None}, app_id
        assert ds.jsonld(context, f'{APP_URL}/pricing') == [], app_id


async def test_only_public_bindings_make_a_named_app_visible(acct, monkeypatch):
    from ai.account import account as singleton

    async def every_row(org_id, kind, audiences):
        return [dict(r) for r in acct.rows if r['state'] != 'removed']

    monkeypatch.setattr(singleton, 'publish_list', every_row)
    for app_id in ('rocketride.preview', 'acme.private', 'acme.orgonly'):
        assert await ds.app(app_id) is None, app_id
    assert (await ds.app('acme.brandy'))['name'] == 'Brandy'


def test_private_named_apps_reach_no_crawler_response(acct, shell_root):
    _seed()
    for app_id in HIDDEN:
        acct.plans[app_id] = [{'name': f'LEAK {app_id} plan', 'price': '5', 'currency': 'usd'}]
    _serve(*(_page(f'/p{i}', [f'plans:{a}', f'app:{a}']) for i, a in enumerate(HIDDEN)))
    client = _client()
    for i, _ in enumerate(HIDDEN):
        resp = _crawl(client, f'/p{i}')
        assert resp.status_code == 200 and '<h1>Pricing</h1>' in resp.text
        assert '<ul></ul>' in resp.text and '<h2>' not in resp.text and 'LEAK' not in resp.text
        assert _jsonld(resp.text) == []
        assert_no_leak(resp.text)


async def test_plans_normalize_to_the_documented_shape(acct):
    acct.plans['rocketride.home'] = [
        {'id': 'pro', 'name': 'Pro', 'price': 20, 'currency': 'usd', 'period': 'month', 'features': ['A', 3, None]},
        {'name': 'Broken'},
        {'name': 'Flag', 'price': True},
        {'name': '', 'price': '1'},
        {'name': 'Long s', 'price': '1', 'currency': 'u\u017fd'},
        'junk',
    ]
    context = await ds.bind(_page('/pricing', ['plans']), '')
    assert context['plans'] == [
        {'id': 'pro', 'name': 'Pro', 'price': '20', 'currency': 'USD', 'period': 'month', 'features': ['A', '3']},
        # Only ASCII is upper-cased: 'u\u017fd'.upper() would be 'USD'.
        {'id': '', 'name': 'Long s', 'price': '1', 'currency': 'u\u017fd', 'period': '', 'features': []},
    ]


async def test_plan_prices_keep_their_exact_decimal_form(acct):
    acct.plans['rocketride.home'] = [
        {'name': 'Text', 'price': '29.50'},
        {'name': 'Int', 'price': 29},
        {'name': 'Decimal', 'price': Decimal('29.50')},
        {'name': 'Exponent', 'price': Decimal('1E+2')},
        {'name': 'Float', 'price': 0.1 + 0.2},
        {'name': 'Whole float', 'price': 29.0},
        {'name': 'Not a number', 'price': Decimal('NaN')},
    ]
    context = await ds.bind(_page('/pricing', ['plans']), '')
    assert [(p['name'], p['price']) for p in context['plans']] == [
        ('Text', '29.50'),
        ('Int', '29'),
        ('Decimal', '29.50'),
        ('Exponent', '100'),
    ]


async def test_oss_default_has_no_plans():
    from ai.account.base import AccountBase

    assert await AccountBase.get_public_plans(object(), 'rocketride.home') == []


# ---------------------------------------------------------------------------
# JSON-LD and URLs
# ---------------------------------------------------------------------------


def test_app_entry_emits_software_application(acct, shell_root):
    _serve(_page('/', ['app:acme.brandy'], snapshot=''))
    client = _client()
    assert _jsonld(_crawl(client, '/').text) == [
        {
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            'name': 'Brandy',
            'description': 'Brand kit generator.',
            'url': 'https://cloud.example/',
        }
    ]
    # People get the shell document as before: no structured data, no store reads.
    calls = acct.publish_list_calls
    human = client.get('/', headers={'User-Agent': BROWSER})
    assert 'SPA' in human.text and _jsonld(human.text) == [] and acct.publish_list_calls == calls


def test_jsonld_shapes():
    url = 'https://cloud.example/pricing'
    app = {'name': 'A', 'description': 'D', 'url': url}
    priced = {'id': 'p', 'name': 'Pro', 'price': '29.50', 'currency': 'USD', 'period': 'month', 'features': ['x', 'y']}
    unpriced = {'id': 'e', 'name': 'Enterprise', 'price': 'Contact us', 'currency': 'USD', 'period': '', 'features': []}
    objs = ds.jsonld({'app': app, 'plans': [priced, unpriced]}, url)
    assert objs == [
        {'@context': 'https://schema.org', '@type': 'SoftwareApplication', 'name': 'A', 'description': 'D', 'url': url},
        {
            '@context': 'https://schema.org',
            '@type': 'Product',
            'name': 'Pro',
            'description': 'x; y',
            'offers': {
                '@type': 'Offer',
                'price': '29.50',
                'priceCurrency': 'USD',
                'url': url,
                'priceSpecification': {
                    '@type': 'UnitPriceSpecification',
                    'price': '29.50',
                    'priceCurrency': 'USD',
                    'unitText': 'month',
                },
            },
        },
    ]
    assert ds.jsonld({}, url) == [] and ds.jsonld({'app': None, 'plans': []}, url) == []


@pytest.mark.parametrize(
    'price, currency',
    [
        ('\u0662\u0669', 'USD'),
        ('\uff12\uff19', 'USD'),
        ('-29', 'USD'),
        ('29.', 'USD'),
        ('1e3', 'USD'),
        ('29', ''),
        ('29', 'US'),
        ('29', 'USDT'),
        ('29', 'U$D'),
        ('29', 'usd'),
        ('29', '\uff35SD'),
    ],
)
def test_a_plan_without_a_plain_price_and_iso_currency_gets_no_offer(price, currency):
    plan = {'id': 'p', 'name': 'Pro', 'price': price, 'currency': currency, 'period': 'month', 'features': []}
    assert ds.jsonld({'plans': [plan]}, 'https://cloud.example/pricing') == []
    plan.update(price='29', currency='EUR')
    assert [b['offers']['priceCurrency'] for b in ds.jsonld({'plans': [plan]}, 'https://cloud.example/pricing')] == [
        'EUR'
    ]


@pytest.mark.parametrize('base', ['http://cloud.example', 'javascript:alert(1)//', ''])
async def test_source_urls_are_https_or_empty(acct, base):
    acct.plans['acme.brandy'] = PLANS
    context = await ds.bind(_page('/', ['app:acme.brandy', 'plans:acme.brandy']), f'{base}/')
    assert context['app']['url'] == ''
    for obj in ds.jsonld(context, f'{base}/'):
        assert 'url' not in obj and 'url' not in obj.get('offers', {}), obj


def test_home_ui_pricing_snapshot_binds_live_plans(acct, shell_root):
    acct.add(
        PLATFORM,
        'rocketride.pipeBuilder',
        {'id': 'rocketride.pipeBuilder', 'name': 'Pipe Builder', 'description': 'Build AI pipelines.'},
    )
    acct.plans['rocketride.pipeBuilder'] = PLANS
    FILES[f'{DIST}/pages/pricing.html'] = (HOME_UI / 'pricing.html').read_bytes()
    _serve(_page('/pricing', ['plans:rocketride.pipeBuilder']))
    text = _crawl(_client()).text
    assert '{{' not in text
    section = re.search(r'<section data-rr-template="plans">(.*?)</section>', text, re.S).group(1)
    assert '<li><h3>Builder</h3><p>29 USD per month</p></li>' in section
    assert '<li><h3>Pro</h3><p>99.50 USD per month</p></li>' in section
    offers = [(b['@type'], b['name'], b['offers']['price'], b['offers']['priceCurrency']) for b in _jsonld(text)]
    assert offers == [('Product', 'Builder', '29', 'USD'), ('Product', 'Pro', '99.50', 'USD')]
    assert {b['offers']['url'] for b in _jsonld(text)} == {'https://cloud.example/pricing'}


def test_hostile_store_data_is_inert_in_the_snapshot_body(acct, shell_root):
    _seed('<html><head></head><body>{{#app}}<h1>{{name}}</h1><p title="{{description}}">x</p>{{/app}}</body></html>')
    _serve(_page('/x', ['app:acme.hostile']))
    text = _crawl(_client(), '/x').text
    assert '<script>alert' not in text and '<img src=x' not in text
    assert '<h1>&lt;script&gt;alert(&quot;n&quot;)&lt;/script&gt;' in text
    assert 'title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;' in text
    # The Mustache syntax inside the hostile name is printed, never expanded.
    assert '{{#apps}}x{{/apps}}' in text
    # ...and the value round-trips intact for the structured-data consumer.
    assert _jsonld(text)[0]['name'] == HOSTILE_NAME


def test_store_text_never_becomes_a_url(acct, shell_root):
    hostile = 'javascript:alert(1)//"><script>alert(2)</script>'
    acct.add('org-acme', 'acme.jsurl', {'id': 'acme.jsurl', 'name': hostile, 'description': hostile})
    _seed(
        '<html><head></head><body>{{#app}}<a href="{{url}}">{{name}}</a>'
        '<p title="{{description}}">{{description}}</p>{{/app}}</body></html>'
    )
    _serve(_page('/x', ['app:acme.jsurl']))
    text = _crawl(_client(), '/x').text
    assert '<a href="https://cloud.example/x">javascript:alert(1)//&quot;&gt;&lt;script&gt;' in text
    assert 'href="javascript' not in text and '<script>alert(2)' not in text
    (block,) = _jsonld(text)
    assert block['name'] == block['description'] == hostile and block['url'] == 'https://cloud.example/x'


# ---------------------------------------------------------------------------
# Failures and the render cache
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('entry', ['plans', 'plans:acme.brandy', 'app:acme.brandy'])
def test_failed_binding_is_served_but_not_cached(acct, shell_root, warned, entry):
    acct.plans['rocketride.home'] = acct.plans['acme.brandy'] = PLANS
    _seed()
    _serve(_page('/pricing', [entry]))
    acct.fail = True
    client = _client()
    resp = _crawl(client)
    assert resp.status_code == 200 and '<h1>Pricing</h1>' in resp.text
    assert 'Builder' not in resp.text and 'Brandy' not in resp.text and _jsonld(resp.text) == []
    assert resp.headers['cache-control'] == 'private, no-cache' and len(pages._render_cache) == 0
    assert any('/pricing' in line and 'store down' in line for line in warned)
    acct.fail = False
    resp = _crawl(client)
    assert ('Builder' in resp.text or 'Brandy' in resp.text) and _jsonld(resp.text)
    assert resp.headers['cache-control'] == 'public, max-age=300' and len(pages._render_cache) == 1


def test_invalidate_plans_drops_named_renders(acct, shell_root):
    acct.plans['rocketride.home'] = [{'name': 'Home', 'price': '1'}]
    acct.plans['acme.brandy'] = [{'name': 'Old', 'price': '1'}]
    _seed()
    _serve(
        _page('/pricing', ['plans:acme.brandy']),
        _page('/own', ['plans']),
        _page('/', ['app:acme.brandy']),
        _page('/about', []),
    )
    client = _client()
    for path in ('/pricing', '/own', '/', '/about'):
        _crawl(client, path)
    acct.plans['acme.brandy'] = [{'name': 'New', 'price': '2'}]
    assert 'Old' in _crawl(client).text
    ds.invalidate('plans')
    assert sorted(key[0] for key in pages._render_cache.keys()) == ['/', '/about']
    assert 'New' in _crawl(client).text


def test_data_source_event_invalidates_dependent_entries(acct, shell_root):
    acct.plans['acme.brandy'] = PLANS
    _seed()
    _serve(_page('/pricing', ['plans:acme.brandy', 'app:acme.brandy']), _page('/plans', ['plans:acme.brandy']))
    client = _client()
    text = _crawl(client).text
    assert '<h2>Brandy</h2>' in text and 'Builder' in text and len(_jsonld(text)) == 3
    assert 'Builder' in _crawl(client, '/plans').text
    # The app turns private (its manifest now says public: false): the cached
    # renders still hold it until the deployment-change hook fires.
    acct.artifacts[('org-acme', 'acme.brandy', 1)]['metadata']['manifest']['public'] = False
    assert 'Brandy' in _crawl(client).text
    pp.app_changed('acme.brandy')
    text = _crawl(client).text
    assert 'Brandy' not in text and 'Builder' not in text and _jsonld(text) == []
    # A page naming only the app's plans depends on its visibility too.
    text = _crawl(client, '/plans').text
    assert 'Builder' not in text and _jsonld(text) == []


def test_a_render_overtaken_by_an_invalidation_is_served_but_not_cached(acct, shell_root, monkeypatch):
    from ai.account import account as singleton

    _seed()
    _serve(_page('/pricing', ['plans']))

    async def repriced_mid_render(app_id):
        ds.invalidate('plans')
        return [{'name': 'Old', 'price': '1'}]

    monkeypatch.setattr(singleton, 'get_public_plans', repriced_mid_render)
    assert 'Old' in _crawl(_client()).text
    assert len(pages._render_cache) == 0


def test_unrelated_source_events_keep_entries(acct, shell_root):
    _seed()
    _serve(_page('/', ['app:acme.brandy']), _page('/about', []))
    client = _client()
    _crawl(client, '/')
    _crawl(client, '/about')
    ds.invalidate('plans')
    assert len(pages._render_cache) == 2


def test_bound_renders_expire_after_the_source_ttl(acct, shell_root, monkeypatch):
    acct.plans['acme.brandy'] = [{'name': 'Old', 'price': '1'}]
    _seed()
    _serve(_page('/pricing', ['plans:acme.brandy']), _page('/about', []))
    monkeypatch.setattr(ds, 'TTL_SECONDS', 0.0)
    client = _client()
    assert 'Old' in _crawl(client).text
    _crawl(client, '/about')
    # A pod that never saw the price change still converges within the TTL.
    acct.plans['acme.brandy'] = [{'name': 'New', 'price': '2'}]
    assert 'New' in _crawl(client).text
    # Responses bound to no source never expire.
    (about,) = [key for key in pages._render_cache.keys() if key[0] == '/about']
    assert math.isinf(pages._render_cache.get(about).expires)


async def test_one_bind_reads_a_named_app_once(acct, monkeypatch):
    from ai.account import account as singleton

    reads = []

    async def counting_artifact(org_id, app_id, version):
        reads.append(app_id)
        return await acct.deployments_artifact(org_id, app_id, version)

    monkeypatch.setattr(singleton, 'deployments_artifact', counting_artifact)
    acct.plans['acme.brandy'] = PLANS
    calls = acct.publish_list_calls
    context = await ds.bind(_page('/pricing', ['plans:acme.brandy', 'app:acme.brandy']), f'{APP_URL}/pricing')
    assert context['app']['name'] == 'Brandy' and len(context['plans']) == 2
    assert acct.publish_list_calls == calls + 1 and reads == ['acme.brandy']


def test_shared_caches_keep_a_bound_response_only_as_long_as_the_engine_would(acct, shell_root, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(pages, 'time', SimpleNamespace(monotonic=lambda: clock[0]))
    _seed()
    _serve(_page('/pricing', ['plans:acme.brandy']), _page('/about', []))
    client = _client()
    assert _crawl(client).headers['cache-control'] == 'public, max-age=300'
    # A hit carries what is left of the entry's lifetime, so a shared cache
    # never holds the data past the TTL counted from the render.
    clock[0] += 120.5
    assert _crawl(client).headers['cache-control'] == 'public, max-age=180'
    clock[0] += 179.5
    assert _crawl(client).headers['cache-control'] == 'public, max-age=300'  # expired: rendered again
    # Data-free crawler responses and people's responses are unchanged.
    assert _crawl(client, '/about').headers['cache-control'] == 'public, max-age=3600'
    assert client.get('/pricing', headers={'User-Agent': BROWSER}).headers['cache-control'] == 'private, no-cache'


def test_a_fresh_bound_response_never_advertises_more_than_the_ttl(acct, shell_root, monkeypatch):
    # At this clock, (now + 300) - now is 300.0000000000582 in floating point,
    # which ceil turned into max-age=301 (seen on a CI runner).
    monkeypatch.setattr(pages, 'time', SimpleNamespace(monotonic=lambda: 524202.9789498676))
    _seed()
    _serve(_page('/pricing', ['plans:acme.brandy']))
    assert _crawl(_client()).headers['cache-control'] == 'public, max-age=300'


def test_a_failing_invalidation_listener_is_a_warning(monkeypatch):
    lines = []
    monkeypatch.setattr(ds, 'warning', lines.append)
    seen = []

    def broken(name):
        raise RuntimeError('listener down')

    ds.on_invalidate(broken)
    ds.on_invalidate(seen.append)
    ds.invalidate('plans')
    assert seen == ['plans'] and len(lines) == 1 and 'listener down' in lines[0]
