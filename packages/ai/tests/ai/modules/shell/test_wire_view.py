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

"""The wire view of the app list (#1022 PR1, design section 1 and 9).

One isolation decision is stamped on each entry (``isolated``, ``firstParty``)
where the binding org is known (``resolve_app_pins``); the binding org itself
never leaves it. ``wire_view(entries, shell_caps)`` is applied at the four
points an app list reaches a client (probe reply, connect reply, account push,
manifest push): for an isolated entry, when ``"appIsolation:1"`` is not among
the client's ``shellCaps``, it drops ``registryVersion`` and ``entry`` so an
old shell shows no broken tile. It works on a copy and is idempotent.

Tests T31 (model part), T32, T33 and T34 of ``.rr-sec/PR1_PLAN.md``.
"""

from __future__ import annotations

import copy
import json

import pytest

from . import isolation_support as sup
from .isolation_support import app_entry, by_id, stamped_apps

CAP = 'appIsolation:1'
LOAD_FIELDS = ('registryVersion', 'entry')


def _wire_view():
    return sup.need(sup.load_module('ai.modules.shell.app_origin'), 'wire_view')


def _assert_old_shell_view(apps):
    """An isolated entry lost its load fields; every other entry is untouched."""
    entries = by_id(apps)
    iso = entries['acme.thirdparty']
    for field in LOAD_FIELDS:
        assert field not in iso, field
    assert iso['id'] == 'acme.thirdparty' and iso['name'] == 'acme.thirdparty'  # still listed
    assert iso.get('isolated') is True
    for untouched in ('rocketride.home', 'acme.plain'):
        for field in LOAD_FIELDS:
            assert field in entries[untouched], (untouched, field)


def _assert_new_shell_view(apps):
    entries = by_id(apps)
    for app_id in entries:
        for field in LOAD_FIELDS:
            assert field in entries[app_id], (app_id, field)


# ---------------------------------------------------------------------------
# wire_view as a function
# ---------------------------------------------------------------------------


def test_wire_view_old_shell_drops_load_fields(isolation_env):
    """T33 (unit): without the cap an isolated entry loses ``registryVersion`` and ``entry``; others keep them."""
    wire_view = _wire_view()
    apps = stamped_apps()
    original = copy.deepcopy(apps)
    out = wire_view(apps, ())
    _assert_old_shell_view(out)
    assert apps == original  # the input (the stored account info) is never mutated
    assert all(a is not b for a, b in zip(out, apps))  # entries are copies


@pytest.mark.parametrize('caps', [None, (), [], ('other:1',), ['appisolation:1'], ['appIsolation:2']])
def test_wire_view_needs_exactly_the_cap(caps, isolation_env):
    """T33: only the exact ``appIsolation:1`` string counts as the cap."""
    _assert_old_shell_view(_wire_view()(stamped_apps(), caps))


@pytest.mark.parametrize('caps', [(CAP,), [CAP], ('x:1', CAP)])
def test_wire_view_new_shell_gets_everything(caps, isolation_env):
    """T33: with the cap the entries are served whole, stamp included."""
    apps = stamped_apps()
    out = _wire_view()(apps, caps)
    assert out == apps
    _assert_new_shell_view(out)


def test_wire_view_is_idempotent(isolation_env):
    """T33: applying it twice (a push built from an already-viewed list) changes nothing more."""
    wire_view = _wire_view()
    once = wire_view(stamped_apps(), ())
    assert wire_view(once, ()) == once
    full = wire_view(stamped_apps(), (CAP,))
    assert wire_view(full, (CAP,)) == full


def test_wire_view_leaves_unstamped_lists_alone(isolation_env):
    """T33: entries with no stamp (dev overlay, older producers) are never touched."""
    apps = [app_entry('acme.dev', dev=True), app_entry('acme.plain')]
    assert _wire_view()(apps, ()) == apps


# ---------------------------------------------------------------------------
# the four serialisation points
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_probe_without_shell_caps_drops_load_fields(isolation_env):
    """T33: the probe reply (``arguments.shellCaps``) serves the old-shell view when the cap is absent."""
    _assert_old_shell_view((await sup.probe_body(stamped_apps()))['apps'])
    _assert_old_shell_view((await sup.probe_body(stamped_apps(), []))['apps'])
    _assert_new_shell_view((await sup.probe_body(stamped_apps(), [CAP]))['apps'])


@pytest.mark.asyncio
async def test_connect_without_shell_caps_drops_load_fields(isolation_env):
    """T33: the connect reply (``auth`` arguments) likewise."""
    _, response = await sup.connect(stamped_apps())
    _assert_old_shell_view(response['body']['apps'])
    _, response = await sup.connect(stamped_apps(), {'shellCaps': [CAP]})
    _assert_new_shell_view(response['body']['apps'])


@pytest.mark.asyncio
async def test_push_without_shell_caps_drops_load_fields_on_a_copy(isolation_env, monkeypatch):
    """T33: the account push uses the caps stored on the connection and never edits the stored account."""
    body, stored = await sup.pushed_account(stamped_apps(), monkeypatch, shell_caps=())
    _assert_old_shell_view(body['apps'])
    _assert_new_shell_view(stored.apps)  # the AccountInfo the connection keeps still has every field
    body, _ = await sup.pushed_account(stamped_apps(), monkeypatch, shell_caps=(CAP,))
    _assert_new_shell_view(body['apps'])


@pytest.mark.asyncio
async def test_manifest_push_without_shell_caps_drops_load_fields(isolation_env, monkeypatch):
    """T33: ``manifest_push`` (OSS branch) too."""
    _assert_old_shell_view((await sup.manifest_pushed_account(stamped_apps(), monkeypatch))['apps'])
    _assert_new_shell_view((await sup.manifest_pushed_account(stamped_apps(), monkeypatch, (CAP,)))['apps'])


def test_account_info_keeps_the_isolation_stamp():
    """T31 (model): ``AccountInfo.apps`` is validated against ``AppManifestEntry``; the stamp must survive it.

    Today the TypedDict does not declare ``isolated`` / ``firstParty``, so
    pydantic drops them and no connect or push could ever carry them.
    """
    from ai.account.models import AccountInfo

    info = AccountInfo(userId='u1', apps=stamped_apps())
    for result in (info.to_connect_result(), info.to_push_result()):
        entries = by_id(result['apps'])
        assert entries['acme.thirdparty']['isolated'] is True
        assert entries['acme.thirdparty']['firstParty'] is False
        assert entries['rocketride.home']['firstParty'] is True


# ---------------------------------------------------------------------------
# T32 the binding org never reaches the wire (guard)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['off', 'enforce'])
async def test_binding_org_never_on_the_wire(mode, isolation_env, registry, monkeypatch):
    """T32 (guard): no entry, in any mode, names the binding org: not as ``bindingOrgId``, not as a value."""
    from ai.account.app_deploy import resolve_app_pins

    if mode == 'off':
        isolation_env.set(RR_APP_ISOLATION=None)
    registry.add('acme.thirdparty', 1, org='bind-org-aaa')
    registry.add('rocketride.home', 1, org='bind-org-bbb', platform=True)
    registry.add('acme.teamapp', 1, org='bind-org-ccc', audience=('team', 't1'), deploy_state='private')

    entries = await resolve_app_pins('org-1', 'u1', ['t1'])
    assert {e['id'] for e in entries} == {'acme.thirdparty', 'rocketride.home', 'acme.teamapp'}

    surfaces = {
        'resolve_app_pins': entries,
        'probe': (await sup.probe_body(entries, [CAP]))['apps'],
        'connect': (await sup.connect(entries, {'shellCaps': [CAP]}))[1]['body']['apps'],
        'push': (await sup.pushed_account(entries, monkeypatch, (CAP,)))[0]['apps'],
        'manifest_push': (await sup.manifest_pushed_account(entries, monkeypatch, (CAP,)))['apps'],
    }
    for name, apps in surfaces.items():
        dumped = json.dumps(apps)
        assert 'bindingOrgId' not in dumped and 'binding_org' not in dumped, name
        for org in ('bind-org-aaa', 'bind-org-bbb', 'bind-org-ccc'):
            assert org not in dumped, (name, org)


# ---------------------------------------------------------------------------
# T34 on_auth
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_auth_ignores_unknown_keys():
    """T34 (guard part): ``auth`` reads only the keys it knows, so a newer shell's extra keys do no harm."""
    conn, response = await sup.connect(
        [], {'shellCaps': [CAP], 'somethingNew': {'a': 1}, 'clientName': 'rocketride-web', 'clientVersion': '9.9.9'}
    )
    assert conn._authenticated is True
    assert response['body']['userId'] == 'u1'
    assert conn._client_info == {'name': 'rocketride-web', 'version': '9.9.9'}


@pytest.mark.asyncio
async def test_on_auth_stores_shell_caps():
    """T34: ``shellCaps`` (strings only, at most 8) are kept on the connection for the pushes that follow."""
    conn, _ = await sup.connect([], {'shellCaps': [CAP, 'b:1']})
    assert tuple(conn._shell_caps) == (CAP, 'b:1')


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'sent,expected',
    [
        (None, ()),
        ([], ()),
        (CAP, ()),  # a bare string is not a list of caps: never iterate its characters
        ({'k': CAP}, ()),
        ([CAP, 5, None, {'x': 1}, 'ok:2'], (CAP, 'ok:2')),  # strings only
        ([f'c:{i}' for i in range(12)], tuple(f'c:{i}' for i in range(8))),  # at most 8
    ],
)
async def test_on_auth_shell_caps_are_sanitised(sent, expected):
    """T34: whatever the client sends, the stored caps are a tuple of at most 8 strings."""
    args = {} if sent is None else {'shellCaps': sent}
    conn, _ = await sup.connect([], args)
    assert tuple(conn._shell_caps) == expected


@pytest.mark.asyncio
async def test_probe_ignores_unknown_arguments_and_bad_shell_caps(isolation_env):
    """T34: the probe is tolerant too: unknown arguments and malformed ``shellCaps`` give the old-shell view."""
    body = await sup.probe_body(stamped_apps(), 'appIsolation:1')  # a bare string, not a list
    _assert_old_shell_view(body['apps'])
    body = await sup.probe_body(stamped_apps(), [5, None, {'x': 1}])
    _assert_old_shell_view(body['apps'])


# ---------------------------------------------------------------------------
# T33b the catalog surfaces (G4 S5): rrext_app list/get and rrext_public_catalog
# ---------------------------------------------------------------------------


def _catalog_account():
    from types import SimpleNamespace

    async def apps(*args, **kwargs):
        return stamped_apps()

    return SimpleNamespace(get_apps_for_user=apps, get_public_apps=apps)


def _catalog_conn(shell_caps, signed_in=True):
    from types import SimpleNamespace
    from unittest.mock import MagicMock

    conn = SimpleNamespace(
        _account_info=SimpleNamespace(userId='u1', organization={'id': 'local'}) if signed_in else None,
        _shell_caps=tuple(shell_caps),
    )
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'body': body})
    conn.build_error = MagicMock(side_effect=lambda req, msg: {'error': msg})
    return conn


@pytest.mark.asyncio
@pytest.mark.parametrize('signed_in', [True, False])
async def test_rrext_app_list_and_get_apply_the_wire_view(signed_in, isolation_env):
    """T33b: the base account's ``rrext_app`` list/get serve the old-shell view without the cap."""
    from ai.account.base import AccountBase

    acct = _catalog_account()
    for caps, check in (((), _assert_old_shell_view), ((CAP,), _assert_new_shell_view)):
        conn = _catalog_conn(caps, signed_in)
        listed = await AccountBase.handle_app(acct, conn, {'command': 'rrext_app', 'arguments': {'subcommand': 'list'}})
        check(listed['body']['apps'])
        got = await AccountBase.handle_app(
            acct, conn, {'command': 'rrext_app', 'arguments': {'subcommand': 'get', 'appId': 'acme.thirdparty'}}
        )
        check([got['body']['app'], *[a for a in stamped_apps() if a['id'] != 'acme.thirdparty']])


@pytest.mark.asyncio
async def test_public_catalog_applies_the_wire_view(isolation_env):
    """T33b: the base account's ``rrext_public_catalog`` too."""
    from ai.account.base import AccountBase

    acct = _catalog_account()
    body = (await AccountBase.handle_public(acct, _catalog_conn((), False), {'arguments': {}}))['body']
    _assert_old_shell_view(body['apps'])
    body = (await AccountBase.handle_public(acct, _catalog_conn((CAP,), False), {'arguments': {}}))['body']
    _assert_new_shell_view(body['apps'])


@pytest.mark.asyncio
async def test_catalog_surfaces_unchanged_under_off(isolation_env):
    """T33b/T40: under off the catalog answers are the plain lists."""
    from ai.account.base import AccountBase

    isolation_env.set(RR_APP_ISOLATION=None)
    acct = _catalog_account()
    conn = _catalog_conn(())
    listed = await AccountBase.handle_app(acct, conn, {'command': 'rrext_app', 'arguments': {'subcommand': 'list'}})
    expected = stamped_apps()
    for entry in expected:
        entry.update({'appStatus': 'free', 'onDesktop': True})
    assert listed['body']['apps'] == expected
    assert (await AccountBase.handle_public(acct, conn, {'arguments': {}}))['body']['apps'] == stamped_apps()
