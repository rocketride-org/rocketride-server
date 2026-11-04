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

"""The SQL of the shared pgvector driver.

Every statement is built with ``psycopg2.sql``: the table is always an
``Identifier`` and every value is a bound parameter. Column names are constants
of this module; a document's metadata reaches the table only through the column
allowlist :data:`METADATA_COLUMNS`, and every other key goes into the ``meta``
jsonb column (or is dropped when the table has none).

Each statement starts with a ``/* rr-pgvector:<name> */`` comment. It names the
statement in ``pg_stat_activity`` and in the server log, and the test double of
``psycopg2`` (``nodes/test/mocks/psycopg2``) dispatches on it.

The table name is folded to lower case before it is quoted: the drivers this one
replaced wrote unquoted names, which PostgreSQL folds, so ``MyDocs`` must keep
naming the table ``mydocs``. Column names are lower case for the same reason.
"""

from __future__ import annotations

import hashlib
import re

from dataclasses import dataclass, replace as dataclass_replace
from typing import Any, List, Optional, Sequence, Tuple

from psycopg2 import sql

#: A valid unquoted PostgreSQL identifier: letter or underscore first, then letters, digits or underscores, at most 63.
VALID_TABLE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,62}$')

#: objectId of the collection's control record.
CONTROL_OBJECT_ID = 'schema'

#: pgvector cannot build an HNSW index over vectors wider than this.
HNSW_MAX_DIMS = 2000

#: The configured similarity names and the metric each one is reported as.
METRICS = {'cosine': 'cosine', 'l2': 'l2', 'inner_product': 'ip'}

#: The distance operator and the HNSW operator class of each metric.
OPERATORS = {'cosine': '<=>', 'l2': '<->', 'ip': '<#>'}
OPCLASSES = {'cosine': 'vector_cosine_ops', 'l2': 'vector_l2_ops', 'ip': 'vector_ip_ops'}

#: DocMetadata keys stored in a column of their own, and that column (PostgreSQL folds the legacy unquoted names).
METADATA_COLUMNS = {
    'objectId': 'objectid',
    'nodeId': 'nodeid',
    'parent': 'parent',
    'permissionId': 'permissionid',
    'isDeleted': 'isdeleted',
    'chunkId': 'chunkid',
    'isTable': 'istable',
    'tableId': 'tableid',
    'vectorSize': 'vectorsize',
    'modelName': 'modelname',
    'signature': 'signature',
}

#: Every column of a table this driver creates, in DDL order.
TABLE_COLUMNS: Tuple[str, ...] = (
    'id',
    'content',
    'objectid',
    'nodeid',
    'parent',
    'permissionid',
    'isdeleted',
    'chunkid',
    'istable',
    'tableid',
    'vectorsize',
    'modelname',
    'embedding',
    'signature',
    'meta',
)

#: Columns a row is read with, when the table has them (``embedding`` only as text, on request).
READ_COLUMNS: Tuple[str, ...] = (
    'id',
    'content',
    'objectid',
    'nodeid',
    'parent',
    'permissionid',
    'isdeleted',
    'chunkid',
    'istable',
    'tableid',
    'vectorsize',
    'modelname',
    'signature',
    'meta',
)

#: Columns a write may fill (``id`` is the table's own; ``embedding`` and ``meta`` are cast).
WRITE_COLUMNS: Tuple[str, ...] = tuple(c for c in TABLE_COLUMNS if c != 'id')

#: Advisory-lock namespace: every write transaction on a table takes ``pg_advisory_xact_lock(hashtext(...))``.
LOCK_NAMESPACE = 'rocketride.pgvector.'


def _q(tag: str, text: str, /, **parts: sql.Composable) -> sql.Composed:
    """A statement named ``tag`` (see the module docstring)."""
    return sql.SQL('/* rr-pgvector:' + tag + ' */ ' + text).format(**parts)


def _col(name: str) -> sql.Identifier:
    return sql.Identifier(name)


def like_escape(text: str) -> str:
    """``text`` with ``\\``, ``%`` and ``_`` escaped, to be matched literally by ``LIKE ... ESCAPE '\\'``."""
    return text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def deleted_predicate(deleted: str) -> str:
    """The row predicate of a ``deleted`` mode: 'active', 'deleted' or 'all' (``TRUE``).

    A NULL flag (a row written by hand or by another client) reads as not deleted, so
    'active' and 'deleted' together always make 'all'.
    """
    if deleted == 'active':
        return '"isdeleted" IS NOT TRUE'
    if deleted == 'deleted':
        return '"isdeleted" IS TRUE'
    return 'TRUE'


# -----------------------------------------------------------------------------
# Filters
# -----------------------------------------------------------------------------


@dataclass
class Where:
    """The row filter of one statement. Every field is optional; ``deleted`` is 'active', 'deleted' or 'all'.

    'active' takes the rows whose ``isdeleted`` is false or NULL, so that
    'active' and 'deleted' together always make 'all'.
    """

    exclude_control: bool = True
    deleted: str = 'active'
    node_id: Optional[str] = None
    is_table: Optional[bool] = None
    table_ids: Optional[Sequence[int]] = None
    parent: Optional[str] = None
    permissions: Optional[Sequence[int]] = None
    object_ids: Optional[Sequence[str]] = None
    object_id: Optional[str] = None
    chunk_ids: Optional[Sequence[int]] = None
    min_chunk_id: Optional[int] = None
    max_chunk_id: Optional[int] = None
    after_chunk_id: Optional[int] = None
    keys: Optional[Sequence[Tuple[str, int]]] = None
    not_keys: Optional[Sequence[Tuple[str, int]]] = None
    content_like: Optional[str] = None

    def build(self) -> Tuple[sql.Composable, List[Any]]:
        """Return ``(predicate, params)``; the predicate is ``TRUE`` when nothing filters."""
        parts: List[sql.Composable] = []
        params: List[Any] = []

        def add(text: str, *values: Any) -> None:
            parts.append(sql.SQL(text))
            params.extend(values)

        if self.content_like is not None:
            add('"content" ILIKE %s ESCAPE \'\\\'', self.content_like)
        if self.exclude_control:
            add('"objectid" <> %s', CONTROL_OBJECT_ID)
        if self.object_id is not None:
            add('"objectid" = %s', self.object_id)
        if self.object_ids is not None:
            add('"objectid" = ANY(%s)', [str(o) for o in self.object_ids])
        if self.node_id is not None:
            add('"nodeid" = %s', self.node_id)
        if self.is_table is not None:
            add('"istable" = %s', bool(self.is_table))
        if self.table_ids is not None:
            add('"tableid" = ANY(%s)', [int(t) for t in self.table_ids])
        if self.parent is not None:
            add('"parent" = %s', self.parent)
        if self.permissions is not None:
            add('"permissionid" = ANY(%s)', [int(p) for p in self.permissions])
        # A NULL flag (a row written by hand or by another client) reads as not deleted.
        if self.deleted in ('active', 'deleted'):
            add(deleted_predicate(self.deleted))
        if self.chunk_ids is not None:
            add('"chunkid" = ANY(%s)', [int(c) for c in self.chunk_ids])
        if self.min_chunk_id is not None:
            add('"chunkid" >= %s', int(self.min_chunk_id))
        if self.max_chunk_id is not None:
            add('"chunkid" <= %s', int(self.max_chunk_id))
        if self.after_chunk_id is not None:
            add('"chunkid" > %s', int(self.after_chunk_id))
        for keys, op in ((self.keys, 'IN'), (self.not_keys, 'NOT IN')):
            if keys is None:
                continue
            if not keys:
                # An empty IN list matches nothing; an empty NOT IN list excludes nothing.
                if op == 'IN':
                    parts.append(sql.SQL('FALSE'))
                continue
            pairs = sql.SQL(', ').join(sql.SQL('(%s, %s)') for _ in keys)
            parts.append(sql.SQL('("objectid", "chunkid") ' + op + ' ({})').format(pairs))
            for object_id, chunk_id in keys:
                params.extend([str(object_id), int(chunk_id)])

        if not parts:
            return sql.SQL('TRUE'), params
        return sql.SQL(' AND ').join(parts), params


#: A document's path in a listing: the smallest ``parent`` of its rows (every chunk of a document carries the same).
_DOC_PATH = 'coalesce(min("parent"), \'\')'

#: A document's ingest time in a listing: the ``meta`` of its first chunk, as :meth:`Statements.list_documents` reads it.
_DOC_INGESTED = '(array_agg("meta"->>\'ingestedAt\' ORDER BY "chunkid"))[1]'


@dataclass
class Having:
    """Conditions on whole documents: the ``documents`` filter (contract section 4.4-A).

    Each condition holds for a document as the listing reports it, over the rows the
    statement's :class:`Where` selects (so under the listing's ``deleted`` mode): the path
    is the smallest ``parent``, the chunk count the number of rows, the ingest time the
    ``meta.ingestedAt`` of the first chunk (compared as text: the stored form is UTC
    ``YYYY-MM-DDTHH:MM:SSZ``, which ``parse_doc_list_filter`` gives the bounds too), and
    the two flags ``bool_or`` over the rows. They go into the ``HAVING`` of the statement
    that pages the document keys, so the keyset cursor and the total it carries count
    only matching documents. A document without an ingest time matches no ingest bound.
    Text is matched literally (``LIKE`` patterns are escaped here); every value is a
    bound parameter. ``ingested_*`` need the table's ``meta`` column: the driver leaves
    them out on a table without it.
    """

    #: The path starts with this text (case-sensitive).
    path_prefix: Optional[str] = None
    #: Lower-case extensions without the dot: the path ends with ``.<one of them>``, ignoring case.
    file_types: Optional[Sequence[str]] = None
    #: The path contains this text, ignoring case.
    path_contains: Optional[str] = None
    #: Ingested at or after this UTC ``YYYY-MM-DDTHH:MM:SSZ``.
    ingested_after: Optional[str] = None
    #: Ingested before this UTC ``YYYY-MM-DDTHH:MM:SSZ``.
    ingested_before: Optional[str] = None
    min_chunks: Optional[int] = None
    max_chunks: Optional[int] = None
    has_first_chunk: Optional[bool] = None
    has_tables: Optional[bool] = None

    def build(self) -> Tuple[List[sql.Composable], List[Any]]:
        """Return ``(conditions, params)``: the conditions to AND into a ``HAVING``, in parameter order."""
        parts: List[sql.Composable] = []
        params: List[Any] = []

        def add(text: str, value: Any) -> None:
            parts.append(sql.SQL(text))
            params.append(value)

        if self.path_prefix is not None:
            add(_DOC_PATH + " LIKE %s ESCAPE '\\'", like_escape(self.path_prefix) + '%')
        if self.file_types:
            # The extensions are letters and digits (parse_doc_list_filter), escaped all the same.
            add('lower(' + _DOC_PATH + ') LIKE ANY(%s)', ['%.' + like_escape(ext.lower()) for ext in self.file_types])
        if self.path_contains is not None:
            add(_DOC_PATH + " ILIKE %s ESCAPE '\\'", '%' + like_escape(self.path_contains) + '%')
        if self.ingested_after is not None:
            add(_DOC_INGESTED + ' >= %s', self.ingested_after)
        if self.ingested_before is not None:
            add(_DOC_INGESTED + ' < %s', self.ingested_before)
        if self.min_chunks is not None:
            add('count(*) >= %s', int(self.min_chunks))
        if self.max_chunks is not None:
            add('count(*) <= %s', int(self.max_chunks))
        if self.has_first_chunk is not None:
            add('coalesce(bool_or("chunkid" = 0), false) = %s', bool(self.has_first_chunk))
        if self.has_tables is not None:
            add('coalesce(bool_or("istable"), false) = %s', bool(self.has_tables))
        return parts, params


# -----------------------------------------------------------------------------
# Statements
# -----------------------------------------------------------------------------


class Statements:
    """Every statement the driver runs against one table."""

    def __init__(self, table: str) -> None:
        """Build the statements for ``table`` (already validated and folded to lower case)."""
        self.table = table
        self.t = sql.Identifier(table)
        #: The text ``to_regclass`` resolves the table from.
        self.regclass = '"' + table + '"'
        self.lock_key = LOCK_NAMESPACE + table

    # --- transaction bootstrap ----------------------------------------------

    @staticmethod
    def begin_read(statement_timeout_ms: int, iterative_scan: bool) -> str:
        """The first statement of every read transaction.

        ``SELECT '[0]'::vector`` loads pgvector's library in the server session,
        so its settings exist (a non-superuser may not ``LOAD`` it); then the
        transaction is made read-only and time-bounded. Nothing is set for the
        session: behind a transaction-mode pooler the next transaction may run
        on another server session.
        """
        text = (
            "/* rr-pgvector:begin_read */ SELECT '[0]'::vector; SET TRANSACTION READ ONLY; "
            f"SET LOCAL statement_timeout = '{int(statement_timeout_ms)}ms'"
        )
        if iterative_scan:
            text += '; SET LOCAL hnsw.iterative_scan = relaxed_order'
        return text

    @staticmethod
    def begin_write(statement_timeout_ms: int, lock_timeout_ms: Optional[int] = None) -> str:
        """The first statement of a write (or DDL) transaction."""
        text = f"/* rr-pgvector:begin_write */ SET LOCAL statement_timeout = '{int(statement_timeout_ms)}ms'"
        if lock_timeout_ms is not None:
            text += f"; SET LOCAL lock_timeout = '{int(lock_timeout_ms)}ms'"
        return text

    def lock(self) -> Tuple[sql.Composed, List[Any]]:
        """Serialise writes to this table across every process, until the transaction ends."""
        return _q('lock', 'SELECT pg_advisory_xact_lock(hashtext(%s))'), [self.lock_key]

    # --- catalog --------------------------------------------------------------

    @staticmethod
    def extension_version() -> Tuple[sql.Composed, List[Any]]:
        return _q('extension_version', "SELECT extversion FROM pg_extension WHERE extname = 'vector'"), []

    def exists(self) -> Tuple[sql.Composed, List[Any]]:
        return _q('exists', 'SELECT to_regclass(%s) IS NOT NULL'), [self.regclass]

    def has_rows(self) -> Tuple[sql.Composed, List[Any]]:
        return _q('has_rows', 'SELECT EXISTS (SELECT 1 FROM {t})', t=self.t), []

    def columns(self) -> Tuple[sql.Composed, List[Any]]:
        return (
            _q(
                'columns',
                'SELECT attname, format_type(atttypid, atttypmod) FROM pg_attribute '
                'WHERE attrelid = to_regclass(%s) AND attnum > 0 AND NOT attisdropped ORDER BY attnum',
            ),
            [self.regclass],
        )

    def indexes(self) -> Tuple[sql.Composed, List[Any]]:
        return (
            _q(
                'indexes',
                'SELECT c.relname, am.amname, pg_get_indexdef(c.oid), c.reloptions FROM pg_index x '
                'JOIN pg_class c ON c.oid = x.indexrelid JOIN pg_am am ON am.oid = c.relam '
                'WHERE x.indrelid = to_regclass(%s) ORDER BY c.relname',
            ),
            [self.regclass],
        )

    def size(self) -> Tuple[sql.Composed, List[Any]]:
        return _q('size', 'SELECT pg_total_relation_size(to_regclass(%s))'), [self.regclass]

    def control(self) -> Tuple[sql.Composed, List[Any]]:
        return (
            _q('control', 'SELECT "modelname", "vectorsize" FROM {t} WHERE "objectid" = %s', t=self.t),
            [CONTROL_OBJECT_ID],
        )

    # --- DDL ------------------------------------------------------------------

    def create_table(self, dimension: int) -> Tuple[sql.Composed, List[Any]]:
        return (
            _q(
                'create_table',
                'CREATE TABLE IF NOT EXISTS {t} (id bigserial PRIMARY KEY, content text, objectid text, nodeid text, '
                'parent text, permissionid int, isdeleted boolean, chunkid int, istable boolean, tableid int, '
                'vectorsize int, modelname text, embedding vector({dim}), signature text, meta jsonb)',
                t=self.t,
                dim=sql.SQL(str(int(dimension))),
            ),
            [],
        )

    def create_key_index(self) -> Tuple[sql.Composed, List[Any]]:
        return (
            _q(
                'create_key_index',
                'CREATE INDEX IF NOT EXISTS {name} ON {t} ("objectid", "chunkid")',
                name=sql.Identifier(_index_name(self.table, 'objectid_chunkid')),
                t=self.t,
            ),
            [],
        )

    def create_hnsw_index(self, metric: str, m: int, ef_construction: int) -> Tuple[sql.Composed, List[Any]]:
        return (
            _q(
                'create_hnsw_index',
                'CREATE INDEX IF NOT EXISTS {name} ON {t} USING hnsw ("embedding" {opclass}) '
                'WITH (m = {m}, ef_construction = {ef})',
                name=sql.Identifier(_index_name(self.table, 'embedding_hnsw')),
                t=self.t,
                opclass=sql.SQL(OPCLASSES[metric]),
                m=sql.SQL(str(int(m))),
                ef=sql.SQL(str(int(ef_construction))),
            ),
            [],
        )

    def add_meta_column(self) -> Tuple[sql.Composed, List[Any]]:
        return _q('add_meta_column', 'ALTER TABLE {t} ADD COLUMN IF NOT EXISTS "meta" jsonb', t=self.t), []

    # --- reads ----------------------------------------------------------------

    @staticmethod
    def _select_list(columns: Sequence[str], *, embedding: bool) -> sql.Composable:
        """The read columns the table has; a missing ``meta``/``signature`` reads as NULL."""
        items: List[sql.Composable] = []
        for name in READ_COLUMNS:
            if name in columns:
                items.append(sql.Identifier(name))
            elif name in ('meta', 'signature'):
                items.append(sql.SQL('NULL AS {}').format(sql.Identifier(name)))
        if embedding:
            items.append(sql.SQL('"embedding"::text AS "embedding_text"'))
        return sql.SQL(', ').join(items)

    def count_all(self) -> Tuple[sql.Composed, List[Any]]:
        return _q('count_all', 'SELECT count(*) FROM {t}', t=self.t), []

    def count_chunks(self, where: Where) -> Tuple[sql.Composed, List[Any]]:
        pred, params = where.build()
        return _q('count_chunks', 'SELECT count(*) FROM {t} WHERE {w}', t=self.t, w=pred), params

    def count_documents(self, where: Where) -> Tuple[sql.Composed, List[Any]]:
        pred, params = where.build()
        return _q('count_documents', 'SELECT count(DISTINCT "objectid") FROM {t} WHERE {w}', t=self.t, w=pred), params

    def get(
        self, columns: Sequence[str], where: Where, limit: Optional[int], offset: int
    ) -> Tuple[sql.Composed, List[Any]]:
        pred, params = where.build()
        return (
            _q(
                'get',
                'SELECT {cols} FROM {t} WHERE {w} ORDER BY "objectid", "chunkid" LIMIT %s OFFSET %s',
                cols=self._select_list(columns, embedding=False),
                t=self.t,
                w=pred,
            ),
            params + [limit, offset],
        )

    def keyword(
        self, columns: Sequence[str], where: Where, limit: Optional[int], offset: int
    ) -> Tuple[sql.Composed, List[Any]]:
        pred, params = where.build()
        return (
            _q(
                'keyword',
                'SELECT {cols} FROM {t} WHERE {w} ORDER BY "objectid", "chunkid" LIMIT %s OFFSET %s',
                cols=self._select_list(columns, embedding=False),
                t=self.t,
                w=pred,
            ),
            params + [limit, offset],
        )

    def semantic(
        self, columns: Sequence[str], metric: str, vector: str, where: Where, limit: Optional[int], offset: int
    ) -> Tuple[sql.Composed, List[Any]]:
        pred, params = where.build()
        return (
            _q(
                'semantic',
                'SELECT {cols}, "embedding" {op} %s::vector AS "distance" FROM {t} WHERE {w} '
                'ORDER BY "distance" LIMIT %s OFFSET %s',
                cols=self._select_list(columns, embedding=False),
                op=sql.SQL(OPERATORS[metric]),
                t=self.t,
                w=pred,
            ),
            [vector] + params + [limit, offset],
        )

    def semantic_exact(
        self, columns: Sequence[str], metric: str, vector: str, where: Where, limit: Optional[int], offset: int
    ) -> Tuple[sql.Composed, List[Any]]:
        """The semantic search that no ANN index can serve (the exact recovery of a filtered HNSW scan).

        Adding zero to the distance keeps the planner off an approximate index for this ORDER BY; the
        subquery makes the ``distance`` alias visible to that expression without passing the query
        vector twice. Undefined distances (NULL or NaN, such as a zero vector under cosine) are left out.
        """
        pred, params = where.build()
        return (
            _q(
                'semantic_exact',
                'SELECT * FROM (SELECT {cols}, "embedding" {op} %s::vector AS "distance" FROM {t} WHERE {w}) '
                'AS candidates WHERE "distance" < \'Infinity\'::float8 ORDER BY "distance" + 0 LIMIT %s OFFSET %s',
                cols=self._select_list(columns, embedding=False),
                op=sql.SQL(OPERATORS[metric]),
                t=self.t,
                w=pred,
            ),
            [vector] + params + [limit, offset],
        )

    def has_ann_index(self) -> Tuple[sql.Composed, List[Any]]:
        """Whether the table has a valid approximate (HNSW or IVFFlat) index: only then can an exact retry find more."""
        return (
            _q(
                'has_ann_index',
                'SELECT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid '
                'JOIN pg_am a ON a.oid = c.relam '
                "WHERE i.indrelid = to_regclass(%s) AND i.indisvalid AND a.amname IN ('hnsw', 'ivfflat'))",
            ),
            [self.regclass],
        )

    def paths(self, where: Where, limit: Optional[int], offset: int) -> Tuple[sql.Composed, List[Any]]:
        """One row per distinct parent (its lowest object id), so ``offset`` and ``limit`` count paths."""
        pred, params = where.build()
        return (
            _q(
                'paths',
                'SELECT DISTINCT ON ("parent") "parent", "objectid" FROM {t} WHERE {w} '
                'ORDER BY "parent", "objectid" LIMIT %s OFFSET %s',
                t=self.t,
                w=pred,
            ),
            params + [limit, offset],
        )

    def render(self, object_id: str, after_chunk: int, limit: int) -> Tuple[sql.Composed, List[Any]]:
        return (
            _q(
                'render',
                'SELECT "content", "chunkid" FROM {t} WHERE "objectid" = %s AND "chunkid" > %s ORDER BY "chunkid" LIMIT %s',
                t=self.t,
            ),
            [object_id, int(after_chunk), int(limit)],
        )

    def list_document_keys(
        self,
        where: Where,
        after: Optional[Tuple[str, str]],
        limit: int,
        *,
        with_total: bool,
        having: Optional[Having] = None,
    ) -> Tuple[sql.Composed, List[Any]]:
        """The ``(objectId, path)`` keys of one page of documents, ordered by ``(path, objectId)`` from ``after``.

        Only ``min(parent)`` is aggregated over the table, which a hash
        aggregate does in one pass; the page's counts and metadata are read
        by :meth:`list_documents` for its own objectIds only. With
        ``with_total`` (the first page, which has no ``after``) every row
        also carries the number of matching documents. ``having`` (the
        documents filter) adds its conditions to the same ``HAVING`` as the
        keyset position, so the total counts only the documents it keeps.
        """
        pred, params = where.build()
        conditions: List[sql.Composable] = []
        if after is not None:
            conditions.append(sql.SQL('(' + _DOC_PATH + ', "objectid") > (%s, %s)'))
            params = params + [after[0], after[1]]
        if having is not None:
            filter_parts, filter_params = having.build()
            conditions.extend(filter_parts)
            params = params + filter_params
        having_sql = sql.SQL('')
        if conditions:
            having_sql = sql.SQL('HAVING {} ').format(sql.SQL(' AND ').join(conditions))
        total = sql.SQL(', count(*) OVER () AS "total"') if with_total else sql.SQL('')
        return (
            _q(
                'list_document_keys',
                'SELECT "objectid", coalesce(min("parent"), \'\') AS "path"{total} FROM {t} WHERE {w} '
                'GROUP BY "objectid" {having}ORDER BY 2, 1 LIMIT %s',
                total=total,
                t=self.t,
                w=pred,
                having=having_sql,
            ),
            params + [int(limit)],
        )

    def list_documents(self, columns: Sequence[str], where: Where) -> Tuple[sql.Composed, List[Any]]:
        """One row per objectId of ``where`` (which names the page's objectIds): counts, flags and metadata.

        The rows are read whatever their ``deleted`` flag, and ``where.deleted`` (the
        listing's mode) selects, per column, the rows each figure counts: ``chunks``,
        ``has_first_chunk``, ``deleted``, ``tables``, ``max_chunk_id`` and the first chunk's
        ``nodeid``, ``point_id`` and ``meta`` are those of the mode's rows, exactly as
        under a ``WHERE`` on the mode; ``deleted_chunks`` counts the document's
        soft-deleted rows under every mode (contract section 4.4-F). A document with no
        row of the mode any more (changed since its key was read) answers ``chunks`` 0.
        """
        mode = sql.SQL(deleted_predicate(where.deleted))
        pred, params = dataclass_replace(where, deleted='all').build()
        if 'meta' in columns:
            meta = sql.SQL('(array_agg("meta" ORDER BY "chunkid") FILTER (WHERE {m}))[1]').format(m=mode)
        else:
            meta = sql.SQL('NULL::jsonb')
        return (
            _q(
                'list_documents',
                'SELECT "objectid", coalesce(min("parent") FILTER (WHERE {m}), \'\') AS "path", '
                'count(*) FILTER (WHERE {m}) AS "chunks", '
                'coalesce(bool_or("chunkid" = 0) FILTER (WHERE {m}), false) AS "has_first_chunk", '
                'coalesce(bool_or("isdeleted") FILTER (WHERE {m}), false) AS "deleted", '
                'count(*) FILTER (WHERE "istable" AND {m}) AS "tables", '
                '(array_agg("nodeid" ORDER BY "chunkid") FILTER (WHERE {m}))[1] AS "nodeid", '
                '(array_agg("id" ORDER BY "chunkid") FILTER (WHERE {m}))[1] AS "point_id", '
                '{meta} AS "meta", '
                'max("chunkid") FILTER (WHERE {m}) AS "max_chunk_id", '
                'count(*) FILTER (WHERE "isdeleted" IS TRUE) AS "deleted_chunks" '
                'FROM {t} WHERE {w} GROUP BY "objectid" ORDER BY 2, 1',
                m=mode,
                meta=meta,
                t=self.t,
                w=pred,
            ),
            params,
        )

    def scroll(self, columns: Sequence[str], where: Where, limit: int) -> Tuple[sql.Composed, List[Any]]:
        pred, params = where.build()
        return (
            _q(
                'scroll',
                'SELECT {cols} FROM {t} WHERE {w} ORDER BY "chunkid" LIMIT %s',
                cols=self._select_list(columns, embedding=False),
                t=self.t,
                w=pred,
            ),
            params + [int(limit)],
        )

    def vectors(self, columns: Sequence[str], where: Where) -> Tuple[sql.Composed, List[Any]]:
        pred, params = where.build()
        return (
            _q(
                'vectors',
                'SELECT {cols} FROM {t} WHERE {w} ORDER BY "objectid", "chunkid"',
                cols=self._select_list(columns, embedding=True),
                t=self.t,
                w=pred,
            ),
            params,
        )

    def sample(
        self, columns: Sequence[str], strategy: str, where: Where, n: int, seed: int = 0
    ) -> Tuple[sql.Composed, List[Any]]:
        """Pick ``n`` rows (``random``, ``stratified`` or ``first``) and read them with their vectors.

        The order is a seeded hash of each row's id (``hashtextextended``), so
        the same seed picks the same rows and nothing is set for the session
        (``setseed`` would seed the session's ``random()``, which a
        transaction-mode pooler hands to the next client). ``stratified``
        takes one row of every document before a second one of any: each
        document's rows are ranked with chunk 0 first, then by one hash, and
        the ranks are taken in the order of a second, independent hash. The
        ids are picked first so that only the chosen rows are read with their
        vectors.
        """
        pred, params = where.build()
        first, second = _sample_seeds(seed)
        if strategy == 'stratified':
            # Placeholders in text order: the two hash seeds, the filter, the limit.
            pick = (
                'WITH "ranked" AS (SELECT "id", row_number() OVER (PARTITION BY "objectid" '
                'ORDER BY ("chunkid" = 0) DESC, hashtextextended("id"::text, %s), "id") AS "rn", '
                'hashtextextended("id"::text, %s) AS "draw" FROM {t} WHERE {w}), '
                '"pick" AS (SELECT "id" FROM "ranked" ORDER BY "rn", "draw", "id" LIMIT %s) '
            )
            values = [first, second] + params + [int(n)]
        elif strategy == 'random':
            pick = (
                'WITH "pick" AS (SELECT "id" FROM {t} WHERE {w} '
                'ORDER BY hashtextextended("id"::text, %s), "id" LIMIT %s) '
            )
            values = params + [first, int(n)]
        else:
            pick = 'WITH "pick" AS (SELECT "id" FROM {t} WHERE {w} ORDER BY "parent", "objectid", "chunkid" LIMIT %s) '
            values = params + [int(n)]
        return (
            _q(
                'sample_' + strategy,
                pick + 'SELECT {cols} FROM {t} JOIN "pick" USING ("id") ORDER BY "objectid", "chunkid"',
                cols=self._select_list(columns, embedding=True),
                t=self.t,
                w=pred,
            ),
            values,
        )

    # --- writes -------------------------------------------------------------

    def insert(self, columns: Sequence[str], rows: int) -> sql.Composed:
        """A multi-row INSERT of ``rows`` rows over ``columns`` (the ``WRITE_COLUMNS`` the table has)."""
        cells: List[sql.Composable] = []
        for name in columns:
            if name == 'embedding':
                cells.append(sql.SQL('%s::vector'))
            elif name == 'meta':
                cells.append(sql.SQL('%s::jsonb'))
            else:
                cells.append(sql.SQL('%s'))
        row = sql.SQL('({})').format(sql.SQL(', ').join(cells))
        return _q(
            'insert',
            'INSERT INTO {t} ({cols}) VALUES {rows}',
            t=self.t,
            cols=sql.SQL(', ').join(sql.Identifier(c) for c in columns),
            rows=sql.SQL(', ').join([row] * rows),
        )

    def delete(self, where: Where) -> Tuple[sql.Composed, List[Any]]:
        pred, params = where.build()
        return _q('delete', 'DELETE FROM {t} WHERE {w}', t=self.t, w=pred), params

    def set_deleted(self, where: Where, value: bool) -> Tuple[sql.Composed, List[Any]]:
        pred, params = where.build()
        return _q('set_deleted', 'UPDATE {t} SET "isdeleted" = %s WHERE {w}', t=self.t, w=pred), [bool(value)] + params


def _sample_seeds(seed: int) -> Tuple[int, int]:
    """Two independent ``bigint`` hash seeds derived from the sample's integer seed."""
    first = int(seed or 0) % (1 << 63)
    second = (first * 6364136223846793005 + 1442695040888963407) % (1 << 63)
    return first, second


def _index_name(table: str, suffix: str) -> str:
    """``<table>_<suffix>``, the name the legacy driver gave its index, when it fits in 63 characters.

    A longer name would be cut by PostgreSQL, and two indexes of a 62- or
    63-character table would then share a name (or take the table's own).
    Such a table gets ``<prefix>_<digest>_<suffix>`` instead: the digest of
    the whole table name keeps tables that share a prefix apart.
    """
    name = f'{table}_{suffix}'
    if len(name) <= 63:
        return name
    digest = hashlib.sha1(table.encode('utf-8')).hexdigest()[:8]
    return f'{table[: 63 - len(suffix) - len(digest) - 2]}_{digest}_{suffix}'


def vector_literal(values: Sequence[float]) -> str:
    """Return the text form pgvector reads a vector from, for a ``%s::vector`` parameter."""
    return '[' + ','.join(repr(float(v)) for v in values) + ']'


__all__ = [
    'CONTROL_OBJECT_ID',
    'HNSW_MAX_DIMS',
    'Having',
    'METADATA_COLUMNS',
    'METRICS',
    'OPCLASSES',
    'OPERATORS',
    'READ_COLUMNS',
    'Statements',
    'TABLE_COLUMNS',
    'VALID_TABLE',
    'WRITE_COLUMNS',
    'Where',
    'deleted_predicate',
    'like_escape',
    'vector_literal',
]
