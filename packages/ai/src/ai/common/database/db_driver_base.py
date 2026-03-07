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
Shared tool-provider driver base class for relational database nodes.

Derived classes must implement two methods:

- ``_db_tool_name``: return the tool namespace prefix used in tool names
  exposed to the LLM (e.g. ``'mysql'``, ``'postgres'``).  This should match
  the ``prefix`` field in the node's ``services.json``.

- ``_db_display_name``: return the human-readable engine name used in tool
  descriptions shown to the LLM (e.g. ``'MySQL'``, ``'PostgreSQL'``).

All three tools — ``get_schema``, ``get_sql``, ``get_data`` — are implemented
here using the ``ToolsBase`` abstract interface.  Tool names are namespaced
with the value returned by ``_db_tool_name()``, so the same base works
for both ``mysql.get_data`` and ``postgres.get_data``.
"""

from __future__ import annotations

from abc import abstractmethod
from typing import Any, Dict, List

from ai.common.tools import ToolsBase

from .sql_safety import is_sql_safe


# ---------------------------------------------------------------------------
# Shared JSON schemas for the three database tools.
# These are dialect-agnostic; the same schema works for any SQL database.
# ---------------------------------------------------------------------------

GET_SCHEMA_SCHEMA: Dict[str, Any] = {
    'type': 'object',
    'properties': {
        'table': {
            'type': 'string',
            'description': 'Optional table name to get schema for. If omitted, returns schema for all tables.',
        },
    },
}

GET_SQL_SCHEMA: Dict[str, Any] = {
    'type': 'object',
    'required': ['question'],
    'properties': {
        'question': {
            'type': 'string',
            'description': 'Natural-language question to convert into a SQL query',
        },
    },
}

GET_DATA_SCHEMA: Dict[str, Any] = {
    'type': 'object',
    'required': ['query'],
    'properties': {
        'query': {
            'type': 'string',
            'description': 'SQL SELECT query to execute against the database',
        },
    },
}


class DatabaseDriverBase(ToolsBase):
    """Abstract base for the tool-provider driver of any relational database node."""

    def __init__(self, *, instance: Any):
        # Derive the tool namespace prefix from the subclass rather than
        # accepting it as a constructor argument, so the prefix is always
        # co-located with the other driver identity methods and cannot drift
        # out of sync with the services.json prefix field.
        self._server_name = self._db_tool_name()
        self._instance = instance

    # ------------------------------------------------------------------
    # Abstract interface — derived classes MUST implement these methods
    # ------------------------------------------------------------------

    @abstractmethod
    def _db_tool_name(self) -> str:
        """Return the tool namespace prefix for this database engine.

        This value is prepended to every tool name exposed to the LLM and
        MUST match the ``prefix`` field in the node's ``services.json`` so
        that tool names stay in sync with the node's protocol identifier.

        Example:
            return 'mysql'   # or 'postgres', 'sqlite', etc.
        """

    @abstractmethod
    def _db_display_name(self) -> str:
        """Return the human-readable database engine name for tool descriptions.

        Example:
            return 'MySQL'   # or 'PostgreSQL', 'SQLite', etc.
        """

    # ------------------------------------------------------------------
    # ToolsBase hooks — all implemented here, keyed on _db_display_name
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[Dict[str, Any]]:
        db = self._db_display_name()
        return [
            {
                'name': f'{self._server_name}.get_data',
                'description': (
                    f'Query the {db} database and return result rows. This is the primary tool for answering '
                    f'database questions — use it by default unless the user specifically asks to see the SQL. '
                    f'The query must be a safe SELECT statement (no INSERT, UPDATE, DELETE, etc.). '
                    f'If you do not know the database schema, call get_schema first.'
                ),
                'input_schema': GET_DATA_SCHEMA,
            },
            {
                'name': f'{self._server_name}.get_schema',
                'description': (
                    f'Get the {db} database schema. Returns the database name and all tables with their '
                    f'columns, types, primary keys, and foreign key relationships. '
                    f'Optionally pass a table name to get the schema for just that table. '
                    f'Call this first if you need to understand the database structure before writing queries.'
                ),
                'input_schema': GET_SCHEMA_SCHEMA,
            },
            {
                'name': f'{self._server_name}.get_sql',
                'description': (
                    f'Convert a natural-language question into a verified SQL SELECT query for {db}. '
                    f'Only use this tool when the user explicitly asks to see the SQL statement itself. '
                    f'For all other database questions, use get_data instead — it returns the actual query results. '
                    f'The generated query is validated for safety (SELECT only, no mutations).'
                ),
                'input_schema': GET_SQL_SCHEMA,
            },
        ]

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:
        name = self._strip_namespace(tool_name)

        if name == 'get_schema':
            if input_obj is not None and not isinstance(input_obj, dict):
                raise ValueError('Tool input must be a JSON object or empty')

        elif name == 'get_sql':
            if not isinstance(input_obj, dict):
                raise ValueError('Tool input must be a JSON object')
            question = input_obj.get('question')
            if not question or not isinstance(question, str) or not question.strip():
                raise ValueError('"question" is required and must be a non-empty string')

        elif name == 'get_data':
            if not isinstance(input_obj, dict):
                raise ValueError('Tool input must be a JSON object')
            query = input_obj.get('query')
            if not query or not isinstance(query, str) or not query.strip():
                raise ValueError('"query" is required and must be a non-empty string')
            if not is_sql_safe(query):
                raise ValueError('Query contains unsafe SQL. Only SELECT statements are permitted.')

        else:
            raise ValueError(f'Unknown tool {tool_name!r} (expected get_schema, get_sql, or get_data)')

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:
        if input_obj is None:
            input_obj = {}
        if not isinstance(input_obj, dict):
            raise ValueError('Tool input must be a JSON object (dict)')

        self._tool_validate(tool_name=tool_name, input_obj=input_obj)
        name = self._strip_namespace(tool_name)

        if name == 'get_schema':
            return self._invoke_get_schema(input_obj)
        elif name == 'get_sql':
            return self._invoke_get_sql(input_obj)
        elif name == 'get_data':
            return self._invoke_get_data(input_obj)

    # ------------------------------------------------------------------
    # Tool implementations — fully dialect-agnostic via SQLAlchemy
    # ------------------------------------------------------------------

    def _invoke_get_schema(self, input_obj: Dict[str, Any]) -> Dict[str, Any]:
        """Return the reflected database schema, optionally filtered to one table."""
        iglobal = self._instance.IGlobal
        table_filter = input_obj.get('table')

        def _format_table(table_info: Dict) -> Dict[str, Any]:
            result: Dict[str, Any] = {
                'columns': [{'column': name, 'type': col_type} for name, col_type in table_info['columns']],
            }
            if table_info.get('primary_key'):
                result['primary_key'] = table_info['primary_key']
            if table_info.get('foreign_keys'):
                result['foreign_keys'] = table_info['foreign_keys']
            return result

        if table_filter:
            table_info = iglobal.db_schema.get(table_filter)
            if table_info is None:
                return {'error': f'Table "{table_filter}" not found', 'database': iglobal.database}
            return {'database': iglobal.database, 'tables': {table_filter: _format_table(table_info)}}

        return {
            'database': iglobal.database,
            'tables': {name: _format_table(info) for name, info in iglobal.db_schema.items()},
        }

    def _invoke_get_sql(self, input_obj: Dict[str, Any]) -> Dict[str, Any]:
        """Translate a natural-language question to a verified SQL SELECT."""
        question = input_obj['question'].strip()
        result = self._instance._buildSQLQuery(question)

        is_valid = result.get('isValid', '').lower() == 'true'
        sql_query = result.get('query', '')

        if is_valid and sql_query and is_sql_safe(sql_query):
            return {'sql': sql_query, 'valid': True}
        elif is_valid and sql_query:
            return {'error': 'Generated query contains unsafe SQL', 'sql': sql_query, 'valid': False}
        else:
            # LLM determined the question isn't a DB question — return its text response.
            return {'answer': sql_query, 'valid': False}

    def _invoke_get_data(self, input_obj: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a SQL SELECT and return the result rows."""
        query = input_obj['query'].strip()
        result = self._instance._executeSQLQuery(query)

        if result is None:
            return {'error': 'Query execution failed', 'rows': []}

        return {'rows': result, 'count': len(result)}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _strip_namespace(self, tool_name: str) -> str:
        """Strip the server-name prefix from a namespaced tool name."""
        prefix = f'{self._server_name}.'
        if tool_name.startswith(prefix):
            return tool_name[len(prefix):]
        return tool_name
