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
Shared instance-level base class for relational database nodes.

Derived classes must implement one method:

- ``_db_display_name()``: return the human-readable database name
  (e.g. ``'MySQL'``, ``'PostgreSQL'``) used in tool descriptions.

All pipeline lane handlers (``writeQuestions``, ``writeTable``,
``writeAnswers``), query execution, and data insertion are implemented here
using SQLAlchemy abstractions that work across dialects.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any, Dict, List

import json
import threading

from rocketlib import IInstanceBase, debug, error, warning, tool_function
from sqlalchemy import MetaData, Table as SQLTable, insert, text
from sqlalchemy.exc import NoSuchTableError, SQLAlchemyError

from ai.common.schema import Answer, Question, QuestionType
from ai.common.table import Table
from ai.common.utils import parse_bool
from rocketlib.types import IInvokeLLM

from .db_global_base import DEFAULT_MAX_EXECUTE_ROWS, DatabaseGlobalBase
from .sql_safety import is_sql_safe


def _isDbFailure(exc: BaseException) -> bool:
    """Return True when ``exc`` is a database failure this node should reformat.

    Two shapes, and the second is why this is a duck-test rather than an
    isinstance list:

    * a SQLAlchemy exception -- what every DBAPI dialect raises, and what
      carries the ``[SQL: ...]`` / ``[parameters: ...]`` tail
      ``_format_db_error`` exists to cut;
    * a plain ``Exception`` carrying ``.orig``. Not every dialect wraps: the
      ``clickhouse+native://`` connector the db_clickhouse node uses raises
      clickhouse-sqlalchemy's own ``DatabaseException``, an ordinary
      ``Exception`` subclass holding the driver's error in ``.orig``, and
      SQLAlchemy does not wrap a non-DBAPI exception. Duck-typed rather than
      imported because this shared base must not depend on any one node's
      driver, and ``.orig`` IS the shape being handled.

    Everything else is False and its caller re-raises it untouched. The
    ``max_execute_rows`` overflow above all: it is a bare ``RuntimeError``
    whose wording and whose rollback callers and tests depend on.

    One predicate for the three sites that used to copy the same test into two
    ``except`` arms apiece -- ``execute``'s session block, ``_executeRawQuery``
    and ``_insertData`` (dylan-savage, review 5215826786 nit 2).
    """
    return isinstance(exc, SQLAlchemyError) or getattr(exc, 'orig', None) is not None


def _generated_primary_keys(table: SQLTable) -> set:
    """Return the lowercased primary-key columns the DATABASE fills in itself.

    Only reflected metadata is trusted. Binding NULL into a generated key is a
    not-null violation on Postgres (``id SERIAL NOT NULL``) and overrides a
    server default elsewhere, so a column this set names is never bound when
    the row does not carry a value for it.

    * ``table.autoincrement_column`` is SQLAlchemy's own resolution. It honours
      an ``autoincrement=True`` reflected from MySQL or PostgreSQL, and applies
      the ``'auto'`` rule -- a lone Integer primary key that is not a foreign
      key -- which is how SQLite's rowid alias is recognised.
    * A primary-key column with a ``server_default``, an ``Identity``, or an
      explicit ``autoincrement=True`` is generated whatever its type, which
      covers ``code TEXT PRIMARY KEY DEFAULT ...`` and ``GENERATED AS IDENTITY``.

    Everything else -- a composite key, a TEXT key with no default -- is the
    caller's to supply. A row that does not is NOT refused here: the column is
    left out of the INSERT and the database answers for it.

    That is deliberate, and it is the narrow reading of this function's own
    name. Reflection describes columns and not triggers, so "no default" is
    not the same as "nobody fills it in": a ``CHAR(36)`` / ``uuid`` primary key
    populated by a ``BEFORE INSERT`` trigger (the standard MySQL UUID idiom
    before 8.0.13, and the same shape on PostgreSQL) is indistinguishable here
    from a text key nobody supplies. Refusing the row before the transaction
    opened meant the trigger never ran, and on the answers lane -- where
    ``writeAnswers`` reduces any exception to one log line -- the whole batch
    disappeared silently (dylan-savage, review 5215826786 item 6). Omitting the
    column instead lets the trigger, or a default the reflection could not see,
    supply the value; where nothing does, the database refuses the row, its own
    message comes back through ``_format_db_error``, and the single transaction
    wrapping the batch rolls every run back, so nothing is half written.

    What this set still decides is what the node must NOT bind: a column in it
    is left out whether the row omits it or carries an explicit null, because
    binding NULL into a generated key is a not-null violation on Postgres
    (``id SERIAL NOT NULL``) and overrides a server default everywhere.

    The set this returns, together with the server-default / identity columns
    ``_insertData`` reads off the reflected table, also decides how an explicit
    null reads: on any of those columns ``{'id': None}`` means "no value" and
    is left to the database, because the insert lane's caller is an upstream
    node emitting every schema key rather than a person choosing NULL. On a
    column with nothing behind it a supplied null is bound as given. The same
    set decides which columns a row may leave out entirely.

    The ``'auto'`` half of that rule is an approximation, and on SQLite it is
    measurably imperfect: ``id INT PRIMARY KEY``, ``id BIGINT PRIMARY KEY`` and
    ``id INTEGER PRIMARY KEY DESC`` all reflect as a lone Integer-affinity key
    and are treated as generated here, yet SQLite aliases none of them to the
    rowid, so an omitted key lands as NULL; conversely
    ``id INTEGER PRIMARY KEY REFERENCES parent(id)`` IS a rowid alias but the
    foreign key excludes it from ``'auto'``. That second case costs nothing now
    that an unreflected key is simply left out of the INSERT: SQLite still
    generates the rowid, and all it buys is SQLAlchemy's SAWarning.
    Both are SQLite-only: PostgreSQL and MySQL reflection set ``autoincrement``
    explicitly (from ``nextval``/Identity and from ``auto_increment``), so the
    resolution is exact for the engines the production nodes connect to, and no
    node in this repo runs on SQLite.
    """
    generated = set()
    autoincrement_column = table.autoincrement_column
    if autoincrement_column is not None:
        generated.add(autoincrement_column.name.lower())
    for column in table.primary_key.columns:
        if column.server_default is not None or column.identity is not None or column.autoincrement is True:
            generated.add(column.name.lower())
    return generated


def _format_table(table_info: dict) -> dict:
    """Render one reflected table into the per-table shape both schema tools return.

    ``get_schema`` and ``refresh_schema`` both promise callers "the same shape",
    and the tool descriptions an LLM chooses between say so, so the rendering
    lives in one place: a key added for one tool is a key both tools emit.

    Takes an entry of ``IGlobal.db_schema`` (``columns`` as ``(name, type)``
    pairs, plus ``primary_key`` and ``foreign_keys`` lists) and returns
    ``{'columns': [{'column': ..., 'type': ...}, ...]}``. ``primary_key`` and
    ``foreign_keys`` are added only when non-empty, so a table without either
    does not carry an empty list into the tool response.
    """
    result = {'columns': [{'column': name, 'type': col_type} for name, col_type in table_info['columns']]}
    if table_info.get('primary_key'):
        result['primary_key'] = table_info['primary_key']
    if table_info.get('foreign_keys'):
        result['foreign_keys'] = table_info['foreign_keys']
    return result


class DatabaseInstanceBase(IInstanceBase, ABC):
    """Abstract base for the IInstance layer of any relational database node.

    Derived classes must implement ``_db_display_name()`` to provide the
    human-readable database name used in tool descriptions (e.g. 'MySQL').
    """

    IGlobal: DatabaseGlobalBase

    # ------------------------------------------------------------------
    # Abstract interface
    # ------------------------------------------------------------------

    @abstractmethod
    def _db_display_name(self) -> str:
        """Return the human-readable database name (e.g. 'MySQL', 'PostgreSQL')."""

    @abstractmethod
    def _db_dialect(self) -> str:
        """Return the machine-readable dialect identifier (e.g. 'mysql', 'postgres').

        Surfaced to SDK callers via the ``dialect`` tool function so applications
        can branch on the underlying engine (dialect-specific SQL, type coercion, etc.).
        """

    # ------------------------------------------------------------------
    # Reflection lock
    # ------------------------------------------------------------------

    def _reflectLock(self) -> threading.Lock:
        """Return this node's reflection lock, or name the step that never ran.

        ``DatabaseGlobalBase.reflect_lock`` is ``None`` on the class and a real
        lock is created in ``beginGlobal``, so a global built without that
        lifecycle call -- a fixture using ``__new__``, or a subclass that
        overrides ``beginGlobal`` and forgets to chain up -- cannot silently
        share one lock across every node in the process. ``with None:`` already
        fails, but with "'NoneType' object does not support the context manager
        protocol", which names neither the attribute nor the call that creates
        it; on the answers lane ``writeAnswers`` reduces any exception to a
        single log line, which is precisely the quiet failure this PR is
        removing elsewhere.
        """
        lock = self.IGlobal.reflect_lock
        if lock is None:
            raise RuntimeError('reflect_lock is created in beginGlobal; this global never ran it')
        return lock

    # ------------------------------------------------------------------
    # Tool methods — dispatched by IInstanceBase.invoke() via @tool_function
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['question'],
            'properties': {
                'question': {
                    'type': 'string',
                    'description': 'Natural-language description of the data you want to retrieve',
                },
                'limit': {
                    'type': 'integer',
                    'description': f'Maximum number of rows to return (default 250, max {DEFAULT_MAX_EXECUTE_ROWS}). Increase when you need the full result set.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'rows': {
                    'type': 'array',
                    'description': 'Result rows returned by the query.',
                    'items': {'type': 'object'},
                },
                'sql': {'type': 'string', 'description': 'The generated SQL SELECT statement that was executed.'},
                'row_limit': {'type': 'integer', 'description': 'The row cap applied to this query.'},
                'valid': {'type': 'boolean', 'description': 'Whether a valid SQL query was generated.'},
                'error': {'type': 'string', 'description': 'Error message if query generation or execution failed.'},
                'answer': {
                    'type': 'string',
                    'description': 'LLM text response when the question is not a database query.',
                },
            },
        },
        description=lambda self: (
            f'Accepts a natural-language description of the data you want, converts it to a safe '
            f'SQL SELECT statement, executes it against the {self._db_display_name()} database, and returns the result rows. '
            f'No schema lookup or SQL knowledge required -- just describe what you need. '
            f'Describe the end result you want, not intermediate steps -- this tool can handle '
            f'aggregations, tokenization, joins, and complex transformations in a single request. '
            f'Results may be large -- consider using peek or store.'
        ),
    )
    def get_data(self, args):
        """Translate natural language to SQL and execute."""
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object')
        question = args.get('question')
        if not question or not isinstance(question, str) or not question.strip():
            raise ValueError('"question" is required and must be a non-empty string')

        question = question.strip()
        raw_limit = args.get('limit')
        try:
            limit = max(1, min(int(raw_limit), DEFAULT_MAX_EXECUTE_ROWS)) if raw_limit is not None else 250
        except (TypeError, ValueError):
            limit = 250

        sql_result = self.get_sql({'question': question, 'limit': limit})
        if not sql_result.get('valid'):
            return sql_result

        sql_query = sql_result['sql']
        result = self._executeSQLQuery(sql_query)
        if result is None:
            return {'valid': False, 'error': 'Query execution failed', 'sql': sql_query, 'rows': []}

        rows = [self._sanitize_row(row) for row in result]
        return {'valid': True, 'rows': rows, 'sql': sql_query, 'row_limit': limit}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'table': {
                    'type': 'string',
                    'description': 'Optional table name to get schema for. If omitted, returns schema for all tables.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'database': {'type': 'string'},
                'tables': {'type': 'object', 'description': 'Map of table name to table definition.'},
                'error': {'type': 'string'},
            },
        },
        description=lambda self: (
            f'Returns the {self._db_display_name()} database schema including all tables, columns, types, primary keys, '
            f'and foreign key relationships. Pass a table name to get the schema for a single table, '
            f'or omit it to get the full database schema. '
            f'Do NOT call this preemptively -- only use when get_data fails or returns unexpected results.'
        ),
    )
    def get_schema(self, args):
        """Return the reflected database schema.

        Serves ``IGlobal.db_schema``, reflected in ``beginGlobal`` and replaced
        by each ``refresh_schema`` call. DDL run since the last reflection
        (through ``execute``) is NOT visible here — use ``refresh_schema``
        after changing the schema.
        """
        if args is not None and not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object or empty')
        if not args:
            args = {}

        table_filter = args.get('table')

        if table_filter:
            table_info = self.IGlobal.db_schema.get(table_filter)
            if table_info is None:
                return {'error': f'Table "{table_filter}" not found', 'database': self.IGlobal.database}
            return {'database': self.IGlobal.database, 'tables': {table_filter: _format_table(table_info)}}

        return {
            'database': self.IGlobal.database,
            'tables': {name: _format_table(info) for name, info in self.IGlobal.db_schema.items()},
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['question'],
            'properties': {
                'question': {'type': 'string', 'description': 'Natural-language question to convert into a SQL query'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'sql': {'type': 'string'},
                'valid': {'type': 'boolean'},
                'error': {'type': 'string'},
                'answer': {'type': 'string'},
            },
        },
        description=lambda self: (
            f'Accepts a natural-language description and returns the equivalent {self._db_display_name()} SQL SELECT statement without executing it. Only use when the user explicitly asks to see the SQL -- for actual data retrieval, use get_data instead.'
        ),
    )
    def get_sql(self, args):
        """Translate natural language to SQL without executing."""
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object')
        question = args.get('question')
        if not question or not isinstance(question, str) or not question.strip():
            raise ValueError('"question" is required and must be a non-empty string')

        question = question.strip()
        limit = args.get('limit', 250)
        result = self._buildSQLQuery(question, limit=limit)

        is_valid = parse_bool(result.get('isValid', False))
        sql_query = result.get('query', '')

        if is_valid and sql_query and is_sql_safe(sql_query):
            return {'sql': sql_query, 'valid': True}
        elif is_valid and sql_query:
            return {'error': 'Generated query contains unsafe SQL', 'sql': sql_query, 'valid': False}
        elif result.get('error'):
            # EXPLAIN rejected the query on every attempt -- surface the real
            # database error instead of the rejected SQL, so callers can tell
            # this apart from a genuinely off-topic question.
            return {'error': result['error'], 'valid': False}
        else:
            return {'answer': sql_query, 'valid': False}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['sql'],
            'properties': {
                'sql': {'type': 'string', 'description': 'Raw SQL statement to execute.'},
                'session_id': {'type': 'string', 'description': 'Optional transaction session id from begin.'},
                'params': {'type': 'array', 'description': 'Optional positional bind values for $1..$n.'},
                'row_mode': {
                    'type': 'string',
                    'enum': ['object', 'array'],
                    'description': "Row shape: 'object' (default) returns dict rows; 'array' returns positional lists (column order preserved, duplicate names kept).",
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'rows': {'type': 'array', 'items': {'type': ['object', 'array']}},
                'affected_rows': {'type': 'integer'},
            },
        },
        description=lambda self: (
            f'Execute a raw SQL statement against this {self._db_display_name()} database. '
            f'Bypasses LLM translation and SQL safety checks. '
            f'A failed statement inside a session_id rolls nothing back and leaves the session open: '
            f'recover with rollback, or rollback to savepoint <name>, before sending more work on that '
            f'session. On PostgreSQL the transaction stays aborted until you do, and commit is refused.'
        ),
    )
    def execute(self, args):
        """Execute a raw SQL statement against this database."""
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object')
        sql = args.get('sql')
        if not sql or not isinstance(sql, str) or not sql.strip():
            raise ValueError('"sql" is required and must be a non-empty string')

        if not self.IGlobal.allow_execute:
            raise ValueError('execute tool is disabled for this node (set allow_execute=true)')

        session_id = args.get('session_id')
        params = args.get('params')
        self._validateExecuteParams(params)
        row_mode = args.get('row_mode', 'object')
        if row_mode not in ('object', 'array'):
            raise ValueError("\"row_mode\" must be 'object' or 'array'")
        if session_id:
            try:
                result = self.IGlobal.tx_registry.execute(session_id, sql.strip(), params, row_mode)
            except KeyError:
                raise ValueError(f'unknown or expired transaction session: {session_id}')
            except Exception as e:
                # The statement itself failed. `tx_registry` has no IGlobal and
                # is shared with other callers, so the formatting the sessionless
                # branch gets from `_executeRawQuery` has to be applied here:
                # otherwise the same tool, behind the same allow_execute gate,
                # returns the raw exception -- `[SQL: ...]` / `[parameters: ...]`
                # tail included -- purely because a session_id was passed.
                # `_isDbFailure` covers both shapes, the dialect-wrapped one and
                # the ClickHouse connector's unwrapped `DatabaseException`, so
                # the session half cannot report a failure differently from the
                # sessionless half. Anything else -- the max_rows RuntimeError
                # above all, whose wording and rollback callers depend on -- is
                # re-raised exactly as the registry threw it.
                #
                # A failed statement leaves the session OPEN: Postgres marks the
                # transaction aborted, MySQL leaves it usable. The client owns
                # recovery — `rollback`, or `rollback to savepoint` for nested
                # transactions — and the idle reaper is the backstop for abandoned
                # sessions. Committing an aborted transaction would degrade to a
                # silent ROLLBACK, so the registry refuses it and raises instead.
                #
                # That policy is NOT appended to this message. The two execute
                # paths report a driver failure with the same bytes -- the
                # contract `test_both_execute_paths_report_a_driver_failure_identically`
                # pins -- and a session-only suffix would break it. It is stated
                # in the `execute` tool description above instead, which every
                # agent reads before calling, and in the node READMEs;
                # `test_the_execute_tool_description_states_the_session_recovery_policy`
                # is what stops that sentence drifting from this code.
                if not _isDbFailure(e):
                    raise
                error(f'Error executing raw SQL in session {session_id}: {e}')
                # `from None` keeps the driver traceback out of the tool response.
                raise RuntimeError(f'SQL execution failed: {self.IGlobal._format_db_error(e)}') from None
        else:
            result = self._executeRawQuery(sql.strip(), params, row_mode)

        rows = [self._sanitize_row(row) for row in result['rows']]
        return {'rows': rows, 'affected_rows': result['affected_rows']}

    @staticmethod
    def _validateExecuteParams(params: Any) -> None:
        """Reject a ``params`` argument that is not an array before anything is dispatched.

        ``to_sqlalchemy_text`` rewrites ``$n`` into a bind by indexing
        ``params[n - 1]``, so a JSON object raised ``KeyError: 0`` from inside
        the rewriter -- which told the caller nothing, and on the session path
        was indistinguishable from an unknown session id: ``execute`` reported
        "unknown or expired transaction session" for a session that was still
        open and still usable.

        The placeholder range check is ``to_sqlalchemy_text``'s own and applies
        when ``params`` is non-empty. It is quote-aware -- a ``$n`` inside a
        string literal, a quoted identifier, a dollar-quoted body or a comment
        is not a placeholder -- and an index past ``len(params)`` raises
        ``ValueError('placeholder $n out of range for k param(s)')``. ``None``
        and an empty list mean "no binds": the rewrite is skipped entirely, so a
        literal ``$1`` reaches the driver unchanged and the driver's own
        complaint is what the caller gets back.
        """
        if params is None:
            return
        if not isinstance(params, list):
            raise ValueError('"params" must be an array of positional bind values')

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema={'type': 'object', 'properties': {'session_id': {'type': 'string'}}},
        description=lambda self: (
            f'Begin a transaction on this {self._db_display_name()} database; returns a session_id.'
        ),
    )
    def begin(self, args):
        """Begin a transaction and return a session_id."""
        if not self.IGlobal.allow_execute:
            raise ValueError('execute tool is disabled for this node (set allow_execute=true)')
        return {'session_id': self.IGlobal.tx_registry.begin()}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['session_id'],
            'properties': {'session_id': {'type': 'string'}},
        },
        output_schema={'type': 'object', 'properties': {'ok': {'type': 'boolean'}}},
        description=lambda self: 'Commit an open transaction session.',
    )
    def commit(self, args):
        """Commit an open transaction session."""
        return self._finishTx(args, commit=True)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['session_id'],
            'properties': {'session_id': {'type': 'string'}},
        },
        output_schema={'type': 'object', 'properties': {'ok': {'type': 'boolean'}}},
        description=lambda self: 'Roll back an open transaction session.',
    )
    def rollback(self, args):
        """Roll back an open transaction session."""
        return self._finishTx(args, commit=False)

    def _finishTx(self, args, *, commit: bool):
        """Shared commit/rollback implementation enforcing the allow_execute gate."""
        if not isinstance(args, dict) or not args.get('session_id'):
            raise ValueError('"session_id" is required')
        if not self.IGlobal.allow_execute:
            raise ValueError('execute tool is disabled for this node (set allow_execute=true)')
        try:
            (self.IGlobal.tx_registry.commit if commit else self.IGlobal.tx_registry.rollback)(args['session_id'])
        except KeyError:
            raise ValueError(f'unknown or expired transaction session: {args["session_id"]}')
        return {'ok': True}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {},
        },
        output_schema={
            'type': 'object',
            'properties': {
                'dialect': {'type': 'string', 'description': 'Database engine identifier.'},
            },
        },
        description='Return the database engine dialect (e.g. postgres, mysql, neo4j).',
    )
    def dialect(self, args):
        """Return the database engine dialect."""
        return {'dialect': self._db_dialect()}

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema={
            'type': 'object',
            'properties': {
                'database': {'type': 'string'},
                'tables': {'type': 'object', 'description': 'Map of table name to table definition.'},
                'refreshed_at': {'type': 'string', 'description': 'UTC ISO-8601 time the reflection completed.'},
            },
        },
        description=lambda self: (
            f'Re-reads the {self._db_display_name()} schema from the database and returns it, in the same '
            f'shape as get_schema plus a refreshed_at timestamp. get_schema serves the snapshot the node '
            f'currently holds -- the start-up reflection until a refresh_schema call replaces it -- so '
            f'tables and columns created or altered since the last reflection are invisible to it. '
            f'Call this after running DDL.'
        ),
    )
    def refresh_schema(self, args):
        """Re-reflect the database schema, replace the cache, and return it.

        ``IGlobal.db_schema`` is the same dict the natural-language path
        describes to the LLM (``_buildSQLQueryOnce`` -> ``describe_schema``),
        so refreshing it also stops ``get_data`` / ``get_sql`` writing queries
        against a table shape that no longer exists. ``IGlobal.schema`` -- the
        configured table's column map that the answers lane inserts against --
        is rebuilt from the same walk at the same time, so the node is current
        on both paths, not just the one this tool returns, and the next insert
        does not reflect the configured table a second time.

        Reflection and publication run under this node's ``reflect_lock`` so
        concurrent callers neither repeat the full table walk nor race on the
        cache. The lock is per-IGlobal, not process-wide: the walk is
        unbounded network I/O (the engine sets no statement timeout), and the
        only state it guards is this node's own two caches, so a second DB node
        in the same pipeline process has nothing to wait for. Declares no
        input; anything passed is ignored.

        Publication is all-or-nothing. ``_getDatabaseSchema`` walks every table
        with no per-table guard, so one ``get_columns`` the database refuses --
        a revoked grant, a lock timeout, a table dropped mid-walk -- ends the
        whole walk. The dropped-table case is reported in its own words because
        SQLAlchemy raises ``NoSuchTableError`` for it, whose only argument is
        the table name: formatted like any other driver error it would read
        ``Schema refresh failed: <name>``. Neither cache is touched in either
        case: the node keeps serving the schema it had and says the refresh
        failed, rather than publishing a half-walked database or, worse,
        rewriting ``IGlobal.schema`` from a half-walked result (or emptying it,
        which re-arms the insert lane's lazy rebuild against a database that
        just refused to be reflected) while ``db_schema`` still held the old
        value. Skipping the offending table and
        continuing, the way ``_getTableSchema`` warns and returns None for a
        single table, was the other option; it is rejected here because the LLM
        path cannot tell a table that vanished from one that could not be read,
        and would write queries as if it were gone.
        """
        with self._reflectLock():
            try:
                refreshed = self.IGlobal._getDatabaseSchema()
            except NoSuchTableError as e:
                # The "dropped mid-walk" case above raises this, and it is the
                # one reflection failure with no driver sentence behind it:
                # SQLAlchemy builds it from the table name alone, so `args[0]`
                # IS the name and the generic formatter would answer
                # "Schema refresh failed: ghost" -- a bare noun the caller
                # cannot tell from a database message. Name what happened.
                missing = e.args[0] if e.args else str(e)
                error(
                    f'Failed to refresh the schema of database "{self.IGlobal.database}": '
                    f'table "{missing}" disappeared between the table list and its reflection'
                )
                raise RuntimeError(
                    f'Schema refresh failed: table "{missing}" disappeared while it was being reflected'
                ) from None
            except Exception as e:
                # The full exception -- statement echo and all -- goes to the
                # server log; the caller gets the driver's own sentence. This
                # tool is not behind the `allow_execute` gate, so `str(e)` here
                # would hand the reflection statement to a caller who was never
                # granted raw SQL.
                error(f'Failed to refresh the schema of database "{self.IGlobal.database}": {e}')
                # `from None` keeps the driver traceback out of the tool response.
                raise RuntimeError(f'Schema refresh failed: {self.IGlobal._format_db_error(e)}') from None

            self.IGlobal.db_schema = refreshed
            # `db_schema` is not the only start-up snapshot: `IGlobal.schema`
            # holds the configured table's column map, and `_insertData`
            # iterates it to build every answers-lane INSERT. Leaving it alone
            # would make "refreshed" true for the LLM path and false for the
            # insert path -- a column added by the DDL that prompted this call
            # would still be skipped.
            #
            # It is REBUILT here rather than emptied. The walk above has already
            # read the configured table's columns, and emptying re-armed the
            # lazy rebuild at the top of `_insertData`, which reflected the same
            # table a second time on the next batch (dylan-savage, review
            # 5215826786 nit 4). The value shape is exactly what
            # `_getTableSchema` publishes and `_insertData` consumes --
            # `{name: (type, comment)}` -- with the comment slot empty, because
            # `_getDatabaseSchema` does not collect comments and `_insertData`
            # only ever reads this map by key. A configured table the refresh
            # did not find (dropped, renamed, or never set) still publishes an
            # empty map, which is both what task start leaves behind and what
            # re-arms the lazy rebuild for a table that comes back.
            #
            # The rebind is atomic and happens under the same `reflect_lock`
            # `_insertData` takes across its check, its rebuild and the snapshot
            # it builds the batch from, so a concurrent insert reads either the
            # old map or this one, never a half-built one.
            #
            # The rebuilt map is a plain reflection, so it carries columns the
            # map `_createTableFromData` curates for an auto-created table
            # deliberately does not: the primary key, and anything DDL has
            # added since. Changing what the INSERT carries is the POINT of the
            # invalidation -- a column added by the DDL that prompted this call
            # is exactly what the next insert should start populating.
            #
            # The guarantee that does hold is narrower: the database still
            # fills in what it owns either way. `_insertData` leaves out any
            # generated primary-key, server-default or identity column the rows
            # do NOT supply (and any other primary key they do not carry), so a
            # column present only in the reflected map is
            # either left to the database or bound the NULL it would have
            # stored anyway, whichever of the two maps a given call is holding.
            #
            # For a column a row DOES supply, the two maps differ and the
            # refresh is what changes the INSERT: on an auto-created table the
            # curated map has no `id`, so a row carrying one has it silently
            # dropped and the database generates a different value; after a
            # refresh the reflected map binds it and the row's own `id` is kept.
            # The post-refresh behaviour is the better of the two, but it is a
            # change, and honouring a supplied key on an auto-created table
            # before any refresh would mean curating the PK into that map --
            # a separate decision, not this one.
            table_info = refreshed.get(self.IGlobal.table)
            self.IGlobal.schema = (
                {name: (col_type, '') for name, col_type in table_info['columns']} if table_info else {}
            )
            refreshed_at = datetime.now(timezone.utc).isoformat()

        # Rendering is pure formatting over `refreshed`, so it runs after the
        # lock is dropped; holding a lock across it only widened the window in
        # which this node's own inserts wait. `refreshed` rather than
        # `IGlobal.db_schema` deliberately: a refresh that overtook this one
        # between the release and here has already published its own map, and
        # this call still owes its caller the schema IT reflected.
        tables = {name: _format_table(info) for name, info in refreshed.items()}
        return {'database': self.IGlobal.database, 'tables': tables, 'refreshed_at': refreshed_at}

    # ------------------------------------------------------------------
    # Sanitization helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _sanitize_value(val):
        """Convert a single database value to a JSON-serializable type."""
        if val is None or isinstance(val, (str, int, float, bool)):
            return val
        if isinstance(val, (dict, list, tuple)):
            # psycopg2 parses json/jsonb into dict/list (and composites into
            # tuples); repr() is not JSON and silently corrupts ORM clients
            # that JSON.parse driver values.
            return json.dumps(val, default=str)
        if hasattr(val, '__float__'):
            return float(val)
        if hasattr(val, 'isoformat'):
            return val.isoformat()
        if isinstance(val, bytes):
            return val.decode('utf-8', errors='replace')
        return str(val)

    @classmethod
    def _sanitize_row(cls, row):
        """Ensure every value in a result row is JSON-serializable."""
        if isinstance(row, dict):
            return {k: cls._sanitize_value(v) for k, v in row.items()}
        if isinstance(row, (list, tuple)):
            return [cls._sanitize_value(v) for v in row]
        return cls._sanitize_value(row)

    # ------------------------------------------------------------------
    # SQL query helpers
    # ------------------------------------------------------------------

    def _buildSQLQuery(self, question_text: str, *, limit: int = 250) -> dict:
        """Generate a SQL query and validate it with EXPLAIN, retrying on failure.

        Calls ``_buildSQLQueryOnce`` to ask the LLM, then runs ``EXPLAIN`` on
        the result.  If EXPLAIN rejects the query the error is fed back to the
        LLM and another attempt is made, up to ``IGlobal.max_validation_attempts``
        times.  Returns the last LLM response if EXPLAIN eventually accepts it;
        if every attempt is rejected, the result is forced to ``isValid: False``
        with the last EXPLAIN error carried in ``error``.
        """
        previous_sql: str | None = None
        last_error: str | None = None
        result: dict = {}

        for attempt in range(self.IGlobal.max_validation_attempts):
            result = self._buildSQLQueryOnce(question_text, limit=limit, previous_sql=previous_sql, error=last_error)

            is_valid = parse_bool(result.get('isValid', False))
            sql_query = result.get('query', '')

            # If the LLM decided the question isn't a DB query, or the safety
            # check rejects the SQL, return immediately — no point running EXPLAIN.
            if not is_valid or not sql_query or not is_sql_safe(sql_query):
                return result

            # Validate the generated SQL against the live database.
            ok, explain_error = self.IGlobal._validateQuery(sql_query)
            if ok:
                return result

            # EXPLAIN rejected the query — log and feed the error back so the
            # LLM can produce a corrected statement on the next attempt.
            warning(
                f'SQL validation attempt {attempt + 1}/{self.IGlobal.max_validation_attempts} failed: {explain_error}'
            )
            previous_sql = sql_query
            last_error = explain_error

        warning(f'SQL validation failed after {self.IGlobal.max_validation_attempts} attempt(s); rejecting the query.')
        # Every EXPLAIN attempt failed. Force isValid False so callers (get_sql,
        # get_data, writeQuestions) don't execute a query the database already
        # refused; keep the last query for context and carry the EXPLAIN error
        # so callers can tell this apart from a non-SQL question.
        result['isValid'] = False
        result['error'] = last_error or 'SQL validation failed'
        return result

    def _buildSQLQueryOnce(
        self, question_text: str, *, limit: int = 250, previous_sql: str | None = None, error: str | None = None
    ) -> dict:
        """Single LLM call: translate a natural-language question into SQL.

        ``previous_sql`` and ``error`` are supplied on retry attempts so the
        LLM knows what it generated before and what the database rejected,
        giving it the context needed to produce a corrected query.

        Returns the parsed JSON dict from the LLM with keys ``isValid`` and
        ``query``.
        """

        def describe_schema(schema: dict) -> str:
            """Format the db_schema dict into a concise text block for the LLM."""

            def simplify_type(sql_type: str) -> str:
                # Strip COLLATE clauses (e.g. VARCHAR(255) COLLATE utf8mb4_general_ci)
                # so the LLM sees clean type names.
                return sql_type.split('COLLATE')[0].strip().upper()

            lines = []
            for table_name, table_info in schema.items():
                columns = table_info.get('columns', [])
                if not columns:
                    continue
                lines.append(f'Table `{table_name}`:')
                pk_cols = set(table_info.get('primary_key', []))
                for name, sql_type in columns:
                    pk_marker = ' [PK]' if name in pk_cols else ''
                    lines.append(f'  {name}: {simplify_type(sql_type)}{pk_marker}')
                for fk in table_info.get('foreign_keys', []):
                    src = ', '.join(fk['columns'])
                    ref_table = fk['referred_table']
                    ref_cols = ', '.join(fk['referred_columns'])
                    lines.append(f'  FK: ({src}) -> {ref_table}({ref_cols})')
                lines.append('')
            return '\n'.join(lines).strip()

        db_schema_description = describe_schema(self.IGlobal.db_schema)

        question: Question = Question(type=QuestionType.QUESTION, role='You are a technical assistant.')
        question.addQuestion(question_text)

        if self.IGlobal.db_description:
            question.addContext(f'Database description: {self.IGlobal.db_description}')

        question.addContext(db_schema_description)
        question.expectJson = True

        question.addInstruction(
            'SQL Query Generation Guidelines',
            'Generate a query based only on the tables provided in context.',
        )
        question.addInstruction(
            'LIMIT',
            f'Limit the results to {limit} rows.',
        )
        question.addInstruction(
            'Formatting',
            'Do not wrap the SQL query in markdown (e.g., no triple backticks or language identifiers) and abide by formatting in the provided examples.',
        )
        question.addInstruction(
            'Commands',
            'You are only permitted to use SELECT. Avoid any unsafe operations (e.g., DELETE, UPDATE, INSERT).',
        )
        question.addInstruction(
            'Ambiguity',
            "If the user's question is ambiguous, make reasonable assumptions and attempt to craft a query. If you infer that the user's question or command is entirely unrelated to querying the database, attempt to answer the question in a manner similar to the provided by the example.",
        )

        # Concrete SQL example so the LLM understands the expected output shape.
        question.addExample(
            'Tell me the salaries of department managers',
            {
                'isValid': 'true',
                'query': (
                    'SELECT dm.emp_no, e.first_name, e.last_name, s.salary\nFROM dept_manager dm\nJOIN employees e ON dm.emp_no = e.emp_no\nJOIN salaries s ON dm.emp_no = s.emp_no\nWHERE CURRENT_DATE BETWEEN s.from_date AND s.to_date\nLIMIT 250'
                ),
            },
        )
        # Off-topic example so the LLM knows how to handle non-DB questions.
        question.addExample(
            'When did the Visigoths sack Rome?',
            {
                'isValid': 'false',
                'query': 'The Visigoths sacked Rome in 410 AD, under the leadership of their king, Alaric I.',
            },
        )

        # On a retry, provide the rejected SQL and the EXPLAIN error so the
        # LLM knows exactly what was wrong and can produce a corrected query.
        if previous_sql and error:
            question.addContext(
                f'Your previous attempt produced the following SQL:\n\n{previous_sql}\n\nThe database rejected it with this error:\n\n{error}\n\nPlease fix the query and try again.'
            )

        result = self.instance.invoke(IInvokeLLM.Ask(question=question))

        if not result or not result.answer:
            raise ValueError('LLM failed to return a SQL query.')

        return result.answer

    def _executeSQLQuery(self, query: str) -> list[dict] | None:
        """Execute a SQL SELECT query and return rows as a list of dicts."""
        try:
            with self.IGlobal.engine.connect() as conn:
                result = conn.execute(text(query))
                rows = result.fetchall()
                column_names = result.keys()
                return [dict(zip(column_names, row)) for row in rows]

        except SQLAlchemyError as e:
            error(f'Error executing SQL query: {e}')
            return None

    def _executeRawQuery(self, query: str, params: list | None = None, row_mode: str = 'object') -> dict:
        """Execute a raw SQL statement (read or write) without LLM or safety gating.

        Uses ``engine.begin()`` so writes auto-commit. Returns
        ``{'rows': [...], 'affected_rows': N}``; there is no failure return
        value, every failure raises. A SQLAlchemy error
        is logged via ``error()`` and re-raised as ``RuntimeError`` carrying
        the DRIVER's own message: the caller wrote the statement, so the caller
        is who needs to read "no such column: foo" — collapsing every failure
        into one opaque string made a typo, a missing table, and a permission
        error indistinguishable. A ``max_execute_rows``
        overflow raises ``RuntimeError`` from *inside* the transaction so
        ``engine.begin()`` rolls back — otherwise a write (e.g. ``INSERT ...
        RETURNING``) would commit even though ``execute()`` reports failure.

        SELECT results are bounded by ``IGlobal.max_execute_rows`` to keep a
        large query from exhausting worker memory.
        """
        from ai.common.database.tx_registry import shape_execute_result, to_sqlalchemy_text

        try:
            with self.IGlobal.engine.begin() as conn:
                clause, binds = to_sqlalchemy_text(query, params)
                result = conn.execute(clause, binds)
                shaped = shape_execute_result(result, self.IGlobal.max_execute_rows, row_mode)
                if shaped is None:
                    # Raise inside the transaction so it rolls back; returning
                    # None here would let an overflowing write commit anyway.
                    error(f'EXECUTE query exceeded max_execute_rows={self.IGlobal.max_execute_rows}')
                    raise RuntimeError(f'EXECUTE query exceeded max_execute_rows={self.IGlobal.max_execute_rows}')
                return shaped

        except Exception as e:
            # Both driver shapes, and nothing else. `_isDbFailure` carries the
            # reasoning: the dialect-wrapped SQLAlchemy exception, and the
            # unwrapped `DatabaseException` the `clickhouse+native://` connector
            # raises, whose raw text (server stack trace and the statement
            # fragment at the error position included) used to go straight to
            # the caller. Anything else is re-raised untouched -- the
            # max_execute_rows `RuntimeError` raised above most of all, whose
            # wording and rollback callers depend on.
            if not _isDbFailure(e):
                raise
            error(f'Error executing raw SQL query: {e}')
            # `from None` keeps the driver traceback out of the tool response;
            # the formatted message already carries what the caller needs.
            raise RuntimeError(f'SQL execution failed: {self.IGlobal._format_db_error(e)}') from None

    def _formatResultAsMarkdown(self, result: Any) -> str:
        """Convert a query result to a markdown table string."""
        headers = None
        data = []

        if isinstance(result, list) and result:
            first = result[0]
            if isinstance(first, dict):
                headers = list(first.keys())
                data = [[str(row.get(key, '')) for key in headers] for row in result]
            elif isinstance(first, (list, tuple)):
                data = [[str(cell) for cell in row] for row in result]
            else:
                data = [[str(row)] for row in result]
        elif isinstance(result, tuple) and len(result) == 2:
            headers, rows = result
            data = [[str(cell) for cell in row] for row in rows]
        else:
            data = [[str(result)]]

        return Table.generate_markdown_table(data, headers)

    # ------------------------------------------------------------------
    # Pipeline lane handlers
    # ------------------------------------------------------------------

    def writeQuestions(self, question: Question) -> None:
        """Handle an incoming question: translate to SQL, execute, and emit results."""
        question_text = question.questions[0].text if question.questions else None

        if not question_text:
            warning('No question text provided.')
            return

        lanes = self.instance.getListeners()

        try:
            # Ask the LLM to translate the natural-language question into SQL.
            query_json = self._buildSQLQuery(question_text)
            sql_query = query_json.get('query')
            is_valid_query = parse_bool(query_json.get('isValid', False))

            # The EXPLAIN repair loop gave up: `query` still holds the rejected
            # SQL, not an answer. Emit the error instead of printing it as prose.
            if query_json.get('error'):
                self._emitError(query_json['error'], lanes)
                return
            # The LLM claimed valid SQL but it fails the safety gate: same rule
            # -- surface the rejection, never emit the unsafe SQL as prose/data.
            if is_valid_query and sql_query and not is_sql_safe(sql_query):
                self._emitError('Generated query contains unsafe SQL', lanes)
                return

            executed = is_valid_query and bool(sql_query)
            # When the LLM decides it isn't a DB question, `sql_query` holds its prose answer.
            result = self._executeSQLQuery(sql_query) if executed else sql_query

            self._emit(result, lanes, executed=executed)

        except Exception as e:
            error(f'Error handling question: {e}')

    def _emitError(self, message: str, lanes) -> None:
        """Emit a validation/safety error to the wired lanes, never a rejected query as prose.

        The answers lane wraps the message as ``{'error': message}`` JSON (matching
        graph_instance_base.py), so a real prose answer and an error are structurally
        distinguishable one lane down -- both would otherwise be indistinguishable
        plain strings.
        """
        if 'text' in lanes:
            self.instance.writeText(message)
        if 'answers' in lanes:
            answer = Answer()
            answer.setAnswer(json.dumps({'error': message}))
            self.instance.writeAnswers(answer)

    def _emit(self, result, lanes, *, executed: bool) -> None:
        """Write a query result to whichever of the text/table/answers lanes are wired.

        ``executed`` distinguishes real query results from a rejected/prose
        fallback -- the table lane and the answers lane's markdown formatting
        must key off whether the query actually ran, not just whether the LLM
        claimed the SQL was valid.
        """
        if 'text' in lanes:
            self.instance.writeText(str(result))

        if 'table' in lanes and executed and result:
            self.instance.writeTable(self._formatResultAsMarkdown(result))

        if 'answers' in lanes:
            answer = Answer()
            answer.setAnswer(self._formatResultAsMarkdown(result) if executed and result else str(result))
            self.instance.writeAnswers(answer)

    def writeTable(self, markdown: str) -> None:
        """Handle incoming markdown table data — parse and insert into the database."""
        if not markdown or not markdown.strip():
            debug('No table data provided.')
            return

        # Table.parse_markdown_table handles separator detection robustly and
        # auto-converts numeric strings to int/float, which produces better
        # type inference when _insertData creates a new table from the data.
        headers, items = Table.parse_markdown_table(markdown)

        if not headers or not items:
            warning(f'Could not parse markdown table data. Raw data: {markdown[:200]}...')
            return

        # Convert from (headers, list-of-lists) to the list-of-dicts that
        # _insertData expects.
        rows = [dict(zip(headers, row)) for row in items]

        try:
            self._insertData(rows)
        except Exception as e:
            error(f'Error inserting table data: {e}')

    def writeAnswers(self, answer: Answer) -> None:
        """Handle incoming structured answer data — extract JSON rows and insert."""
        items = answer.getJson()

        if not items:
            debug('No items to insert.')
            return

        try:
            self._insertData(items)
        except Exception as e:
            error(f'Error in writeAnswers: {e}')

    # ------------------------------------------------------------------
    # Data insertion
    # ------------------------------------------------------------------

    def _insertData(self, items: List[Dict[str, Any]]) -> None:
        """Insert rows into the database table, auto-creating it if needed."""
        if not items:
            debug('No items to insert.')
            return

        # Auto-create the table from the incoming data shape if it doesn't exist.
        if not self.IGlobal._tableExists(self.IGlobal.table):
            debug(f'Table "{self.IGlobal.table}" does not exist. Creating it from data structure...')
            if not self.IGlobal._createTableFromData(self.IGlobal.table, items):
                error(
                    f'Failed to create table "{self.IGlobal.table}". Please create it manually before running the pipeline.'
                )
                raise RuntimeError(
                    f'Table "{self.IGlobal.table}" does not exist and could not be created automatically.'
                )
            debug(f'Successfully created table "{self.IGlobal.table}" from data structure.')

        # Fetch the schema if it wasn't populated at startup (e.g. the table
        # was just created above, or beginGlobal found no table), then take a
        # private snapshot to build this batch from.
        #
        # The check, the rebuild and the snapshot are one critical section.
        # The map is empty at task start, after `beginGlobal` found no table,
        # and after a `refresh_schema` whose walk did not find the configured
        # table, so at runtime a second insert can arrive while the first is
        # reflecting, and the state it would observe is wrong: a map still
        # being built silently drops the columns not yet added.
        #
        # What the snapshot buys is one map for the whole batch. Both parts of
        # that matter and they are different: binding it to a local is what
        # stops a `refresh_schema` arriving mid-batch from swapping the map the
        # per-row loop below is walking (every publisher REBINDS
        # `IGlobal.schema` -- `_getTableSchema` and `_createTableFromData` both
        # assign a map they finished building, so nothing mutates the live one
        # in place today), and copying it is what keeps that true if a future
        # publisher ever fills a map in place again, which is exactly the bug
        # both publishers were fixed for. The copy is a handful of tuples.
        #
        # Every batch takes the lock, even the common case where the map is
        # already built and the body is one falsy test. The trade-off is
        # deliberate: an uncontended acquire is a few hundred nanoseconds
        # against an insert that is about to do network I/O, and the two
        # cheaper shapes both cost correctness. A check-then-lock fast path has
        # to read `IGlobal.schema` once into a local and snapshot THAT -- read
        # it twice and a `refresh_schema` landing between the two hands this
        # batch an empty map -- which is a second code path pinned by no test.
        # What made the unconditional acquire expensive was that the lock was
        # process-wide: the waiting was on OTHER nodes' reflections. `reflect_lock`
        # is per-IGlobal, so the only thing this batch can queue behind is this
        # node's own refresh or rebuild, which it genuinely must not read past.
        #
        # The lock is released before the Table reflection and before the
        # INSERT. Neither reads `IGlobal.schema` and both are slow.
        with self._reflectLock():
            if not self.IGlobal.schema:
                # `_getTableSchema` publishes the map it builds, in one
                # assignment once the walk is complete, and returns the same
                # columns as pairs. Rebuilding `IGlobal.schema` from those
                # pairs here produced the identical key set with the reflected
                # column comment blanked to '' -- a second publisher for no
                # gain, since this map is only ever read by key. `refresh_schema`
                # does publish exactly that comment-less shape, out of its own
                # walk, which is fine for a map read by key; what this block
                # avoids is a THIRD publisher, running on every batch.
                if not self.IGlobal._getTableSchema(self.IGlobal.table):
                    error(f'Unable to retrieve schema for table "{self.IGlobal.table}"')
                    raise RuntimeError(f'Table "{self.IGlobal.table}" schema could not be retrieved.')
            schema = dict(self.IGlobal.schema)

        metadata = MetaData()
        engine = self.IGlobal.engine

        # Reflect the live table definition so SQLAlchemy knows the exact
        # column set and types when building the INSERT statement.
        try:
            table = SQLTable(self.IGlobal.table, metadata, autoload_with=engine)
        except NoSuchTableError:
            error(
                f'Table "{self.IGlobal.table}" does not exist in database "{self.IGlobal.database}". Please create it manually before running the pipeline.'
            )
            raise

        # Columns the database fills in itself must not be bound, whether the
        # row omits them or carries an explicit null for them. The loop below
        # binds NULL for any schema column the incoming rows do not provide, and
        # an explicit NULL is not "please supply the value" to any database --
        # it overrides a server default and violates NOT NULL. Postgres renders
        # `Column('id', Integer, primary_key=True, autoincrement=True)` as
        # `id SERIAL NOT NULL`; a `created_at timestamptz NOT NULL DEFAULT now()`
        # behaves the same way.
        #
        # `_createTableFromData` curates `IGlobal.schema` down to the data
        # columns for exactly this reason, but any map built by reflection --
        # `beginGlobal` for a table that already existed, `refresh_schema`'s
        # own rebuild, or the lazy rebuild above -- carries every column the
        # table has. That difference is meant to reach the INSERT: a
        # column added by DDL is one the next insert should populate. What must
        # NOT reach it is a NULL bound into a column the database owns, so both
        # kinds are read off the reflected table and skipped -- omitted or
        # explicitly null, it makes no difference: generated primary keys, and
        # anything carrying a server default or an identity.
        #
        # The decision is per ROW. Taking it once for the batch, from the union
        # of the rows' keys, meant one row carrying `id` put `id` into every
        # mapping, so the rows that omitted it bound NULL into a key the
        # database was supposed to generate.
        generated_pk_columns = _generated_primary_keys(table)
        generated_defaults = {
            column.name.lower()
            for column in table.columns
            if column.server_default is not None or column.identity is not None
        }
        pk_names = {column.name.lower() for column in table.primary_key.columns}

        def prepare_value(value: Any) -> Any:
            """Convert complex Python types to SQL-compatible values."""
            if value is None:
                return None
            elif isinstance(value, (list, dict)):
                # Serialise composite types as JSON strings.
                return json.dumps(value)
            elif isinstance(value, bool):
                # Most SQL databases represent booleans as integer 0/1.
                return 1 if value else 0
            else:
                return value

        # Build the list of row dicts, mapping incoming keys to schema column
        # names with case-insensitive matching. Nothing here refuses a row: the
        # node decides only what it must not BIND, and the database decides
        # what it will accept. Every run of the batch shares one
        # `engine.begin()` below, so a row the database refuses rolls the whole
        # batch back and leaves no row of it behind.
        insert_values = []
        for item in items:
            if not isinstance(item, dict):
                continue

            # `schema` is never empty here: the locked block above either left
            # `IGlobal.schema` populated or raised.
            values: Dict[str, Any] = {}
            # Case-insensitive key lookup so 'UserName' maps to 'username'.
            item_lower_keys = {k.lower(): k for k in item.keys()}
            for colname in schema.keys():
                lowered = colname.lower()
                original_key = item_lower_keys.get(lowered)
                if original_key is not None:
                    supplied = item[original_key]
                    if supplied is None and (lowered in generated_pk_columns or lowered in generated_defaults):
                        # An explicit null on a column the DATABASE owns means
                        # the same thing as omitting it. The caller on this lane
                        # is an upstream node, not a person: an LLM node or a
                        # JSON mapper emits every schema key, writing null for
                        # the ones it has no value for. Binding that NULL is a
                        # not-null violation on Postgres and a silent one, since
                        # `writeAnswers` only logs. (The `execute` tool is a
                        # different contract and is not affected: a person wrote
                        # that statement and their NULL is theirs.)
                        #
                        # The same column set as the omitted-column branch below,
                        # deliberately: generated keys AND server defaults /
                        # identities. Splitting the rule by nullability, or by
                        # key-ness, would make one emitted row land differently
                        # depending on a column attribute its sender cannot see.
                        continue
                    # Supplied, including an explicit None on a column with
                    # nothing behind it: the caller asked for NULL and gets NULL.
                    values[colname] = prepare_value(supplied)
                elif lowered in generated_pk_columns or lowered in generated_defaults:
                    # The database owns this column's value when the row omits
                    # it -- a generated key, or a server default / identity.
                    continue
                elif lowered in pk_names:
                    # A primary key reflection does not show as generated, that
                    # the row does not carry. This used to be a pre-flight
                    # ValueError; it is an omission now. Reflection describes
                    # columns, not triggers, so "no default" does not mean
                    # "nobody fills it in" -- the standard pre-8.0.13 MySQL UUID
                    # idiom is a CHAR(36) key filled by a BEFORE INSERT trigger,
                    # which reflects exactly like a key nobody supplies, and
                    # refusing the row meant the trigger never ran. Leaving the
                    # column out lets it run. Binding NULL is still not the
                    # alternative -- but not because a bound NULL defeats the
                    # trigger: a BEFORE ROW trigger fires before the NOT NULL
                    # check on PostgreSQL and on MySQL 5.7+, sees the NULL and
                    # fills it. What an explicit NULL does override is a column
                    # DEFAULT, and where no trigger exists it is a NOT NULL
                    # violation. Omitting the column is the one shape that works
                    # for a default, a trigger and a generated key alike, so the
                    # choice is between omitting the column and refusing the row,
                    # and refusing it is the database's call, not this node's.
                    #
                    # SQLAlchemy emits a SAWarning for exactly this shape ("is
                    # marked as a member of the primary key ... and no explicit
                    # value is passed"). It is correct to warn and wrong to
                    # silence: the statement really does leave a key to the
                    # database, which is the point. It goes out through Python's
                    # `warnings` module -- stderr under the default filter, once
                    # per distinct message per process, so once per table/column
                    # per engine process -- and never reaches the tool response;
                    # rocketlib does not route warnings through its logger.
                    continue
                else:
                    # Column in schema, no value in the row, no default behind
                    # it — insert NULL.
                    values[colname] = None
            insert_values.append(values)

        if insert_values:
            # Rows whose mappings differ are not one executemany any more, so
            # group CONTIGUOUS rows that share a key set. Contiguous rather than
            # gathered: a generated id follows insertion order, and reordering
            # the batch would hand the caller ids in an order their rows never
            # had. Every run shares one engine.begin(), so the batch stays
            # all-or-nothing exactly as a single executemany was.
            runs: List[List[Dict[str, Any]]] = []
            previous_keys = None
            for values in insert_values:
                keys = tuple(values)
                if keys != previous_keys:
                    runs.append([])
                    previous_keys = keys
                runs[-1].append(values)

            try:
                with self.IGlobal.engine.begin() as conn:
                    for run in runs:
                        if run[0]:
                            conn.execute(insert(table), run)
                            continue
                        # Nothing left to bind: every column of these rows is
                        # the database's to fill -- generated, defaulted, or a
                        # key this node declines to guess at. Handing the
                        # statement no values at all lets SQLAlchemy render the
                        # dialect's own form (`DEFAULT VALUES` on PostgreSQL and
                        # SQLite, `() VALUES ()` on MySQL) instead of binding
                        # NULL into a column the database was about to fill.
                        for _ in run:
                            conn.execute(insert(table))
                debug(f"Inserted {len(insert_values)} records into '{self.IGlobal.table}' in {len(runs)} run(s).")
            except Exception as e:
                # The context manager has already rolled back every run of the
                # batch; nothing of it is written. The full exception --
                # statement echo and bound values included -- goes to the server
                # log, and the caller gets the driver's own sentence through the
                # same formatter the `execute` tool uses. That matters more now
                # that the node no longer refuses a row itself: a key nothing
                # fills in fails HERE, and "NOT NULL constraint failed:
                # codes.code" is what says so. A failure that is not a database
                # failure is re-raised untouched -- the same `_isDbFailure`
                # predicate the two execute sites ask.
                error(f'Error inserting data into "{self.IGlobal.table}": {e}')
                if not _isDbFailure(e):
                    raise
                # `from None` keeps the driver traceback out of the message.
                raise RuntimeError(
                    f'Insert into "{self.IGlobal.table}" failed: {self.IGlobal._format_db_error(e)}'
                ) from None
        else:
            debug('No records to insert.')
