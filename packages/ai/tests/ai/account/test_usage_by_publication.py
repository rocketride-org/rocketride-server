# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Served by publication on the OSS edition (plan 8.3, B39).

OSS keeps no ledger (``apply_usage`` is a no-op), so the breakdown is the
base's empty list, and the ``rrext_account_billing`` ``usage_by_publication``
verb answers that local shape instead of an edition error. Every other
billing subcommand still needs SaaS.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from ai.account.oss import Account


class _Conn:
    def build_response(self, request, body=None):
        return {'ok': True, 'body': body or {}}

    def build_error(self, request, message):
        return {'ok': False, 'message': message}


def _account():
    return Account.__new__(Account)  # the constructor needs a server; the verbs do not


def _billing(sub, **args):
    request = {'command': 'rrext_account_billing', 'arguments': {'subcommand': sub, **args}}
    return asyncio.run(_account().handle_account(_Conn(), request))


def test_the_base_breakdown_is_empty():
    since = datetime(2026, 11, 1, tzinfo=timezone.utc)
    until = datetime(2026, 12, 1, tzinfo=timezone.utc)

    assert asyncio.run(_account().get_usage_by_publication('org-1')) == []
    assert asyncio.run(_account().get_usage_by_publication('org-1', since, until)) == []


def test_the_verb_answers_the_empty_breakdown():
    response = _billing('usage_by_publication', orgId='org-1', since='2026-11-01T00:00:00Z')

    assert response == {'ok': True, 'body': {'usage': []}}


def test_other_billing_subcommands_still_need_saas():
    with pytest.raises(NotImplementedError):
        _billing('usage_by_user', orgId='org-1')
