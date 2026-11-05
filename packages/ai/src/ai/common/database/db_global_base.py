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
Shared global (connection-level) base class for relational database nodes.

Derived classes must implement two methods that carry the only
driver-specific knowledge:

- ``_connection_params``: maps the node's stored config (whose keys are
  DB-namespaced, e.g. ``mysql.host``) into a flat dict with canonical keys
  ``host``, ``user``, ``password``, ``database``, ``table``.

- ``_build_connection_url``: turns those flat params into a SQLAlchemy DSN
  string, e.g. ``mysql+pymysql://user:pass@host/db``.

Everything else — schema reflection, type inference, table auto-creation,
session lifecycle — is handled here and is dialect-agnostic.
"""

import re
import threading

from abc import ABC, abstractmethod
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Dict, Iterator, List, Optional, Tuple

from sqlalchemy import (
    Column,
    DateTime,
    Float,
    Integer,
    MetaData,
    String,
    Text,
    Table as SQLTable,
    create_engine,
    inspect,
    text,
)
from sqlalchemy.engine import Connection
from sqlalchemy.exc import DBAPIError

from rocketlib import IGlobalBase, error, warning
from ai.common.config import Config

DEFAULT_MAX_EXECUTE_ROWS = 25000

# Everything a driver or SQLAlchemy appends to its primary message that can
# echo the executed statement or the values bound into it back to the caller:
#
#   * SQLAlchemy's StatementError repr ends in "[SQL: ...]" / "[parameters: ...]"
#     / "[cached since ...]" / the sqlalche.me background link.
#   * psycopg2 quotes the offending line of the statement as "LINE n: ..."
#     followed by a caret marker, and psycopg2 interpolates bind values
#     client-side, so that line can contain the parameters verbatim.
#   * PostgreSQL DETAIL/HINT/CONTEXT/QUERY/STATEMENT blocks routinely restate
#     the offending key values ("Key (email)=(a@b.com) already exists.").
#
# The primary message alone -- "no such column: foo", "duplicate key value
# violates unique constraint users_email_key" -- is what a caller needs in
# order to fix their statement, and it carries no user data.
#
# Two alternation groups, because the two kinds of marker cannot be matched
# the same way:
#
#   * The tails a library APPENDS can begin anywhere, mid-line included, so
#     they stay bare substrings.
#   * PostgreSQL's five context blocks are separate LINES of the server
#     message. As bare substrings they also fired inside an application's own
#     text: a PL/pgSQL `RAISE EXCEPTION 'Order rejected. HINT: contact
#     billing'` was cut to "Order rejected.", and a MySQL message reading
#     "Invalid QUERY: missing tenant filter" to "Invalid". So they are
#     anchored to a preceding newline. The anchor is `\n` and not `(?m)^`
#     deliberately: `^` also matches at position 0, which would make a message
#     whose first token is one of the five all-detail and degrade it to the
#     fallback constant.
_DB_ERROR_DETAIL = re.compile(
    r"""
        \[SQL:
      | \[parameters:
      | \[cached\ since
      | \[generated\ in
      | \(Background\ on\ this\ error
      | LINE\ \d+:
      | \n[ \t]*(?:DETAIL:|HINT:|CONTEXT:|QUERY:|STATEMENT:)
    """,
    re.VERBOSE,
)


# Returned when a message carries no primary sentence at all, so the caller
# always gets a non-empty string and never the statement echo.
_DB_ERROR_FALLBACK = 'Database error'

# A SQLSTATE as the standard defines it: five characters, digits and capitals.
# ODBC-backed drivers (pyodbc and friends) report `(sqlstate, message)` where
# pymysql reports `(errno, message)`, so the integer branch in
# `_format_db_error` misses them. Matched strictly so that a driver which
# merely happens to put two strings in `args` keeps the old behaviour.
_SQLSTATE = re.compile(r'\A[0-9A-Z]{5}\Z')


def _strip_statement_detail(message: str) -> str:
    """Cut a driver/SQLAlchemy message down to its primary sentence.

    Everything from the first ``_DB_ERROR_DETAIL`` marker onwards is dropped,
    because that tail is where the executed statement and its bind parameters
    live. Returns the input unchanged when there is no marker.

    When the message is nothing but detail there is no primary sentence to
    keep, so the fallback is a neutral constant rather than the first line:
    that line would be the ``[SQL: ...]`` echo this function exists to remove,
    and handing it back would defeat the whole point on the one input where it
    matters most.

    Module-level rather than a method so ``_format_db_error`` stays usable
    when it is bound onto a stub IGlobal (see tests/database/test_execute_session.py).
    """
    match = _DB_ERROR_DETAIL.search(message)
    trimmed = message[: match.start()] if match else message
    trimmed = trimmed.strip()
    return trimmed or _DB_ERROR_FALLBACK


class DatabaseGlobalBase(IGlobalBase, ABC):
    """Abstract base for the IGlobal layer of any relational database node."""

    engine = None
    tx_registry = None  # type: ignore[assignment]  # TransactionRegistry, set in beginGlobal
    database: str = ''
    table: str = ''
    db_description: str = ''
    schema: Dict[str, Tuple[str, str]] = {}
    db_schema: Dict[str, Dict] = {}
    max_validation_attempts: int = 5
    allow_execute: bool = False
    max_execute_rows: int = DEFAULT_MAX_EXECUTE_ROWS

    # SQLAlchemy pool sizing for the runtime engine opened in `beginGlobal`.
    POOL_SIZE: int = 10
    MAX_OVERFLOW: int = 20

    # Longest a generated query may run, in seconds (`read_only_connection`): a pg_sleep or a cartesian
    # product the LLM wrote must not hold a worker and a pooled connection indefinitely.
    READ_QUERY_TIMEOUT: int = 60

    # ClickHouse only: the settings sent with each generated query, worked out from the user's profile on first use
    _clickhouse_settings: Optional[Dict[str, float]] = None

    # Serialises this node's schema re-reflection: `refresh_schema`'s full
    # table walk against `_insertData`'s lazy rebuild of `schema`, and either
    # of those against another copy of itself. Both writers rebind `schema` and
    # `db_schema` wholesale, and neither is read by any other IGlobal, so the
    # state this protects is exactly one node's -- hence one lock per IGlobal,
    # created in `beginGlobal`. A module-level lock covered the same races but
    # also made them cross-node: a refresh walking a wide database (no
    # statement timeout on the engine) stalled the answers lane of every DB
    # node in the engine process, which the pre-refresh_schema code never did.
    # `None` here rather than a real lock so that a global which never ran
    # `beginGlobal` fails loudly instead of silently sharing class state:
    # `DatabaseInstanceBase._reflectLock` turns that into a named RuntimeError
    # before either caller enters its `with`.
    reflect_lock: Optional[threading.Lock] = None

    # ------------------------------------------------------------------
    # Abstract interface — derived classes MUST implement these two methods
    # ------------------------------------------------------------------

    @abstractmethod
    def _connection_params(self, config: Dict[str, Any]) -> Dict[str, str]:
        """Map the node's stored config to a flat connection-params dict.

        Must return a dict with exactly these keys:
            host, user, password, database, table
        """

    def _max_validation_attempts(self, config: Dict[str, Any]) -> int:
        """Return the maximum number of EXPLAIN-validation retries for generated SQL.

        Override in a derived class to read the value from the node's config.
        The base implementation returns 5, matching the services.json default.
        """
        return 5

    def _db_description(self, config: Dict[str, Any]) -> str:
        """Return the user-provided description of the database content and purpose.

        Override in a derived class to read the value from the node's config.
        The base implementation returns an empty string.
        """
        return ''

    @abstractmethod
    def _build_connection_url(self, params: Dict[str, str]) -> str:
        """Return a SQLAlchemy DSN string for this database engine.

        ``params`` is the dict returned by ``_connection_params``.
        The password in ``params['password']`` is the raw string; URL-encoding
        should be applied here if the driver requires it.

        Example (MySQL):
            password = urllib.parse.quote_plus(params['password'])
            return f"mysql+pymysql://{params['user']}:{password}@{params['host']}/{params['database']}"
        """

    # ------------------------------------------------------------------
    # Validation helpers
    # ------------------------------------------------------------------

    def _format_db_error(self, exc: Exception) -> str:
        """Return the driver's own message, cut at the first statement echo.

        This string is user-facing: ``_executeRawQuery`` re-raises it as a
        ``RuntimeError`` that reaches the ``execute`` tool caller, so it must
        say what went wrong without echoing back what was run.

        Read "never the statement or its parameters" as "never the statement
        the caller sent, nor a value they bound, as a repeated block" -- the
        exact promise is spelled out under REMOVED / PASSED THROUGH below,
        because a driver's own primary sentence can still quote the token it
        stopped on, and overclaiming here is how the ClickHouse leak dylan
        found in review 5215826786 stayed invisible.

        ``str(exc)`` is the wrong answer for a SQLAlchemy ``StatementError``:
        its repr appends ``[SQL: ...]`` and ``[parameters: ...]``, which is
        exactly the data that must stay in the server log. So each driver
        shape is unwrapped explicitly and only the primary message is kept:

        * pymysql puts ``(errno, message)`` in ``.orig.args``
          -> ``Error <code>: <message>``.
        * Drivers that carry the code on ``.code`` and the text on ``.message``
          (clickhouse-driver) are read directly -> ``Error <code>: <message>``.
          The db_clickhouse node overrides this method for ClickHouse's own text,
          whose echoes these markers do not cover.
        * psycopg2 exposes the server's primary message on ``.orig.diag``;
          its ``str()`` also carries the ``LINE n:`` echo of the statement,
          which psycopg2 has already interpolated the bind values into.
          ``diag.message_primary`` is returned WITHOUT the stripper, because
          the server has already split DETAIL / HINT / CONTEXT / QUERY /
          STATEMENT and the ``LINE n:`` echo onto ``diag`` fields of their
          own: there is no tail left in it, so a marker firing there could
          only be truncating the application's own wording.
        * ODBC-backed drivers (pyodbc and friends) report
          ``(sqlstate, message)`` where pymysql reports ``(errno, message)``,
          so a five-character SQLSTATE in ``args[0]`` is prefixed the same way
          an integer errno is -> ``Error <sqlstate>: <message>``. No node in
          this repo uses such a driver today; the branch is here so the
          generic one below cannot return the bare code.
        * sqlite3 (and anything else) puts the bare message in ``.orig.args[0]``.

        Every branch runs through ``_strip_statement_detail`` as a backstop,
        so a driver shape not enumerated here still cannot leak the tail --
        every branch except the ``diag.message_primary`` one above, which the
        server has already separated from its context blocks and which
        therefore has no tail for the stripper to find.

        What this does and does not promise, stated exactly, because the
        difference matters and is easy to overclaim:

        * REMOVED: SQLAlchemy's ``[SQL: ...]`` / ``[parameters: ...]`` /
          ``[cached since ...]`` tail, and the drivers' trailing blocks --
          psycopg2's ``LINE n:`` echo, PostgreSQL's DETAIL / HINT / CONTEXT /
          QUERY / STATEMENT *as lines of the message* (the five words are
          left alone in the middle of a sentence, where they belong to the
          application, not to the server).
        * PASSED THROUGH: the driver's own primary sentence, as the database
          wrote it. A syntax error can quote part of the statement: sqlite3
          and psycopg2 name the token they rejected, but MySQL 1064 ``near '...'
          at line N`` quotes the rest of the statement from where the parser
          stopped, up to 80 characters, so a value bound after that point can
          appear in it (pymysql and psycopg2 interpolate bind values
          client-side). It can also
          quote a value the statement merely TOUCHED rather than carried:
          PostgreSQL's ``invalid input syntax for type integer: "<value>"``
          names the offending row value for an ``INSERT ... SELECT`` or a
          ``CAST``, which may come from another table.

        That is accepted, not overlooked. The recipient holds
        ``allow_execute``, so they can already read anything the database user
        can read by writing a ``SELECT``; passing the message through does not
        widen their read access, it only tells them why their own statement
        failed. Blanking quoted tokens generically is not the answer either,
        because MySQL quotes identifiers with single quotes too ("Unknown
        column 'foo' in 'field list'"), so the redaction would delete the one
        thing the caller needs. The full exception, statement and binds
        included, stays in the server log.
        """
        try:
            # SQLAlchemy wraps driver exceptions in DBAPIError; the original
            # driver exception lives in .orig.
            orig = getattr(exc, 'orig', None)
            if orig is None:
                orig = exc

            args = getattr(orig, 'args', ())
            is_seq = isinstance(args, (list, tuple))

            if is_seq and len(args) >= 2 and isinstance(args[0], int):
                return _strip_statement_detail(f'Error {args[0]}: {args[1]}')

            # psycopg2: diag.message_primary is the server message with the
            # LINE/DETAIL/HINT context already split off.
            diag = getattr(orig, 'diag', None)
            primary = getattr(diag, 'message_primary', None) if diag is not None else None
            if isinstance(primary, str) and primary.strip():
                code = getattr(orig, 'pgcode', None)
                primary = primary.strip()
                # Returned WITHOUT the stripper. `message_primary` is the one
                # field the server has already separated from its own context
                # blocks -- psycopg2 puts DETAIL / HINT / CONTEXT / QUERY /
                # STATEMENT and the `LINE n:` echo on `diag` fields of their
                # own -- so there is no tail here to cut, and running the
                # markers over it could only truncate an application's text
                # (`RAISE EXCEPTION 'Order rejected. HINT: contact billing'`).
                return f'Error {code}: {primary}' if isinstance(code, str) and code else primary

            # Drivers such as clickhouse-driver carry the code on `.code` and the
            # text on `.message`, not as an (int, str) pair in args, so the
            # numeric branch above misses it and args[0] alone would drop the
            # code that identifies the failure.
            code = getattr(orig, 'code', None)
            message = getattr(orig, 'message', None)
            if isinstance(code, int) and isinstance(message, str) and message.strip():
                return _strip_statement_detail(f'Error {code}: {message}')

            # ODBC-backed drivers report `(sqlstate, message)`. Without this
            # branch the generic one below returned the five-character code
            # alone -- the half of the pair a caller cannot act on.
            if (
                is_seq
                and len(args) >= 2
                and isinstance(args[0], str)
                and _SQLSTATE.match(args[0])
                and isinstance(args[1], str)
                and args[1].strip()
            ):
                return _strip_statement_detail(f'Error {args[0]}: {args[1]}')

            # sqlite3 and the generic DBAPI shape: args[0] is the message.
            if is_seq and args and isinstance(args[0], str) and args[0].strip():
                return _strip_statement_detail(args[0])

            if orig is not exc:
                return _strip_statement_detail(str(orig))
        except Exception:
            pass
        return _strip_statement_detail(str(exc))

    def validateConfig(self):
        """Quick save-time validation: probe the database with SELECT 1.

        Surfaces driver/provider error messages verbatim so the user can see
        exactly what went wrong (wrong password, unreachable host, etc.).
        """
        engine = None
        try:
            raw = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            params = self._connection_params(raw)
            db_url = self._build_connection_url(params)

            # Short connect timeout for the validation probe; pre_ping ensures
            # we don't hand out stale connections.
            engine = create_engine(
                db_url,
                pool_pre_ping=True,
                connect_args={'connect_timeout': 5},
            )

            # Minimal probe: confirm credentials and reachability with SELECT 1.
            with engine.connect() as conn:
                conn.execute(text('SELECT 1'))

            # Do not reflect tables at save-time; let the runtime surface
            # table errors when the pipeline actually runs.

        except DBAPIError as e:
            warning(self._format_db_error(e))
            return
        except Exception as e:
            warning(self._format_db_error(e))
            return
        finally:
            # Always release the transient validation engine so connections
            # don't linger after the config dialog closes.
            try:
                if engine:
                    engine.dispose()
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Table / schema helpers
    # ------------------------------------------------------------------

    def _tableExists(self, table: str) -> bool:
        """Return True if the table exists in the connected database."""
        if not self.engine:
            return False
        try:
            inspector = inspect(self.engine)
            return table in inspector.get_table_names()
        except Exception:
            return False

    def _is_datetime_string(self, value: str) -> bool:
        """Return True if the string matches a common date or datetime format."""
        if not isinstance(value, str):
            return False
        # Check the two most common date/datetime formats found in data exports.
        for fmt in ('%Y-%m-%d', '%Y-%m-%d %H:%M:%S'):
            try:
                datetime.strptime(value, fmt)
                return True
            except ValueError:
                pass
            except Exception as e:
                warning(f'Unexpected error while checking datetime format for value "{value}": {e}')
                return False
        return False

    def _inferColumnType(self, value: Any) -> type:
        """Infer a SQLAlchemy column type from a Python value."""
        if value is None:
            # Null values carry no type information; default to the widest type.
            return Text

        python_type = type(value)

        if python_type is int:
            return Integer
        elif python_type is float:
            return Float
        elif python_type is bool:
            # SQL databases commonly represent booleans as integer 0/1.
            return Integer
        elif python_type in (list, dict):
            # Composite types are serialised to JSON strings before insertion.
            return Text
        elif python_type in (str, bytes):
            if isinstance(value, str):
                try:
                    if self._is_datetime_string(value):
                        return DateTime
                except Exception as e:
                    warning(f'Error detecting datetime format for value "{value}": {e}')
            return Text
        else:
            return Text

    def _createTableFromData(self, table: str, sample_data: List[Dict[str, Any]]) -> bool:
        """Create a table based on sample data structure.

        Scans all rows to infer the broadest compatible SQLAlchemy type for
        each column.  An auto-increment ``id`` primary key is always prepended
        so the database engine has an explicit clustered index.
        """
        if not self.engine or not sample_data:
            return False

        try:
            first_row = sample_data[0] if sample_data else {}
            if not isinstance(first_row, dict):
                return False

            # ------------------------------------------------------------------
            # Phase 1: infer a column type for every key in the first row,
            # then widen (or narrow) it by scanning the remaining rows.
            # ------------------------------------------------------------------
            columns = []
            for col_name, col_value in first_row.items():
                # Seed the inferred type from the first row's value.
                inferred_type = self._inferColumnType(col_value)
                has_complex_types = isinstance(col_value, (list, dict))

                for row in sample_data[1:]:
                    if not isinstance(row, dict):
                        continue
                    if col_name not in row or row[col_name] is None:
                        # Missing / null values carry no type info; skip.
                        continue

                    row_value = row[col_name]
                    if isinstance(row_value, (list, dict)):
                        # Complex types always serialise to Text; no need to
                        # scan further rows for this column.
                        has_complex_types = True
                        inferred_type = Text
                        break

                    row_type = self._inferColumnType(row_value)

                    # Type-widening / narrowing rules applied in priority order:
                    #
                    #   • Text (default from None) can be narrowed to a more
                    #     specific type when we see a concrete value.
                    #   • Integer widens to Float (Float is a numeric superset).
                    #   • Any concrete type + an actual string → must be Text.
                    #   • Two incompatible concrete types (e.g. Integer vs
                    #     DateTime) → no clean common SQL type; fall back to Text.
                    if not has_complex_types:
                        if inferred_type == Text and row_type != Text:
                            # Tentatively narrow from the null-default; may
                            # still widen to Text again on a later row.
                            inferred_type = row_type
                        elif inferred_type == Integer and row_type == Float:
                            # Float can represent all integers; widen.
                            inferred_type = Float
                        elif row_type == Text and inferred_type != Text:
                            # A real string value forces the column to Text.
                            inferred_type = Text
                        elif inferred_type != Text and row_type != Text and inferred_type != row_type:
                            # Incompatible concrete types — no narrower type
                            # fits both, so store as Text.
                            inferred_type = Text
                        # Matching types: no change needed.

                # ------------------------------------------------------------------
                # Phase 2: finalise the Column definition.
                # For Text columns, prefer String(255) when values are short
                # enough to benefit from indexing; use TEXT otherwise.
                # ------------------------------------------------------------------
                if inferred_type == Text:
                    if has_complex_types:
                        # JSON-serialised complex values can be arbitrarily long.
                        col = Column(col_name, Text, nullable=True)
                    else:
                        max_len = max(
                            (len(str(row.get(col_name, ''))) for row in sample_data if isinstance(row, dict)),
                            default=0,
                        )
                        col = Column(col_name, String(255) if max_len <= 255 else Text, nullable=True)
                else:
                    col = Column(col_name, inferred_type(), nullable=True)

                columns.append(col)

            # ------------------------------------------------------------------
            # Phase 3: create the table.  Prepend an auto-increment PK so the
            # engine always has an explicit clustered index.
            # ------------------------------------------------------------------
            pk_col = Column('id', Integer, primary_key=True, autoincrement=True)
            metadata = MetaData()
            _sql_table = SQLTable(table, metadata, pk_col, *columns)  # noqa: F841
            metadata.create_all(self.engine)

            # Populate the schema cache with data columns only.  The 'id' PK
            # is auto-generated by the DB and must not appear in insert
            # value mappings.
            #
            # Built locally and published in a single assignment, for the same
            # reason `_getTableSchema` is: this runs outside `reflect_lock`,
            # and the table already exists by the time the loop starts, so a
            # second first-batch can be in `_insertData` right now. Filling
            # `self.schema` key by key let it snapshot a truthy but incomplete
            # map and silently drop the columns not yet added.
            schema = {col.name: (str(col.type), '') for col in columns}
            self.schema = schema

            return True

        except Exception as e:
            error(f'Failed to create table "{table}": {e}')
            return False

    def _getTableSchema(self, table: str) -> Optional[List[Tuple[str, str]]]:
        """Return column (name, type) pairs, or None if the table doesn't exist."""
        if not self.engine:
            raise ValueError('Database connection is not initialized.')

        try:
            inspector = inspect(self.engine)

            # Return None (rather than raising) when the table is absent so
            # callers can handle the missing-table case gracefully.
            if not self._tableExists(table):
                return None

            columns = inspector.get_columns(table)
            schema: Dict[str, Tuple[str, str]] = {}
            for column in columns:
                col_name = column['name']
                col_type = column['type']  # renamed to avoid shadowing the 'type' builtin
                comment = column.get('comment', '')
                schema[col_name] = (str(col_type), comment)

            # Publish in a single assignment. Building into `self.schema` and
            # filling it column by column made every intermediate state visible:
            # `_insertData` reads this map to decide which columns to bind, so a
            # reader arriving mid-rebuild saw a truthy but incomplete map and
            # silently dropped the columns not yet added. Assigning at the end
            # also means a reflection that fails above leaves the previous map
            # in place instead of a half-built one.
            self.schema = schema

            return [(col_name, str(col_type)) for col_name, (col_type, _comment) in schema.items()]

        except Exception as e:
            warning(f'Unable to retrieve database schema for "{table}": {e}')
            return None

    def _getDatabaseSchema(self) -> Dict[str, Dict]:
        """Reflect the full database schema: columns, primary keys, and foreign keys."""
        if not self.engine:
            raise ValueError('Database connection is not initialized.')

        inspector = inspect(self.engine)
        db_schema: Dict[str, Dict] = {}

        for table_name in inspector.get_table_names():
            # Gather column names and their SQL types.
            columns = inspector.get_columns(table_name)
            col_list = [(column['name'], str(column['type'])) for column in columns]

            # Identify primary-key columns so callers can mark them in LLM prompts.
            pk = inspector.get_pk_constraint(table_name)
            pk_columns = pk.get('constrained_columns', []) if pk else []

            # Collect foreign-key relationships for JOIN hints in LLM context.
            fks = inspector.get_foreign_keys(table_name)
            fk_list = [
                {
                    'columns': fk['constrained_columns'],
                    'referred_table': fk['referred_table'],
                    'referred_columns': fk['referred_columns'],
                }
                for fk in fks
            ]

            db_schema[table_name] = {
                'columns': col_list,
                'primary_key': pk_columns,
                'foreign_keys': fk_list,
            }

        return db_schema

    @contextmanager
    def read_only_connection(self) -> Iterator[Connection]:
        """Yield a connection on which the database refuses writes and stops a query after ``READ_QUERY_TIMEOUT``.

        This is the database's own guarantee that a generated statement cannot change it; ``is_sql_safe`` is a
        first pass over its shape. On PostgreSQL it covers one statement only, see below.

        - PostgreSQL: a READ ONLY transaction (``SET TRANSACTION READ ONLY`` as its first statement) with
          ``SET LOCAL statement_timeout``; both end with the transaction, so nothing is left on the session.
          SQLAlchemy's ``postgresql_readonly`` is not used: it leaves the connection set to READ WRITE
          afterwards, also for a role whose default is read-only. Both callers run one statement and do not
          commit, so the block is one transaction. psycopg2 sends a ``;``-chain as one string: a ``COMMIT`` or
          ``ROLLBACK`` in it ends the transaction, so the statements after it can write, and a ``SET`` or
          ``set_config()`` in it lifts the time limit for the statements after it. ``is_sql_safe`` rejects
          any chain; on PostgreSQL that rule is part of the guarantee. MySQL and MariaDB (pymysql connects
          without multi-statements), ClickHouse and SQLite refuse a ``;``-chain outright.
        - MySQL and MariaDB (dialect ``mysql``, or ``mariadb`` for a ``mariadb+`` URL): a read-only session
          (``SET SESSION TRANSACTION READ ONLY``, which also refuses DDL) with ``max_execution_time``
          (``max_statement_time`` on MariaDB). ``SELECT ... INTO OUTFILE`` is not a table change and still
          runs here: ``is_sql_safe`` refuses it, and a role without the FILE privilege cannot run it.
        - ClickHouse: ``readonly=1`` and ``max_execution_time`` sent with each query; readonly=1 also refuses
          table functions such as ``url()`` and ``file()`` and stops the query from changing either setting.
          Only the settings the user's profile lets it change are sent (``_clickhouse_read_settings``). A
          profile with readonly=2, or a ``CHANGEABLE_IN_READONLY`` constraint, lets the query change the
          time limit itself; ``is_sql_safe`` refuses a ``SETTINGS`` clause, and only a MIN/MAX constraint
          in the profile makes the server refuse it. With readonly=2 the node may not send readonly=1, so
          table functions run when the user holds their grants.
        - SQLite: ``PRAGMA query_only``.

        Nothing outlives the block: the transaction is rolled back, and the session settings the block changed
        get back the values they had before it (which the server, ``init_connect`` or a role may have set, so
        not the defaults) before the connection goes back to the pool. A connection whose reset fails is
        discarded. Reads of
        server files and signals to other sessions (``pg_read_file``, ``pg_terminate_backend``, ``LOAD_FILE``)
        are reads to the database: only a role without those privileges stops them.

        Raises:
            RuntimeError: The engine's dialect has no read-only mode here, so no query is run.
        """
        dialect = self.engine.dialect.name
        if dialect not in ('postgresql', 'mysql', 'mariadb', 'clickhouse', 'sqlite'):
            raise RuntimeError(f'No read-only mode for the {dialect} dialect; the query was not run')
        timeout = int(self.READ_QUERY_TIMEOUT)
        with self.engine.connect() as conn:
            if dialect == 'postgresql':
                conn.exec_driver_sql('SET TRANSACTION READ ONLY')
                conn.exec_driver_sql(f'SET LOCAL statement_timeout = {timeout * 1000}')
                yield conn
                return
            if dialect == 'clickhouse':
                yield conn.execution_options(settings=self._clickhouse_read_settings(conn, timeout))
                return
            if dialect in ('mysql', 'mariadb'):
                # The session, not one transaction: DDL commits implicitly and would start a read-write one
                mariadb = conn.dialect.is_mariadb
                setting, value = ('max_statement_time', timeout) if mariadb else ('max_execution_time', timeout * 1000)
                read_only = 'tx_read_only' if mariadb else 'transaction_read_only'
                was_read_only, was_limit = conn.exec_driver_sql(
                    f'SELECT @@SESSION.{read_only}, @@SESSION.{setting}'
                ).one()
                begin = ['SET SESSION TRANSACTION READ ONLY', f'SET SESSION {setting} = {value}']
                end = [
                    f'SET SESSION TRANSACTION READ {"ONLY" if was_read_only else "WRITE"}',
                    f'SET SESSION {setting} = {was_limit}',
                ]
            else:
                was_query_only = conn.exec_driver_sql('PRAGMA query_only').scalar()
                begin, end = ['PRAGMA query_only = ON'], [f'PRAGMA query_only = {"ON" if was_query_only else "OFF"}']
            try:
                for statement in begin:
                    conn.exec_driver_sql(statement)
                yield conn
            finally:
                try:
                    conn.rollback()
                    for statement in end:
                        conn.exec_driver_sql(statement)
                    conn.rollback()
                except Exception as e:
                    # The session may still be read-only or time-limited: never hand it to another caller
                    warning(f'Could not reset a read-only database session, discarding it: {e}')
                    conn.invalidate()

    def _clickhouse_read_settings(self, conn: Connection, timeout: int) -> Dict[str, float]:
        """Return the per-query settings that make a ClickHouse query read-only and time-limited.

        ClickHouse refuses the whole query when it carries a setting the user may not change, so the user's
        settings are read once from ``system.settings`` (every user may read it) and only these are sent:

        - ``readonly=1`` when the profile allows writes. A profile with readonly 1 or 2 already refuses them,
          and readonly=2 refuses a change of ``readonly`` itself.
        - ``max_execution_time`` = ``timeout``, kept within the setting's MIN/MAX constraint (code 452
          otherwise), when the user may change it and the profile has no stricter limit. ``readonly=1``
          locks every setting (code 164) unless a ``CHANGEABLE_IN_READONLY`` constraint frees this one.
          When the user may not change it and the profile allows longer queries, the profile's limit
          applies and a warning says what to set.

        Args:
            conn: An open connection, used for the one lookup.
            timeout: The time limit in seconds.

        Returns:
            The settings to send with each query.
        """
        if self._clickhouse_settings is None:
            profile = {
                row[0]: row[1:]
                for row in conn.exec_driver_sql(
                    "SELECT name, value, readonly, min, max FROM system.settings WHERE name IN ('readonly', 'max_execution_time')"
                )
            }
            settings: Dict[str, float] = {} if float(profile['readonly'][0]) else {'readonly': 1}
            value, locked, low, high = profile['max_execution_time']
            current = float(value)
            limit = min(max(float(timeout), float(low or 0)), float(high or 'inf'))
            # A stricter limit in the profile stays: ours would loosen it
            if not current or current > limit:
                if int(locked):
                    allowed = f'{value} s' if current else 'no limit'
                    warning(
                        f'This ClickHouse user may not change max_execution_time and its profile allows {allowed}, '
                        f'so a generated query is not stopped after {timeout} s. Set max_execution_time in the '
                        'profile, or allow changing it with a CHANGEABLE_IN_READONLY constraint.'
                    )
                else:
                    settings['max_execution_time'] = int(limit) if limit.is_integer() else limit
            self._clickhouse_settings = settings
        return self._clickhouse_settings

    def _validateQuery(self, query: str) -> tuple[bool, str]:
        """Validate a SQL query using EXPLAIN without executing it.

        Runs ``EXPLAIN <query>`` inside ``read_only_connection``, so even a database that
        evaluated part of the query while planning it could not write.
        Returns ``(True, '')`` on success or ``(False, error_message)`` on failure.

        ``EXPLAIN`` is standard SQL supported by MySQL and PostgreSQL; both
        engines raise an exception for syntactically or semantically invalid
        queries, which is exactly the signal we need.

        The failure message goes through ``_format_db_error`` rather than
        ``str(e)``. This error does not stop at the retry loop: it is carried
        out through ``_buildSQLQuery`` into ``get_sql``'s ``error`` field and
        from there into ``get_data``'s, and NEITHER of those tools is gated on
        ``allow_execute`` the way ``execute`` is. ``str()`` of a SQLAlchemy
        ``StatementError`` appends ``[SQL: ...]`` / ``[parameters: ...]``, so
        the raw string handed the full ``EXPLAIN`` statement to a caller who
        was never granted raw SQL. The full exception still goes to the log.
        """
        if not self.engine:
            return False, 'Database engine not initialized'
        try:
            with self.read_only_connection() as conn:
                conn.execute(text(f'EXPLAIN {query}'))
            return True, ''
        except Exception as e:
            warning(f'EXPLAIN validation failed for the generated query: {e}')
            return False, self._format_db_error(e)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def beginGlobal(self) -> None:
        # One reflection lock per node. Created before anything can reflect, so
        # `refresh_schema` and `_insertData` always find a real lock here.
        self.reflect_lock = threading.Lock()

        # Resolve connection parameters via the subclass-provided mapping.
        raw = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        params = self._connection_params(raw)

        # Read behavior settings from config before opening the engine so
        # they're available to the instance as soon as beginGlobal returns.
        self.max_validation_attempts = max(1, self._max_validation_attempts(raw))
        self.db_description = (self._db_description(raw) or '').strip()

        # The execute tool is opt-in: callers invoking the 'execute' tool
        # function bypass the LLM translation + is_sql_safe gate, so the node
        # owner must explicitly enable the capability. Strings like 'false' /
        # '0' must not be truthy here, so don't use bool() directly.
        allow_execute = raw.get('allow_execute', False)
        if isinstance(allow_execute, str):
            self.allow_execute = allow_execute.strip().lower() in {'1', 'true', 'yes', 'on'}
        else:
            self.allow_execute = bool(allow_execute)
        try:
            self.max_execute_rows = max(1, int(raw.get('max_execute_rows', DEFAULT_MAX_EXECUTE_ROWS)))
        except (TypeError, ValueError):
            self.max_execute_rows = DEFAULT_MAX_EXECUTE_ROWS
        try:
            self.tx_max_sessions = max(1, int(raw.get('tx_max_sessions', 20)))
        except (TypeError, ValueError):
            self.tx_max_sessions = 20
        try:
            self.tx_idle_timeout = max(1.0, float(raw.get('tx_idle_timeout', 300)))
        except (TypeError, ValueError):
            self.tx_idle_timeout = 300.0

        self.database = params['database']
        self.table = params['table']

        # Build the DSN via the subclass; it handles driver selection and
        # any required URL-encoding.
        db_url = self._build_connection_url(params)

        # POOL_SIZE + MAX_OVERFLOW cap the node's concurrent connections
        # (30 by default; a subclass may override both).
        self.engine = create_engine(db_url, pool_size=self.POOL_SIZE, max_overflow=self.MAX_OVERFLOW)

        from ai.common.database.tx_registry import TransactionRegistry

        self.tx_registry = TransactionRegistry(
            self.engine,
            max_sessions=self.tx_max_sessions,
            idle_timeout=self.tx_idle_timeout,
            max_rows=self.max_execute_rows,
        )

        # Reflect the full database schema once at startup so LLM prompts have
        # complete context without per-query reflection overhead.
        self.db_schema = self._getDatabaseSchema()

        # Reflect the target table schema; it may not exist yet if this
        # pipeline is configured to write to a brand-new table.
        #
        # `_getTableSchema` publishes `self.schema` itself when the reflection
        # succeeds, so there is nothing to assign on that branch: rebuilding
        # the same map from the pairs it returns only blanked the reflected
        # column comment, and `_insertData`, the sole reader, indexes this map
        # by key. The missing-table branch is the one case it leaves untouched.
        if self._getTableSchema(self.table) is None:
            warning(
                f'Table "{self.table}" does not exist in database "{self.database}". It will be created automatically when data is received. If you prefer to create it manually, please do so before running the pipeline.'
            )
            self.schema = {}

    def endGlobal(self) -> None:
        if self.tx_registry:
            self.tx_registry.close_all()
        if self.engine:
            self.engine.dispose()
