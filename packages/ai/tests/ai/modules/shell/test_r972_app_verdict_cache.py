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


"""#972 PR 1a (F4): the shell's app verdict caches are hard and never cache an outage.

``_authorize_app`` used to slide its 5-minute entry on every hit, so a
caller fetching at least once per window kept a revoked verdict forever;
and both caches turned an ``authenticate`` exception into an anonymous
verdict they then cached for the full window. Fake account, fake clock.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import ai.account
import ai.account.app_deploy as app_deploy_mod
import ai.modules.shell.shell as shell_mod


class _Clock:
    """Deterministic stand-in for the module's ``time`` import."""

    def __init__(self) -> None:
        self.now = 1_000_000.0

    def time(self) -> float:
        return self.now


class _Account:
    """SaaS-shaped account: ``outages`` authenticate calls raise, then succeed."""

    capabilities = ('saas',)

    def __init__(self, outages: int = 0) -> None:
        self.outages = outages
        self.entitled = {'app.x'}
        self.authentications = 0

    async def authenticate(self, token):
        self.authentications += 1
        if self.outages:
            self.outages -= 1
            raise RuntimeError('database unavailable')
        return SimpleNamespace(userId='u1', organization=None, sysPermissions=[])

    async def get_apps_for_user(self, user_id, organizations, sys_perms=None):
        return [{'id': app_id} for app_id in sorted(self.entitled)]

    async def get_public_apps(self):
        return []


def _setup(monkeypatch, account):
    clock = _Clock()
    monkeypatch.setattr(shell_mod, 'time', clock)
    monkeypatch.setattr(shell_mod, '_app_auth_cache', {})
    monkeypatch.setattr(shell_mod, '_version_dir_cache', {})
    monkeypatch.setattr(ai.account, 'account', account)

    async def entitled_version_dirs(info, app_id):
        if info is not None and app_id in account.entitled:
            return {1: f'{app_id}/v1/dist'}
        return {}

    monkeypatch.setattr(app_deploy_mod, 'entitled_version_dirs', entitled_version_dirs)
    return clock


def _authorize():
    return asyncio.run(shell_mod._authorize_app('tok', 'app.x'))


def test_r972_1a_auth_exception_is_not_cached(monkeypatch):
    """E7: an authenticate outage answers anonymously once; the next call re-authenticates."""
    account = _Account(outages=1)
    _setup(monkeypatch, account)

    assert _authorize() is False  # anonymous verdict while auth is down
    assert _authorize() is True  # not served the cached anonymous verdict
    assert account.authentications == 2


def test_r972_1a_hot_verdict_expires_hard(monkeypatch):
    """E7: hits every 60 s do not keep a verdict past 300 s."""
    account = _Account()
    clock = _setup(monkeypatch, account)

    assert _authorize() is True
    account.entitled = set()  # revoked
    for _ in range(4):
        clock.now += 60
        assert _authorize() is True  # still inside the hard window
    clock.now += 60  # 300 s after the first resolution
    assert _authorize() is False


def test_r972_1a_version_dirs_auth_exception_is_not_cached(monkeypatch):
    """E7: the versioned-serving cache answers anonymously during an outage, uncached."""
    account = _Account(outages=1)
    _setup(monkeypatch, account)

    assert asyncio.run(shell_mod._version_dirs_for('tok', 'app.x', want=1)) == {}
    assert asyncio.run(shell_mod._version_dirs_for('tok', 'app.x', want=1)) == {1: 'app.x/v1/dist'}


def test_r972_1a_app_entry_info_auth_exception_answers_anonymously(monkeypatch):
    """The resolution probe answers as anonymous when authentication raises."""
    account = _Account(outages=2)
    _setup(monkeypatch, account)

    assert asyncio.run(shell_mod._app_entry_info('tok', 'app.x')) is None


def test_r972_1a_real_deny_is_still_cached(monkeypatch):
    """Control: an error tuple from authenticate (a real deny) is cached as before."""
    account = _Account()
    _setup(monkeypatch, account)

    async def deny(token):
        account.authentications += 1
        return (401, 'invalid token')

    account.authenticate = deny
    assert _authorize() is False
    assert _authorize() is False
    assert account.authentications == 1
