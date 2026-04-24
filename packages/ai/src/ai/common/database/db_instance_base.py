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
from typing import Any, Dict, List

import json

from rocketlib import IInstanceBase, debug, error, warning, tool_function
from sqlalchemy import MetaData, Table as SQLTable, insert, text
from sqlalchemy.exc import NoSuchTableError, SQLAlchemyError

from ai.common.schema import Answer, Question, QuestionType
from ai.common.table import Table
from rocketlib.types import IInvokeLLM

from .db_global_base import DatabaseGlobalBase
from .sql_safety import is_sql_safe


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

    # ------------------------------------------------------------------
    # Tool methods — dispatched by IInstanceBase.invoke() via @tool_function
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['question'],
            'properties': {
                'question': {'type': 'string', 'description': 'Natural-language description of the data you want to retrieve'},
                'limit': {'type': 'integer', 'description': 'Maximum number of rows to return (default 250, max 25000). Increase when you need the full result set.'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'rows': {'type': 'array', 'description': 'Result rows returned by the query.', 'items': {'type': 'object'}},
                'sql': {'type': 'string', 'description': 'The generated SQL SELECT statement that was executed.'},
                'row_limit': {'type': 'integer', 'description': 'The row cap applied to this query.'},
                'valid': {'type': 'boolean', 'description': 'Whether a valid SQL query was generated.'},
                'error': {'type': 'string', 'description': 'Error message if query generation or execution failed.'},
                'answer': {'type': 'string', 'description': 'LLM text response when the question is not a database query.'},
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
            limit = max(1, min(int(raw_limit), 25000)) if raw_limit is not None else 250
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
                'table': {'type': 'string', 'description': 'Optional table name to get schema for. If omitted, returns schema for all tables.'},
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
        """Return the reflected database schema."""
        if args is not None and not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object or empty')
        if not args:
            args = {}

        table_filter = args.get('table')

        def _format_table(table_info):
            result = {'columns': [{'column': name, 'type': col_type} for name, col_type in table_info['columns']]}
            if table_info.get('primary_key'):
                result['primary_key'] = table_info['primary_key']
            if table_info.get('foreign_keys'):
                result['foreign_keys'] = table_info['foreign_keys']
            return result

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
        description=lambda self: f'Accepts a natural-language description and returns the equivalent {self._db_display_name()} SQL SELECT statement without executing it. Only use when the user explicitly asks to see the SQL -- for actual data retrieval, use get_data instead.',
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

        is_valid = result.get('isValid', '').lower() == 'true'
        sql_query = result.get('query', '')

        if is_valid and sql_query and is_sql_safe(sql_query):
            return {'sql': sql_query, 'valid': True}
        elif is_valid and sql_query:
            return {'error': 'Generated query contains unsafe SQL', 'sql': sql_query, 'valid': False}
        else:
            return {'answer': sql_query, 'valid': False}

    # ------------------------------------------------------------------
    # Sanitization helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _sanitize_value(val):
        """Convert a single database value to a JSON-serializable type."""
        if val is None or isinstance(val, (str, int, float, bool)):
            return val
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
        times.  Returns the last LLM response regardless of whether validation
        ultimately succeeded.
        """
        previous_sql: str | None = None
        last_error: str | None = None
        result: dict = {}

        for attempt in range(self.IGlobal.max_validation_attempts):
            result = self._buildSQLQueryOnce(question_text, limit=limit, previous_sql=previous_sql, error=last_error)

            is_valid = result.get('isValid', '').lower() == 'true'
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
            warning(f'SQL validation attempt {attempt + 1}/{self.IGlobal.max_validation_attempts} failed: {explain_error}')
            previous_sql = sql_query
            last_error = explain_error

        warning(f'SQL validation failed after {self.IGlobal.max_validation_attempts} attempt(s); returning last result.')
        return result

    def _buildSQLQueryOnce(self, question_text: str, *, limit: int = 250, previous_sql: str | None = None, error: str | None = None) -> dict:
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
                'query': ('SELECT dm.emp_no, e.first_name, e.last_name, s.salary\nFROM dept_manager dm\nJOIN employees e ON dm.emp_no = e.emp_no\nJOIN salaries s ON dm.emp_no = s.emp_no\nWHERE CURRENT_DATE BETWEEN s.from_date AND s.to_date\nLIMIT 250'),
            },
        )
        # Off-topic example so the LLM knows how to handle non-DB questions.
        question.addExample(
            'When did the Visigoths sack Rome?',
            {'isValid': 'false', 'query': 'The Visigoths sacked Rome in 410 AD, under the leadership of their king, Alaric I.'},
        )

        # On a retry, provide the rejected SQL and the EXPLAIN error so the
        # LLM knows exactly what was wrong and can produce a corrected query.
        if previous_sql and error:
            question.addContext(f'Your previous attempt produced the following SQL:\n\n{previous_sql}\n\nThe database rejected it with this error:\n\n{error}\n\nPlease fix the query and try again.')

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
            is_valid_query = query_json.get('isValid', '').lower() == 'true'
            sql_query = query_json.get('query')

            # Execute the query only when the LLM flagged it as valid SQL and
            # the safety check passes; otherwise return the LLM's text response.
            if is_valid_query and sql_query and is_sql_safe(sql_query):
                result = self._executeSQLQuery(sql_query)
            else:
                result = sql_query

            if 'text' in lanes:
                self.instance.writeText(str(result))

            if 'table' in lanes and is_valid_query and result:
                self.instance.writeTable(self._formatResultAsMarkdown(result))

            if 'answers' in lanes:
                answer = Answer()
                if is_valid_query and result:
                    answer.setAnswer(self._formatResultAsMarkdown(result))
                else:
                    answer.setAnswer(str(result))
                self.instance.writeAnswers(answer)

        except Exception as e:
            error(f'Error handling question: {e}')

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
                error(f'Failed to create table "{self.IGlobal.table}". Please create it manually before running the pipeline.')
                raise RuntimeError(f'Table "{self.IGlobal.table}" does not exist and could not be created automatically.')
            debug(f'Successfully created table "{self.IGlobal.table}" from data structure.')

        # Fetch the schema if it wasn't populated at startup (e.g. the table
        # was just created above, or beginGlobal found no table).
        if not self.IGlobal.schema:
            table_schema = self.IGlobal._getTableSchema(self.IGlobal.table)
            if table_schema:
                self.IGlobal.schema = {name: (col_type, '') for name, col_type in table_schema}
            else:
                error(f'Unable to retrieve schema for table "{self.IGlobal.table}"')
                raise RuntimeError(f'Table "{self.IGlobal.table}" schema could not be retrieved.')

        schema = self.IGlobal.schema
        metadata = MetaData()
        engine = self.IGlobal.engine

        # Reflect the live table definition so SQLAlchemy knows the exact
        # column set and types when building the INSERT statement.
        try:
            table = SQLTable(self.IGlobal.table, metadata, autoload_with=engine)
        except NoSuchTableError:
            error(f'Table "{self.IGlobal.table}" does not exist in database "{self.IGlobal.database}". Please create it manually before running the pipeline.')
            raise

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
        # names with case-insensitive matching.
        insert_values = []
        for item in items:
            if not isinstance(item, dict):
                continue

            values: Dict[str, Any] = {}
            if schema:
                for colname in schema.keys():
                    # Case-insensitive key lookup so 'UserName' maps to 'username'.
                    item_lower_keys = {k.lower(): k for k in item.keys()}
                    if colname.lower() in item_lower_keys:
                        original_key = item_lower_keys[colname.lower()]
                        values[colname] = prepare_value(item[original_key])
                    else:
                        # Column in schema but not in data — insert NULL.
                        values[colname] = None
            else:
                # No schema cached — insert whatever keys the item provides.
                for key, raw_value in item.items():
                    values[key] = prepare_value(raw_value)

            insert_values.append(values)

        if insert_values:
            try:
                with self.IGlobal.engine.begin() as conn:
                    conn.execute(insert(table), insert_values)
                debug(f"Inserted {len(insert_values)} records into '{self.IGlobal.table}'.")
            except Exception as e:
                # The context manager has already rolled back; re-raise so the
                # caller can decide how to surface the failure.
                error(f'Error inserting data into "{self.IGlobal.table}": {e}')
                raise
        else:
            debug('No records to insert.')
