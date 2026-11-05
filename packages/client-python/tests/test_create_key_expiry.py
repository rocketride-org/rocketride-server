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


"""create_key reports the expiry the server GRANTED (record.expiresAt), which a SaaS server caps for a key minted over a sign-in session; `rocketride login` prints it instead of claiming the key never expires (TS twin: tests/account-create-key.test.ts)."""

import asyncio

from rocketride.account import AccountApi
from rocketride.cli.commands.auth import describe_login_key_expiry, utc_day


class _Client:
    def __init__(self, body):
        self.body = body
        self.calls = []

    async def call(self, command, **kwargs):
        self.calls.append((command, kwargs))
        return self.body


def _create(body, **kwargs):
    client = _Client(body)
    api = AccountApi(client)
    return asyncio.run(api.create_key(name='ci', **kwargs)), client.calls


def test_create_key_returns_the_granted_expiry_which_can_be_earlier_than_requested():
    result, calls = _create(
        {'key': 'rr_x', 'record': {'id': 'k1', 'expiresAt': '2027-02-03T10:00:00'}}, expires_at='2030-01-01T00:00:00Z'
    )
    assert result == {'key': 'rr_x', 'expiresAt': '2027-02-03T10:00:00'}
    assert calls == [
        ('rrext_account_keys', {'subcommand': 'create', 'name': 'ci', 'expiresAt': '2030-01-01T00:00:00Z'})
    ]


def test_create_key_reports_none_when_the_server_says_the_key_does_not_expire():
    result, _ = _create({'key': 'rr_x', 'record': {'id': 'k1', 'expiresAt': None}})
    assert result == {'key': 'rr_x', 'expiresAt': None}


def test_create_key_leaves_expires_at_absent_when_the_server_did_not_report_it():
    result, _ = _create({'key': 'rr_x'})
    assert result == {'key': 'rr_x'}
    assert 'expiresAt' not in result


def test_the_login_line_prints_the_granted_day_bounded_by_the_sign_in_session():
    assert describe_login_key_expiry('2027-02-03T23:30:00.123456') == (
        ' It expires on 2027-02-03 (bounded by your sign-in session); run `rocketride login` again before then.'
    )
    assert describe_login_key_expiry(None) == ' It does not expire.'


def test_utc_day_reads_naive_server_time_as_utc_and_keeps_an_unreadable_value():
    assert utc_day('2027-02-03T23:59:59') == '2027-02-03'
    assert utc_day('2027-02-04T01:00:00+05:30') == '2027-02-03'
    assert utc_day('2027-02-03T10:00:00Z') == '2027-02-03'
    assert utc_day('not a date') == 'not a date'
