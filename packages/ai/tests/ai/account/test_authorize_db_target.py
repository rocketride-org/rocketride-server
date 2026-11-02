# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Tests for the ``AccountBase.authorize_db_target`` default (editions with no
orgs or teams). The SaaS override and its matrix live in the saas repo
(extension/test/saas/test_datacore_access.py).
"""

from __future__ import annotations

import asyncio

from ai.account.base import AccountBase, DbDecision

IDENTITY = {'org_id': '', 'user_id': 'u1', 'team_id': '', 'run_kind': 'dev', 'owner_kind': 'user'}


class _Minimal(AccountBase):
    async def authenticate(self, credential):  # pragma: no cover - unused
        return None


def test_org_scope_is_allowed_by_default():
    decision = asyncio.run(_Minimal().authorize_db_target(IDENTITY))
    assert decision == DbDecision(True, 'single_tenant', False)
    assert asyncio.run(_Minimal().authorize_db_target(IDENTITY, {'scope': 'org'})).allowed


def test_team_and_user_scopes_are_refused_by_default():
    for scope in ('team', 'user'):
        decision = asyncio.run(_Minimal().authorize_db_target(IDENTITY, {'scope': scope}))
        assert (decision.allowed, decision.reason) == (False, 'scope_needs_rocketride_cloud')


def test_a_denial_is_falsy():
    # Same as the SaaS DbDecision: a plain NamedTuple is always truthy, so
    # `if decision:` would issue a DSN on every denial.
    denied = asyncio.run(_Minimal().authorize_db_target(IDENTITY, {'scope': 'user'}))
    assert not denied
    assert asyncio.run(_Minimal().authorize_db_target(IDENTITY))
    assert not DbDecision(False, 'any_reason', True)


def test_an_allow_names_the_database_it_approved():
    # Callers provision decision.owner_id: '' is the org database.
    decision = asyncio.run(_Minimal().authorize_db_target(IDENTITY, {'scope': 'org'}))
    assert (decision.allowed, decision.owner_id) == (True, '')
    assert asyncio.run(_Minimal().authorize_db_target(IDENTITY, {'scope': 'team', 'team_id': 't1'})).owner_id == ''
