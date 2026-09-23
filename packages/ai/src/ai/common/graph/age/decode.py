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

"""agtype decoding: AGE result text -> plain Python values.

Wraps the vendored Apache AGE driver decoder (``_agtype/``, ANTLR-based —
handles the full agtype superset incl. ``::vertex``/``::edge``/``::path``
annotations, nested containers, and numeric edge cases that ``json.loads``
cannot). Graph entities are flattened to plain dicts so rows survive the node
layer's JSON sanitisation:

- vertex -> ``{'id', 'label', 'properties'}``
- edge   -> ``{'id', 'label', 'start_id', 'end_id', 'properties'}``
- path   -> list of those, in traversal order
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from antlr4 import CommonTokenStream, InputStream
from antlr4.error.ErrorListener import ErrorListener

from ._agtype import Edge, Path, Vertex
from ._agtype.builder import ResultVisitor
from ._agtype.gen.AgtypeLexer import AgtypeLexer
from ._agtype.gen.AgtypeParser import AgtypeParser
from .errors import AgeTranslationError


class _StrictErrorListener(ErrorListener):
    """Fail loud on malformed agtype (the vendored default error-recovers silently)."""

    def __init__(self) -> None:
        self.errors: list[str] = []

    def syntaxError(self, recognizer, offendingSymbol, line, column, msg, e):  # noqa: N802 (ANTLR API)
        self.errors.append(f'line {line}:{column} {msg}')


def _parse_agtype_strict(text: str) -> Any:
    """Parse agtype text with the vendored grammar, raising on syntax errors."""
    listener = _StrictErrorListener()
    lexer = AgtypeLexer(InputStream(text))
    lexer.removeErrorListeners()
    lexer.addErrorListener(listener)
    parser = AgtypeParser(CommonTokenStream(lexer))
    parser.removeErrorListeners()
    parser.addErrorListener(listener)
    tree = parser.agType()
    if listener.errors:
        raise AgeTranslationError('agtype syntax error: ' + '; '.join(listener.errors[:3]))
    return tree.accept(ResultVisitor(None))


def _to_plain(value: Any) -> Any:
    if isinstance(value, Vertex):
        return {
            'id': value.id,
            'label': value.label,
            'properties': _to_plain(value.properties or {}),
        }
    if isinstance(value, Edge):
        return {
            'id': value.id,
            'label': value.label,
            'start_id': getattr(value, 'start_id', None),
            'end_id': getattr(value, 'end_id', None),
            'properties': _to_plain(value.properties or {}),
        }
    if isinstance(value, Path):
        return [_to_plain(entity) for entity in value]
    if isinstance(value, Decimal):
        # agtype numerics parse to Decimal; JSON layers downstream want floats.
        return float(value)
    if isinstance(value, dict):
        return {k: _to_plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_plain(v) for v in value]
    return value


def decode_agtype(text: Any) -> Any:
    """Decode one agtype column value into a plain Python value.

    psycopg2 returns agtype columns as ``str`` (no registered adapter); SQL
    NULL arrives as ``None`` and passes through.
    """
    if text is None:
        return None
    if not isinstance(text, str):
        # Defensive: an adapter already produced a Python value.
        return _to_plain(text)
    try:
        return _to_plain(_parse_agtype_strict(text))
    except AgeTranslationError:
        raise
    except Exception as e:
        raise AgeTranslationError(f'Failed to decode agtype value: {e}') from e
