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
CLI output channel with uniform ``--json`` semantics.

Every CLI command routes its user-facing output through one Output
instance so the three output modes behave identically everywhere:

    - human (default): line-oriented, append-only text on stdout.
    - ``--json``: stdout carries EXACTLY one JSON value (the command
      result or an error envelope); human progress lines are suppressed
      so stdout stays machine-parseable.
    - ``--json=<file>``: the JSON value is written to the file and the
      human lines keep flowing on stdout.

Errors print as one ``Error: <message> — <hint>`` sentence on stderr in
every mode (stderr is never JSON), and in JSON modes the payload is an
``{"error": {"message": ..., "hint": ...}}`` envelope so scripted
callers never have to parse prose.

This module is the exact behavioral twin of the TypeScript CLI's
``src/cli/output.ts`` — changes here must be mirrored there.
"""

import json
import sys
from typing import Any, Optional


class Output:
    """
    Uniform output channel for one CLI command invocation.

    Modes (from the parsed ``--json`` argument value):
        - ``None``  -> human mode
        - ``'-'``   -> JSON on stdout (bare ``--json``)
        - ``<path>`` -> JSON written to the file
    """

    def __init__(self, json_arg: Optional[str]):
        """
        Create the channel from the command's ``--json`` option value.

        Args:
            json_arg: ``None`` (human mode), ``'-'`` (bare ``--json``,
                JSON on stdout), or a file path (``--json=<file>``).
        """
        # Resolve the three-way mode from the argparse value
        if json_arg is None:
            self._mode = 'human'
            self._file_path = ''
        elif json_arg == '-':
            self._mode = 'stdout'
            self._file_path = ''
        else:
            self._mode = 'file'
            self._file_path = json_arg

        # The command's JSON result; set once by result()/fail()
        self._payload: Any = None
        self._has_payload = False

    @property
    def json_requested(self) -> bool:
        """Whether JSON output was requested in any form."""
        return self._mode != 'human'

    @property
    def interactive(self) -> bool:
        """Whether interactive prompts are allowed (never under bare --json)."""
        return self._mode != 'stdout' and sys.stdin.isatty()

    def line(self, text: str) -> None:
        """
        Emit one human progress/result line.

        Suppressed in bare ``--json`` mode so stdout carries nothing but
        the final JSON value.

        Args:
            text: The line to print.
        """
        if self._mode != 'stdout':
            print(text)

    def result(self, value: Any) -> None:
        """
        Record the command's JSON result payload.

        Args:
            value: JSON-serializable result of the command.
        """
        self._payload = value
        self._has_payload = True

    def fail(self, message: str, hint: str = '') -> int:
        """
        Report a command failure: one sentence + next step on stderr, and
        an error envelope as the JSON payload.

        Args:
            message: What went wrong, as a plain sentence.
            hint: The next step the user should take (may be empty).

        Returns:
            1, so callers can ``return out.fail(...)``.
        """
        # Human-readable failure always lands on stderr, never in the JSON
        print(f'Error: {message} — {hint}' if hint else f'Error: {message}', file=sys.stderr)
        error: dict = {'message': message}
        if hint:
            error['hint'] = hint
        self._payload = {'error': error}
        self._has_payload = True
        return 1

    def finish(self) -> None:
        """
        Flush the JSON payload to its destination.

        Called exactly once, after the command finishes (success or
        failure). A no-op in human mode or when no payload was recorded.
        """
        if self._mode == 'human' or not self._has_payload:
            return
        text = json.dumps(self._payload, indent=2, default=str)
        if self._mode == 'stdout':
            print(text)
        else:
            with open(self._file_path, 'w', encoding='utf-8') as f:
                f.write(text + '\n')
