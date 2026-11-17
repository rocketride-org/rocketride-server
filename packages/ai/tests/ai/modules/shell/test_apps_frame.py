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

"""``POST /apps/frame`` (#1022 PR1, design Appendix A) and the E8 main-origin refusal.

``POST /apps/frame {appId, version}`` (bearer optional) answers what the shell
needs to open an isolated app's frame::

    200 {v: 1, origin, entryPrefix, expiresAt (epoch ms), capabilities, network, state}
    400 bad_request | 401 invalid_token | 404 not_found | 409 isolation_off | 429 rate_limited

The route table is the REAL one: these tests mount what ``initModule``
registers, so a missing route is a behavioural failure (the base answers 405
from the ``/apps/{path}`` catch-all), not an import error.

Tests T28, T29, T30 and T35 of ``.rr-sec/PR1_PLAN.md``.
"""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

import ai.modules.shell.shell as shell_mod

from . import isolation_support as sup
from .isolation_support import label_for

THIRD = 'acme.thirdparty'
FIRST = 'rocketride.home'
BEARER = {'Authorization': 'Bearer good-token'}


class FrameWorld:
    """Registry with one app per situation, behind the shell module's real routes."""

    def __init__(self, env, reg, reads):
        self.env = env
        self.registry = reg
        self.reads = reads
        reg.add(THIRD, 1, org='acme-org')  # public, ready
        reg.add(FIRST, 1, org='platform-org', platform=True)  # first party
        reg.add('acme.teamonly', 1, org='acme-org', audience=('team', 't1'), deploy_state='private')
        reg.add('acme.submitted', 1, org='acme-org', audience=('team', 't1'), deploy_state='submit')
        reg.add('acme.inreview', 1, org='acme-org', audience=('public', ''), deploy_state='submit')
        self.client = TestClient(sup.shell_inner_app())

    def post(self, body=None, *, headers=None, raw=None):
        kwargs = {'headers': headers or {}}
        if raw is not None:
            kwargs['content'] = raw
        else:
            kwargs['json'] = body
        return self.client.post('/apps/frame', **kwargs)

    def frame(self, app_id, version=1, *, auth=True):
        return self.post({'appId': app_id, 'version': version}, headers=BEARER if auth else None)

    def config(self):
        return self.env.config()


@pytest.fixture
def world(isolation_env, registry, store_reads, clock):
    return FrameWorld(isolation_env, registry, store_reads)


def _ao():
    return sup.load_module('ai.modules.shell.app_origin')


# ---------------------------------------------------------------------------
# T28 every status of the contract
# ---------------------------------------------------------------------------


def test_apps_frame_200_contract(world):
    """T28: the 200 body of an isolated, ready, third-party app for a signed-in caller."""
    resp = world.frame(THIRD)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {'v', 'origin', 'entryPrefix', 'expiresAt', 'capabilities', 'network', 'state'}
    assert body['v'] == 1
    assert body['origin'] == f'https://{label_for(THIRD)}.apps.example'
    assert body['state'] == 'ready'
    assert body['network'] == []
    assert isinstance(body['capabilities'], list) and 'core' in body['capabilities']

    match = re.fullmatch(r'/_t/([^/]+)/v1/', body['entryPrefix'])
    assert match, body['entryPrefix']
    token = match.group(1)
    claims = sup.need(_ao(), 'verify_frame_token')(token, label_for(THIRD), config=world.config())
    assert (claims['a'], claims['v'], claims['u'], claims['o']) == (THIRD, 1, 'u1', 'org-1')
    assert body['expiresAt'] == claims['exp'] * 1000  # epoch ms
    # the token is a path segment on the app origin: never in the origin (the frame URL) or a query
    assert token not in body['origin'] and '?' not in body['origin'] and '#' not in body['origin']


def test_apps_frame_200_carries_the_manifest_network(world):
    """T28: ``network`` is the version's validated ``appManifest.network``."""
    world.registry.add(
        'acme.net', 1, org='acme-org', network=['https://api.example.com', 'https://cdn.example.org:8443']
    )
    body = world.frame('acme.net').json()
    assert body['network'] == ['https://api.example.com', 'https://cdn.example.org:8443']


@pytest.mark.parametrize(
    'body',
    [
        {},
        {'appId': THIRD},
        {'version': 1},
        {'appId': '', 'version': 1},
        {'appId': 'a' * 129, 'version': 1},
        {'appId': '../etc/passwd', 'version': 1},
        {'appId': 'acme thirdparty', 'version': 1},
        {'appId': 'acme/thirdparty', 'version': 1},
        {'appId': 5, 'version': 1},
        {'appId': THIRD, 'version': 0},
        {'appId': THIRD, 'version': -1},
        {'appId': THIRD, 'version': '1'},
        {'appId': THIRD, 'version': 1.5},
        {'appId': THIRD, 'version': True},
        {'appId': THIRD, 'version': None},
        [],
        'x',
    ],
)
def test_apps_frame_400_bad_body(body, world):
    """T28: a malformed body is 400 ``bad_request`` (appId segment grammar, at most 128 chars; version an int >= 1)."""
    resp = world.post(body)
    assert resp.status_code == 400, (body, resp.text)
    assert 'bad_request' in resp.text


def test_apps_frame_400_not_json(world):
    """T28: an unparseable body is a 400, never a 500."""
    assert world.post(raw=b'not json {', headers={'content-type': 'application/json'}).status_code == 400
    assert world.post(raw=b'', headers={'content-type': 'application/json'}).status_code == 400


def test_apps_frame_401_invalid_bearer(world):
    """T28: a bearer that is present but invalid is 401 ``invalid_token``, even for a public app."""
    resp = world.post({'appId': THIRD, 'version': 1}, headers={'Authorization': 'Bearer nope'})
    assert resp.status_code == 401
    assert 'invalid_token' in resp.text


def test_apps_frame_404_is_one_answer(world):
    """T28: unknown app, unknown version, not entitled, first party, wrong audience: the same 404, byte for byte."""
    cases = [
        ('acme.nothere', 1),  # no such app
        (THIRD, 99),  # no such version
        (FIRST, 1),  # not isolated (first party)
        ('acme.inreview', 1),  # public binding still in review
    ]
    answers = set()
    for app_id, version in cases:
        resp = world.frame(app_id, version)
        assert resp.status_code == 404, (app_id, version)
        assert 'not_found' in resp.text
        answers.add((resp.text, resp.headers['content-type']))
    assert len(answers) == 1, answers  # no oracle: every cause looks identical


def test_apps_frame_409_when_isolation_is_off(world):
    """T28: under ``off`` the route exists and says so (the shell must never get a frame it cannot use)."""
    world.env.set(RR_APP_ISOLATION=None)
    resp = world.frame(THIRD)
    assert resp.status_code == 409
    assert 'isolation_off' in resp.text


def test_apps_frame_429_rate_limited(world, clock):
    """T28: a client that hammers the route is limited per caller, and recovers after the window."""
    statuses = [world.frame(THIRD).status_code for _ in range(400)]
    assert statuses[0] == 200
    assert 429 in statuses, 'no rate limit within 400 requests in one instant'
    first_429 = statuses.index(429)
    assert set(statuses[first_429:]) == {429}  # once limited it stays limited inside the window
    limited = world.frame(THIRD)
    assert limited.status_code == 429 and 'rate_limited' in limited.text
    clock.advance(3600)
    assert world.frame(THIRD).status_code == 200


def test_apps_frame_rate_limit_is_not_shared_between_callers(world, clock):
    """T28: one caller's burst does not lock another one out."""
    world.registry.tokens['other-token'] = 'u2'
    world.registry.membership['u2'] = {'org': 'org-1', 'teams': []}
    for _ in range(400):
        world.frame(THIRD)
    resp = world.post({'appId': THIRD, 'version': 1}, headers={'Authorization': 'Bearer other-token'})
    assert resp.status_code == 200


def test_apps_frame_optin_isolates_only_listed_apps(world):
    """T28: under ``optin`` an unlisted third-party app is not isolated (404); a listed one is."""
    world.env.set(RR_APP_ISOLATION='optin', RR_APP_ISOLATION_APPS='acme.net')
    world.registry.add('acme.net', 1, org='acme-org')
    assert world.frame('acme.net').status_code == 200
    assert world.frame(THIRD).status_code == 404


def test_apps_frame_verdict_is_cached_60s_and_invalidated(world, clock):
    """T28: the per-(app, caller) verdict is cached for 60 s and dropped by ``invalidate_app_serving``."""
    assert world.frame(THIRD).status_code == 200
    world.registry.first_party.add((THIRD, 'acme-org'))  # the platform adopts the app: no longer isolated
    clock.advance(30)
    assert world.frame(THIRD).status_code == 200  # cached
    shell_mod.invalidate_app_serving(THIRD)
    assert world.frame(THIRD).status_code == 404


# ---------------------------------------------------------------------------
# T29 anonymous callers
# ---------------------------------------------------------------------------


def test_apps_frame_anonymous_public_only(world):
    """T29: no bearer: a public READY version gets a ``/_p/`` prefix; nothing internal or in review."""
    resp = world.frame(THIRD, auth=False)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body['entryPrefix'] == f'/_p/{THIRD}/v1/'
    assert body['state'] == 'ready'
    assert body['origin'] == f'https://{label_for(THIRD)}.apps.example'
    assert world.registry.account_info_calls == []  # no identity was involved

    for app_id in ('acme.teamonly', 'acme.submitted', 'acme.inreview', FIRST, 'acme.nothere'):
        resp = world.frame(app_id, auth=False)
        assert resp.status_code == 404, app_id


def test_apps_frame_anonymous_does_not_get_a_user_token(world):
    """T29: an anonymous answer never contains a token path."""
    body = world.frame(THIRD, auth=False).json()
    assert '/_t/' not in body['entryPrefix']


# ---------------------------------------------------------------------------
# T30 the grant
# ---------------------------------------------------------------------------


def _caps(world, app_id, auth=True):
    resp = world.frame(app_id, auth=auth)
    assert resp.status_code == 200, (app_id, resp.text)
    return sorted(resp.json()['capabilities']), resp.json()['state']


def test_grant_ready_uses_approved_set_else_core(world):
    """T30: a ready version gets its stored ``approvedCapabilities``; none stored means ``["core"]``."""
    world.registry.add('acme.granted', 1, org='acme-org', approved=['core', 'pipelines.run', 'fs.app'])
    world.registry.add('acme.ungranted', 1, org='acme-org')
    assert _caps(world, 'acme.granted') == (['core', 'fs.app', 'pipelines.run'], 'ready')
    assert _caps(world, 'acme.ungranted') == (['core'], 'ready')
    # the same for an anonymous caller of a public ready version
    assert _caps(world, 'acme.granted', auth=False) == (['core', 'fs.app', 'pipelines.run'], 'ready')
    assert _caps(world, THIRD) == (['core'], 'ready')


def test_grant_internal_and_submit_are_core_only(world):
    """T30: internal (team/user) and ``submit`` versions get ``["core"]`` whatever was stored on them."""
    world.registry.add(
        'acme.internalgrant',
        1,
        org='acme-org',
        audience=('team', 't1'),
        deploy_state='private',
        approved=['core', 'pipelines.run'],
    )
    world.registry.add(
        'acme.submitgrant',
        1,
        org='acme-org',
        audience=('team', 't1'),
        deploy_state='submit',
        approved=['core', 'fs.app'],
    )
    assert _caps(world, 'acme.internalgrant') == (['core'], 'internal')
    assert _caps(world, 'acme.submitgrant') == (['core'], 'submit')
    assert _caps(world, 'acme.teamonly') == (['core'], 'internal')
    assert _caps(world, 'acme.submitted') == (['core'], 'submit')


@pytest.mark.asyncio
async def test_account_base_approved_capabilities_reader():
    """T30: the base reader returns the stored list, ``["core"]`` for missing, garbage or unknown names."""
    from ai.account.base import AccountBase

    reader = sup.need(AccountBase, 'approved_capabilities')

    class Fake:
        def __init__(self, metadata):
            self.metadata = metadata

        async def deployments_versions(self, org_id, app_id):
            return [{'version': 1, 'metadata': self.metadata}]

        async def deployments_artifact(self, org_id, app_id, version):
            return {'kind': 'app', 'metadata': self.metadata}

    assert await reader(Fake({'approvedCapabilities': ['core', 'fs.app']}), 'o', 'a', 1) == ['core', 'fs.app']
    assert await reader(Fake({}), 'o', 'a', 1) == ['core']
    assert await reader(Fake({'approvedCapabilities': 'fs.app'}), 'o', 'a', 1) == ['core']
    assert await reader(Fake({'approvedCapabilities': ['core', {'x': 1}]}), 'o', 'a', 1) == ['core']
    assert await reader(Fake({}), 'o', 'a', 9) == ['core']  # a version that is not on the rail


def test_account_base_has_the_capability_writer():
    """T30: ``set_approved_capabilities(org, app, version, caps, actor)`` exists on the base account (a coroutine)."""
    import inspect

    from ai.account.base import AccountBase

    writer = sup.need(AccountBase, 'set_approved_capabilities')
    assert inspect.iscoroutinefunction(writer)
    assert list(inspect.signature(writer).parameters)[1:] == ['org_id', 'app_id', 'version', 'caps', 'actor']


# ---------------------------------------------------------------------------
# T35 E8: the main origin never serves an isolated app's dist
# ---------------------------------------------------------------------------

COOKIE = {'cookie': 'rr_apps_token=good-token'}


@pytest.mark.parametrize(
    'file',
    ['remoteEntry.js', 'static/js/main.abc123.js', 'index.html', 'mf-manifest.json', 'main.css', 'x.mjs', 'x.js.map'],
)
@pytest.mark.parametrize(
    'headers', [{}, COOKIE, {**COOKIE, 'origin': 'https://app.example', 'sec-fetch-dest': 'script'}]
)
def test_e8_404_isolated_any_client(file, headers, world):
    """T35 (behavioural): the main origin answers 404 for an isolated third-party dist, for ANY client.

    Today ``_serve_versioned`` streams the third-party ``remoteEntry.js`` with 200
    and an old shell (or a stale tab) would run it in the shell realm.
    """
    resp = world.client.get(f'/apps/{THIRD}/v1/{file}', headers=headers)
    assert resp.status_code == 404, (file, headers)
    assert world.reads == [], 'the bytes must not even be read from the store'


def test_e8_first_party_still_served(world):
    """T35: a first-party app (not isolated) keeps serving from the main origin."""
    resp = world.client.get(f'/apps/{FIRST}/v1/remoteEntry.js', headers=COOKIE)
    assert resp.status_code == 200
    assert resp.text.startswith('// bundle ')


def test_e8_unlisted_app_under_optin_is_still_served(world):
    """T35: under ``optin`` only the listed apps lose main-origin serving."""
    world.env.set(RR_APP_ISOLATION='optin', RR_APP_ISOLATION_APPS='acme.net')
    world.registry.add('acme.net', 1, org='acme-org')
    assert world.client.get(f'/apps/{THIRD}/v1/remoteEntry.js', headers=COOKIE).status_code == 200
    assert world.client.get('/apps/acme.net/v1/remoteEntry.js', headers=COOKIE).status_code == 404


def test_e8_refusal_is_not_an_existence_oracle(world):
    """T35: the refusal adds no oracle: an isolated version and a version that does not exist answer the same."""
    same = world.client.get(f'/apps/{THIRD}/v1/remoteEntry.js', headers=COOKIE)
    other = world.client.get(f'/apps/{THIRD}/v77/remoteEntry.js', headers=COOKIE)
    assert same.status_code == other.status_code == 404
    assert same.text == other.text


def test_e8_isolated_icon_is_not_a_script_vector(world):
    """T35: an isolated app's versioned icon may still feed an ``<img>`` but must not be a navigable script on the shell origin.

    Either 404, or served with a policy that neutralises script inside an SVG
    opened as a document (``sandbox`` or ``default-src 'none'``) plus nosniff.
    """
    resp = world.client.get(f'/apps/{THIRD}/v1/icon.svg', headers=COOKIE)
    if resp.status_code == 200:
        csp = resp.headers.get('content-security-policy', '')
        assert 'sandbox' in csp or "default-src 'none'" in csp
        assert resp.headers.get('x-content-type-options') == 'nosniff'
    else:
        assert resp.status_code == 404
