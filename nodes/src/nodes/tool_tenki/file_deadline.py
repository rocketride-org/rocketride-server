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

"""
A deadline for a Tenki session's file calls.

The SDK applies the client's ``timeout`` to control-plane calls only. A session's file calls go to
its data plane, and there the SDK (tenki 1.0.6 through 1.4.1, ``tenki_sandbox/data_plane.py``) sends them
with no deadline at all, so one stalled or half-open connection would hang ``read_file``,
``write_file`` and the rest for good. Its file API takes no timeout either. It does pass keyword
arguments on to gRPC, so the deadline is added at the one object every file call of a session goes
out through.

That object is a private attribute of the SDK (``SandboxFS._rpc``), which is why this lives in a
module of its own, free of engine imports: test_tool_tenki_sdk.py runs it against the real SDK. It
pins the attribute, pins that the deadline reaches gRPC on both planes, and pins that a call left
alone still gets none, so a release that changes any of this fails there instead of hanging here.

Not covered: the SDK's own check of a session's data plane. When the SDK has not yet seen that plane
answer (after every resume, and on a new session if Tenki did not mark it verified), the first FILE
call makes the SDK send a Stat of its own, with no deadline, while holding its lock on the plane
(``Sandbox._ensure_data_plane``). If that request stalls, the file call waits on it whatever its
own deadline, and so does every later call on the session, including the close at shutdown. A
command does not go through that check, and its first answer marks the plane as verified, so the
node runs one bounded no-op command after every create and resume (``IGlobal._ensure_warm``) before
any other call. What is left exposed is a file call already under way when a parallel call resumes
the session.
"""

from __future__ import annotations

import functools

#: The file calls that return one answer, by the name the SDK's file API calls them. The streaming
#: read and write are not here: a deadline on a stream would cap the transfer rather than a stall,
#: and the node uses neither.
UNARY_FILE_CALLS = frozenset({'stat', 'read_file', 'write_file', 'list', 'mkdir', 'remove'})


class FileCallDeadline:
    """Stands in for the object a session's file API sends its calls through, adding the deadline."""

    def __init__(self, rpc, timeout: float) -> None:
        self._rpc = rpc
        self._timeout = timeout

    def __getattr__(self, name: str):
        call = getattr(self._rpc, name)
        if name not in UNARY_FILE_CALLS:
            return call
        return functools.partial(call, timeout=self._timeout)


def bound_file_calls(session, timeout: float) -> None:
    """Send every unary file call ``session`` makes from now on with a deadline of ``timeout`` seconds.

    A call that runs past it fails with the SDK's ``CommandTimeoutError``, like any other call that
    reaches its deadline.

    Raises:
        AttributeError: If the SDK's file API no longer has the shape this relies on. The caller
            must not go on to use a session whose file calls it could not bound.
    """
    files = session.fs
    files._rpc = FileCallDeadline(files._rpc, timeout)
