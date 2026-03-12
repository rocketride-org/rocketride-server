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

import os
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import (
    Column, DateTime, Float, Integer, MetaData, String, Text,
    Table as SQLTable, create_engine, inspect, text,
)
from sqlalchemy.exc import DBAPIError

from rocketlib import IGlobalBase, error, warning
from ai.common.config import Config


class DatabaseGlobalBase(IGlobalBase, ABC):
    """Abstract base for the IGlobal layer of any relational database node."""

    engine = None
    database: str = ''
    table: str = ''
    db_description: str = ''
    schema: Dict[str, Tuple[str, str]] = {}
    db_schema: Dict[str, Dict] = {}
    max_validation_attempts: int = 5

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
        """Return a user-facing error string using DB/driver payload when present.

        Prefer numeric code and provider message when available, otherwise
        fallback to the exception string.
        """
        try:
            # SQLAlchemy wraps driver exceptions in DBAPIError; the original
            # driver exception lives in .orig, which carries (code, message)
            # in its .args tuple.
            orig = getattr(exc, 'orig', exc)
            args = getattr(orig, 'args', ())
            if isinstance(args, (list, tuple)) and len(args) >= 2 and isinstance(args[0], int):
                code, msg = args[0], args[1]
                return f'Error {code}: {str(msg)}'.strip()
        except Exception:
            pass
        return str(exc).strip()

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
            self.schema = {}
            for col in columns:
                self.schema[col.name] = (str(col.type), '')

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
            self.schema = {}
            for column in columns:
                col_name = column['name']
                col_type = column['type']   # renamed to avoid shadowing the 'type' builtin
                comment = column.get('comment', '')
                self.schema[col_name] = (str(col_type), comment)

            return [(col_name, str(col_type)) for col_name, (col_type, _comment) in self.schema.items()]

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

    def _validateQuery(self, query: str) -> tuple[bool, str]:
        """Validate a SQL query using EXPLAIN without executing it.

        Runs ``EXPLAIN <query>`` inside a read-only connection.  The connection
        is always closed after the check so no rows are returned or state changed.
        Returns ``(True, '')`` on success or ``(False, error_message)`` on failure.

        ``EXPLAIN`` is standard SQL supported by MySQL and PostgreSQL; both
        engines raise an exception for syntactically or semantically invalid
        queries, which is exactly the signal we need.
        """
        if not self.engine:
            return False, 'Database engine not initialized'
        try:
            with self.engine.connect() as conn:
                conn.execute(text(f'EXPLAIN {query}'))
            return True, ''
        except Exception as e:
            return False, str(e)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def beginGlobal(self) -> None:
        # Resolve connection parameters via the subclass-provided mapping.
        raw = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        params = self._connection_params(raw)

        # Read behavior settings from config before opening the engine so
        # they're available to the instance as soon as beginGlobal returns.
        self.max_validation_attempts = max(1, self._max_validation_attempts(raw))
        self.db_description = (self._db_description(raw) or '').strip()

        self.database = params['database']
        self.table = params['table']

        # Build the DSN via the subclass; it handles driver selection and
        # any required URL-encoding.
        db_url = self._build_connection_url(params)

        # pool_size + max_overflow allow up to 30 concurrent connections.
        self.engine = create_engine(db_url, pool_size=10, max_overflow=20)

        # Reflect the full database schema once at startup so LLM prompts have
        # complete context without per-query reflection overhead.
        self.db_schema = self._getDatabaseSchema()

        # Reflect the target table schema; it may not exist yet if this
        # pipeline is configured to write to a brand-new table.
        table_schema = self._getTableSchema(self.table)
        if table_schema is None:
            warning(
                f'Table "{self.table}" does not exist in database "{self.database}". '
                f'It will be created automatically when data is received. '
                f'If you prefer to create it manually, please do so before running the pipeline.'
            )
            self.schema = {}
        else:
            # Store as {col_name: (type_str, comment)} to match the schema cache format.
            self.schema = {name: (col_type, '') for name, col_type in table_schema}

    def endGlobal(self) -> None:
        if self.engine:
            self.engine.dispose()
