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

"""Test double of psycopg2 for the shared pgvector store driver.

``nodes/test/mocks`` shadows the real client engine-wide when ``ROCKETRIDE_MOCK``
is set (the mocked ``services.json`` cases), and unit tests load it on purpose.
It is an in-memory stand-in for one PostgreSQL + pgvector database that
understands exactly the statements of ``ai.common.store.pgvector``: every one
of them starts with a ``/* rr-pgvector:<name> */`` tag, and this module
dispatches on that tag. An untagged statement other than the save-time probe
(``SELECT 1``, ``SELECT NULL::vector``) raises ``NotImplementedError``, so a
driver change cannot pass here silently.

What it models: tables with their columns, indexes and rows; ``WHERE``
predicates the driver builds (``=``, ``<>``, ``IS [NOT] TRUE``, ``ANY``, ranges,
key pairs, ``ILIKE``); cosine / L2 / inner-product distances; the seeded id hash samples are
ordered by (``hashtextextended``, modelled by a stable keyed hash);
``DELETE`` row counts; transactions (a read-only transaction refuses writes, a
failed statement aborts the transaction until rollback, rollback undoes
writes); errors with their SQLSTATE. Tests may make the next statement with a
given tag fail (:attr:`MockConnection.fail_next`) or mark a table locked
(:attr:`MockConnection.locked_tables`, which makes the ``meta`` ALTER time out).

Results from this double are never evidence that a backend works: the live
suites (``test_store_postgres_full.py``, ``test_rocketride_db_full.py``) are.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import threading

from typing import Any, Callable, Dict, Iterator, List, Optional, Sequence, Tuple

from . import extensions, sql  # noqa: F401 - exposed as psycopg2.sql / psycopg2.extensions

# =============================================================================
# Exceptions (DB-API hierarchy, with SQLSTATE)
# =============================================================================


class Warning(Exception):  # noqa: A001 - DB-API name
    pass


class Error(Exception):
    def __init__(self, message: str = '', pgcode: Optional[str] = None) -> None:
        super().__init__(message)
        self.pgcode = pgcode
        self.pgerror = message


class InterfaceError(Error):
    pass


class DatabaseError(Error):
    pass


class DataError(DatabaseError):
    pass


class OperationalError(DatabaseError):
    pass


class IntegrityError(DatabaseError):
    pass


class InternalError(DatabaseError):
    pass


class ProgrammingError(DatabaseError):
    pass


class NotSupportedError(DatabaseError):
    pass


# =============================================================================
# The in-memory database
# =============================================================================


class MockTable:
    """One table: ordered columns, rows by id, indexes."""

    def __init__(self, name: str, columns: List[Tuple[str, str]]) -> None:
        self.name = name
        self.columns = columns
        self.rows: Dict[int, Dict[str, Any]] = {}
        self.next_id = 1
        #: name -> (method, definition, reloptions)
        self.indexes: Dict[str, Tuple[str, str, Optional[List[str]]]] = {}

    @property
    def column_names(self) -> List[str]:
        return [c[0] for c in self.columns]

    @property
    def dimension(self) -> Optional[int]:
        for name, kind in self.columns:
            if name == 'embedding':
                match = re.match(r'vector\((\d+)\)', kind)
                return int(match.group(1)) if match else None
        return None


_TAG = re.compile(r'\s*/\*\s*rr-pgvector:(\w+)\s*\*/\s*', re.S)
#: The per-document expressions of a filtered listing (ai.common.store.pgvector.sql.Having).
_DOC_PATH = 'coalesce(min("parent"), \'\')'
_DOC_INGESTED = '(array_agg("meta"->>\'ingestedAt\' ORDER BY "chunkid"))[1]'
_TABLE = re.compile(r'(?:FROM|INTO|TABLE(?: IF NOT EXISTS)?|ON|UPDATE) "([^"]+)"')


def _unquote(regclass: str) -> str:
    return regclass.strip().strip('"').lower()


def _cosine_distance(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return float('nan')
    return 1.0 - dot / (na * nb)


def _distance(op: str, a: Sequence[float], b: Sequence[float]) -> float:
    if len(a) != len(b):
        raise DataError(f'different vector dimensions {len(a)} and {len(b)}', '22000')
    if op == '<=>':
        return _cosine_distance(a, b)
    if op == '<->':
        return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))
    return -sum(x * y for x, y in zip(a, b))


def _parse_vector(text: Any) -> Optional[List[float]]:
    if text is None:
        return None
    if isinstance(text, (list, tuple)):
        return [float(v) for v in text]
    return [float(v) for v in json.loads(text)]


def _id_hash(row_id: Any, seed: int) -> int:
    """A stable keyed hash of a row id: what ``hashtextextended("id"::text, seed)`` stands for here."""
    digest = hashlib.blake2b(f'{seed}:{row_id}'.encode(), digest_size=8).digest()
    return int.from_bytes(digest, 'big', signed=True)


def _like(pattern: str, text: Optional[str], *, ignore_case: bool = True) -> bool:
    """``text ILIKE pattern ESCAPE '\\'`` (``LIKE`` with ``ignore_case=False``)."""
    if text is None:
        return False
    out = ''
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == '\\' and i + 1 < len(pattern):
            out += re.escape(pattern[i + 1])
            i += 2
            continue
        out += '.*' if ch == '%' else '.' if ch == '_' else re.escape(ch)
        i += 1
    return re.fullmatch(out, text, re.S | re.I if ignore_case else re.S) is not None


def _predicate(where: str, params: Iterator[Any]) -> Callable[[Dict[str, Any]], bool]:
    """A row test for a WHERE clause the driver builds; consumes its parameters in order."""
    tests: List[Callable[[Dict[str, Any]], bool]] = []
    for part in where.split(' AND '):
        part = part.strip()
        if part == 'TRUE':
            continue
        if part == 'FALSE':
            tests.append(lambda row: False)
            continue
        match = re.fullmatch(r'"content" ILIKE %s ESCAPE \'\\\'', part)
        if match:
            pattern = next(params)
            tests.append(lambda row, p=pattern: _like(p, row.get('content')))
            continue
        match = re.fullmatch(r'"(\w+)" (=|<>|>=|<=|>) %s', part)
        if match:
            col, op, value = match.group(1), match.group(2), next(params)

            def test(row, col=col, op=op, value=value):
                current = row.get(col)
                if current is None:
                    return False
                return {
                    '=': current == value,
                    '<>': current != value,
                    '>=': current >= value,
                    '<=': current <= value,
                    '>': current > value,
                }[op]

            tests.append(test)
            continue
        match = re.fullmatch(r'"(\w+)" IS (NOT )?TRUE', part)
        if match:
            col, negate = match.group(1), bool(match.group(2))
            tests.append(lambda row, col=col, negate=negate: (row.get(col) is True) != negate)
            continue
        match = re.fullmatch(r'"(\w+)" = ANY\(%s\)', part)
        if match:
            col, values = match.group(1), list(next(params))
            tests.append(lambda row, col=col, values=values: row.get(col) in values)
            continue
        match = re.fullmatch(r'\("objectid", "chunkid"\) (NOT IN|IN) \(((?:\(%s, %s\)(?:, )?)+)\)', part)
        if match:
            count = match.group(2).count('(%s, %s)')
            keys = {(next(params), next(params)) for _ in range(count)}
            negate = match.group(1) == 'NOT IN'
            tests.append(
                lambda row, keys=keys, negate=negate: ((row.get('objectid'), row.get('chunkid')) in keys) != negate
            )
            continue
        raise NotImplementedError(f'psycopg2 test double: unsupported predicate {part!r}')
    return lambda row: all(t(row) for t in tests)


def _select_names(select_list: str) -> List[str]:
    """Column names (or aliases) of a select list the driver builds."""
    names = []
    for item in select_list.split(', '):
        alias = re.search(r' AS "(\w+)"$', item)
        if alias:
            names.append(alias.group(1))
            continue
        match = re.fullmatch(r'"(\w+)"', item.strip())
        if not match:
            raise NotImplementedError(f'psycopg2 test double: unsupported select item {item!r}')
        names.append(match.group(1))
    return names


class MockCursor:
    """A cursor over the in-memory database."""

    def __init__(self, connection: 'MockConnection') -> None:
        self.connection = connection
        self.description: Optional[List[Tuple]] = None
        self.rowcount = -1
        self._results: List[Tuple] = []
        self._index = 0
        self.closed = False

    def __enter__(self) -> 'MockCursor':
        return self

    def __exit__(self, *exc: Any) -> bool:
        self.close()
        return False

    def close(self) -> None:
        self.closed = True

    def fetchone(self) -> Optional[Tuple]:
        if self._index < len(self._results):
            row = self._results[self._index]
            self._index += 1
            return row
        return None

    def fetchall(self) -> List[Tuple]:
        rows = self._results[self._index :]
        self._index = len(self._results)
        return rows

    def _set(self, names: List[str], rows: List[Tuple]) -> None:
        self.description = [(name, None, None, None, None, None, None) for name in names]
        self._results = list(rows)
        self._index = 0
        self.rowcount = len(rows)

    # ------------------------------------------------------------------

    def execute(self, query: Any, params: Optional[Sequence[Any]] = None) -> None:
        conn = self.connection
        if conn.closed:
            raise InterfaceError('connection already closed')
        text = query.as_string(self) if hasattr(query, 'as_string') else str(query)
        conn.executed.append((text, list(params) if params is not None else None))
        if conn._status == 'error':
            raise InternalError(
                'current transaction is aborted, commands ignored until end of transaction block', '25P02'
            )
        conn._status = 'intrans'
        try:
            self._dispatch(text, list(params or []))
        except Error:
            conn._status = 'error'
            raise

    def _dispatch(self, text: str, params: List[Any]) -> None:
        db = MockConnection
        self.description = None
        self._results = []
        self._index = 0
        self.rowcount = -1
        match = _TAG.match(text)
        if not match:
            stripped = text.strip().rstrip(';').strip()
            if stripped in ('SELECT 1', 'SELECT NULL::vector'):
                self._set(['?column?'], [(1 if stripped == 'SELECT 1' else None,)])
                return
            raise NotImplementedError(f'psycopg2 test double: unsupported statement {text[:80]!r}')
        tag = match.group(1)
        failure = db.fail_next.pop(tag, None)
        if failure is not None:
            raise failure
        body = text[match.end() :]
        handler = getattr(self, '_op_' + tag, None)
        if handler is None and tag.startswith('sample_'):
            handler = self._op_sample
        if handler is None:
            raise NotImplementedError(f'psycopg2 test double: unsupported statement tag {tag!r}')
        with db._lock:
            handler(body, params, tag)

    # --- helpers ---------------------------------------------------------------

    def _table(self, body: str, *, required: bool = True) -> Optional[MockTable]:
        match = _TABLE.search(body)
        if not match:
            raise NotImplementedError(f'psycopg2 test double: no table in {body[:80]!r}')
        table = MockConnection._tables.get(match.group(1))
        if table is None and required:
            raise ProgrammingError(f'relation "{match.group(1)}" does not exist', '42P01')
        return table

    def _write(self, table: MockTable) -> None:
        conn = self.connection
        if conn._read_only:
            raise InternalError('cannot execute statement in a read-only transaction', '25006')
        if table.name not in conn._snapshots:
            conn._snapshots[table.name] = copy.deepcopy(table)

    @staticmethod
    def _where(
        body: str, params: List[Any], stop: str = r' GROUP BY | ORDER BY | LIMIT |$'
    ) -> Tuple[Callable, Iterator[Any]]:
        it = iter(params)
        match = re.search(r' WHERE (.*?)(?:' + stop + ')', body, re.S)
        if not match:
            return (lambda row: True), it
        return _predicate(match.group(1), it), it

    def _rows_out(
        self, names: List[str], rows: List[Dict[str, Any]], extra: Optional[Dict[int, Dict[str, Any]]] = None
    ) -> None:
        out = []
        for row in rows:
            values = []
            for name in names:
                if name == 'embedding_text':
                    emb = row.get('embedding')
                    values.append(None if emb is None else '[' + ','.join(repr(float(v)) for v in emb) + ']')
                elif extra is not None and name in extra.get(id(row), {}):
                    values.append(extra[id(row)][name])
                else:
                    values.append(copy.deepcopy(row.get(name)))
            out.append(tuple(values))
        self._set(names, out)

    # --- transaction bootstrap -------------------------------------------------

    def _op_begin_read(self, body: str, params: List[Any], tag: str) -> None:
        conn = self.connection
        conn._read_only = True
        conn.settings = {}
        for name, value in re.findall(r"SET LOCAL ([\w.]+) = '?([\w.]+)'?", body):
            conn.settings[name] = value

    def _op_begin_write(self, body: str, params: List[Any], tag: str) -> None:
        conn = self.connection
        conn.settings = {}
        for name, value in re.findall(r"SET LOCAL ([\w.]+) = '?([\w.]+)'?", body):
            conn.settings[name] = value

    def _op_lock(self, body: str, params: List[Any], tag: str) -> None:
        self._set(['pg_advisory_xact_lock'], [(None,)])

    # --- catalog ---------------------------------------------------------------

    def _op_extension_version(self, body: str, params: List[Any], tag: str) -> None:
        version = MockConnection.extension_version
        self._set(['extversion'], [(version,)] if version else [])

    def _op_exists(self, body: str, params: List[Any], tag: str) -> None:
        self._set(['?column?'], [(_unquote(params[0]) in MockConnection._tables,)])

    def _op_has_rows(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        self._set(['exists'], [(bool(table.rows),)])

    def _op_columns(self, body: str, params: List[Any], tag: str) -> None:
        table = MockConnection._tables.get(_unquote(params[0]))
        self._set(['attname', 'format_type'], list(table.columns) if table else [])

    def _op_indexes(self, body: str, params: List[Any], tag: str) -> None:
        table = MockConnection._tables.get(_unquote(params[0]))
        rows = []
        if table:
            for name in sorted(table.indexes):
                method, definition, options = table.indexes[name]
                rows.append((name, method, definition, options))
        self._set(['relname', 'amname', 'pg_get_indexdef', 'reloptions'], rows)

    def _op_size(self, body: str, params: List[Any], tag: str) -> None:
        table = MockConnection._tables.get(_unquote(params[0]))
        self._set(['pg_total_relation_size'], [(8192 * (1 + len(table.rows)) if table else None,)])

    def _op_control(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        rows = [r for r in table.rows.values() if r.get('objectid') == params[0]]
        self._set(['modelname', 'vectorsize'], [(r.get('modelname'), r.get('vectorsize')) for r in rows])

    # --- DDL -------------------------------------------------------------------

    def _op_create_table(self, body: str, params: List[Any], tag: str) -> None:
        match = re.match(r'CREATE TABLE IF NOT EXISTS "(\w+)" \((.*)\)$', body.strip(), re.S)
        if not match:
            raise NotImplementedError(f'psycopg2 test double: unsupported DDL {body[:80]!r}')
        name = match.group(1)
        if self.connection._read_only:
            raise InternalError('cannot execute CREATE TABLE in a read-only transaction', '25006')
        if name in MockConnection._tables:
            return
        columns = []
        for definition in match.group(2).split(', '):
            col, _, kind = definition.partition(' ')
            columns.append((col, kind.replace(' PRIMARY KEY', '')))
        MockConnection._tables[name] = MockTable(name, columns)
        self.connection._created.append(name)

    def _op_create_key_index(self, body: str, params: List[Any], tag: str) -> None:
        match = re.match(r'CREATE INDEX IF NOT EXISTS "(\w+)" ON "(\w+)" \(("objectid", "chunkid")\)', body.strip())
        if not match:
            raise NotImplementedError(f'psycopg2 test double: unsupported DDL {body[:80]!r}')
        table = MockConnection._tables[match.group(2)]
        table.indexes.setdefault(
            match.group(1),
            ('btree', f'CREATE INDEX {match.group(1)} ON public.{table.name} USING btree (objectid, chunkid)', None),
        )

    def _op_create_hnsw_index(self, body: str, params: List[Any], tag: str) -> None:
        match = re.match(
            r'CREATE INDEX IF NOT EXISTS "(\w+)" ON "(\w+)" USING hnsw \("embedding" (\w+)\) WITH \(m = (\d+), ef_construction = (\d+)\)',
            body.strip(),
        )
        if not match:
            raise NotImplementedError(f'psycopg2 test double: unsupported DDL {body[:80]!r}')
        name, table_name, opclass, m, ef = match.groups()
        table = MockConnection._tables[table_name]
        definition = f"CREATE INDEX {name} ON public.{table_name} USING hnsw (embedding {opclass}) WITH (m='{m}', ef_construction='{ef}')"
        table.indexes.setdefault(name, ('hnsw', definition, [f'm={m}', f'ef_construction={ef}']))

    def _op_add_meta_column(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        if table.name in MockConnection.locked_tables:
            raise OperationalError(f'canceling statement due to lock timeout on "{table.name}"', '55P03')
        self._write(table)
        if 'meta' not in table.column_names:
            table.columns.append(('meta', 'jsonb'))

    # --- reads -----------------------------------------------------------------

    def _op_count_all(self, body: str, params: List[Any], tag: str) -> None:
        self._set(['count'], [(len(self._table(body).rows),)])

    def _op_count_chunks(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        test, _ = self._where(body, params)
        self._set(['count'], [(sum(1 for r in table.rows.values() if test(r)),)])

    def _op_count_documents(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        test, _ = self._where(body, params)
        self._set(['count'], [(len({r.get('objectid') for r in table.rows.values() if test(r)}),)])

    def _read_list(self, body: str) -> List[str]:
        match = re.match(r'SELECT (.*?) FROM "\w+"', body, re.S)
        return _select_names(match.group(1))

    def _ordered(self, rows: List[Dict[str, Any]], keys: Sequence[str]) -> List[Dict[str, Any]]:
        def key(row):
            return tuple((row.get(k) is None, row.get(k) if row.get(k) is not None else 0) for k in keys)

        return sorted(rows, key=key)

    def _paged(self, rows: List[Any], it: Iterator[Any]) -> List[Any]:
        limit = next(it)
        offset = next(it)
        rows = rows[offset:]
        return rows if limit is None else rows[:limit]

    def _op_get(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        test, it = self._where(body, params)
        rows = self._ordered([r for r in table.rows.values() if test(r)], ('objectid', 'chunkid'))
        self._rows_out(self._read_list(body), self._paged(rows, it))

    _op_keyword = _op_get

    def _op_semantic(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        match = re.match(r'SELECT (.*), "embedding" (<=>|<->|<#>) %s::vector AS "distance" FROM', body, re.S)
        names = _select_names(match.group(1)) + ['distance']
        op = match.group(2)
        query = _parse_vector(params[0])
        test, it = self._where(body, params[1:])
        scored = []
        for row in table.rows.values():
            if not test(row) or row.get('embedding') is None:
                continue
            scored.append((_distance(op, row['embedding'], query), row))
        scored.sort(key=lambda pair: (math.isnan(pair[0]), pair[0]))
        page = self._paged(scored, it)
        self._rows_out(names, [row for _d, row in page], {id(row): {'distance': d} for d, row in page})

    def _op_semantic_exact(self, body: str, params: List[Any], tag: str) -> None:
        """The exact recovery search: the semantic statement under a subquery that drops undefined distances."""
        inner = body[body.index('(') + 1 : body.rindex(') AS candidates')]
        self._op_semantic(inner + ' ORDER BY "distance" LIMIT %s OFFSET %s', params, tag)
        self._results = [row for row in self._results if row[-1] is not None and math.isfinite(row[-1])]
        self.rowcount = len(self._results)

    def _op_has_ann_index(self, body: str, params: List[Any], tag: str) -> None:
        table = MockConnection._tables.get(_unquote(params[0]))
        has = bool(table) and any(
            method in ('hnsw', 'ivfflat') for method, _definition, _options in table.indexes.values()
        )
        self._set(['exists'], [(has,)])

    def _op_paths(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        test, it = self._where(body, params)
        rows = self._ordered([r for r in table.rows.values() if test(r)], ('parent', 'objectid'))
        # DISTINCT ON (parent): the first row (the lowest object id) of each path, so the page counts paths.
        distinct: List[Dict[str, Any]] = []
        for row in rows:
            if not distinct or distinct[-1].get('parent') != row.get('parent'):
                distinct.append(row)
        self._set(['parent', 'objectid'], [(r.get('parent'), r.get('objectid')) for r in self._paged(distinct, it)])

    def _op_render(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        object_id, after, limit = params
        rows = sorted(
            (r for r in table.rows.values() if r.get('objectid') == object_id and (r.get('chunkid') or 0) > after),
            key=lambda r: r.get('chunkid') or 0,
        )
        self._set(['content', 'chunkid'], [(r.get('content'), r.get('chunkid')) for r in rows[:limit]])

    @staticmethod
    def _documents(table: MockTable, test: Callable) -> Dict[str, List[Dict[str, Any]]]:
        """The rows matching ``test``, grouped by objectId, each group in chunk order."""
        groups: Dict[str, List[Dict[str, Any]]] = {}
        for row in table.rows.values():
            if test(row):
                groups.setdefault(row.get('objectid'), []).append(row)
        return {oid: sorted(rows, key=lambda r: r.get('chunkid') or 0) for oid, rows in groups.items()}

    @staticmethod
    def _path(rows: List[Dict[str, Any]]) -> str:
        parents = [r.get('parent') for r in rows if r.get('parent') is not None]
        return min(parents) if parents else ''

    @classmethod
    def _having(cls, conditions: str, it: Iterator[Any]) -> Tuple[Optional[Tuple[str, str]], List[Callable]]:
        """The keyset position and the document tests of a listing's ``HAVING`` (the documents filter).

        Each test takes ``(path, rows)``: a document's path and its rows in chunk order.
        """
        after: Optional[Tuple[str, str]] = None
        tests: List[Callable[[str, List[Dict[str, Any]]], bool]] = []
        path = re.escape(_DOC_PATH)
        ingested = re.escape(_DOC_INGESTED)
        for part in conditions.split(' AND '):
            part = part.strip()
            if re.fullmatch(r'\(' + path + r', "objectid"\) > \(%s, %s\)', part):
                after = (next(it), next(it))
                continue
            match = re.fullmatch(path + r" (I?LIKE) %s ESCAPE '\\'", part)
            if match:
                pattern, ignore_case = next(it), match.group(1) == 'ILIKE'
                tests.append(lambda p, rows, pat=pattern, ic=ignore_case: _like(pat, p, ignore_case=ic))
                continue
            if re.fullmatch(r'lower\(' + path + r'\) LIKE ANY\(%s\)', part):
                patterns = list(next(it))
                tests.append(lambda p, rows, pats=patterns: any(_like(x, p.lower(), ignore_case=False) for x in pats))
                continue
            match = re.fullmatch(ingested + r' (>=|<) %s', part)
            if match:
                op, bound = match.group(1), next(it)

                def first_ingested(p, rows, op=op, bound=bound):
                    value = (rows[0].get('meta') or {}).get('ingestedAt') if rows else None
                    if value is None:
                        return False
                    return value >= bound if op == '>=' else value < bound

                tests.append(first_ingested)
                continue
            match = re.fullmatch(r'count\(\*\) (>=|<=) %s', part)
            if match:
                op, bound = match.group(1), next(it)
                tests.append(lambda p, rows, op=op, b=bound: len(rows) >= b if op == '>=' else len(rows) <= b)
                continue
            match = re.fullmatch(r'coalesce\(bool_or\(("chunkid" = 0|"istable")\), false\) = %s', part)
            if match:
                flag, wanted = match.group(1), next(it)
                if flag == '"istable"':
                    tests.append(lambda p, rows, w=wanted: any(r.get('istable') is True for r in rows) == w)
                else:
                    tests.append(lambda p, rows, w=wanted: any(r.get('chunkid') == 0 for r in rows) == w)
                continue
            raise NotImplementedError(f'psycopg2 test double: unsupported HAVING condition {part!r}')
        return after, tests

    def _op_list_document_keys(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        test, it = self._where(body, params, stop=r' GROUP BY ')
        groups = self._documents(table, test)
        having = re.search(r' HAVING (.*) ORDER BY 2, 1 LIMIT ', body, re.S)
        after, tests = self._having(having.group(1), it) if having else (None, [])
        limit = next(it)
        keys = sorted(
            (self._path(rows), oid) for oid, rows in groups.items() if all(t(self._path(rows), rows) for t in tests)
        )
        with_total = 'count(*) OVER ()' in body
        out = [
            (oid, path, len(keys)) if with_total else (oid, path)
            for path, oid in keys
            if after is None or (path, oid) > after
        ]
        self._set(['objectid', 'path', 'total'] if with_total else ['objectid', 'path'], out[:limit])

    def _op_list_documents(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        if ' HAVING ' in body or ' LIMIT ' in body:
            raise NotImplementedError('psycopg2 test double: a documents page is read by its objectIds')
        # Every figure but deleted_chunks counts the rows of the listing's mode (FILTER (WHERE <mode>)).
        mode = re.search(r'count\(\*\) FILTER \(WHERE (.*?)\) AS "chunks"', body)
        if mode is None:
            raise NotImplementedError('psycopg2 test double: a documents page names the rows of its mode')
        in_mode = _predicate(mode.group(1), iter(()))
        test, _ = self._where(body, params, stop=r' GROUP BY ')
        has_meta = '"meta" ORDER BY' in body
        out = []
        for object_id, every in self._documents(table, test).items():
            rows = [r for r in every if in_mode(r)]
            chunk_ids = [r.get('chunkid') for r in rows if r.get('chunkid') is not None]
            out.append(
                (
                    object_id,
                    self._path(rows),
                    len(rows),
                    any(r.get('chunkid') == 0 for r in rows),
                    any(bool(r.get('isdeleted')) for r in rows),
                    sum(1 for r in rows if r.get('istable')),
                    rows[0].get('nodeid') if rows else None,
                    rows[0].get('id') if rows else None,
                    copy.deepcopy(rows[0].get('meta')) if has_meta and rows else None,
                    max(chunk_ids) if chunk_ids else None,
                    sum(1 for r in every if r.get('isdeleted') is True),
                )
            )
        out.sort(key=lambda r: (r[1], r[0]))
        self._set(
            [
                'objectid',
                'path',
                'chunks',
                'has_first_chunk',
                'deleted',
                'tables',
                'nodeid',
                'point_id',
                'meta',
                'max_chunk_id',
                'deleted_chunks',
            ],
            out,
        )

    def _op_scroll(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        test, it = self._where(body, params)
        rows = self._ordered([r for r in table.rows.values() if test(r)], ('chunkid',))
        self._rows_out(self._read_list(body), rows[: next(it)])

    def _op_vectors(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        test, _ = self._where(body, params)
        rows = self._ordered([r for r in table.rows.values() if test(r)], ('objectid', 'chunkid'))
        self._rows_out(self._read_list(body), rows)

    def _op_sample(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        strategy = tag[len('sample_') :]
        if 'setseed' in body or 'random()' in body:
            raise NotImplementedError('psycopg2 test double: samples are ordered by a seeded id hash')
        it = iter(params)
        seeds = [next(it), next(it)] if strategy == 'stratified' else []
        match = re.search(r' FROM "\w+" WHERE (.*?)(?: ORDER BY |\), "pick")', body, re.S)
        test = _predicate(match.group(1), it)
        if strategy == 'random':
            seeds = [next(it)]
        limit = next(it)
        rows = [r for r in self._ordered(list(table.rows.values()), ('id',)) if test(r)]
        if strategy == 'random':
            picked = sorted(rows, key=lambda r: (_id_hash(r.get('id'), seeds[0]), r.get('id')))[:limit]
        elif strategy == 'stratified':
            by_doc: Dict[str, List[Dict[str, Any]]] = {}
            for r in rows:
                by_doc.setdefault(r.get('objectid'), []).append(r)
            ranked = []
            for entries in by_doc.values():
                entries.sort(key=lambda r: (r.get('chunkid') != 0, _id_hash(r.get('id'), seeds[0]), r.get('id')))
                for rn, r in enumerate(entries, start=1):
                    ranked.append((rn, _id_hash(r.get('id'), seeds[1]), r.get('id'), r))
            ranked.sort(key=lambda p: p[:3])
            picked = [p[3] for p in ranked[:limit]]
        else:
            picked = self._ordered(rows, ('parent', 'objectid', 'chunkid'))[:limit]
        final = re.search(r'^.*\bSELECT (.*?) FROM "\w+" JOIN "pick"', body, re.S)  # the outer SELECT
        self._rows_out(_select_names(final.group(1)), self._ordered(picked, ('objectid', 'chunkid')))

    # --- writes ----------------------------------------------------------------

    def _op_insert(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        self._write(table)
        match = re.match(r'INSERT INTO "\w+" \((.*?)\) VALUES', body)
        columns = [c.strip().strip('"') for c in match.group(1).split(',')]
        unknown = [c for c in columns if c not in table.column_names]
        if unknown:
            raise ProgrammingError(f'column "{unknown[0]}" of relation "{table.name}" does not exist', '42703')
        width = len(columns)
        if not params or len(params) % width:
            raise ProgrammingError('INSERT has more expressions than target columns', '42601')
        dimension = table.dimension
        for start in range(0, len(params), width):
            record = dict(zip(columns, params[start : start + width]))
            if 'embedding' in record:
                record['embedding'] = _parse_vector(record['embedding'])
                if record['embedding'] is not None and dimension and len(record['embedding']) != dimension:
                    raise DataError(f'expected {dimension} dimensions, not {len(record["embedding"])}', '22000')
            if isinstance(record.get('meta'), str):
                record['meta'] = json.loads(record['meta'])
            if isinstance(record.get('content'), str) and '\x00' in record['content']:
                raise DataError('invalid byte sequence for encoding "UTF8": 0x00', '22021')
            record['id'] = table.next_id
            table.rows[table.next_id] = record
            table.next_id += 1
        self.rowcount = len(params) // width

    def _op_delete(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        self._write(table)
        test, _ = self._where(body, params)
        doomed = [rid for rid, row in table.rows.items() if test(row)]
        for rid in doomed:
            del table.rows[rid]
        self.rowcount = len(doomed)

    def _op_set_deleted(self, body: str, params: List[Any], tag: str) -> None:
        table = self._table(body)
        self._write(table)
        value = params[0]
        test, _ = self._where(body, params[1:])
        count = 0
        for row in table.rows.values():
            if test(row):
                row['isdeleted'] = value
                count += 1
        self.rowcount = count


class MockConnection:
    """One connection to the shared in-memory database."""

    # Class-level state: one database for the whole process (reset() between tests).
    _tables: Dict[str, MockTable] = {}
    _lock = threading.RLock()
    #: Statement tag -> the exception its next execution raises (consumed once).
    fail_next: Dict[str, Exception] = {}
    #: Tables another session holds: the ``meta`` ALTER times out on them.
    locked_tables: set = set()
    #: What ``SELECT extversion FROM pg_extension`` answers (None: pgvector is not installed).
    extension_version: Optional[str] = '0.8.0'
    #: Every connection opened since the last reset().
    opened: List['MockConnection'] = []

    def __init__(self, **kwargs: Any) -> None:
        self.dsn = kwargs.get('dsn')
        self.dbname = kwargs.get('dbname')
        self.user = kwargs.get('user')
        self.password = kwargs.get('password')
        self.host = kwargs.get('host')
        self.port = kwargs.get('port')
        self.application_name = kwargs.get('application_name')
        self.autocommit = False
        self.closed = 0
        self.executed: List[Tuple[str, Optional[List[Any]]]] = []
        self.settings: Dict[str, str] = {}
        self.commits = 0
        self.rollbacks = 0
        self._status = 'idle'
        self._read_only = False
        self._snapshots: Dict[str, MockTable] = {}
        self._created: List[str] = []
        MockConnection.opened.append(self)

    def cursor(self, *args: Any, **kwargs: Any) -> MockCursor:
        if self.closed:
            raise InterfaceError('connection already closed')
        return MockCursor(self)

    def _end(self) -> None:
        self._status = 'idle'
        self._read_only = False
        self._snapshots = {}
        self._created = []
        self.settings = {}

    def commit(self) -> None:
        if self._status == 'error':
            self.rollback()
            return
        self.commits += 1
        self._end()

    def rollback(self) -> None:
        with MockConnection._lock:
            for name, snapshot in self._snapshots.items():
                MockConnection._tables[name] = snapshot
            for name in self._created:
                MockConnection._tables.pop(name, None)
        self.rollbacks += 1
        self._end()

    def get_transaction_status(self) -> int:
        return {
            'idle': extensions.TRANSACTION_STATUS_IDLE,
            'intrans': extensions.TRANSACTION_STATUS_INTRANS,
            'error': extensions.TRANSACTION_STATUS_INERROR,
        }[self._status]

    def close(self) -> None:
        if not self.closed and self._status != 'idle':
            self.rollback()
        self.closed = 1

    @classmethod
    def reset(cls) -> None:
        """Forget every table, injected failure, lock and connection."""
        with cls._lock:
            cls._tables.clear()
        cls.fail_next.clear()
        cls.locked_tables.clear()
        cls.extension_version = '0.8.0'
        cls.opened.clear()

    @classmethod
    def table(cls, name: str) -> Optional[MockTable]:
        """The in-memory table ``name`` (for assertions)."""
        return cls._tables.get(name)


def connect(
    dsn: Optional[str] = None, connection_factory: Any = None, cursor_factory: Any = None, **kwargs: Any
) -> MockConnection:
    """Open a connection to the in-memory database."""
    if MockConnection.fail_next.get('connect') is not None:
        raise MockConnection.fail_next.pop('connect')
    return MockConnection(dsn=dsn, **kwargs)


apilevel = '2.0'
threadsafety = 2
paramstyle = 'pyformat'
__version__ = '2.9.12 (test double)'
