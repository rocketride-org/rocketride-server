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

- ``_create_driver``: instantiate and return the concrete tool-provider driver
  for this database engine (e.g. ``MySQLDriver``, ``PostgreSQLDriver``).

All pipeline lane handlers (``writeQuestions``, ``writeTable``,
``writeAnswers``), query execution, and data insertion are implemented here
using SQLAlchemy abstractions that work across dialects.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List

import json

from rocketlib import IInstanceBase, debug, error, warning
from sqlalchemy import MetaData, Table as SQLTable, insert, text
from sqlalchemy.exc import NoSuchTableError, SQLAlchemyError

from ai.common.schema import Answer, Question, QuestionType
from ai.common.table import Table
from ai.common.tools import ToolsBase
from rocketlib.types import IInvokeLLM

from .db_global_base import DatabaseGlobalBase
from .sql_safety import is_sql_safe


class DatabaseInstanceBase(IInstanceBase, ABC):
    """Abstract base for the IInstance layer of any relational database node."""

    # Type annotation for the global connection state; derived classes narrow
    # this to their concrete IGlobal subclass for IDE and type-checker support.
    IGlobal: DatabaseGlobalBase

    _driver: ToolsBase = None

    # ------------------------------------------------------------------
    # Abstract interface — derived classes MUST implement this method
    # ------------------------------------------------------------------

    @abstractmethod
    def _create_driver(self) -> ToolsBase:
        """Instantiate and return the tool-provider driver for this database.

        Example (MySQL):
            return MySQLDriver(server_name='mysql', instance=self)
        """

    # ------------------------------------------------------------------
    # Lifecycle — fully generic, uses _create_driver from the subclass
    # ------------------------------------------------------------------

    def beginInstance(self) -> None:
        self._driver = self._create_driver()

    def endInstance(self) -> None:
        pass

    def invoke(self, param: Any) -> Any:
        if self._driver is None:
            raise RuntimeError('Database driver not initialized')
        return self._driver.handle_invoke(param)

    # ------------------------------------------------------------------
    # SQL query helpers
    # ------------------------------------------------------------------

    def _buildSQLQuery(self, question_text: str) -> dict:
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
            result = self._buildSQLQueryOnce(question_text, previous_sql=previous_sql, error=last_error)

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
            warning(
                f'SQL validation attempt {attempt + 1}/{self.IGlobal.max_validation_attempts} failed: {explain_error}'
            )
            previous_sql = sql_query
            last_error = explain_error

        warning(f'SQL validation failed after {self.IGlobal.max_validation_attempts} attempt(s); returning last result.')
        return result

    def _buildSQLQueryOnce(self, question_text: str, *, previous_sql: str | None = None, error: str | None = None) -> dict:
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
            'Limit the results to 250 unless instructed otherwise by the provided question.',
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
            'If the user\'s question is ambiguous, make reasonable assumptions and attempt to craft a query. '
            'If you infer that the user\'s question or command is entirely unrelated to querying the database, '
            'attempt to answer the question in a manner similar to the provided by the example.',
        )

        # Concrete SQL example so the LLM understands the expected output shape.
        question.addExample(
            'Tell me the salaries of department managers',
            {
                'isValid': 'true',
                'query': (
                    'SELECT dm.emp_no, e.first_name, e.last_name, s.salary\n'
                    'FROM dept_manager dm\n'
                    'JOIN employees e ON dm.emp_no = e.emp_no\n'
                    'JOIN salaries s ON dm.emp_no = s.emp_no\n'
                    'WHERE CURRENT_DATE BETWEEN s.from_date AND s.to_date\n'
                    'LIMIT 250'
                ),
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
            question.addContext(
                f'Your previous attempt produced the following SQL:\n\n{previous_sql}\n\n'
                f'The database rejected it with this error:\n\n{error}\n\n'
                f'Please fix the query and try again.'
            )

        result = self.instance.invoke('llm', IInvokeLLM(op='ask', question=question))

        if not result or not result.answer:
            raise ValueError('LLM failed to return a SQL query.')

        return result.answer

    def _executeSQLQuery(self, query: str) -> list[dict] | None:
        """Execute a SQL SELECT query and return rows as a list of dicts."""
        try:
            # Use a transaction block so any implicit state changes are rolled
            # back automatically on error (the context manager handles rollback).
            with self.IGlobal.session.begin():
                result = self.IGlobal.session.execute(text(query))
                rows = result.fetchall()
                column_names = result.keys()
                return [dict(zip(column_names, row)) for row in rows]

        except SQLAlchemyError as e:
            # The 'with session.begin()' context manager has already rolled back
            # the transaction at this point; just log and return None.
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
            # Roll back any partial transaction that may have been left open by
            # a failed sub-call (e.g. _executeSQLQuery raised before committing).
            self.IGlobal.session.rollback()

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
            self.IGlobal.session.rollback()

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
            self.IGlobal.session.rollback()

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
                    f'Failed to create table "{self.IGlobal.table}". '
                    f'Please create it manually before running the pipeline.'
                )
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
            error(
                f'Table "{self.IGlobal.table}" does not exist in database '
                f'"{self.IGlobal.database}". Please create it manually before running the pipeline.'
            )
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
                # 'with session.begin()' commits on __exit__ and rolls back
                # automatically on any exception — no explicit commit needed.
                with self.IGlobal.session.begin():
                    self.IGlobal.session.execute(insert(table), insert_values)
                debug(f"Inserted {len(insert_values)} records into '{self.IGlobal.table}'.")
            except Exception as e:
                # The context manager has already rolled back; re-raise so the
                # caller can decide how to surface the failure.
                error(f'Error inserting data into "{self.IGlobal.table}": {e}')
                raise
        else:
            debug('No records to insert.')
