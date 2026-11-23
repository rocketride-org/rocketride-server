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

"""Host dispatch of the app-origin middleware (#1022 PR1, design section 5 and 12).

``AppHostMiddleware`` is a pure ASGI middleware, outermost, for ``http`` and
``websocket`` scopes:

* on an APP HOST (label of exactly 25 chars in ``[a-z2-7]`` under the template,
  host lowercased, trailing dot stripped, port compared with the template) only
  ``/_rr/*``, ``/_t/<token>/v<N>/*`` and ``/_p/<appId>/v<N>/*`` are served;
  everything else is 404 and a WebSocket is closed before accept (HTTP 403);
* on any OTHER host, paths starting ``/_t/``, ``/_p/`` or ``/_rr/`` are 404 and
  everything else passes through untouched.

Tests T9 to T19 of ``.rr-sec/PR1_PLAN.md`` (host matrix H1 to H10). H4 and H5
are GUARDS: they hold on the base too (no route answers ``/_t`` there), so they
build the app without the middleware when its module does not exist yet.
"""

from __future__ import annotations

import asyncio
import re

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from . import isolation_support as sup
from .isolation_support import app_host_of, csp_directives, label_for, meta_content

LABEL = label_for('acme.thirdparty')
HOST = app_host_of(LABEL)
FAKE_TOKEN = 'v1.k1.eyJhIjoieCJ9.c2lnbmF0dXJl'  # token-shaped; only where no real one can exist yet; gitleaks:allow


def _config_or_none(env):
    """The parsed config, or None while the fix does not exist (guards only)."""
    ao = sup.module_or_none('ai.modules.shell.app_origin')
    if ao is None:
        return None
    return sup.need(ao, 'load_isolation_config')(__import__('os').environ)


def _client(env, *, require=True, hits=None):
    cfg = env.config() if require else _config_or_none(env)
    app = sup.outer_app(sup.shell_inner_app(hits), cfg, require=require)
    return TestClient(app, base_url=sup.SHELL_ORIGIN)


def _guard_token(env):
    """A real token when the fix exists, a token-shaped string on the base."""
    ao = sup.module_or_none('ai.modules.shell.app_origin')
    cfg = _config_or_none(env)
    if ao is None or cfg is None:
        return FAKE_TOKEN
    return ao.mint_frame_token('acme.thirdparty', 1, 'u1', 'org-1', config=cfg)


# ---------------------------------------------------------------------------
# T9 H1: a valid label is an app host
# ---------------------------------------------------------------------------


def test_h1_valid_label_serves_frame_html_with_shell_origins(isolation_env):
    """T9: ``/_rr/frame.html`` on an app host serves the guest frame with the shell origins as a meta tag."""
    hits: list = []
    client = _client(isolation_env, hits=hits)
    resp = client.get('/_rr/frame.html', headers={'host': HOST})
    assert resp.status_code == 200
    assert resp.headers['content-type'].startswith('text/html')
    assert resp.headers['cache-control'] == 'no-cache'
    origins = meta_content(resp.text, 'rr-shell-origins')
    assert origins is not None, resp.text
    assert sup.SHELL_ORIGIN in origins.replace(',', ' ').split()
    assert '/_rr/guest-test.js' in resp.text  # the stub's script tag survives the injection
    assert hits == []  # the inner app never saw the request


def test_h1_guest_bundle_is_immutable_and_only_the_marker_file_is_served(isolation_env):
    """T9: ``/_rr/guest-<hash>.js`` is the file named by runtime.json, cached forever; no other guest file."""
    client = _client(isolation_env)
    resp = client.get('/_rr/guest-test.js', headers={'host': HOST})
    assert resp.status_code == 200
    assert 'immutable' in resp.headers['cache-control']
    assert resp.text == '/* guest runtime test stub */'
    assert client.get('/_rr/guest-other.js', headers={'host': HOST}).status_code == 404
    assert client.get('/_rr/runtime.json', headers={'host': HOST}).status_code == 404
    assert client.get('/_rr/../shell/index.html', headers={'host': HOST}).status_code == 404


# ---------------------------------------------------------------------------
# T10 H2: label shape
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'label',
    [
        LABEL[:-1],  # 24 characters
        LABEL + 'a',  # 26 characters
        '0' + LABEL[1:],  # '0' is not base32
        LABEL[:-1] + '1',
        LABEL[:-1] + '8',
        LABEL[:-1] + '-',
        LABEL[:-1] + '_',
        'a' + 'b' * 23 + '.x',  # a label cannot contain a dot
    ],
)
def test_h2_wrong_shape_is_not_an_app_host(label, isolation_env):
    """T10: only a 25-character ``[a-z2-7]`` label is an app host, but ANY name under the app suffix is app-domain
    traffic: it never reaches the engine's own routes (G4 M1: a wildcard DNS name such as ``www.<suffix>``
    must not serve the engine same-site with every app).
    """
    hits: list = []
    client = _client(isolation_env, hits=hits)
    host = app_host_of(label)
    assert client.get('/_rr/frame.html', headers={'host': host}).status_code == 404
    assert client.get('/auth', headers={'host': host}).status_code == 404
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect('/ws', headers={'host': host}):
            pass
    assert hits == []


@pytest.mark.parametrize(
    'host', ['apps.example', 'www.apps.example', 'x.y.apps.example', 'APPS.EXAMPLE.', 'apps.example:8443']
)
def test_names_under_the_app_suffix_never_reach_the_engine(host, isolation_env):
    """T10 (G4 M1): the bare suffix and every other name below it are app-domain traffic: 404, never the engine."""
    hits: list = []
    client = _client(isolation_env, hits=hits)
    for path in ('/', '/auth', '/shell/index.html', '/apps/session'):
        assert client.get(path, headers={'host': host}).status_code == 404, (host, path)
    assert hits == []


@pytest.mark.parametrize('port', ['\u00b2', '\u0668\u0660', '80x', ''])
def test_non_ascii_or_malformed_port_is_a_404_not_a_500(port, isolation_env):
    """T11 (G4 L6): only ASCII digits are a port; anything else under the app suffix is a plain 404."""
    hits: list = []
    client = _client(isolation_env, hits=hits)
    value = f'{HOST}:{port}'
    try:
        raw = value.encode('latin-1')  # how a server decodes header bytes: '\u00b2' arrives as itself
    except UnicodeEncodeError:
        raw = value.encode('utf-8')
    resp = client.get('/_rr/frame.html', headers={'host': raw})
    assert resp.status_code == 404
    assert hits == []


def test_h2_unknown_but_well_formed_label_still_gets_frame_html(isolation_env):
    """T10: ``frame.html`` is not tied to an app: any well-formed label gets it (tokens carry the app)."""
    client = _client(isolation_env)
    resp = client.get('/_rr/frame.html', headers={'host': app_host_of('a' + 'q' * 24)})
    assert resp.status_code == 200


def test_h2_other_domain_is_not_an_app_host(isolation_env):
    """T10: the suffix must match the template."""
    client = _client(isolation_env)
    for host in (f'{LABEL}.other.example', f'{LABEL}.apps.example.evil.example', f'{LABEL}.evil-apps.example'):
        assert client.get('/_rr/frame.html', headers={'host': host}).status_code == 404, host


# ---------------------------------------------------------------------------
# T11 H3: case, trailing dot, port
# ---------------------------------------------------------------------------


def test_h3_case_and_trailing_dot_are_normalised(isolation_env):
    """T11: the Host header is lowercased and a trailing dot stripped before the label check."""
    client = _client(isolation_env)
    for host in (HOST.upper(), HOST + '.', HOST.upper() + '.'):
        assert client.get('/_rr/frame.html', headers={'host': host}).status_code == 200, host


@pytest.mark.parametrize('suffix', [':8443', ':80', ':1'])
def test_h3_wrong_port_is_not_an_app_host(suffix, isolation_env):
    """T11: the port must match the template (https default: none)."""
    hits: list = []
    client = _client(isolation_env, hits=hits)
    host = HOST + suffix
    assert client.get('/_rr/frame.html', headers={'host': host}).status_code == 404
    assert client.get('/auth', headers={'host': host}).status_code == 404  # still app-domain traffic (G4 M1)
    assert hits == []


def test_h3_localhost_template_compares_the_port(isolation_env):
    """T11: ``http://{label}.apps.localhost:8765``: the port is part of the host match."""
    isolation_env.set(RR_APP_ORIGIN_TEMPLATE=sup.LOCAL_TEMPLATE)
    client = _client(isolation_env)
    good = app_host_of(LABEL, sup.LOCAL_TEMPLATE)
    assert good.endswith(':8765')
    assert client.get('/_rr/frame.html', headers={'host': good}).status_code == 200
    assert client.get('/_rr/frame.html', headers={'host': good.replace(':8765', ':9999')}).status_code == 404
    assert client.get('/_rr/frame.html', headers={'host': good.replace(':8765', '')}).status_code == 404


# ---------------------------------------------------------------------------
# T12 H4 (guard) and T13 H5 (guard): app-host paths on every other host are 404
# ---------------------------------------------------------------------------


def _app_host_paths(token):
    return [
        f'/_t/{token}/v1/remoteEntry.js',
        '/_t/',
        '/_t',
        '/_p/acme.thirdparty/v1/remoteEntry.js',
        '/_rr/frame.html',
        '/_rr/clear',
        '/_rr/guest-test.js',
    ]


def test_h4_app_host_paths_are_404_on_the_shell_host(isolation_env):
    """T12 (guard): ``/_t``, ``/_p``, ``/_rr`` answer 404 on the shell's own host; no bundle bytes ever."""
    client = _client(isolation_env, require=False)
    for path in _app_host_paths(_guard_token(isolation_env)):
        resp = client.get(path)
        assert resp.status_code == 404, path
        assert 'bundle' not in resp.text and 'guest runtime' not in resp.text


def test_h4_app_host_paths_are_404_on_any_unrelated_host(isolation_env):
    """T12 (guard): the same on an arbitrary host name."""
    client = _client(isolation_env, require=False)
    for host in ('localhost', '127.0.0.1:8080', 'evil.example', f'{LABEL}.evil.example'):
        for path in _app_host_paths(_guard_token(isolation_env)):
            assert client.get(path, headers={'host': host}).status_code == 404, (host, path)


@pytest.mark.parametrize('forged', ['x-forwarded-host', 'x-rr-app-host', 'forwarded', 'x-original-host'])
def test_h5_forged_host_headers_do_not_make_an_app_host(forged, isolation_env):
    """T13 (guard): with ``RR_APP_HOST_SOURCE=host`` only the Host header counts."""
    client = _client(isolation_env, require=False)
    value = f'host={HOST}' if forged == 'forwarded' else HOST
    for path in _app_host_paths(_guard_token(isolation_env)):
        assert client.get(path, headers={forged: value}).status_code == 404, (forged, path)


@pytest.mark.parametrize('secret_header', [None, '', 'short', 'w' * 32, 'w' * 33])
def test_h5_edge_header_without_the_right_secret_is_not_an_app_host(secret_header, isolation_env):
    """T13 (guard): ``edge-header``: an empty, short, missing or wrong secret means a non-app host."""
    isolation_env.set(RR_APP_HOST_SOURCE='edge-header', RR_EDGE_SECRET='s' * 32)
    client = _client(isolation_env, require=False)
    headers = {'x-rr-app-host': HOST}
    if secret_header is not None:
        headers['x-rr-edge-secret'] = secret_header
    for path in _app_host_paths(_guard_token(isolation_env)):
        assert client.get(path, headers=headers).status_code == 404, (secret_header, path)
    # ... and the Host header alone does not make one either, in this mode
    assert client.get('/_rr/frame.html', headers={'host': HOST}).status_code == 404


def test_edge_header_mode_app_suffix_host_without_secret_never_reaches_the_engine(isolation_env):
    """T13 (G4 M1): with ``edge-header``, an app-suffix Host that arrives without the secret is app-domain
    traffic too: 404, not the engine's routes.
    """
    isolation_env.set(RR_APP_HOST_SOURCE='edge-header', RR_EDGE_SECRET='s' * 32)
    hits: list = []
    client = _client(isolation_env, hits=hits)
    for headers in ({'host': HOST}, {'host': HOST, 'x-rr-app-host': HOST, 'x-rr-edge-secret': 'w' * 32}):
        assert client.get('/auth', headers=headers).status_code == 404, headers
    assert hits == []
    # an ordinary host still reaches the engine in this mode
    assert client.get('/auth', headers={'host': 'origin.internal'}).status_code == 200


# ---------------------------------------------------------------------------
# T14 H7: WebSocket on an app host
# ---------------------------------------------------------------------------


def test_h7_websocket_on_an_app_host_is_rejected_before_accept(isolation_env):
    """T14: the scope gets ``websocket.close`` without accept (the client sees HTTP 403); the app never runs."""
    hits: list = []
    client = _client(isolation_env, hits=hits)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect('/ws', headers={'host': HOST}):
            pass
    assert hits == []


def test_h7_websocket_on_the_shell_host_still_works(isolation_env):
    """T14 control: the same socket on a non-app host passes through untouched."""
    hits: list = []
    client = _client(isolation_env, hits=hits)
    with client.websocket_connect('/ws') as ws:
        assert ws.receive_text() == 'hello from inner'
    assert ('websocket', '/ws') in hits


# ---------------------------------------------------------------------------
# T15 H8: the shell's routes do not exist on an app host
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'method,path',
    [
        ('GET', '/'),
        ('GET', '/pricing'),
        ('GET', '/shell'),
        ('GET', '/shell/index.html'),
        ('GET', '/shell/static/main.js'),
        ('POST', '/apps/session'),
        ('GET', '/apps/acme.thirdparty/v1/remoteEntry.js'),
        ('POST', '/apps/frame'),
        ('GET', '/auth'),
        ('GET', '/robots.txt'),
        ('GET', '/openapi.json'),
        ('GET', '/_t'),
        ('GET', '/_rr'),
    ],
)
def test_h8_shell_routes_are_404_on_an_app_host(method, path, isolation_env):
    """T15: only the three app-host route families exist there; the inner app is never reached."""
    hits: list = []
    client = _client(isolation_env, hits=hits)
    resp = client.request(method, path, headers={'host': HOST})
    assert resp.status_code == 404, (method, path)
    assert hits == []


# ---------------------------------------------------------------------------
# T16 H9: clear
# ---------------------------------------------------------------------------


SAME_ORIGIN_FRAME = {'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate'}


@pytest.mark.parametrize(
    'fetch',
    [
        SAME_ORIGIN_FRAME,
        {'sec-fetch-site': 'none', 'sec-fetch-dest': 'document'},  # typed into the address bar
    ],
)
def test_h9_clear_sends_clear_site_data(fetch, isolation_env):
    """T16: ``/_rr/clear`` empties the app origin's storage on a same-ORIGIN navigation (the guest navigates its own frame there on logout)."""
    resp = _client(isolation_env).get('/_rr/clear', headers={'host': HOST, **fetch})
    assert resp.status_code == 200
    assert resp.headers['clear-site-data'] == '"storage"'
    assert resp.headers['cache-control'] == 'no-store'


@pytest.mark.parametrize(
    'fetch',
    [
        {},  # no fetch metadata: fail closed
        {'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'iframe'},  # another app (same site): G4 round 2 R2-L2
        {'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'document'},
        {'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe'},  # another site frames it
        {'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document'},
        {'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'image'},  # a subresource, not a navigation
        {'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'script'},
        {**SAME_ORIGIN_FRAME, 'origin': 'https://evil.example'},
    ],
)
def test_h9_clear_refuses_cross_site_and_subresource_loads(fetch, isolation_env):
    """T16 (G4 SEC L3): another site cannot wipe an app's storage by loading ``/_rr/clear``."""
    resp = _client(isolation_env).get('/_rr/clear', headers={'host': HOST, **fetch})
    assert resp.status_code == 404
    assert 'clear-site-data' not in resp.headers


def test_public_lookups_are_rate_limited_per_client(served_app, monkeypatch):
    """T19 (G4 SEC L2): ``/_p`` for ids nobody published costs a registry walk each; a client gets a bounded number."""
    from ai.account import account

    walks = []
    real = account.publish_list

    async def counting(*args, **kwargs):
        walks.append(args)
        return await real(*args, **kwargs)

    monkeypatch.setattr(account, 'publish_list', counting)
    statuses = []
    for i in range(200):
        app_id = f'acme.random{i}'
        statuses.append(
            served_app.get(f'/_p/{app_id}/v1/remoteEntry.js', host=app_host_of(label_for(app_id))).status_code
        )
    assert set(statuses[:50]) == {404}
    assert statuses[-1] == 429
    assert len(walks) < 200
    # a published app whose answer is already known keeps serving
    assert served_app.get('/_p/acme.thirdparty/v1/remoteEntry.js').status_code in (200, 429)


def test_public_route_refuses_non_canonical_ids(served_app):
    """T19 (G4 round 3 R3-L3): ``/_p/acme.thirdparty./`` is not another name for the app, even on its own label's host."""
    alias = 'acme.thirdparty.'
    resp = served_app.get(f'/_p/{alias}/v1/remoteEntry.js', host=app_host_of(label_for(alias)))
    assert resp.status_code == 404
    assert served_app.reads == []


def test_html_from_a_dist_cannot_be_framed(served_app):
    """T19 (G4 NIT): an HTML file of an app's dist (``/_t``, ``/_p``) gets ``frame-ancestors 'none'``; frame.html is the only framable document."""
    for resp in (
        served_app.get_bundle(file='index.html'),
        served_app.get('/_p/acme.thirdparty/v1/index.html'),
    ):
        assert resp.status_code == 200
        assert csp_directives(resp.headers['content-security-policy'])['frame-ancestors'] == ["'none'"]
    assert 'frame-ancestors' not in csp_directives(served_app.get_bundle().headers['content-security-policy'])
    # A 304 replaces a cache's stored headers, so it carries the same policy as the 200 it validates.
    public = served_app.get('/_p/acme.thirdparty/v1/index.html')
    again = served_app.get('/_p/acme.thirdparty/v1/index.html', headers={'if-none-match': public.headers['etag']})
    assert again.status_code == 304
    assert again.headers['content-security-policy'] == public.headers['content-security-policy']
    assert csp_directives(again.headers['content-security-policy'])['frame-ancestors'] == ["'none'"]


# ---------------------------------------------------------------------------
# T17 H10: no cookies on an app host
# ---------------------------------------------------------------------------


def test_h10_no_set_cookie_on_any_app_host_response(served_app):
    """T17: not on frame.html, the guest, clear, bundles, 404s, nor when the request carries cookies."""
    token = served_app.token()
    paths = [
        '/_rr/frame.html',
        '/_rr/guest-test.js',
        '/_rr/clear',
        f'/_t/{token}/v1/remoteEntry.js',
        '/_p/acme.thirdparty/v1/remoteEntry.js',
        f'/_t/{token}/v9/remoteEntry.js',
        '/auth',
        '/apps/session',
        '/nothing/here',
    ]
    for path in paths:
        for cookie in ('', 'rr_apps_token=stolen; inner_session=1'):
            headers = {'cookie': cookie} if cookie else {}
            resp = served_app.get(path, headers=headers)
            assert 'set-cookie' not in resp.headers, (path, cookie)


# ---------------------------------------------------------------------------
# T18 edge-header positive case
# ---------------------------------------------------------------------------


def test_edge_header_with_the_secret_makes_an_app_host(isolation_env):
    """T18: with the right ``X-RR-Edge-Secret`` the host comes from ``X-RR-App-Host`` (constant-time compare)."""
    isolation_env.set(RR_APP_HOST_SOURCE='edge-header', RR_EDGE_SECRET='s' * 32)
    client = _client(isolation_env)
    resp = client.get('/_rr/frame.html', headers={'x-rr-app-host': HOST, 'x-rr-edge-secret': 's' * 32})
    assert resp.status_code == 200
    # the real Host header (the edge's own name) is irrelevant in this mode
    resp = client.get(
        '/_rr/frame.html', headers={'host': 'origin.internal', 'x-rr-app-host': HOST, 'x-rr-edge-secret': 's' * 32}
    )
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# T19 header snapshot
# ---------------------------------------------------------------------------


def _assert_common_headers(resp, where):
    h = resp.headers
    max_age = re.search(r'max-age=(\d+)', h.get('strict-transport-security', ''))
    assert max_age and int(max_age.group(1)) >= 31536000, where
    assert h.get('cross-origin-resource-policy') == 'same-origin', where
    assert h.get('referrer-policy') == 'no-referrer', where
    assert h.get('x-content-type-options') == 'nosniff', where
    assert h.get('origin-agent-cluster') == '?1', where
    assert 'service-worker' in h.get('vary', '').lower(), where
    assert 'content-security-policy' in h, where


def test_app_host_headers_snapshot(served_app):
    """T19: every app-host response carries the full header set; the CSP is Appendix C's, exactly.

    The per-version ``network`` origins are not in any app-host CSP in PR1:
    ``frame.html`` is per label, not per app, and how they reach the frame's
    policy is a PR2 acceptance criterion (G4 S2). So nothing is stripped
    before comparing: no source beyond Appendix C's may appear.
    """
    token = served_app.token()
    responses = {
        'frame': served_app.get('/_rr/frame.html'),
        'guest': served_app.get('/_rr/guest-test.js'),
        'clear': served_app.get('/_rr/clear'),
        'token': served_app.get(f'/_t/{token}/v1/remoteEntry.js'),
        'public': served_app.get('/_p/acme.thirdparty/v1/remoteEntry.js'),
        'missing': served_app.get('/nothing/here'),
    }
    for name, resp in responses.items():
        _assert_common_headers(resp, name)

    frame = csp_directives(responses['frame'].headers['content-security-policy'])
    assert frame['default-src'] == ["'none'"]
    assert frame['script-src'] == ["'self'", "'wasm-unsafe-eval'"]
    assert frame['style-src'] == ["'self'", "'unsafe-inline'"]
    assert frame['img-src'] == ["'self'", 'data:', 'blob:']
    assert frame['font-src'] == ["'self'", 'data:']
    assert frame['connect-src'] == ["'self'"]
    assert frame['worker-src'] == ["'self'", 'blob:']
    assert frame['frame-src'] == ["'none'"]
    assert frame['form-action'] == ["'none'"]
    assert frame['base-uri'] == ["'none'"]
    assert frame['object-src'] == ["'none'"]
    assert frame['frame-ancestors'] == [sup.SHELL_ORIGIN]

    # The same policy minus frame-ancestors on everything else that serves code.
    for name in ('guest', 'token', 'public'):
        csp = csp_directives(responses[name].headers['content-security-policy'])
        assert 'frame-ancestors' not in csp, name
        assert csp == {k: v for k, v in frame.items() if k != 'frame-ancestors'}, name


def test_csp_never_widens_beyond_self_and_network_origins(served_app):
    """T19: no wildcard, no scheme-only source, no eval, no inline script, whatever the app asked for."""
    csp = served_app.get(f'/_t/{served_app.token()}/v1/remoteEntry.js').headers['content-security-policy']
    assert '*' not in csp
    assert "'unsafe-eval'" not in csp
    assert 'unsafe-inline' not in csp_directives(csp)['script-src']
    for sources in csp_directives(csp).values():
        assert 'https:' not in sources and 'http:' not in sources


@pytest.mark.parametrize('path_kind', ['token', 'public'])
def test_app_host_refuses_service_worker_registration(path_kind, served_app):
    """T19 (E9): a request that declares ``Service-Worker: script`` is refused on the app host."""
    path = (
        f'/_t/{served_app.token()}/v1/remoteEntry.js'
        if path_kind == 'token'
        else '/_p/acme.thirdparty/v1/remoteEntry.js'
    )
    ok = served_app.get(path)
    assert ok.status_code == 200
    resp = served_app.get(path, headers={'service-worker': 'script'})
    assert resp.status_code == 404


def test_server_installs_the_middleware_only_when_not_off(monkeypatch, isolation_env):
    """T19 (section 5): ``WebServer`` adds AppHostMiddleware outermost when the mode is not off, nothing under off."""
    from ai.web.server import WebServer

    host_mod = sup.load_module('ai.web.app_host')
    middleware_cls = sup.need(host_mod, 'AppHostMiddleware')

    server = WebServer()
    assert server.app.user_middleware[0].cls is middleware_cls  # first in the list is the outermost

    isolation_env.set(RR_APP_ISOLATION=None)
    off = WebServer()
    assert all(m.cls is not middleware_cls for m in off.app.user_middleware)


def test_app_host_scripts_keep_their_type_when_the_os_maps_js_differently(served_app, monkeypatch):
    """Windows can map '.js' to text/plain, which a nosniff browser refuses to run; the app host pins the type like the shell."""
    import mimetypes

    real_guess = mimetypes.guess_type

    def registry_guess(url, strict=True):
        if str(url).lower().endswith(('.js', '.mjs', '.css')):
            return ('text/plain', None)
        return real_guess(url, strict)

    monkeypatch.setattr(mimetypes, 'guess_type', registry_guess)
    for resp in (served_app.get_bundle(), served_app.get('/_p/acme.thirdparty/v1/remoteEntry.js')):
        assert resp.status_code == 200
        assert resp.headers['content-type'].startswith('text/javascript')


# ====================================================================


# PR2b: T80 ticketed frame.html, T81 network on /_t and /_p, T82 Vary, T104 chunks
# ===========================================================================

NET = ['https://api.example.com', 'https://cdn.example.org:8443']


def _ticket(served_app, network, *, app='acme.thirdparty', version=1):
    ao = sup.load_module('ai.modules.shell.app_origin')
    return sup.need(ao, 'mint_frame_ticket')(app, version, network, config=served_app.config)


def _frame(served_app, ticket=None, *, host=None, extra=''):
    query = f'?c={ticket}{extra}' if ticket is not None else ''
    return served_app.get(f'/_rr/frame.html{query}', host=host)


def _base_frame_csp(served_app):
    return csp_directives(_frame(served_app).headers['content-security-policy'])


def test_t80_a_ticketed_frame_widens_img_and_connect_src_to_the_network_only(served_app):
    """T80: the version's approved origins join ``img-src`` and ``connect-src``; nothing else moves."""
    base = _base_frame_csp(served_app)
    resp = _frame(served_app, _ticket(served_app, NET))
    assert resp.status_code == 200
    csp = csp_directives(resp.headers['content-security-policy'])
    assert csp['img-src'] == ["'self'", 'data:', 'blob:', *NET]
    assert csp['connect-src'] == ["'self'", *NET]
    for name, sources in base.items():
        if name not in ('img-src', 'connect-src'):
            assert csp[name] == sources, name
    assert csp['frame-ancestors'] == [sup.SHELL_ORIGIN]
    assert '*' not in resp.headers['content-security-policy']
    assert meta_content(resp.text, 'rr-shell-origins') is not None


def test_t80_a_ticketed_frame_is_never_cached(served_app):
    """T80: ``no-store``, because the CSP depends on the query (B4 keys on it too)."""
    assert _frame(served_app, _ticket(served_app, NET)).headers['cache-control'] == 'no-store'


def test_t80_a_frame_without_a_ticket_is_unchanged(served_app):
    """T80 control: no ticket, the base policy and ``no-cache``, as in PR1."""
    resp = _frame(served_app)
    assert resp.headers['cache-control'] == 'no-cache'
    csp = csp_directives(resp.headers['content-security-policy'])
    assert csp['connect-src'] == ["'self'"]
    assert csp['img-src'] == ["'self'", 'data:', 'blob:']


def test_t80_an_empty_network_ticket_is_the_base_policy(served_app):
    """T80: a version with no network gets exactly the base CSP, still ``no-store`` (it IS a ticketed request)."""
    resp = _frame(served_app, _ticket(served_app, []))
    assert csp_directives(resp.headers['content-security-policy']) == _base_frame_csp(served_app)


def _bad_tickets(served_app, clock):
    ao = sup.load_module('ai.modules.shell.app_origin')
    cfg = served_app.config
    kid, key = cfg.token_keys[0]
    now = int(clock.now)
    good = _ticket(served_app, NET)
    other_app = sup.need(ao, 'mint_frame_ticket')('acme.other', 1, NET, config=cfg)
    frame_token = served_app.token()
    forged_http = sup.seal_raw(
        key, kid, {'a': 'acme.thirdparty', 'v': 1, 'n': ['http://evil.example'], 'iat': now, 'exp': now + 900}, '.csp'
    )
    forged_wild = sup.seal_raw(
        key,
        kid,
        {
            'a': 'acme.thirdparty',
            'v': 1,
            'n': ['https://*.example.com', "'unsafe-eval'", 'https:'],
            'iat': now,
            'exp': now + 900,
        },
        '.csp',
    )
    forged_shell = sup.seal_raw(
        key, kid, {'a': 'acme.thirdparty', 'v': 1, 'n': [sup.SHELL_ORIGIN], 'iat': now, 'exp': now + 900}, '.csp'
    )
    flipped = good[:-3] + ('AAA' if not good.endswith('AAA') else 'BBB')
    return {
        'garbage': 'not-a-ticket',
        'empty': '',
        'other app': other_app,
        'a frame token': frame_token,
        'tampered': flipped,
        'network over http': forged_http,
        'wildcard network': forged_wild,
        'the shell origin as network': forged_shell,
    }


def test_t80_a_bad_ticket_gets_the_base_policy(served_app, clock):
    """T80: bad, foreign, forged or revalidated-away tickets never widen anything (and never fail the frame itself)."""
    base = _base_frame_csp(served_app)
    for name, ticket in _bad_tickets(served_app, clock).items():
        resp = _frame(served_app, ticket)
        assert resp.status_code == 200, name
        assert csp_directives(resp.headers['content-security-policy']) == base, name
        assert 'evil.example' not in resp.headers['content-security-policy'], name


def test_t80_an_expired_ticket_gets_the_base_policy(served_app, clock):
    """T80: expiry means the base CSP; a reload remints."""
    ticket = _ticket(served_app, NET)
    assert csp_directives(_frame(served_app, ticket).headers['content-security-policy'])['connect-src'] != ["'self'"]
    clock.advance(901)
    assert csp_directives(_frame(served_app, ticket).headers['content-security-policy']) == _base_frame_csp(served_app)


def test_t80_the_ticket_only_counts_on_its_own_host(served_app):
    """T80: label-bound: another app's host with this app's ticket is the base policy."""
    other_host = app_host_of(label_for('acme.other'))
    resp = _frame(served_app, _ticket(served_app, NET), host=other_host)
    assert resp.status_code == 200
    assert csp_directives(resp.headers['content-security-policy'])['connect-src'] == ["'self'"]


def test_t80_the_query_is_read_strictly(served_app):
    """T80: two ``c`` parameters, or a ticket on a non-frame route, never widen."""
    good = _ticket(served_app, NET)
    two = served_app.get(f'/_rr/frame.html?c=garbage&c={good}')
    assert csp_directives(two.headers['content-security-policy'])['connect-src'] == ["'self'"]
    guest = served_app.get(f'/_rr/guest-test.js?c={good}')
    assert csp_directives(guest.headers['content-security-policy'])['connect-src'] == ["'self'"]


def _add_net_app(served_app, app_id='acme.net', version=1, network=None, **kw):
    served_app.registry.add(app_id, version, org='acme-org', network=NET if network is None else network, **kw)
    return app_host_of(label_for(app_id))


def test_t81_token_route_csp_carries_the_versions_network(served_app):
    """T81: ``/_t/<token>/v<N>/`` documents and scripts get the version's network in ``img-src`` and ``connect-src``."""
    host = _add_net_app(served_app)
    resp = served_app.get_bundle(token=served_app.token(app='acme.net'), host=host)
    assert resp.status_code == 200
    csp = csp_directives(resp.headers['content-security-policy'])
    assert csp['connect-src'] == ["'self'", *NET]
    assert csp['img-src'] == ["'self'", 'data:', 'blob:', *NET]
    assert 'frame-ancestors' not in csp
    base = _base_frame_csp(served_app)
    for name, sources in base.items():
        if name not in ('img-src', 'connect-src', 'frame-ancestors'):
            assert csp[name] == sources, name


def test_t81_public_route_csp_carries_the_versions_network(served_app):
    """T81: the anonymous ``/_p/`` route too."""
    host = _add_net_app(served_app)
    resp = served_app.get('/_p/acme.net/v1/remoteEntry.js', host=host)
    assert resp.status_code == 200
    assert csp_directives(resp.headers['content-security-policy'])['connect-src'] == ["'self'", *NET]


def test_t81_html_from_a_dist_keeps_frame_ancestors_none_and_gets_the_network(served_app):
    """T81: the document policy is the same plus ``frame-ancestors 'none'``."""
    host = _add_net_app(served_app)
    resp = served_app.get_bundle(token=served_app.token(app='acme.net'), file='index.html', host=host)
    csp = csp_directives(resp.headers['content-security-policy'])
    assert csp['frame-ancestors'] == ["'none'"]
    assert csp['connect-src'] == ["'self'", *NET]


def test_t81_each_version_has_its_own_network(served_app):
    """T81: v1 and v2 of one app carry different lists; each response gets its own version's."""
    host = _add_net_app(served_app, 'acme.multi', 1, ['https://one.example.com'])
    served_app.registry.add('acme.multi', 2, org='acme-org', network=['https://two.example.com'])
    token = served_app.token(app='acme.multi', version=1)
    one = served_app.get_bundle(token=token, version=1, host=host)
    assert csp_directives(one.headers['content-security-policy'])['connect-src'] == [
        "'self'",
        'https://one.example.com',
    ]
    token2 = served_app.token(app='acme.multi', version=2)
    two = served_app.get_bundle(token=token2, version=2, host=host)
    assert csp_directives(two.headers['content-security-policy'])['connect-src'] == [
        "'self'",
        'https://two.example.com',
    ]


def test_t81_a_version_without_network_and_a_404_stay_on_the_base_policy(served_app):
    """T81 control: the default app has no network; a refused request carries no one's network."""
    base = _base_frame_csp(served_app)
    ok = served_app.get_bundle()
    assert {k: v for k, v in csp_directives(ok.headers['content-security-policy']).items()} == {
        k: v for k, v in base.items() if k != 'frame-ancestors'
    }
    host = _add_net_app(served_app)
    miss = served_app.get(f'/_t/{served_app.token(app="acme.net")}/v9/remoteEntry.js', host=host)
    assert miss.status_code == 404
    assert csp_directives(miss.headers['content-security-policy'])['connect-src'] == ["'self'"]


def test_t81_an_invalid_stored_network_is_dropped_not_served(served_app):
    """T81: the list is revalidated at serve time (the registry is not trusted): one bad entry drops it all."""
    host = _add_net_app(served_app, 'acme.badnet', 1, ['https://ok.example.com', 'http://evil.example'])
    resp = served_app.get_bundle(token=served_app.token(app='acme.badnet'), host=host)
    assert 'evil.example' not in resp.headers['content-security-policy']
    assert csp_directives(resp.headers['content-security-policy'])['connect-src'] == ["'self'"]


def test_t82_vary_merges_a_routes_value_with_service_worker(isolation_env, monkeypatch):
    """T82: a route's own ``Vary`` survives next to ``Service-Worker`` (the middleware used to overwrite it)."""
    from starlette.responses import Response

    host_mod = sup.load_module('ai.web.app_host')

    async def route(self, scope, headers, label, path):
        return Response('x', media_type='text/plain', headers={'Vary': 'Origin, Accept-Encoding'})

    monkeypatch.setattr(sup.need(host_mod, 'AppHostMiddleware'), '_serve', route)
    resp = _client(isolation_env).get('/anything', headers={'host': HOST})
    tokens = [t.strip().lower() for t in resp.headers['vary'].split(',') if t.strip()]
    assert {'service-worker', 'origin', 'accept-encoding'} <= set(tokens), resp.headers['vary']
    assert len(tokens) == len(set(tokens)), 'no token twice'


def test_t82_vary_star_and_absent_vary(isolation_env, monkeypatch):
    """T82: ``Vary: *`` stays ``*``; a route with no ``Vary`` still gets ``Service-Worker``; a route that already says it does not repeat it."""
    from starlette.responses import Response

    host_mod = sup.load_module('ai.web.app_host')
    cls = sup.need(host_mod, 'AppHostMiddleware')
    for given, check in (
        ('*', lambda toks: toks == ['*']),
        (None, lambda toks: toks == ['service-worker']),
        ('service-worker', lambda toks: toks == ['service-worker']),
        ('Service-Worker, Origin', lambda toks: sorted(toks) == ['origin', 'service-worker']),
    ):

        async def route(self, scope, headers, label, path, _given=given):
            return Response('x', media_type='text/plain', headers={'Vary': _given} if _given else {})

        monkeypatch.setattr(cls, '_serve', route)
        resp = _client(isolation_env).get('/anything', headers={'host': HOST})
        tokens = [t.strip().lower() for t in resp.headers['vary'].split(',') if t.strip()]
        assert check(tokens), (given, resp.headers['vary'])


def _chunk_names():
    return sorted(sup.GUEST_CHUNK_BODIES)


def test_t104_every_listed_chunk_is_served_with_its_type_and_an_immutable_cache(isolation_env):
    """T104: exact-name allowlist from ``runtime.json``: the bytes, the right type, cached forever."""
    client = _client(isolation_env)
    for name in _chunk_names():
        resp = client.get(f'/_rr/{name}', headers={'host': HOST})
        assert resp.status_code == 200, name
        assert resp.content == sup.GUEST_CHUNK_BODIES[name], name
        ext = name.rsplit('.', 1)[1]
        assert resp.headers['content-type'].split(';')[0] == sup.GUEST_CHUNK_TYPES[ext], name
        assert resp.headers['cache-control'] == 'public, max-age=31536000, immutable', name
        assert 'set-cookie' not in resp.headers


def test_t104_the_guest_bundle_keeps_working_beside_the_chunks(isolation_env):
    """T104 control: PR1's behaviour for the entry file is unchanged."""
    resp = _client(isolation_env).get('/_rr/guest-test.js', headers={'host': HOST})
    assert resp.status_code == 200 and 'immutable' in resp.headers['cache-control']


@pytest.mark.parametrize(
    'path',
    [
        '/_rr/guest-unlisted.js',  # exists on disk (see the fixture below), not in runtime.json
        '/_rr/guest-chunk.1a2b3c.js.map',
        '/_rr/guest-chunk.1a2b3c.JS',
        '/_rr/Guest-chunk.1a2b3c.js',
        '/_rr/guest-chunk.1a2b3c.js/',
        '/_rr/guest-%20.js',
        '/_rr/guest-a b.js',
        '/_rr/guest-.js',
        '/_rr/guest-..js',
        '/_rr/guest-x.exe',
        '/_rr/runtime.json',
        '/_rr/frame.html.bak',
        '/_rr/..%2fframe.html',
        '/_rr/../guest-chunk.1a2b3c.js',
        '/_rr/sub/guest-chunk.1a2b3c.js',
        '/_rr//guest-chunk.1a2b3c.js',
        '/_rr/guest-chunk.1a2b3c.js%00.png',
        '/_rr/guest-chunk.1a2b3c.js?x=../y',
    ],
)
def test_t104_anything_else_is_404(path, isolation_env):
    """T104: an unlisted name (even one on disk), a name outside the charset, ``../`` and a two-segment path are all 404."""
    (isolation_env.static / 'shell-guest' / 'guest-unlisted.js').write_text('/* on disk but not listed */')
    resp = _client(isolation_env).get(path, headers={'host': HOST})
    if path.endswith('?x=../y'):
        assert resp.status_code == 200  # a query never changes which file is served
    else:
        assert resp.status_code == 404, (path, resp.status_code)


def test_t104_chunks_are_app_host_only(isolation_env):
    """T104: on the shell host the guest chunks are as absent as the guest bundle is (H4)."""
    resp = _client(isolation_env).get(f'/_rr/{_chunk_names()[0]}', headers={'host': 'app.example'})
    assert resp.status_code == 404


def test_a_token_serves_only_the_deployment_it_was_minted_for(served_app):
    """A bound token whose version now resolves to another dist tree is the one 404."""
    ao = sup.load_module('ai.modules.shell.app_origin')
    dirs = asyncio.run(ao.token_version_dirs('u1', 'org-1', served_app.APP))
    real = dirs[1]
    mint = sup.need(ao, 'mint_frame_token')
    bound = mint(served_app.APP, 1, 'u1', 'org-1', config=served_app.config, dist_dir=real)
    elsewhere = mint(
        served_app.APP, 1, 'u1', 'org-1', config=served_app.config, dist_dir='orgs/other-org/files/apps/x/v1/dist'
    )
    assert served_app.get_bundle(token=bound).status_code == 200
    assert served_app.get_bundle(token=elsewhere).status_code == 404


def test_public_assets_are_revalidated_so_a_withdrawn_deployment_stops_loading(served_app):
    """``/_p`` answers ``private, no-cache`` with an ETag; revalidation re-resolves the version, so withdrawal is a 404."""
    import ai.modules.shell.shell as shell_mod

    path = '/_p/acme.thirdparty/v1/remoteEntry.js'
    first = served_app.get(path)
    assert first.status_code == 200
    assert first.headers['cache-control'] == 'private, no-cache'
    validator = first.headers['etag']
    again = served_app.get(path, headers={'if-none-match': validator})
    assert again.status_code == 304 and again.headers['etag'] == validator
    assert served_app.get(path, headers={'if-none-match': '"something-else"'}).status_code == 200

    served_app.registry.rows.clear()  # the deployment is withdrawn
    shell_mod.invalidate_app_serving(served_app.APP)
    assert served_app.get(path, headers={'if-none-match': validator}).status_code == 404
