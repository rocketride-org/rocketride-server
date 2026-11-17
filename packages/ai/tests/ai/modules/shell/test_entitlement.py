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

"""Entitlement re-check behind a frame token (#1022 PR1, design section 7).

Every ``/_t`` request verifies the token and then asks
``entitlement_ok(user_id, org_id, app_id, version)``: on SaaS it builds the
account with ``account_info_for(user_id, org_id)`` (``None`` denies) and checks
the version against ``entitled_version_dirs``; on OSS the check is skipped, as
``apps_static`` skips it. The verdict is cached by ``(app, user, org)`` for a
hard 60 s and dropped by ``invalidate_app_serving``.

Tests T26 and T27 of ``.rr-sec/PR1_PLAN.md``.
"""

from __future__ import annotations

import pytest

import ai.modules.shell.shell as shell_mod

from . import isolation_support as sup

APP = 'acme.teamapp'
DENIED = (401, 403, 404)


def _entitled():
    return sup.need(sup.load_module('ai.modules.shell.app_origin'), 'entitlement_ok')


@pytest.mark.asyncio
async def test_entitlement_removed_from_team_then_org(registry, clock):
    """T26: a team binding entitles ``u1``; removal shows after 60 s or at once on invalidation, org removal too."""
    registry.add(APP, 1, org='pub-org', audience=('team', 't1'), deploy_state='private')
    ok = _entitled()

    assert await ok('u1', 'org-1', APP, 1) is True
    calls = len(registry.account_info_calls)

    # removed from the team: the cached verdict still answers inside the 60 s window ...
    registry.membership['u1']['teams'] = []
    clock.advance(30)
    assert await ok('u1', 'org-1', APP, 1) is True
    assert len(registry.account_info_calls) == calls  # no new account lookup: it was the cache

    # ... and the hard TTL (never slid by use) ends it
    clock.advance(31)
    assert await ok('u1', 'org-1', APP, 1) is False

    # back in the team; invalidate_app_serving drops the cached denial immediately
    registry.membership['u1']['teams'] = ['t1']
    assert await ok('u1', 'org-1', APP, 1) is False  # still the cached denial
    shell_mod.invalidate_app_serving(APP)
    assert await ok('u1', 'org-1', APP, 1) is True

    # removed from the org: invalidation makes it visible at once
    registry.membership['u1'] = {'org': 'org-2', 'teams': []}
    shell_mod.invalidate_app_serving(APP)
    assert await ok('u1', 'org-1', APP, 1) is False  # account_info_for(u1, org-1) is None now


@pytest.mark.asyncio
async def test_entitlement_ttl_is_hard_not_sliding(registry, clock):
    """T26: use does not extend the verdict: a hot token cannot outlive a revocation by more than 60 s."""
    registry.add(APP, 1, org='pub-org', audience=('team', 't1'), deploy_state='private')
    ok = _entitled()
    assert await ok('u1', 'org-1', APP, 1) is True
    registry.membership['u1']['teams'] = []
    for _ in range(5):  # keep it hot: 5 hits spread over 50 s
        clock.advance(10)
        await ok('u1', 'org-1', APP, 1)
    clock.advance(11)  # 61 s after the first verdict
    assert await ok('u1', 'org-1', APP, 1) is False


@pytest.mark.asyncio
async def test_entitlement_is_per_version_and_per_app(registry, clock):
    """T26: the check is for the token's own version; another version or app is not entitled by it."""
    registry.add(APP, 1, org='pub-org', audience=('team', 't1'), deploy_state='private')
    ok = _entitled()
    assert await ok('u1', 'org-1', APP, 1) is True
    assert await ok('u1', 'org-1', APP, 2) is False
    assert await ok('u1', 'org-1', 'acme.nothere', 1) is False


@pytest.mark.asyncio
async def test_account_info_for_none_denies_on_saas(registry, clock):
    """T27: SaaS with an account that knows nobody (the base ``None``) serves nobody."""
    registry.add(APP, 1, org='pub-org', audience=('public', ''))  # even a PUBLIC app: the token needs a live account
    ok = _entitled()
    assert await ok('ghost', 'org-1', APP, 1) is False
    assert await ok('u1', 'wrong-org', APP, 1) is False
    assert await ok('u1', 'org-1', APP, 1) is True  # control: a real member passes


@pytest.mark.asyncio
async def test_account_base_defaults():
    """T27: the base account answers ``None`` for ``account_info_for`` (the OSS behaviour)."""
    from ai.account.base import AccountBase

    method = sup.need(AccountBase, 'account_info_for')
    assert await method(object(), 'u1', 'org-1') is None


@pytest.mark.asyncio
async def test_oss_skips_entitlement(registry, monkeypatch, clock):
    """T27: OSS serving is open: no account lookup, no registry walk, always true."""
    registry.install(monkeypatch, saas=False)
    ok = _entitled()
    assert await ok('anyone', 'local', 'acme.unpublished', 7) is True
    assert registry.account_info_calls == []


def test_oss_route_serves_a_token_without_an_account(served_app, monkeypatch):
    """T27: on OSS the token route serves a built version with no account at all (``open_version_dirs``)."""
    served_app.registry.add('acme.ossapp', 1, org='local')
    served_app.registry.install(monkeypatch, saas=False)
    resp = served_app.get_bundle(
        served_app.token(app='acme.ossapp', user='nobody', org='local'),
        host=sup.app_host_of(sup.label_for('acme.ossapp')),
    )
    assert resp.status_code == 200
    assert served_app.registry.account_info_calls == []


def test_saas_route_denies_a_token_whose_user_left(served_app):
    """T26/T27: the route applies the same check, so a valid token of a removed member stops serving."""
    served_app.registry.add(APP, 1, org='pub-org', audience=('team', 't1'), deploy_state='private')
    host = sup.app_host_of(sup.label_for(APP))
    token = served_app.token(app=APP)
    assert served_app.get_bundle(token, host=host).status_code == 200
    served_app.registry.membership['u1'] = {'org': 'org-2', 'teams': []}
    shell_mod.invalidate_app_serving(APP)
    assert served_app.get_bundle(token, host=host).status_code in DENIED
