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

"""Test double of ``psycopg2.sql``: the same composition API, rendered without a server.

``as_string(context)`` accepts any context (the real module needs a live
connection to quote identifiers), and renders identifiers and literals the way
PostgreSQL reads them.
"""

from __future__ import annotations

import string

from typing import Any, Iterable, List


class Composable:
    """Base of every composable SQL piece."""

    def __init__(self, wrapped: Any) -> None:
        self._wrapped = wrapped

    def as_string(self, context: Any = None) -> str:  # pragma: no cover - abstract
        raise NotImplementedError

    def __add__(self, other: Any) -> 'Composed':
        if isinstance(other, Composed):
            return Composed([self] + other.seq)
        if isinstance(other, Composable):
            return Composed([self, other])
        return NotImplemented

    def __mul__(self, n: int) -> 'Composed':
        return Composed([self] * n)

    def __eq__(self, other: Any) -> bool:
        return type(self) is type(other) and self._wrapped == other._wrapped

    def __ne__(self, other: Any) -> bool:
        return not self.__eq__(other)

    def __repr__(self) -> str:
        return f'{type(self).__name__}({self._wrapped!r})'


class Composed(Composable):
    """A sequence of composables."""

    def __init__(self, seq: Iterable[Composable]) -> None:
        items = list(seq)
        for item in items:
            if not isinstance(item, Composable):
                raise TypeError(f'Composed elements must be Composable, got {item!r} instead')
        super().__init__(items)

    @property
    def seq(self) -> List[Composable]:
        return list(self._wrapped)

    def as_string(self, context: Any = None) -> str:
        return ''.join(item.as_string(context) for item in self._wrapped)

    def __iter__(self):
        return iter(self._wrapped)

    def __add__(self, other: Any) -> 'Composed':
        if isinstance(other, Composed):
            return Composed(self._wrapped + other._wrapped)
        if isinstance(other, Composable):
            return Composed(self._wrapped + [other])
        return NotImplemented

    def join(self, joiner: Any) -> 'Composed':
        if isinstance(joiner, str):
            joiner = SQL(joiner)
        return joiner.join(self._wrapped)


class SQL(Composable):
    """A piece of SQL text; ``{}`` placeholders are filled by :meth:`format`."""

    def __init__(self, text: str) -> None:
        if not isinstance(text, str):
            raise TypeError('SQL values must be strings')
        super().__init__(text)

    @property
    def string(self) -> str:
        return self._wrapped

    def as_string(self, context: Any = None) -> str:
        return self._wrapped

    def format(self, *args: Any, **kwargs: Any) -> Composed:
        rv: List[Composable] = []
        auto = 0
        for literal, field, spec, conversion in string.Formatter().parse(self._wrapped):
            if spec or conversion:
                raise ValueError('no format specification allowed by SQL')
            if literal:
                rv.append(SQL(literal))
            if field is None:
                continue
            if field == '':
                value = args[auto]
                auto += 1
            elif field.isdigit():
                value = args[int(field)]
            else:
                value = kwargs[field]
            if not isinstance(value, Composable):
                raise TypeError(f'SQL.format arguments must be Composable, got {value!r}')
            rv.append(value)
        return Composed(rv)

    def join(self, seq: Iterable[Composable]) -> Composed:
        rv: List[Composable] = []
        for i, item in enumerate(seq):
            if i:
                rv.append(self)
            rv.append(item)
        return Composed(rv)


class Identifier(Composable):
    """A quoted identifier (``"name"`` or ``"schema"."name"``)."""

    def __init__(self, *strings: str) -> None:
        if not strings:
            raise TypeError('Identifier cannot be empty')
        for s in strings:
            if not isinstance(s, str):
                raise TypeError('SQL identifier parts must be strings')
        super().__init__(strings)

    @property
    def strings(self):
        return self._wrapped

    def as_string(self, context: Any = None) -> str:
        return '.'.join('"' + s.replace('"', '""') + '"' for s in self._wrapped)


class Literal(Composable):
    """A literal value rendered as SQL."""

    def as_string(self, context: Any = None) -> str:
        value = self._wrapped
        if value is None:
            return 'NULL'
        if isinstance(value, bool):
            return 'true' if value else 'false'
        if isinstance(value, (int, float)):
            return repr(value)
        return "'" + str(value).replace("'", "''") + "'"


class Placeholder(Composable):
    """A parameter placeholder (``%s`` or ``%(name)s``)."""

    def __init__(self, name: Any = None) -> None:
        super().__init__(name)

    def as_string(self, context: Any = None) -> str:
        return '%s' if self._wrapped is None else f'%({self._wrapped})s'


NULL = SQL('NULL')
DEFAULT = SQL('DEFAULT')
