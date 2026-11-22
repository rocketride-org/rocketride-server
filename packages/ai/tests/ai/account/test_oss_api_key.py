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

"""
A standalone server's API key is RR_APIKEY; the client's ROCKETRIDE_APIKEY never opens it.

ROCKETRIDE_APIKEY is the key a client sends. A server that holds only that
name was configured for a key, so it must neither start nor accept anyone:
reading RR_APIKEY alone would see no key and accept every credential.
"""

import asyncio

import pytest

from ai.account.oss import Account


@pytest.fixture
def account(monkeypatch):
    """An OSS account with no key in the environment and an empty app rail."""
    for name in ('RR_APIKEY', 'ROCKETRIDE_APIKEY'):
        monkeypatch.delenv(name, raising=False)
    acct = Account.__new__(Account)  # the constructor needs a server; authenticate does not

    async def no_apps():
        return []

    monkeypatch.setattr(acct, '_assemble_apps', no_apps)
    return acct


def _login(acct, credential):
    """``authenticate`` run to completion."""
    return asyncio.run(acct.authenticate(credential))


def test_the_server_key_is_rr_apikey(account, monkeypatch):
    monkeypatch.setenv('RR_APIKEY', 'server-key')
    assert _login(account, 'server-key').userId == 'local'
    assert _login(account, 'wrong') == (401, 'Invalid API key')
    assert _login(account, '') == (401, 'Invalid API key')


def test_the_clients_key_name_alone_opens_nothing(account, monkeypatch):
    # Configured for a key under the client's name: every login is refused,
    # the matching value included, and the reason names the server's setting
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'client-key')
    for credential in ('client-key', 'anything', ''):
        status, message = _login(account, credential)
        assert status == 401 and 'RR_APIKEY' in message


def test_the_clients_key_beside_the_servers_is_only_the_clients(account, monkeypatch):
    monkeypatch.setenv('RR_APIKEY', 'server-key')
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'client-key')
    assert _login(account, 'server-key').userId == 'local'
    assert _login(account, 'client-key') == (401, 'Invalid API key')


def test_no_key_at_all_is_an_open_local_server(account):
    assert _login(account, 'anything').userId == 'local'


def test_a_server_with_only_the_clients_key_name_refuses_to_start(account, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'client-key')
    with pytest.raises(SystemExit, match='RR_APIKEY'):
        asyncio.run(account.init_account(None))


def test_a_server_with_its_own_key_starts(account, monkeypatch):
    monkeypatch.setenv('RR_APIKEY', 'server-key')
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'client-key')
    seeded = []

    async def seed():
        seeded.append(True)

    monkeypatch.setattr(account, '_seed_builtin_apps', seed)
    asyncio.run(account.init_account(None))
    assert seeded == [True]
