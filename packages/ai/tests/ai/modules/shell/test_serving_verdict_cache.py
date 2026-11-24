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


"""The shell's serving verdict cache has a hard expiry and never caches an outage.

A verdict used to be kept for as long as its caller kept asking, and an
``authenticate`` exception was turned into an anonymous verdict that was then
cached for the full window. On this branch one cache answers every served
artifact (``_version_dirs_for``); develop's second cache (``_authorize_app``)
does not exist here, so its cases run against this one. Fake account, fake clock.
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

    def __init__(self, outages: int = 0, error_tuples=()) -> None:
        self.outages = outages
        self.error_tuples = list(error_tuples)
        self.entitled = {'app.x'}
        self.authentications = 0

    async def authenticate(self, token):
        self.authentications += 1
        if self.error_tuples:
            return self.error_tuples.pop(0)
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
    monkeypatch.setattr(shell_mod, '_version_dir_cache', {})
    monkeypatch.setattr(ai.account, 'account', account)

    async def entitled_version_dirs(info, artifact_id, kind='app'):
        if info is not None and artifact_id in account.entitled:
            return {1: f'{artifact_id}/v1/dist'}
        return {}

    monkeypatch.setattr(app_deploy_mod, 'entitled_version_dirs', entitled_version_dirs)
    return clock


def _dirs():
    return asyncio.run(shell_mod._version_dirs_for('tok', 'app', 'app.x', want=1))


SERVED = {1: 'app.x/v1/dist'}


def test_version_dirs_auth_exception_is_not_cached(monkeypatch):
    """An authenticate outage answers anonymously once; the next call re-authenticates."""
    account = _Account(outages=1)
    _setup(monkeypatch, account)

    assert _dirs() == {}  # the anonymous map while auth is down
    assert _dirs() == SERVED  # not served the anonymous map from the cache
    assert account.authentications == 2


def test_hot_verdict_expires_hard(monkeypatch):
    """Hits every 60 s do not keep a verdict past 300 s."""
    account = _Account()
    clock = _setup(monkeypatch, account)

    assert _dirs() == SERVED
    account.entitled = set()  # revoked
    for _ in range(4):
        clock.now += 60
        assert _dirs() == SERVED  # still inside the hard window
    clock.now += 60  # 300 s after the first resolution
    assert _dirs() == {}


def test_version_dirs_unavailable_error_tuple_is_not_cached(monkeypatch):
    """A 503 error tuple is an outage: answered anonymously once, never cached."""
    account = _Account(error_tuples=[(503, 'unavailable')])
    _setup(monkeypatch, account)

    assert _dirs() == {}
    assert _dirs() == SERVED
    assert account.authentications == 2


def test_version_dirs_denial_error_tuple_is_cached(monkeypatch):
    """A 401 error tuple is a definite denial: the anonymous answer is cached."""
    account = _Account(error_tuples=[(401, 'invalid')])
    _setup(monkeypatch, account)

    assert _dirs() == {}
    assert _dirs() == {}
    assert account.authentications == 1


def test_app_entry_info_auth_exception_answers_anonymously(monkeypatch):
    """The resolution probe answers as anonymous when authentication raises."""
    account = _Account(outages=2)
    _setup(monkeypatch, account)

    assert asyncio.run(shell_mod._app_entry_info('tok', 'app.x')) is None


def test_real_deny_is_still_cached(monkeypatch):
    """Control: an error tuple from authenticate (a real deny) is cached as before."""
    account = _Account()
    _setup(monkeypatch, account)

    async def deny(token):
        account.authentications += 1
        return (401, 'invalid token')

    account.authenticate = deny
    assert _dirs() == {}
    assert _dirs() == {}
    assert account.authentications == 1


def test_an_outage_leaves_nothing_in_the_cache(monkeypatch):
    """The anonymous answer of an outage is not stored at all: the map stays empty."""
    account = _Account(outages=1)
    _setup(monkeypatch, account)

    assert _dirs() == {}
    assert shell_mod._version_dir_cache == {}
