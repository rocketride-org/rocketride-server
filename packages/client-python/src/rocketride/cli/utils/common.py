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
Shared CLI plumbing: client lifecycle, error shaping, and prompts.

Every command runs through :func:`run_cli_command`, which owns the
Output lifecycle (JSON flush), converts raised errors into the uniform
failure shape, disconnects any live clients, and returns the command's
exit code — so individual commands contain only their own logic.

This module is the behavioral twin of the TypeScript CLI's
``src/cli/common.ts`` — changes here must be mirrored there.
"""

import getpass
import re
from typing import Any, Awaitable, Callable, List, Optional

from .output import Output


# Clients opened by the running command, disconnected on exit/signal
_active_clients: List[Any] = []


async def connect_client(uri: str, apikey: str = '', on_event: Optional[Callable] = None):
    """
    Create and connect a RocketRideClient, tracked for cleanup.

    Args:
        uri: Server URI to connect to.
        apikey: Credential for authentication (may be empty for OSS).
        on_event: Optional DAP event handler (e.g. upload progress lines).

    Returns:
        The connected client.
    """
    from rocketride import RocketRideClient

    client = RocketRideClient(uri, auth=apikey or '', on_event=on_event)
    _active_clients.append(client)
    await client.connect()
    return client


async def disconnect_all() -> None:
    """
    Disconnect every client the command opened. Safe to call repeatedly.
    """
    clients = list(_active_clients)
    _active_clients.clear()
    for client in clients:
        try:
            await client.disconnect()
        except Exception:  # noqa: BLE001
            pass


def hint_for(err: Exception, uri: Optional[str] = None) -> str:
    """
    Derive the user-facing hint for a raised error.

    Auth rejections name the fix (``rocketride login``); connection
    failures point at the server address; everything else gets no hint.

    Args:
        err: The raised exception.
        uri: The server the command was talking to.

    Returns:
        A hint sentence, possibly empty.
    """
    message = str(err)
    if re.search(
        r'invalid api key|not authenticated|unauthorized|authentication failed|account is waitlisted',
        message,
        re.IGNORECASE,
    ):
        return f"credentials for {uri or 'the server'} were rejected — run 'rocketride login' to re-authenticate"
    if re.search(
        r'refused|unreachable|timed? ?out|cannot reach|connection (failed|refused|closed)|getaddrinfo',
        message,
        re.IGNORECASE,
    ):
        return f'is the server at {uri or "the configured URI"} running?'
    return ''


async def run_cli_command(args, fn: Callable[[Output], Awaitable[int]]) -> int:
    """
    Run one CLI command action with uniform lifecycle handling.

    Owns the Output construction and flush, error conversion, and client
    cleanup.

    Args:
        args: Parsed argparse namespace (carries ``json`` and ``uri``).
        fn: The command body; returns its exit code.

    Returns:
        The command's exit code.
    """
    out = Output(getattr(args, 'json', None))
    code = 0
    try:
        code = await fn(out)
    except Exception as err:  # noqa: BLE001
        code = out.fail(str(err), hint_for(err, getattr(args, 'uri', None)))
    finally:
        await disconnect_all()
        out.finish()
    return code


def prompt_line(question: str, fallback: str = '') -> str:
    """
    Prompt for one line of input on the terminal.

    Args:
        question: The prompt text (no trailing space needed).
        fallback: Pre-filled default shown in brackets; returned on empty input.

    Returns:
        The entered (or defaulted) value, stripped.
    """
    suffix = f' [{fallback}]' if fallback else ''
    answer = input(f'{question}{suffix}: ').strip()
    return answer or fallback


def prompt_hidden(question: str) -> str:
    """
    Prompt for a secret on the terminal without echoing it.

    Args:
        question: The prompt text.

    Returns:
        The entered value, stripped.
    """
    return getpass.getpass(f'{question}: ').strip()
