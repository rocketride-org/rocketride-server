# =============================================================================
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
Small string utilities.

This is the single home of ``safe_str``. Both node-side agent drivers and
``ai.common.agent`` internals import from here — there is no duplicate
copy anywhere else in the codebase.
"""

from __future__ import annotations

from typing import Any


def safe_str(value: Any) -> str:
    """Convert any value to a string without raising.

    Returns an empty string for ``None``. For anything else, calls
    ``str(value)``; if ``str()`` itself raises (an object whose ``__str__``
    blows up), returns an empty string. Never propagates an exception.

    Args:
        value: The value to convert. Any type is accepted, including
            objects whose ``__str__`` is malformed.

    Returns:
        The stringified value, or ``''`` for ``None`` / a failing ``__str__``.
    """
    if value is None:
        return ''
    try:
        return str(value)
    except Exception:
        return ''


def error_text(exc: BaseException) -> str:
    """The message of an exception, for text a user reads: no engine source location.

    An error raised inside the engine reaches Python as an Exception whose ``str()``
    ends in `` at (<engine source path>:<line>)``; the engine marks it ``__formatted``
    and keeps the bare message in ``message`` (engLib store/python/bindings.cpp).
    Answers are shown to customers, so they get the bare message; logs keep ``str()``.
    Any other exception is ``str(exc)``. Never raises.
    """
    if getattr(exc, '__formatted', False):
        message = safe_str(getattr(exc, 'message', ''))
        if message:
            return message
    return safe_str(exc)
