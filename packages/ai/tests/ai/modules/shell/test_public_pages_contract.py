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
Contract tests for the ``publicPages`` + ``site`` manifest sections.

``check_manifest`` is the one validator: the publish gate (app_deploy) refuses
on any error it returns, and the aggregate builder re-runs it on every
published manifest (seeded rows never pass the gate) and keeps only the pages
it returns. Every error is actionable: it names the field and says what to do.
"""

from __future__ import annotations

import pytest

from ai.modules.shell.contract import (
    PLATFORM_DEVELOPER_ID,
    RESERVED_PREFIXES,
    check_manifest,
    is_privileged,
    may_claim_root,
    path_error,
)

ROOT_APP = 'rocketride.home'


@pytest.fixture(autouse=True)
def _root_app(monkeypatch):
    """The default root claimant, pinned explicitly so the tests read whole."""
    monkeypatch.setenv('RR_PUBLIC_ROOT_APPS', ROOT_APP)


def _page(path, **extra):
    return {'path': path, 'title': 'T', **extra}


# ---------------------------------------------------------------------------
# Path grammar
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('path', ['/', '/pricing', '/legal/terms', '/mcp-server', '/a.b_c~d'])
def test_path_grammar_accepts(path):
    assert path_error(path) is None


@pytest.mark.parametrize(
    'path,why',
    [
        ('pricing', 'absolute'),
        ('/Pricing', 'lowercase'),
        ('/pricing/', 'trailing slash'),
        ('/pricing?x=1', 'query'),
        ('/pricing#top', 'fragment'),
        ('//pricing', 'empty segment'),
        ('/a/../b', 'dot segment'),
        ('/a/./b', 'dot segment'),
        ('/a/%2e%2e', 'characters'),
        ('/a b', 'characters'),
        ('/pricing\n', 'characters'),
        ('/prícing', 'characters'),
        ('/\uff41pi', 'characters'),  # fullwidth 'a': never a lookalike of the reserved '/api'
        ('', 'absolute'),
        (None, 'string'),
        (7, 'string'),
    ],
)
def test_path_grammar_rejects_with_reason(path, why):
    err = path_error(path)
    assert err is not None and why in err


@pytest.mark.parametrize('path', ['*', '/*', '/marketplace/*', '/a/*/b', '/a*', '/A/*'])
def test_wildcard_path_rejected(path):
    assert path_error(path) == 'wildcard pages are not supported'
    pages, _, errors = check_manifest(ROOT_APP, {'publicPages': [_page(path, data=['app:rocketride.home'])]})
    assert pages == []
    assert errors == [f'publicPages[0].path {path!r}: wildcard pages are not supported']


# ---------------------------------------------------------------------------
# Privilege
# ---------------------------------------------------------------------------


def test_privilege_is_the_platform_developer_namespace():
    assert PLATFORM_DEVELOPER_ID == 'rocketride'
    assert is_privileged('rocketride.home')
    assert is_privileged('rocketride')
    assert not is_privileged('rocketrides.home')  # prefix lookalike
    assert not is_privileged('acme.rocketride')
    assert not is_privileged('')


def test_may_claim_root_needs_privilege_and_the_root_list(monkeypatch):
    assert may_claim_root(ROOT_APP)
    assert not may_claim_root('rocketride.pipeBuilder')
    # A third party named in the env still cannot claim root: privilege first.
    monkeypatch.setenv('RR_PUBLIC_ROOT_APPS', 'acme.home, rocketride.home')
    assert not may_claim_root('acme.home')
    assert may_claim_root('rocketride.home')


def test_root_claimants_default_to_home_ui(monkeypatch):
    monkeypatch.delenv('RR_PUBLIC_ROOT_APPS', raising=False)
    assert may_claim_root('rocketride.home')


def test_manifest_without_the_sections_is_a_no_op():
    assert check_manifest('acme.app', {'name': 'x'}) == ([], None, [])


def test_third_party_publicpages_rejected_loudly():
    pages, site, errors = check_manifest('acme.app', {'publicPages': [_page('/acme')]})
    assert pages == [] and site is None
    assert len(errors) == 1 and 'platform' in errors[0] and 'acme.app' in errors[0]
    # With a site block too, the one error is about publicPages.
    _, site, errors = check_manifest('acme.app', {'publicPages': [_page('/acme')], 'site': {'title': 'Acme'}})
    assert site is None and len(errors) == 1 and errors[0].startswith('publicPages is a platform capability')


def test_third_party_site_alone_is_ignored():
    # 'site' is a generic key a store manifest may carry, and it can never take effect without a root page.
    assert check_manifest('acme.app', {'name': 'x', 'site': {'title': 'Acme', 'docsUrl': 'http://x'}}) == ([], None, [])


def test_privileged_non_root_app_cannot_mount_root_paths():
    pages, _, errors = check_manifest('rocketride.pipeBuilder', {'publicPages': [_page('/builder')]})
    assert pages == []
    assert 'may-claim-root' in errors[0] and 'RR_PUBLIC_ROOT_APPS' in errors[0]


# ---------------------------------------------------------------------------
# Field validation
# ---------------------------------------------------------------------------


def test_valid_manifest_yields_pages_and_site():
    manifest = {
        'publicPages': [
            _page('/', description='Home page', listed=True, data=['app:rocketride.pipeBuilder']),
            _page('/pricing', description='Plans', data=['plans'], snapshot='pages/pricing.html'),
            _page('/store', listed=False),
        ],
        'site': {'title': 'RocketRide', 'blurb': 'B', 'docsUrl': 'https://docs.rocketride.org/llms.txt'},
    }
    pages, site, errors = check_manifest(ROOT_APP, manifest)
    assert errors == []
    assert [p.path for p in pages] == ['/', '/pricing', '/store']
    pricing = pages[1]
    assert (pricing.app_id, pricing.title, pricing.description) == (ROOT_APP, 'T', 'Plans')
    assert pricing.data == ('plans',) and pricing.snapshot == 'pages/pricing.html' and pricing.listed
    assert pages[0].data == ('app:rocketride.pipeBuilder',)
    assert pages[2].listed is False
    assert all(dict(p.extra) == {} for p in pages)
    assert site == {'title': 'RocketRide', 'blurb': 'B', 'docsUrl': 'https://docs.rocketride.org/llms.txt'}


def test_named_data_entries_validate():
    for entry in ('plans', 'plans:rocketride.pipeBuilder', 'app:rocketride.pipeBuilder', 'app:' + 'a' * 128):
        pages, _, errors = check_manifest(ROOT_APP, {'publicPages': [_page('/x', data=[entry])]})
        assert errors == [], entry
        assert pages[0].data == (entry,)
    rejected = ('app', 'apps', 'plans:', 'plans:bad id', 'app:', 'app:.x', 'app:' + 'a' * 129, 'Plans', 'plans:x\n')
    for entry in rejected:
        pages, _, errors = check_manifest(ROOT_APP, {'publicPages': [_page('/x', data=[entry])]})
        assert pages == [], entry
        assert len(errors) == 1 and f'publicPages[0].data: unknown data source {entry!r}' in errors[0]
        assert errors[0].endswith('known forms: plans, plans:<appId>, app:<appId>')
    # The engine binds by source name: one entry per source on a page.
    for entries, name in (
        (['plans', 'plans:rocketride.x'], 'plans'),
        (['plans', 'plans'], 'plans'),
        (['app:a', 'app:b'], 'app'),
    ):
        pages, _, errors = check_manifest(ROOT_APP, {'publicPages': [_page('/x', data=entries)]})
        assert pages == [], entries
        assert errors == [f"publicPages[0].data: '{name}' appears more than once; a page binds each source once"]
    pages, _, errors = check_manifest(ROOT_APP, {'publicPages': [_page('/x', data=['plans:a', 'app:a'])]})
    assert errors == [] and pages[0].data == ('plans:a', 'app:a')


@pytest.mark.parametrize(
    'page,needle',
    [
        ({'path': '/x'}, 'title'),
        ({'path': '/x', 'title': ''}, 'title'),
        ({'path': '/x', 'title': 'x' * 301}, 'title'),
        ({'path': '/x', 'title': 'T', 'description': 5}, 'description'),
        ({'path': '/x', 'title': 'T', 'listed': 'yes'}, 'listed'),
        ({'path': '/x', 'title': 'T', 'data': 'plans'}, 'data'),
        ({'path': '/x', 'title': 'T', 'data': [5]}, 'data'),
        ({'path': '/x', 'title': 'T', 'data': ['nope']}, "unknown data source 'nope'"),
        ({'path': '/x', 'title': 'T', 'snapshot': '../secrets.html'}, 'snapshot'),
        ({'path': '/x', 'title': 'T', 'snapshot': '/abs.html'}, 'snapshot'),
        ({'path': '/x', 'title': 'T', 'snapshot': 'pages\\x.html'}, 'snapshot'),
        ({'path': '/x', 'title': 'T', 'snapshot': 'pages/x.js'}, 'snapshot'),
        ({'path': '/x', 'title': 'T', 'snapshot': 'pages//x.html'}, 'snapshot'),
        ({'path': '/x', 'title': 'T', 'snapshot': 'pages/x.html\n'}, 'snapshot'),
        ('not-a-dict', 'object'),
    ],
)
def test_bad_page_fields_fail_with_the_field_named(page, needle):
    pages, _, errors = check_manifest(ROOT_APP, {'publicPages': [page]})
    assert pages == []
    assert len(errors) == 1 and needle in errors[0] and 'publicPages[0]' in errors[0]


# Half of an emoji: what a JS .slice() through one leaves in a JSON string.
SURROGATE = '\ud83d'
SURROGATE_ERROR = 'contains a lone surrogate (U+D800 to U+DFFF), which UTF-8 cannot carry; fix the text encoding'


@pytest.mark.parametrize(
    'manifest,field',
    [
        ({'publicPages': [_page('/x', title=f'Launch {SURROGATE}')]}, 'publicPages[0].title'),
        ({'publicPages': [_page('/x', description=f'{SURROGATE} day')]}, 'publicPages[0].description'),
        ({'publicPages': [_page('/')], 'site': {'title': f'R{SURROGATE}'}}, 'site.title'),
        ({'publicPages': [_page('/')], 'site': {'blurb': SURROGATE}}, 'site.blurb'),
        ({'publicPages': [_page('/')], 'site': {'docsUrl': f'https://docs.example/{SURROGATE}'}}, 'site.docsUrl'),
    ],
)
def test_lone_surrogates_are_rejected_in_text_fields(manifest, field):
    pages, site, errors = check_manifest(ROOT_APP, manifest)
    assert errors == [f'{field}: {SURROGATE_ERROR}']
    assert site is None and [p.path for p in pages] == (['/'] if 'site' in manifest else [])
    # A whole emoji (a valid pair) is text like any other.
    pages, _, errors = check_manifest(ROOT_APP, {'publicPages': [_page('/x', title='Launch \U0001f680')]})
    assert errors == [] and pages[0].title == 'Launch \U0001f680'


def test_unknown_page_and_site_keys_are_ignored():
    manifest = {
        'publicPages': [
            _page('/', futureField={'a': 1}, image='/og.png'),
            _page('/x', published='2026-11-09'),
        ],
        'site': {'title': 'R', 'futureSite': [1]},
        'futureSection': True,
    }
    pages, site, errors = check_manifest(ROOT_APP, manifest)
    assert errors == []
    assert [p.path for p in pages] == ['/', '/x']
    assert site == {'title': 'R'}
    # A page keeps its unknown keys, read-only, for the layers that serve them.
    assert dict(pages[0].extra) == {'futureField': {'a': 1}, 'image': '/og.png'}
    assert dict(pages[1].extra) == {'published': '2026-11-09'}
    with pytest.raises(TypeError):
        pages[0].extra['image'] = '/other.png'


def test_publicpages_must_be_a_list():
    _, _, errors = check_manifest(ROOT_APP, {'publicPages': {'path': '/x'}})
    assert errors and 'list' in errors[0]


def test_duplicate_paths_in_one_manifest_rejected():
    pages, _, errors = check_manifest(ROOT_APP, {'publicPages': [_page('/x'), _page('/x')]})
    assert [p.path for p in pages] == ['/x']
    assert 'duplicate' in errors[0]


@pytest.mark.parametrize(
    'path',
    [p for prefix in RESERVED_PREFIXES for p in (prefix, f'{prefix}/x')]
    + ['/status', '/.well-known/openai-apps-challenge', '/auth/callback', '/webhook/abc'],
)
def test_reserved_prefixes_rejected(path):
    pages, _, errors = check_manifest(ROOT_APP, {'publicPages': [_page(path)]})
    assert pages == [] and 'reserved' in errors[0]


def test_reserved_prefix_is_segment_aware():
    # '/apis', '/tasks' and '/mcp-server' are NOT under '/api', '/task' and '/mcp'.
    pages, _, errors = check_manifest(
        ROOT_APP, {'publicPages': [_page('/apis'), _page('/tasks'), _page('/mcp-server')]}
    )
    assert errors == [] and len(pages) == 3


def test_live_route_conflicts_rejected():
    live = {'/metrics': 'GET /metrics', '/health': 'GET /health'}.get

    pages, _, errors = check_manifest(
        ROOT_APP,
        {'publicPages': [_page('/metrics'), _page('/health'), _page('/fine')]},
        live_conflict=live,
    )
    assert [p.path for p in pages] == ['/fine']
    assert len(errors) == 2 and all('live server route' in e for e in errors)


def test_site_only_from_the_root_owner():
    # Declares site but not '/': rejected.
    _, site, errors = check_manifest(ROOT_APP, {'publicPages': [_page('/x')], 'site': {'title': 'R'}})
    assert site is None and "'/'" in errors[0]


@pytest.mark.parametrize(
    'site,needle',
    [
        ('str', 'object'),
        ({'title': 3}, 'site.title'),
        ({'blurb': ['x']}, 'site.blurb'),
        ({'docsUrl': 'http://docs.example/llms.txt'}, 'site.docsUrl'),
        ({'docsUrl': 'javascript:alert(1)'}, 'site.docsUrl'),
        ({'docsUrl': 'https://docs.example/llms.txt\n'}, 'site.docsUrl'),
        ({'docsUrl': 'https://x/"><script>'}, 'site.docsUrl'),
    ],
)
def test_bad_site_fields(site, needle):
    _, out, errors = check_manifest(ROOT_APP, {'publicPages': [_page('/')], 'site': site})
    assert out is None and needle in errors[0]


@pytest.mark.parametrize('char', ['<', '>', '"', "'", '`'])
@pytest.mark.parametrize(
    'template',
    [
        'https://docs{}.example/llms.txt',
        'https://docs.example/llms{}.txt',
        'https://docs.example/llms.txt?q={}',
        'https://docs.example/llms.txt#{}',
    ],
)
def test_a_docs_url_carrying_an_html_special_character_is_refused(char, template):
    # A real URL percent-encodes these; raw, they would break out of an HTML attribute.
    _, out, errors = check_manifest(ROOT_APP, {'publicPages': [_page('/')], 'site': {'docsUrl': template.format(char)}})
    assert out is None and 'site.docsUrl' in errors[0]


@pytest.mark.parametrize(
    'url',
    [
        'https://docs.example/llms.txt?v=1&lang=en#top',
        'https://docs.example:8443/a%22b%3C/c;d=e,f~g!h$i*j+k(l)@m',
    ],
)
def test_a_docs_url_with_a_query_and_a_fragment_is_accepted(url):
    _, out, errors = check_manifest(ROOT_APP, {'publicPages': [_page('/')], 'site': {'docsUrl': url}})
    assert errors == [] and out == {'docsUrl': url}


def test_errors_carry_no_em_dashes():
    manifest = {
        'publicPages': [_page('/Bad'), _page('/api'), _page('/d', data=['nope']), _page('/x', snapshot='x.js')],
        'site': {'docsUrl': 'http://x'},
    }
    _, _, errors = check_manifest(ROOT_APP, manifest, live_conflict=lambda p: None)
    _, _, more = check_manifest('acme.app', manifest)
    assert len(errors) == 5 and more
    assert not any('—' in e for e in errors + more)
