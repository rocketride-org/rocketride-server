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
What a command's output streams are replaced with once the node stops keeping its output.

The SDK keeps every chunk a command prints, in the ``ProcessStream`` behind ``Process.stdout`` and
``Process.stderr``, until the command exits, with no limit of its own. Nothing in its public API stops
that: ``ProcessStream.close`` only ends what a reader sees, and ``Process.kill`` only signals the
process the sandbox started, while the run stream is held by the SDK's own thread (``Process._pump``,
tenki 1.4.1, ``tenki_sandbox/process.py``). That thread does look the streams up on the process for
every frame it receives (``self.stdout.push(...)``), so replacing them with streams that keep nothing
is what stops the keeping, whatever the command does next.

That lookup is SDK internals, which is why this lives in a module of its own, free of engine imports:
test_tool_tenki_sdk.py drives a real ``Process`` through it against a data plane that floods it, and
fails if the SDK keeps anything of what follows.

The node calls this wherever it stops reading a process: at the output limit, and on every path that
gives a process up before its result (a start or a result that never arrived in time, the kill command
itself). The SDK's thread runs on after each of those, and must keep nothing it receives.
"""

from __future__ import annotations


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
    """Replace ``process``'s output streams with ``DiscardStream`` and end the ones they replace.

    From then on the SDK hands each chunk that arrives to a ``DiscardStream``, and its result carries no
    output. Ending the replaced streams releases their readers, and once those finish nothing refers to
    the streams any more, so what they hold is freed. The run itself goes on until the command exits:
    the SDK still receives its output, and drops it.
    """
    replaced = (process.stdout, process.stderr)
    process.stdout, process.stderr = DiscardStream(), DiscardStream()
    for stream in replaced:
        stream.close()
