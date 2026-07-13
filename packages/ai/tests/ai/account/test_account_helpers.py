"""
Unit tests for small ai.account helpers.

Covers three files that are too small for their own test modules:

- ``ai/account/base.py`` — ``AccountBase.generate_token`` (deterministic
  SHA-256 token derivation), ``init_account`` no-op, and the OSS defaults
  that raise NotImplementedError for SaaS-only operations.
- ``ai/account/report.py`` — the ``Reporter`` class: ``LS_REPORT`` env
  toggles real HTTP POSTs vs. silent no-op; exceptions are swallowed.
- ``ai/account/keystore.py`` — in-memory token map: reserve, map_to_node,
  add_token, remove_token, get_tokens with ownership checks.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from ai.account.base import AccountBase
from ai.account.keystore import KeyStore
from ai.account.models import RequestContext
from ai.account.report import Reporter


# ---------------------------------------------------------------------------
# AccountBase
# ---------------------------------------------------------------------------


class _ConcreteAccount(AccountBase):
    """Minimal subclass so AccountBase becomes instantiable for tests."""

    async def authenticate(self, credential: str):
        """No-op authenticate so the ABC contract is satisfied."""
        return None


def test_generate_token_is_deterministic_for_same_content():
    """The same content dict + same prefix always yields the same token."""
    acct = _ConcreteAccount()
    t1 = acct.generate_token({'a': 1, 'b': 2}, prefix='tk_')
    t2 = acct.generate_token({'b': 2, 'a': 1}, prefix='tk_')  # different order
    assert t1 == t2
    assert t1.startswith('tk_')
    # Token body is exactly 32 hex chars.
    assert len(t1) == len('tk_') + 32


def test_generate_token_differs_for_different_content():
    """Distinct content dicts produce distinct tokens."""
    acct = _ConcreteAccount()
    a = acct.generate_token({'k': 'v1'})
    b = acct.generate_token({'k': 'v2'})
    assert a != b


def test_generate_token_default_prefix_is_empty():
    """Without an explicit prefix, the token is just the 32-char hex digest."""
    acct = _ConcreteAccount()
    t = acct.generate_token({'k': 'v'})
    assert len(t) == 32
    assert all(c in '0123456789abcdef' for c in t)


@pytest.mark.asyncio
async def test_init_account_is_a_no_op_in_oss():
    """init_account in the base class does nothing and returns None."""
    acct = _ConcreteAccount()
    server = MagicMock()
    assert await acct.init_account(server) is None


@pytest.mark.asyncio
async def test_handle_account_raises_not_implemented_in_oss():
    """OSS deployments do not implement account management."""
    acct = _ConcreteAccount()
    with pytest.raises(NotImplementedError, match='Account management requires SaaS'):
        await acct.handle_account(MagicMock(), {}, RequestContext())


@pytest.mark.asyncio
async def test_handle_app_raises_not_implemented_in_oss():
    """OSS deployments do not implement the app marketplace."""
    acct = _ConcreteAccount()
    with pytest.raises(NotImplementedError, match='App marketplace requires SaaS'):
        await acct.handle_app(MagicMock(), {}, RequestContext())


# ---------------------------------------------------------------------------
# Reporter
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reporter_is_noop_when_ls_report_unset(monkeypatch):
    """Without ``LS_REPORT`` in the environment, ``report`` does nothing."""
    monkeypatch.delenv('LS_REPORT', raising=False)
    r = Reporter()
    # No exception, no return value. Nothing to assert beyond not raising.
    await r.report(apikey='ak_1', token='tk_1', metrics={'rows': 1})


@pytest.mark.asyncio
async def test_reporter_posts_to_endpoint_when_configured(monkeypatch):
    """With ``LS_REPORT`` set, ``report`` issues a POST to that URL."""
    monkeypatch.setenv('LS_REPORT', 'http://license.example.com/report')

    from ai.account import report as report_mod

    captured = {}

    def _fake_post(url, json=None):
        """Capture the POST call so the test can inspect it."""
        captured['url'] = url
        captured['json'] = json
        return MagicMock()

    monkeypatch.setattr(report_mod.requests, 'post', _fake_post)

    r = Reporter()
    await r.report(apikey='ak_1', token='tk_1', metrics={'rows': 7})

    assert captured['url'] == 'http://license.example.com/report'
    assert captured['json'] == {
        'apikey': 'ak_1',
        'token': 'tk_1',
        'metrics': {'rows': 7},
    }


@pytest.mark.asyncio
async def test_reporter_swallows_post_failures(monkeypatch):
    """Any exception from ``requests.post`` is caught — report never raises."""
    monkeypatch.setenv('LS_REPORT', 'http://license.example.com/report')
    from ai.account import report as report_mod

    monkeypatch.setattr(
        report_mod.requests,
        'post',
        MagicMock(side_effect=ConnectionError('network down')),
    )

    r = Reporter()
    # The call returns normally despite the underlying ConnectionError.
    await r.report(apikey='ak_1', token='tk_1', metrics={})


# ---------------------------------------------------------------------------
# KeyStore — reserve / add / remove / get / map
# ---------------------------------------------------------------------------


def test_keystore_default_token_map_is_empty():
    """A fresh KeyStore has an empty token map and an optional config dict."""
    ks = KeyStore()
    assert ks.token_map == {}
    assert ks.config == {}


def test_keystore_uses_supplied_config_dict():
    """The constructor stores a caller-supplied config dict verbatim."""
    cfg = {'region': 'eu-west-1'}
    ks = KeyStore(config=cfg)
    assert ks.config is cfg


@pytest.mark.asyncio
async def test_reserve_token_records_apikey_and_name():
    """``reserve_token`` stores the apikey + name with empty pool/endpoint."""
    ks = KeyStore()
    await ks.reserve_token('ak_1', 'tk_x', 'first-task')
    assert ks.token_map['tk_x'] == ('ak_1', 'first-task', '', '')


@pytest.mark.asyncio
async def test_reserve_token_rejects_duplicates():
    """Reserving an already-in-use token raises ValueError."""
    ks = KeyStore()
    await ks.reserve_token('ak_1', 'tk_x', 'first')
    with pytest.raises(ValueError, match='already in use'):
        await ks.reserve_token('ak_1', 'tk_x', 'second')


@pytest.mark.asyncio
async def test_add_token_overwrites_with_routing_info():
    """``add_token`` upgrades a reserved entry with pool + endpoint."""
    ks = KeyStore()
    await ks.reserve_token('ak_1', 'tk_x', 'name')
    await ks.add_token('ak_1', 'tk_x', 'name', 'gpu', 'ws://node:5566/svc')
    assert ks.token_map['tk_x'] == ('ak_1', 'name', 'gpu', 'ws://node:5566/svc')


@pytest.mark.asyncio
async def test_remove_token_drops_owned_entry():
    """``remove_token`` removes the entry when the apikey matches."""
    ks = KeyStore()
    await ks.reserve_token('ak_1', 'tk_x', 'name')
    await ks.remove_token('ak_1', 'tk_x')
    assert 'tk_x' not in ks.token_map


@pytest.mark.asyncio
async def test_remove_token_unknown_is_silent():
    """Removing a token that was never reserved is a no-op (no exception)."""
    ks = KeyStore()
    await ks.remove_token('ak_1', 'tk_does-not-exist')  # must not raise


@pytest.mark.asyncio
async def test_remove_token_wrong_owner_raises():
    """An apikey mismatch on remove raises ValueError."""
    ks = KeyStore()
    await ks.reserve_token('ak_1', 'tk_x', 'name')
    with pytest.raises(ValueError, match='not valid'):
        await ks.remove_token('ak_intruder', 'tk_x')


@pytest.mark.asyncio
async def test_map_to_node_unknown_token_raises():
    """``map_to_node`` for an unreserved token raises ValueError."""
    ks = KeyStore()
    with pytest.raises(ValueError, match='not valid'):
        await ks.map_to_node('ak_1', 'tk_none')


@pytest.mark.asyncio
async def test_map_to_node_reserved_but_inactive_raises():
    """A reserved-but-never-activated token raises a different ValueError."""
    ks = KeyStore()
    await ks.reserve_token('ak_1', 'tk_x', 'name')
    with pytest.raises(ValueError, match='not active'):
        await ks.map_to_node('ak_1', 'tk_x')


@pytest.mark.asyncio
async def test_map_to_node_wrong_apikey_raises():
    """A token owned by a different apikey raises ValueError."""
    ks = KeyStore()
    await ks.add_token('ak_owner', 'tk_x', 'name', 'gpu', 'ws://x:5566')
    with pytest.raises(ValueError, match='not valid'):
        await ks.map_to_node('ak_other', 'tk_x')


@pytest.mark.asyncio
async def test_map_to_node_happy_path_returns_pool_and_endpoint():
    """Owner + active token returns (pool, endpoint) tuple."""
    ks = KeyStore()
    await ks.add_token('ak_1', 'tk_x', 'name', 'gpu', 'ws://node:5566/svc')
    pool, endpoint = await ks.map_to_node('ak_1', 'tk_x')
    assert pool == 'gpu'
    assert endpoint == 'ws://node:5566/svc'


@pytest.mark.asyncio
async def test_get_tokens_filters_by_apikey():
    """``get_tokens`` returns only the tokens owned by the supplied apikey."""
    ks = KeyStore()
    await ks.reserve_token('ak_1', 'tk_a', 'one')
    await ks.reserve_token('ak_1', 'tk_b', 'two')
    await ks.reserve_token('ak_2', 'tk_c', 'three')

    owned = set(await ks.get_tokens('ak_1'))
    other = set(await ks.get_tokens('ak_2'))
    assert owned == {'tk_a', 'tk_b'}
    assert other == {'tk_c'}


@pytest.mark.asyncio
async def test_get_tokens_unknown_apikey_returns_empty():
    """An apikey with no reserved tokens yields an empty list."""
    ks = KeyStore()
    assert await ks.get_tokens('ak_nobody') == []


# ---------------------------------------------------------------------------
# models — permission resolution + pod context
# ---------------------------------------------------------------------------


def _acct(sys_perms=None, organization=None, waitlisted=False):
    """Build an AccountInfo-shaped stub for the resolve_* permission helpers."""
    return SimpleNamespace(sysPermissions=sys_perms or [], organization=organization, waitlisted=waitlisted)


def test_resolve_team_permissions_grants_sys_admin_without_membership():
    """A sys.admin caller with no org/team membership still gets full perms."""
    from ai.account.models import _FULL_TEAM_PERMISSIONS, resolve_team_permissions

    assert resolve_team_permissions(_acct(sys_perms=['sys.admin']), 'team-x') == list(_FULL_TEAM_PERMISSIONS)


def test_resolve_team_permissions_grants_internal_without_membership():
    """The pod 'internal' service credential also bypasses team membership."""
    from ai.account.models import _FULL_TEAM_PERMISSIONS, resolve_team_permissions

    assert resolve_team_permissions(_acct(sys_perms=['internal']), 'team-x') == list(_FULL_TEAM_PERMISSIONS)


def test_resolve_task_permissions_grants_sys_admin_without_membership():
    """The task-scoped resolver applies the same sys.admin bypass."""
    from ai.account.models import _FULL_TEAM_PERMISSIONS, resolve_task_permissions

    assert resolve_task_permissions(_acct(sys_perms=['sys.admin']), 'team-x') == list(_FULL_TEAM_PERMISSIONS)


def test_resolve_task_permissions_grants_internal_without_membership():
    """The task-scoped resolver also honours the pod 'internal' service credential."""
    from ai.account.models import _FULL_TEAM_PERMISSIONS, resolve_task_permissions

    assert resolve_task_permissions(_acct(sys_perms=['internal']), 'team-x') == list(_FULL_TEAM_PERMISSIONS)


def test_resolve_team_permissions_raises_for_normal_user_without_membership():
    """A normal caller with no membership in the team still raises (unchanged)."""
    from ai.account.models import resolve_team_permissions

    acct = _acct(organization={'id': 'org-1', 'permissions': [], 'teams': []})
    with pytest.raises(PermissionError, match='No membership'):
        resolve_team_permissions(acct, 'team-x')


def test_to_pod_context_includes_waitlisted():
    """The waitlisted flag must be forwarded so verify_auth can reject in pod mode."""
    from ai.account.models import AccountInfo

    assert AccountInfo(userId='u1', waitlisted=True).to_pod_context()['waitlisted'] is True
    assert AccountInfo(userId='u2').to_pod_context()['waitlisted'] is False


# ---------------------------------------------------------------------------
# OSS account — subscriptions + desktop subcommand
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_oss_authenticate_marks_all_catalog_apps_free(monkeypatch):
    """OSS authenticate populates subscriptions = {appId: 'free'} for the catalog."""
    from ai.account.oss import Account

    acct = Account.__new__(Account)  # bypass __init__
    acct.capabilities = ['oss']
    monkeypatch.setattr(acct, '_read_apps_json', lambda public_only=False: [{'id': 'a1'}, {'id': 'a2'}])
    monkeypatch.delenv('ROCKETRIDE_APIKEY', raising=False)  # unconfigured -> any credential matches

    info = await acct.authenticate('ak_dev')
    assert info.subscriptions == {'a1': 'free', 'a2': 'free'}


@pytest.mark.asyncio
async def test_oss_desktop_subcommand_returns_all_apps_free_and_on_desktop(monkeypatch):
    """OSS 'desktop' subcommand mirrors the catalog: every app free + onDesktop."""
    from ai.account.oss import Account

    acct = Account.__new__(Account)
    monkeypatch.setattr(
        acct, '_read_apps_json', lambda public_only=False: [{'id': 'a1', 'name': 'A'}, {'id': 'a2', 'name': 'B'}]
    )
    conn = MagicMock()
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})

    req = {'command': 'rrext_account_me', 'arguments': {'subcommand': 'desktop'}}
    result = await acct.handle_account(conn, req, RequestContext())

    apps = result['body']['apps']
    assert {a['id'] for a in apps} == {'a1', 'a2'}
    assert all(a['appStatus'] == 'free' and a['onDesktop'] is True for a in apps)
