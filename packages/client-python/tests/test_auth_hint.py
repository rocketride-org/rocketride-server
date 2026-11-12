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
The "No authorization provided" error says what to do next (#3187).

Connecting without a key used to print only the engine's four words, which is
where two coding agents stopped in a cold-start test. The message is unchanged
- it is the server's - but it now travels with a hint covering what was not
sent, how to send it, and where a key comes from. The CLI prints that hint, and
an uncaught script shows it under the error.
"""

import importlib
import sys
from typing import Any, Dict, Optional

import pytest

from rocketride import RocketRideClient
from rocketride.core.exceptions import NO_AUTHORIZATION_HINT, AuthenticationException

# `rocketride.cli.main` has to be imported as a module: `rocketride.cli` re-exports
# `main` the function, so `from rocketride.cli import main` would bind that instead.
cli_main = importlib.import_module('rocketride.cli.main')


def _client() -> RocketRideClient:
    """A client that will never reach the network: request() is always replaced."""
    return RocketRideClient(auth='', uri='ws://localhost:1')


def _reject_with(message: str):
    """Build an async stand-in for request() that fails the auth command."""

    async def _request(request: Dict[str, Any], timeout: Optional[float] = None) -> Dict[str, Any]:
        return {'success': False, 'message': message}

    return _request


@pytest.mark.asyncio
async def test_no_authorization_carries_actionable_advice(monkeypatch):
    """The engine's terse text keeps its message and gains a hint."""
    client = _client()
    monkeypatch.setattr(client, 'request', _reject_with('No authorization provided'))

    with pytest.raises(AuthenticationException) as excinfo:
        await client._internal_login()

    exc = excinfo.value
    # The message stays exactly what the engine said.
    assert str(exc) == 'No authorization provided'
    # The advice arrives separately, in the hint field.
    assert exc.hint == NO_AUTHORIZATION_HINT
    # Every piece of advice the issue asks for.
    assert 'ROCKETRIDE_APIKEY' in exc.hint
    assert 'pass `auth`' in exc.hint
    assert 'local engine' in exc.hint
    assert 'rocketride login' in exc.hint


@pytest.mark.asyncio
async def test_other_auth_failures_are_left_alone(monkeypatch):
    """A different rejection is not told it forgot an API key."""
    client = _client()
    monkeypatch.setattr(client, 'request', _reject_with('Authentication failed'))

    with pytest.raises(AuthenticationException) as excinfo:
        await client._internal_login()

    assert str(excinfo.value) == 'Authentication failed'
    assert excinfo.value.hint is None


def test_hint_is_shown_under_an_uncaught_error():
    """A crashed script shows the advice under the error (PEP 678).

    str() must not grow the hint: it is kept apart from the message so an
    application can show the message to an end user without the checklist.
    """
    exc = AuthenticationException({'message': 'No authorization provided', 'hint': NO_AUTHORIZATION_HINT})

    assert str(exc) == 'No authorization provided'
    notes = getattr(exc, '__notes__', None) or []
    assert NO_AUTHORIZATION_HINT in notes


def test_exception_without_a_hint_adds_no_note():
    """No hint, no note - the note path only ever carries advice."""
    exc = AuthenticationException({'message': 'No authorization provided'})

    assert exc.hint is None
    assert not getattr(exc, '__notes__', None)


def test_cli_prints_the_hint_under_the_error(capsys, monkeypatch):
    """`rocketride <cmd>` reports the message and its hint, then exits 1.

    A first-time user sees the advice instead of a traceback.
    """

    async def _dispatch(args):
        raise AuthenticationException({'message': 'No authorization provided', 'hint': NO_AUTHORIZATION_HINT})

    monkeypatch.setattr(cli_main, '_dispatch', _dispatch)
    monkeypatch.setattr(sys, 'argv', ['rocketride', 'list'])

    with pytest.raises(SystemExit) as excinfo:
        cli_main.main()

    assert excinfo.value.code == 1
    err = capsys.readouterr().err
    assert 'No authorization provided' in err
    assert 'ROCKETRIDE_APIKEY' in err
    # The advice, not a stack trace.
    assert 'Traceback' not in err


def test_cli_prints_plain_errors_without_a_hint(capsys, monkeypatch):
    """An exception with no hint still reports cleanly, with no blank advice line."""

    async def _dispatch(args):
        raise AuthenticationException({'message': 'Authentication failed'})

    monkeypatch.setattr(cli_main, '_dispatch', _dispatch)
    monkeypatch.setattr(sys, 'argv', ['rocketride', 'list'])

    with pytest.raises(SystemExit) as excinfo:
        cli_main.main()

    assert excinfo.value.code == 1
    err = capsys.readouterr().err
    assert 'Authentication failed' in err
    assert 'Traceback' not in err
