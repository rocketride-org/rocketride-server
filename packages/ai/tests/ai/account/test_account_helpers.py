"""
Unit tests for small ai.account helpers.

Covers three files that are too small for their own test modules:

- ``ai/account/base.py`` — ``init_account`` no-op and the OSS defaults
  that raise NotImplementedError for SaaS-only operations.
- ``ai/account/report.py`` — the ``Reporter`` class: ``LS_REPORT`` env
  toggles real HTTP POSTs vs. silent no-op; exceptions are swallowed.
- ``ai/account/keystore.py`` — in-memory token map: reserve, map_to_node,
  add_token, remove_token, get_tokens with ownership checks.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from ai.account.base import AccountBase
from ai.account.desktop import FileDesktopBackend
from ai.account.report import Reporter
from ai.account.store_providers.memory import MemoryStore


# ---------------------------------------------------------------------------
# AccountBase
# ---------------------------------------------------------------------------


class _ConcreteAccount(AccountBase):
    """Minimal subclass so AccountBase becomes instantiable for tests."""

    async def authenticate(self, credential: str):
        """No-op authenticate so the ABC contract is satisfied."""
        return None


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
        await acct.handle_account(MagicMock(), {})


def _conn(authenticated: bool = False):
    """A conn stub: build_response/build_error capture their body/message."""
    conn = MagicMock()
    conn.build_response.side_effect = lambda _req, body=None: {'success': True, 'body': body}
    conn.build_error.side_effect = lambda _req, msg='': {'success': False, 'message': msg}
    if authenticated:
        conn._account_info = MagicMock(userId='local', organization={'id': 'local'})
    else:
        conn._account_info = None
    return conn


def _req(sub: str, **extra):
    """An rrext_app request dict for one subcommand."""
    return {'command': 'rrext_app', 'arguments': {'subcommand': sub, **extra}}


@pytest.mark.asyncio
async def test_handle_app_list_serves_oss_with_login_decoration():
    """OSS serves the catalog READ surface: the login walk's entries,
    decorated exactly as OSS login decorates (free + the user's stored
    desktop, seeded with the inventory on the first read) so the catalog
    and the handshake can never disagree. The desktop writes themselves are
    covered in test_desktop.py.
    """
    acct = _ConcreteAccount()
    acct._desktop_backend_instance = FileDesktopBackend(MemoryStore())

    async def fake_apps(user_id, organizations):
        return [{'id': 'rocketride.sql', 'name': 'SQL', 'shells': None}]

    acct.get_apps_for_user = fake_apps
    result = await acct.handle_app(_conn(authenticated=True), _req('list'))
    assert result['success'] is True
    (entry,) = result['body']['apps']
    assert entry['appStatus'] == 'free'
    assert entry['onDesktop'] is True


@pytest.mark.asyncio
async def test_handle_app_list_anonymous_uses_public_walk():
    """Anonymous callers get the public walk; nothing is on a desktop and
    every action needs a sign-in first (the SaaS catalog's anonymous shape).
    """
    acct = _ConcreteAccount()

    async def fake_public():
        return [{'id': 'rocketride.hello', 'name': 'Home'}]

    acct.get_public_apps = fake_public
    result = await acct.handle_app(_conn(), _req('list'))
    assert [(a['id'], a['appStatus'], a['onDesktop']) for a in result['body']['apps']] == [
        ('rocketride.hello', 'auth', False)
    ]


@pytest.mark.asyncio
async def test_handle_app_admin_surface_stays_saas_only():
    """The genuinely SaaS-only catalog half (admin/pricing/list_mine)
    still raises — emulating the review ladder or Stripe would be inventing
    features, not parity.
    """
    acct = _ConcreteAccount()
    for sub in ('admin_queue', 'pricing_list', 'list_mine'):
        with pytest.raises(NotImplementedError, match='requires SaaS'):
            await acct.handle_app(_conn(authenticated=True), _req(sub))


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
