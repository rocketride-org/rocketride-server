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
``client.deploy.delete`` and ``rocketride deploy delete`` against a fake
client — no server (the TS twin is ``cli-deploy-delete.test.ts``).

The SDK verb is one DAP call on the generic rail door; the CLI verb runs
through the real parse + dispatch path, confirms on a terminal, needs
``--yes`` off one, and passes the server's refusal through by name.
"""

import importlib
from typing import Any, Dict, List

import pytest

from rocketride.deploy import DeployApi

cli_main = importlib.import_module('rocketride.cli.main')
cli_common = importlib.import_module('rocketride.cli.utils.common')
cli_deploy = importlib.import_module('rocketride.cli.commands.deploy')

DELETED = {
    'projectId': 'acme.docBrain',
    'version': 3,
    'kind': 'pipe',
    'sha256': 'abc',
    'deleted': True,
    'orgId': 'org-1',
}


class _FakeDeploy:
    """The ``client.deploy`` namespace: records delete calls, answers or raises."""

    def __init__(self, answer: Any = None):
        self.answer = DELETED if answer is None else answer
        self.calls: List[Dict[str, Any]] = []

    async def delete(self, project_id: str, version: int) -> Dict[str, Any]:
        self.calls.append({'project_id': project_id, 'version': version})
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


class _FakeClient:
    """Minimal stand-in for RocketRideClient used by the CLI under test."""

    def __init__(self, deploy: _FakeDeploy):
        self.deploy = deploy
        self.connected = False

    def is_connected(self) -> bool:
        return self.connected

    async def connect(self) -> None:
        self.connected = True

    async def disconnect(self) -> None:
        self.connected = False


async def run_cli(monkeypatch, fake_client: _FakeClient, argv: List[str]) -> int:
    """Run the CLI's parse + dispatch path with a fake client, returning its exit code."""

    async def fake_connect_client(uri, apikey='', on_event=None):
        cli_common._active_clients.append(fake_client)
        await fake_client.connect()
        return fake_client

    monkeypatch.setattr(cli_deploy, 'connect_client', fake_connect_client)
    parser = cli_main.setup_parser()
    args = parser.parse_args(['deploy', 'delete', '--uri', 'https://deploy.test', '--apikey', 'k', *argv])
    return await cli_main._dispatch(args)


def _terminal(monkeypatch, on: bool) -> None:
    """Pretend stdin is (or is not) a terminal for one test."""
    monkeypatch.setattr('sys.stdin.isatty', lambda: on)


# =============================================================================
# SDK
# =============================================================================


class _CallRecorder:
    """A client whose ``call`` records its arguments and answers DELETED."""

    def __init__(self):
        self.calls: List[Any] = []

    async def call(self, command: str, **kwargs: Any) -> Dict[str, Any]:
        self.calls.append((command, kwargs))
        return DELETED


@pytest.mark.asyncio
async def test_sdk_delete_is_one_call_on_the_generic_rail_door():
    client = _CallRecorder()
    assert await DeployApi(client).delete('docBrain', 3) == DELETED
    assert client.calls == [('rrext_deploy', {'subcommand': 'delete', 'projectId': 'docBrain', 'version': 3})]


# =============================================================================
# CLI
# =============================================================================


@pytest.mark.asyncio
async def test_cli_deletes_with_yes_and_prints_what_went(monkeypatch, capsys):
    deploy = _FakeDeploy()
    assert await run_cli(monkeypatch, _FakeClient(deploy), ['docBrain', '3', '--yes']) == 0
    assert deploy.calls == [{'project_id': 'docBrain', 'version': 3}]
    assert 'Deleted docBrain v3 from the server.' in capsys.readouterr().out


@pytest.mark.asyncio
async def test_cli_needs_yes_off_a_terminal_and_never_reaches_the_server(monkeypatch, capsys):
    deploy = _FakeDeploy()
    _terminal(monkeypatch, False)
    assert await run_cli(monkeypatch, _FakeClient(deploy), ['docBrain', '3']) == 1
    err = capsys.readouterr().err
    assert 'needs confirmation' in err and '--yes' in err
    assert deploy.calls == []


@pytest.mark.asyncio
async def test_cli_confirms_on_a_terminal_no_cancels_yes_deletes(monkeypatch, capsys):
    deploy = _FakeDeploy()
    _terminal(monkeypatch, True)
    answers = iter(['n', 'y'])
    prompts: List[str] = []

    def fake_prompt(question: str, fallback: str = '') -> str:
        prompts.append(question)
        return next(answers)

    monkeypatch.setattr(cli_deploy, 'prompt_line', fake_prompt)
    assert await run_cli(monkeypatch, _FakeClient(deploy), ['docBrain', '3']) == 1
    assert deploy.calls == []
    assert 'Cancelled.' in capsys.readouterr().out
    assert await run_cli(monkeypatch, _FakeClient(deploy), ['docBrain', '3']) == 0
    assert deploy.calls == [{'project_id': 'docBrain', 'version': 3}]
    assert prompts[0].startswith('Delete docBrain v3 from the server?')


@pytest.mark.asyncio
async def test_cli_passes_the_server_refusal_through_by_name(monkeypatch, capsys):
    refusal = RuntimeError('acme.docBrain v3 is published to @team/Production; unpublish it first')
    assert await run_cli(monkeypatch, _FakeClient(_FakeDeploy(refusal)), ['docBrain', '3', '--yes']) == 1
    assert 'published to @team/Production; unpublish it first' in capsys.readouterr().err


def test_cli_version_must_be_a_whole_registry_number(capsys):
    """``3`` and ``v3`` name a version; anything else is refused before the server (the TS CLI's rule)."""
    parser = cli_main.setup_parser()
    assert parser.parse_args(['deploy', 'delete', 'docBrain', '3']).version == 3
    assert parser.parse_args(['deploy', 'delete', 'docBrain', 'V3']).version == 3
    for typed in ('latest', '3.5', '3abc', '3e1', '0', '-3', 'v', ''):
        with pytest.raises(SystemExit):
            parser.parse_args(['deploy', 'delete', 'docBrain', typed])
    assert "invalid version '3.5'" in capsys.readouterr().err
