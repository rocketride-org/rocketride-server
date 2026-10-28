# =============================================================================
# RocketRide Engine
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

"""The two places tool_tenki reaches into tenki SDK internals, kept engine-free so test_tool_tenki_sdk.py runs them."""

from __future__ import annotations

import functools

# The file calls that return one answer. The streaming read and write are left alone: the node uses neither.
UNARY_FILE_CALLS = frozenset({'stat', 'read_file', 'write_file', 'list', 'mkdir', 'remove'})


class DiscardStream:
    """Takes the place of a ``ProcessStream``: accepts every chunk and keeps none."""

    def push(self, data: bytes) -> None:
        pass

    def close(self) -> None:
        pass

    def fail(self, error: Exception) -> None:
        pass

    def __iter__(self):
        return iter(())

    def read(self) -> bytes:
        return b''

    def read_text(self, encoding: str = 'utf-8') -> str:
        return ''


def stop_keeping_output(process) -> None:
    """Make the SDK drop everything ``process`` prints from now on, and end the streams its readers block on."""
    # The SDK keeps every chunk until the command exits, with no limit, but looks the streams up on the process for
    # each frame (Process._pump, tenki 1.4.1), so swapping them is what stops the keeping.
    replaced = (process.stdout, process.stderr)
    process.stdout, process.stderr = DiscardStream(), DiscardStream()
    for stream in replaced:
        stream.close()


class FileCallDeadline:
    """Stands in for the object a session's file API sends its calls through, adding a gRPC deadline."""

    def __init__(self, rpc, timeout: float) -> None:
        self._rpc = rpc
        self._timeout = timeout

    def __getattr__(self, name: str):
        call = getattr(self._rpc, name)
        return functools.partial(call, timeout=self._timeout) if name in UNARY_FILE_CALLS else call


def bound_file_calls(session, timeout: float) -> None:
    """Send every unary file call of ``session`` with a deadline; raises AttributeError if the SDK changed shape."""
    # The SDK sends file calls with no deadline (tenki 1.0.6 to 1.4.1) and its file API takes none, so one stalled
    # connection would hang them for good; SandboxFS._rpc is the one object they all go out through.
    files = session.fs
    files._rpc = FileCallDeadline(files._rpc, timeout)
