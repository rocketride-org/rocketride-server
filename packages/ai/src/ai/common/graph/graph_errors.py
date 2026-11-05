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

"""The one error shape every graph tool raises (CONTRACT v1 §1 item 7).

A raised graph error's text is ``"<headline>\\n<detail>"``: the first line is a
short, stable headline the app shows as the error title; everything after the
first newline is the database's or driver's own text, which the app shows
under "Database said". Stable headline prefixes:

- ``Refused: ...`` — a safety rule or the database refused the statement
- ``Not supported on Apache AGE <version>: <construct>`` — with a hint
- ``Query timed out after <N> ms``
- ``Invalid read_query input: ...``
- ``Query failed`` — any other database error
"""

from __future__ import annotations

from typing import Optional


class GraphToolError(Exception):
    """A graph tool failure with a headline and an optional detail."""

    def __init__(self, headline: str, detail: Optional[str] = '') -> None:
        self.headline = headline.strip().splitlines()[0] if headline.strip() else 'Query failed'
        self.detail = (detail or '').strip()
        super().__init__(self.headline + (f'\n{self.detail}' if self.detail else ''))


def driver_detail(exc: BaseException, *, max_lines: int = 12, max_chars: int = 2000) -> str:
    """The driver's own message, trimmed to a readable size (never a repr of an object)."""
    text = str(getattr(exc, 'message', None) or exc).strip() or type(exc).__name__
    lines = text.splitlines()[:max_lines]
    out = '\n'.join(lines)
    return out if len(out) <= max_chars else out[: max_chars - 1] + '…'
