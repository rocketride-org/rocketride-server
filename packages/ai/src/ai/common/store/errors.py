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

"""Exceptions shared by the vector store drivers and the explorer tools.

The tool wrapper (``vectordb_tool``) maps each of these onto the tool envelope
and never lets one escape the tool boundary:

* :class:`StoreUnsupported` -> ``{'success': False, 'code': 'UNSUPPORTED', 'error': str(e)}``.
  Raised by an optional ``DocumentStoreBase`` hook a driver does not implement.
* :class:`ToolRefusal` -> ``{'success': False, 'code': e.code, 'error': e.message, **e.extra}``.
  Raised by tool code that refuses a call with one of the documented codes
  (``INVALID_INPUT``, ``NOT_FOUND``, ``WRITES_DISABLED``, ...).
* :class:`StoreError` -> ``{'success': False, 'code': 'STORE_ERROR', 'error': ...}``, like any
  other exception. Drivers raise it when the backend failed and the message is safe to show
  (it must never carry a host, DSN, credential or database name).

See ``docs/development/nodes/vector-tool-contract.md``.
"""

from typing import Any, Dict, Optional


class StoreUnsupported(Exception):
    """The driver does not implement an optional store hook.

    The message names the hook and, where useful, why (for example
    ``'sampleChunks(strategy="stratified") is not native on this backend'``).
    """


class StoreError(Exception):
    """The backend failed in a way the caller may be told about.

    The message must be safe to return to a tool caller: no host, port, DSN,
    credential or tenant database name.
    """


class ToolRefusal(Exception):
    """A tool refuses a call with a documented code.

    :param code: One of the codes in ``vx_types.TOOL_CODES`` (for example ``'WRITES_DISABLED'``).
    :param message: A plain sentence for the caller.
    :param extra: Extra envelope keys (for example ``{'retry_after_s': 12}``); merged into the
        failure envelope after ``success``, ``code`` and ``error``.
    """

    def __init__(self, code: str, message: str, extra: Optional[Dict[str, Any]] = None) -> None:
        """Build the refusal; ``extra`` is copied so the caller's dict is never shared."""
        super().__init__(message)
        self.code: str = code
        self.message: str = message
        self.extra: Dict[str, Any] = dict(extra or {})

    def envelope(self) -> Dict[str, Any]:
        """Return the failure envelope this refusal maps to."""
        return {'success': False, 'code': self.code, 'error': self.message, **self.extra}


__all__ = ['StoreError', 'StoreUnsupported', 'ToolRefusal']
