# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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

import os
import urllib.parse
from datetime import datetime
from typing import Dict, List, Tuple, Optional, Any

from sqlalchemy import create_engine, inspect, text, Column, String, Integer, Float, DateTime, Text, MetaData, Table as SQLTable
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import sessionmaker

from rocketlib import IGlobalBase, warning, error
from ai.common.config import Config


class IGlobal(IGlobalBase):
    engine = None
    session = None
    database: str = ''
    table: str = ''
    schema: Dict[str, Tuple[str, str]] = {}

    # ------------------------------------------------------------------
    # Config normalization (shape may store under mysql.default)
    # ------------------------------------------------------------------
    @staticmethod
    def _connection_params(config: Dict[str, Any]) -> Dict[str, str]:
        """Extract host, user, password, database, table from config.

        Supports both flat keys (host, user, ...) and shape layout
        (mysql.default = { mysql.host, mysql.user, ... }) so connection works
        regardless of how the UI/store saves the config.
        """
        block = config.get('mysql.default')
        if not isinstance(block, dict):
            block = {}
        return {
            'host': (block.get('mysql.host') or config.get('host') or 'localhost').strip(),
            'user': (block.get('mysql.user') or config.get('user') or 'root').strip(),
            'password': str(block.get('mysql.password') or config.get('password') or ''),
            'database': (block.get('mysql.database') or config.get('database') or 'database').strip(),
            'table': (block.get('mysql.table') or config.get('table') or 'table').strip(),
        }

    # ------------------------------------------------------------------
    # Validation helpers
    # ------------------------------------------------------------------
    def _format_db_error(self, exc: Exception) -> str:
        """Return a user-facing error string using DB/driver payload when present.

        Prefer numeric code and provider message when available, otherwise fallback
        to the exception string. Mirrors the light formatting used by LLM validators.
        """
        try:
            orig = getattr(exc, 'orig', exc)
            args = getattr(orig, 'args', ())
            if isinstance(args, (list, tuple)) and len(args) >= 2 and isinstance(args[0], (int,)):  # (code, message)
                code = args[0]
                msg = args[1]
                return f'Error {code}: {str(msg)}'.strip()
        except Exception:
            pass
        return str(exc).strip()

    def validateConfig(self):
        """Quick save-time validation for MySQL connection settings.

        - Loads deps
        - Attempts TCP connect (host:port), runs SELECT 1
        - Optionally warns if the configured table does not exist
        - Surfaces provider/driver errors verbatim, lightly formatted.
        """
        # Load dependencies first
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        engine = None
        try:
            raw = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            params = self._connection_params(raw)
            host = params['host']
            user = params['user']
            password = urllib.parse.quote_plus(params['password'])
            database = params['database']

            # Build URL. Host may include a port (e.g., 127.0.0.1:3306)
            db_url = f'mysql+pymysql://{user}:{password}@{host}/{database}'

            # Create engine with quick connect timeout; pre_ping validates stale connections
            engine = create_engine(
                db_url,
                pool_pre_ping=True,
                connect_args={'connect_timeout': 5},
            )

            # Minimal probe: open connection and run SELECT 1
            with engine.connect() as conn:
                conn.execute(text('SELECT 1'))

                # Do not reflect tables at save-time; let SDK surface table errors at runtime

        except DBAPIError as e:
            # Surface driver-provided message (covers OperationalError/ProgrammingError)
            warning(self._format_db_error(e))
            return
        except Exception as e:
            warning(self._format_db_error(e))
            return
        finally:
            try:
                if engine:
                    engine.dispose()
            except Exception:
                pass

    def _tableExists(self, table: str) -> bool:
        """Check if a table exists in the database."""
        if not self.engine:
            return False

        try:
            inspector = inspect(self.engine)
            return table in inspector.get_table_names()
        except Exception:
            return False

    def _is_datetime_string(self, value: str) -> bool:
        """Check if a string value matches a datetime format.

        Uses datetime.strptime to validate against common date/time patterns.
        Returns False on any error (invalid format, unexpected exceptions).
        """
        if not isinstance(value, str):
            return False

        for fmt in ('%Y-%m-%d', '%Y-%m-%d %H:%M:%S'):
            try:
                datetime.strptime(value, fmt)
                return True
            except ValueError:
                pass
            except Exception as e:
                warning(f'Unexpected error while checking datetime format for value "{value}": {str(e)}')
                return False

        return False

    def _inferColumnType(self, value: Any) -> type:
        """Infer SQLAlchemy column type from a Python value."""
        if value is None:
            return Text

        python_type = type(value)

        if python_type is int:
            return Integer
        elif python_type is float:
            return Float
        elif python_type is bool:
            return Integer  # MySQL uses TINYINT for boolean
        elif python_type in (list, dict):
            return Text
        elif python_type in (str, bytes):
            if isinstance(value, str):
                try:
                    if self._is_datetime_string(value):
                        return DateTime
                except Exception as e:
                    warning(f'Error detecting datetime format for value "{value}": {str(e)}')
            return Text
        else:
            return Text

    def _createTableFromData(self, table: str, sample_data: List[Dict[str, Any]]) -> bool:
        """Create a table based on sample data structure."""
        if not self.engine or not sample_data:
            return False

        try:
            first_row = sample_data[0] if sample_data else {}
            if not isinstance(first_row, dict):
                return False

            columns = []
            for col_name, col_value in first_row.items():
                inferred_type = self._inferColumnType(col_value)
                has_complex_types = isinstance(col_value, (list, dict))

                for row in sample_data[1:]:
                    if isinstance(row, dict) and col_name in row and row[col_name] is not None:
                        row_value = row[col_name]
                        if isinstance(row_value, (list, dict)):
                            has_complex_types = True
                            inferred_type = Text
                        else:
                            row_type = self._inferColumnType(row_value)
                            if not has_complex_types:
                                if row_type == Integer and inferred_type == Text:
                                    inferred_type = Integer
                                elif row_type == Float and inferred_type == Text:
                                    inferred_type = Float
                                elif row_type == DateTime and inferred_type == Text:
                                    inferred_type = DateTime

                if inferred_type == Text:
                    if has_complex_types:
                        col = Column(col_name, Text, nullable=True)
                    else:
                        max_len = max((len(str(row.get(col_name, ''))) for row in sample_data if isinstance(row, dict)), default=0)
                        if max_len <= 255:
                            col = Column(col_name, String(255), nullable=True)
                        else:
                            col = Column(col_name, Text, nullable=True)
                else:
                    col = Column(col_name, inferred_type(), nullable=True)

                columns.append(col)

            metadata = MetaData()
            _sql_table = SQLTable(table, metadata, *columns)  # noqa: F841
            metadata.create_all(self.engine)

            self.schema = {}
            for col in columns:
                self.schema[col.name] = (str(col.type), '')

            return True

        except Exception as e:
            error(f'Failed to create table "{table}": {str(e)}')
            return False

    def _getTableSchema(self, table: str) -> Optional[List[Tuple[str, str]]]:
        """Get table schema, returning None if table doesn't exist instead of raising."""
        if not self.engine:
            raise ValueError('Database connection is not initialized.')

        try:
            inspector = inspect(self.engine)

            if not self._tableExists(table):
                return None

            columns = inspector.get_columns(table)
            self.schema = {}
            for column in columns:
                name = column['name']
                type = column['type']
                comment = column.get('comment', '')
                self.schema[name] = (str(type), comment)

            return [(name, str(type)) for name, (type, comment) in self.schema.items()]

        except Exception as e:
            warning(f'Unable to retrieve database schema for "{table}": {str(e)}')
            return None

    def _getDatabaseSchema(self) -> Dict[str, List[Tuple[str, str]]]:
        if not self.engine:
            raise ValueError('Database connection is not initialized.')

        inspector = inspect(self.engine)

        db_schema: Dict[str, List[Tuple[str, str]]] = {}

        for table_name in inspector.get_table_names():
            columns = inspector.get_columns(table_name)
            schema = []
            for column in columns:
                name = column['name']
                col_type = str(column['type'])
                schema.append((name, col_type))
            db_schema[table_name] = schema

        return db_schema

    def beginGlobal(self) -> None:
        # Install what we need
        import os
        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)
        raw = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        params = self._connection_params(raw)

        self.database = params['database']
        self.table = params['table']
        encoded_password = urllib.parse.quote_plus(params['password'])
        db_url = f'mysql+pymysql://{params["user"]}:{encoded_password}@{params["host"]}/{self.database}'

        # Create the engine for the database connection
        self.engine = create_engine(db_url, pool_size=10, max_overflow=20)

        # Create the session maker and session
        Session = sessionmaker(bind=self.engine)
        self.session = Session()

        # Get the db schema info
        self.db_schema = self._getDatabaseSchema()

        # Get the table schema info - table may not exist yet, that's OK
        table_schema = self._getTableSchema(self.table)
        if table_schema is None:
            warning(
                f'Table "{self.table}" does not exist in database "{self.database}". '
                f'It will be created automatically when data is received. '
                f'If you prefer to create it manually, please run: '
                f'CREATE TABLE `{self.table}` (columns...) in your MySQL database.'
            )
            self.schema = {}
        else:
            self.schema = {name: (col_type, '') for name, col_type in table_schema}

    def endGlobal(self) -> None:
        # Close the session if it exists
        if self.session:
            self.session.close()

        # Dispose of the engine to release connections
        if self.engine:
            self.engine.dispose()
