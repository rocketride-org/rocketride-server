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

import re
from typing import Any

# The end of an engine error's text: " at (<source file>:<line>)" (engLib store/python/bindings.cpp).
# The file is a full path for Python code, which on Windows can hold "(x86)"; a bare file name for
# the engine's own C++; or "<Unknown>" with line -1 when there was no traceback. An error whose
# message quotes another engine error ends in one location per level. Only a file name (an
# extension, or <...>) counts, so ordinary text such as "retry at (10:30)" stays.
_ENGINE_LOCATION = re.compile(r'(?: at \((?:<[^<>()]*>|(?:[^()]|\([^()]*\))*\.\w+):-?\d+\))+$')


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


def error_text(error: BaseException | str, with_type: bool = False) -> str:
    """The text of an error, for text a user or a parent agent reads: no engine source location.

    An error raised inside the engine reaches Python as an Exception whose ``str()`` is
    ``<code>: <message> at (<source file>:<line>)``, marked ``__formatted`` (engLib
    store/python/bindings.cpp). Answers are shown to customers, so they get the same text
    without the location. The code stays: callers that tell an error answer by its label
    (Discord) rely on it. The location is dropped from any exception or string, so a
    message that quotes an engine error loses it too. Logs keep ``str()``.

    Args:
        error: The exception, or an error's text (a framework event's ``error`` field).
        with_type: Open with the exception's type name, ``<Type>: <text>``. An engine error
            already opens with its code, so it gets no second label.
    """
    text = _ENGINE_LOCATION.sub('', safe_str(error)).rstrip()
    if with_type and not getattr(error, '__formatted', False):
        return f'{type(error).__name__}: {text}'
    return text
