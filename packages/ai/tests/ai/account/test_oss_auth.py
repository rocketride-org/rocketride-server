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
"""
OSS authentication: ``Account.authenticate`` against ROCKETRIDE_APIKEY,
``Account.init_account`` refusing to start an engine that is reachable from
the network while no key is set (any credential would be accepted as admin),
and ``update_env`` / ``set_env`` refusing to remove that key afterwards.
"""

import os
from types import SimpleNamespace

import pytest

from ai.account.oss import Account, _is_loopback


def _account(monkeypatch) -> Account:
    """An OSS Account whose app seeding does nothing (only the auth guard is under test)."""
    account = Account.__new__(Account)  # the constructor needs a server; these verbs do not

    async def _no_seed(self):
        return None

    monkeypatch.setattr(Account, '_seed_builtin_apps', _no_seed)
    return account


@pytest.mark.parametrize('host', ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]'])
def test_loopback_hosts(host):
    assert _is_loopback(host)


@pytest.mark.parametrize(
    'host', ['0.0.0.0', '::', '', '10.0.0.5', '192.168.1.10', 'engine.example.com', 'host.docker.internal']
)
def test_network_hosts(host):
    assert not _is_loopback(host)


async def test_configured_key_rejects_a_wrong_credential(monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'the-right-key')
    result = await _account(monkeypatch).authenticate('a-wrong-key')
    assert result == (401, 'Invalid API key')


async def test_configured_key_accepts_the_right_credential(monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'the-right-key')
    info = await _account(monkeypatch).authenticate('the-right-key')
    assert info.userId == 'local'


async def test_configured_key_rejects_an_empty_credential(monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'the-right-key')
    assert await _account(monkeypatch).authenticate('') == (401, 'Invalid API key')


async def test_no_key_on_loopback_starts(monkeypatch):
    monkeypatch.delenv('ROCKETRIDE_APIKEY', raising=False)
    await _account(monkeypatch).init_account(SimpleNamespace(config={'host': '127.0.0.1'}))


async def test_no_key_with_no_host_configured_starts(monkeypatch):
    # The server's default bind address is localhost.
    monkeypatch.delenv('ROCKETRIDE_APIKEY', raising=False)
    await _account(monkeypatch).init_account(SimpleNamespace(config={}))


@pytest.mark.parametrize('host', ['0.0.0.0', '::', '10.0.0.5'])
async def test_no_key_on_a_network_address_refuses_to_start(monkeypatch, host):
    monkeypatch.delenv('ROCKETRIDE_APIKEY', raising=False)
    with pytest.raises(RuntimeError, match='ROCKETRIDE_APIKEY'):
        await _account(monkeypatch).init_account(SimpleNamespace(config={'host': host}))


async def test_empty_key_counts_as_no_key(monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_APIKEY', '')
    with pytest.raises(RuntimeError, match='ROCKETRIDE_APIKEY'):
        await _account(monkeypatch).init_account(SimpleNamespace(config={'host': '0.0.0.0'}))


async def test_key_on_a_network_address_starts(monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'the-right-key')
    await _account(monkeypatch).init_account(SimpleNamespace(config={'host': '0.0.0.0'}))


class _Conn:
    def build_response(self, request, body=None):
        return {'ok': True, 'body': body or {}}

    def build_error(self, request, message):
        return {'ok': False, 'message': message}


def _env_request(sub, **args):
    return {'command': 'rrext_account_me', 'arguments': {'subcommand': sub, **args}}


@pytest.fixture
def started(monkeypatch, tmp_path):
    """An OSS Account started on 0.0.0.0 with a key, its .env beside a fake executable."""
    for key in [k for k in os.environ if k.startswith('ROCKETRIDE_')]:
        monkeypatch.delenv(key)
    monkeypatch.setattr('sys.executable', str(tmp_path / 'engine'))
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'the-right-key')
    account = _account(monkeypatch)

    async def start():
        await account.init_account(SimpleNamespace(config={'host': '0.0.0.0'}))
        return account

    return start


@pytest.mark.parametrize('sub', ['update_env', 'set_env'])
@pytest.mark.parametrize('value', [None, ''])
async def test_a_network_engine_keeps_its_key(started, sub, value):
    account = await started()
    resp = await account.handle_account(_Conn(), _env_request(sub, env={'ROCKETRIDE_APIKEY': value}))
    assert resp['ok'] is False and 'ROCKETRIDE_APIKEY' in resp['message']
    assert os.environ['ROCKETRIDE_APIKEY'] == 'the-right-key'


async def test_a_network_engine_can_rotate_its_key(started):
    account = await started()
    resp = await account.handle_account(_Conn(), _env_request('update_env', env={'ROCKETRIDE_APIKEY': 'a-new-key'}))
    assert resp == {'ok': True, 'body': {'updated': True}}
    assert os.environ['ROCKETRIDE_APIKEY'] == 'a-new-key'


async def test_a_loopback_engine_can_drop_its_key(monkeypatch, tmp_path):
    for key in [k for k in os.environ if k.startswith('ROCKETRIDE_')]:
        monkeypatch.delenv(key)
    monkeypatch.setattr('sys.executable', str(tmp_path / 'engine'))
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'the-right-key')
    account = _account(monkeypatch)
    await account.init_account(SimpleNamespace(config={'host': '127.0.0.1'}))
    resp = await account.handle_account(_Conn(), _env_request('update_env', env={'ROCKETRIDE_APIKEY': None}))
    assert resp == {'ok': True, 'body': {'updated': True}}
    assert 'ROCKETRIDE_APIKEY' not in os.environ
