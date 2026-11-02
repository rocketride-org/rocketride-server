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

"""`rocketride app create` (Python CLI) resolves the developer id like the wizard and the TS CLI: --developer, else the account's, else 'local' with a warning."""

from types import SimpleNamespace

from rocketride.cli.commands import app as app_cmd
from rocketride.cli.utils.output import Output


def _args(**overrides):
    base = {'developer': None, 'uri': 'http://localhost:5565', 'apikey': 'key'}
    base.update(overrides)
    return SimpleNamespace(**base)


def _connect_returning(account_info, calls):
    async def fake_connect(uri, apikey='', on_event=None):
        calls.append((uri, apikey))
        return SimpleNamespace(get_account_info=lambda: account_info)

    return fake_connect


async def test_uses_the_connected_account_developer_id(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(
        app_cmd, 'connect_client', _connect_returning({'organization': {'developerId': 'personal'}}, calls)
    )

    assert await app_cmd.resolve_create_developer_id(_args(), Output(None)) == 'personal'
    assert calls == [('http://localhost:5565', 'key')]
    assert capsys.readouterr().err == ''


async def test_explicit_developer_wins_without_connecting(monkeypatch):
    calls = []
    monkeypatch.setattr(app_cmd, 'connect_client', _connect_returning({}, calls))

    assert await app_cmd.resolve_create_developer_id(_args(developer='acme'), Output(None)) == 'acme'
    assert calls == []


async def test_connection_failure_warns_and_falls_back(monkeypatch, capsys):
    async def failing_connect(uri, apikey='', on_event=None):
        raise ConnectionError('ECONNREFUSED')

    monkeypatch.setattr(app_cmd, 'connect_client', failing_connect)

    assert await app_cmd.resolve_create_developer_id(_args(), Output(None)) == 'local'
    err = capsys.readouterr().err
    assert 'Warning: could not read the developer id' in err
    assert 'ECONNREFUSED' in err
    assert "using 'local'" in err


async def test_missing_key_warns_without_connecting(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(app_cmd, 'connect_client', _connect_returning({}, calls))

    assert await app_cmd.resolve_create_developer_id(_args(apikey=''), Output(None)) == 'local'
    assert calls == []
    assert 'Warning: no account credentials' in capsys.readouterr().err


async def test_unregistered_org_warns_and_falls_back(monkeypatch, capsys):
    monkeypatch.setattr(app_cmd, 'connect_client', _connect_returning({'organization': {'developerId': None}}, []))

    assert await app_cmd.resolve_create_developer_id(_args(), Output(None)) == 'local'
    assert 'no registered developer id' in capsys.readouterr().err
