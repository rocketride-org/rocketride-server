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
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

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
from sqlalchemy.exc import DBAPIError, InterfaceError as SAInterfaceError, TimeoutError as SAPoolTimeoutError

from rocketlib import IGlobalBase, error, warning
from ai.common.config import Config

DEFAULT_MAX_EXECUTE_ROWS = 25000


class DatabaseUnavailableError(RuntimeError):
    """The database could not be reached, or dropped the connection, while serving a request.

    Raised instead of reporting the failure as a property of the SQL: a
    connection that was refused says nothing about the statement, so the caller
    must neither feed it back to the LLM as "the database rejected your query"
    nor carry on as if the question had been answered. The message is generic;
    the driver's text is in the engine log.
    """


# PostgreSQL SQLSTATE classes and codes that mean the server cannot take the
# request right now rather than that the statement is wrong:
# 08 connection exception, 53 insufficient resources (too many connections),
# 57P01 admin_shutdown, 57P02 crash_shutdown, 57P03 cannot_connect_now.
_UNAVAILABLE_SQLSTATE_CLASSES = frozenset({'08', '53'})
_UNAVAILABLE_SQLSTATES = frozenset({'57P01', '57P02', '57P03'})

# MySQL / MariaDB server error numbers (PyMySQL puts them in ``args[0]``) that mean
# the server is going away: 1053 ER_SERVER_SHUTDOWN. The disconnects SQLAlchemy
# already recognises (2006, 2013, ...) arrive as ``connection_invalidated``.
_UNAVAILABLE_MYSQL_ERRNOS = frozenset({1053})

# Deliberately NOT outages, so they keep the "the database rejected this statement"
# path: PostgreSQL 55P03 lock_not_available and 57014 query_canceled (a statement or
# lock timeout is about this query, not about the server), and ClickHouse 202
# TOO_MANY_SIMULTANEOUS_QUERIES / 241 MEMORY_LIMIT_EXCEEDED (resource limits of the
# query). `test_db_lane_failures.py` pins each as a rejection.

# Driver exception classes, matched by name through the MRO, that say the link to
# the server failed. Names rather than imports because this base must not depend
# on one node's driver (clickhouse-driver's NetworkError is the reason).
_UNAVAILABLE_DRIVER_CLASS_NAMES = frozenset({'InterfaceError', 'NetworkError', 'SocketTimeoutError'})


def is_connection_failure(exc: BaseException) -> bool:
    """Return True when ``exc``, raised while a statement ran, means the database is unreachable.

    Decided by exception type and SQLSTATE, not by message text. Deliberately not
    "any ``OperationalError``": PyMySQL raises one for an unknown column, which is
    the SQL being wrong and is exactly what the LLM repair loop exists for.

    * SQLAlchemy marked the connection invalid (``connection_invalidated``: the
      dialect recognised a disconnect), raised ``InterfaceError``, or the pool
      timed out handing out a connection;
    * the driver's own error is a socket-level ``OSError`` (refused, reset,
      timed out), a driver interface/network class, or carries an unavailable
      SQLSTATE.

    Only for a failure that happened *after* a connection was obtained: an error
    while opening one is always a connection failure and callers separate that
    phase themselves.
    """
    if isinstance(exc, DBAPIError) and exc.connection_invalidated:
        return True
    if isinstance(exc, (SAInterfaceError, SAPoolTimeoutError)):
        return True
    orig = getattr(exc, 'orig', None) or exc
    if isinstance(orig, OSError):
        return True
    if any(cls.__name__ in _UNAVAILABLE_DRIVER_CLASS_NAMES for cls in type(orig).__mro__):
        return True
    code = getattr(orig, 'pgcode', None)
    if isinstance(code, str) and (code[:2] in _UNAVAILABLE_SQLSTATE_CLASSES or code in _UNAVAILABLE_SQLSTATES):
        return True
    args = getattr(orig, 'args', ())
    if args and isinstance(args[0], int) and args[0] in _UNAVAILABLE_MYSQL_ERRNOS:
        return True
    return False


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

    # Seconds one connection attempt may take; `beginGlobal` replaces it from the
    # node config key `connect_timeout`.
    connect_timeout: float = 5.0

    # Dead-peer and ping settings for PostgreSQL; `beginGlobal` replaces them from the
    # node config (`tcp_user_timeout`, `keepalives_*`, `ping_timeout`).
    network_settings: Dict[str, Any] = {
        'tcp_user_timeout': 30.0,
        'keepalives_idle': 30,
        'keepalives_interval': 10,
        'keepalives_count': 3,
        'ping_timeout': 5.0,
    }

    # SQLAlchemy pool sizing for the runtime engine opened in `beginGlobal`.
    POOL_SIZE: int = 10
    MAX_OVERFLOW: int = 20

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
        """Return True if the table exists in the connected database.

        ``False`` means the table is not there (or the engine is not set up). A
        database that cannot be reached raises ``DatabaseUnavailableError``
        instead: reporting it as "no such table" sent ``_insertData`` down the
        create-the-table path, whose failure then read as "could not be created"
        for what was an outage.
        """
        if not self.engine:
            return False
        connected = False
        try:
            with self.engine.connect() as conn:
                connected = True
                return table in inspect(conn).get_table_names()
        except Exception as e:
            # Failing to open the connection at all is an outage whatever the
            # driver called it; after that, only the unavailable shapes are.
            if not connected or is_connection_failure(e):
                error(f'Database unavailable while checking for table "{table}": {e}')
                raise DatabaseUnavailableError('Database is unavailable (details are in the engine log)') from None
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

        phase = 'before'
        try:
            # Return None (rather than raising) when the table is absent so
            # callers can handle the missing-table case gracefully. An outage
            # raises `DatabaseUnavailableError` from here instead.
            if not self._tableExists(table):
                return None

            # An explicit connection, so "could not connect" is told apart from a
            # reflection error: `inspect(engine)` connects inside itself, and the
            # driver's refusal then looks like any other failure.
            phase = 'connecting'
            with self.engine.connect() as conn:
                phase = 'connected'
                columns = inspect(conn).get_columns(table)
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

        except DatabaseUnavailableError:
            raise
        except Exception as e:
            if phase == 'connecting' or (phase == 'connected' and is_connection_failure(e)):
                error(f'Database unavailable while reflecting table "{table}": {e}')
                raise DatabaseUnavailableError('Database is unavailable (details are in the engine log)') from None
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

    def _validateQuery(self, query: str) -> tuple[bool, str]:
        """Validate a SQL query using EXPLAIN without executing it.

        Runs ``EXPLAIN <query>`` inside a read-only connection.  The connection
        is always closed after the check so no rows are returned or state changed.
        Returns ``(True, '')`` on success or ``(False, error_message)`` when the
        database rejects the statement. Raises ``DatabaseUnavailableError`` when the
        database cannot be reached: that is not a property of the SQL.

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
        connected = False
        try:
            with self.engine.connect() as conn:
                connected = True
                conn.execute(text(f'EXPLAIN {query}'))
            return True, ''
        except Exception as e:
            # A database that cannot be reached is not a verdict on the SQL.
            # Reporting it as "rejected" fed the connection error to the LLM as
            # the reason its query was wrong, and let the lane finish as though
            # the question had been answered. Raise it instead.
            if not connected or is_connection_failure(e):
                error(f'Database unavailable during EXPLAIN validation: {e}')
                raise DatabaseUnavailableError('Database is unavailable (details are in the engine log)') from None
            warning(f'EXPLAIN validation failed for the generated query: {e}')
            return False, self._format_db_error(e)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def _connect_args(self, db_url: str) -> dict:
        """Driver ``connect_args`` for the runtime engine.

        The per-attempt connect timeout for the backends whose driver takes
        ``connect_timeout`` (PostgreSQL, MySQL/MariaDB), plus, for PostgreSQL, the
        keepalive and ``tcp_user_timeout`` settings that drop a connection to a
        peer that stopped acknowledging. A subclass for any other driver overrides
        this. Values come from the node config, read in ``beginGlobal``.

        These are ``connect_args``, so they take precedence over the same
        parameter written in the connection URL's query string.
        """
        from ai.common.database.connect_retry import connect_timeout_args, postgres_network_args
        from sqlalchemy.engine import make_url

        backend = make_url(db_url).get_backend_name()
        args = connect_timeout_args(backend, self.connect_timeout)
        if backend == 'postgresql':
            args.update(postgres_network_args(self.network_settings))
        return args

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
        #
        # `pool_pre_ping` tests a pooled connection on checkout and replaces a
        # dead one. Without it the first statement after a pooler restart or a
        # failover fails on a connection the server closed long ago. The
        # connect timeout bounds one attempt: with none, a black-holed host
        # holds the statement for the OS TCP timeout (minutes).
        from ai.common.database.connect_retry import (
            install_connect_retry,
            install_ping_watchdog,
            network_settings_from_config,
            policy_from_config,
            timeout_from_config,
        )

        self.connect_timeout = timeout_from_config(raw)
        self.network_settings = network_settings_from_config(raw)
        self.engine = create_engine(
            db_url,
            pool_size=self.POOL_SIZE,
            max_overflow=self.MAX_OVERFLOW,
            pool_pre_ping=True,
            connect_args=self._connect_args(db_url),
        )
        # Retry only the opening of a connection, never a statement: nothing has
        # been sent when an attempt is repeated, so no write can be duplicated.
        install_connect_retry(self.engine, policy_from_config(raw))
        if self.engine.dialect.name == 'postgresql':
            # Bound the pre-ping check itself: TCP settings cannot detect a pooler that
            # keeps acknowledging but stopped answering, and libpq has no read timeout.
            install_ping_watchdog(self.engine, self.network_settings['ping_timeout'])

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
