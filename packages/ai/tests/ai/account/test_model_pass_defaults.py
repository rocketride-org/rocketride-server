# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The hosted models defaults on ``AccountBase``: no pass, nothing to revoke, and the providers this engine runs."""

from __future__ import annotations

import asyncio

from ai.account.base import AccountBase


class _Minimal(AccountBase):
    async def authenticate(self, credential):  # pragma: no cover - unused
        return None


IDENTITY = {'org_id': 'o1', 'user_id': 'u1', 'team_id': 't1', 'run_id': 'r1', 'task_id': 'task-1'}


def test_an_engine_without_a_hosted_backend_issues_no_pass():
    assert asyncio.run(_Minimal().issue_model_pass(IDENTITY)) is None


def test_revoking_an_unknown_run_does_nothing():
    assert asyncio.run(_Minimal().revoke_model_pass('no-such-run')) is None


def test_the_engine_says_it_runs_openai_on_a_hosted_backend():
    """A hosted backend offers hosted models only to an engine that names the provider here."""
    assert 'openai' in AccountBase.hosted_model_providers
    assert 'openai' in _Minimal.hosted_model_providers
