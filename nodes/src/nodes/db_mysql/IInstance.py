# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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

from typing import List, Dict, Any

from rocketlib import IInstanceBase
from sqlalchemy import Table as SQLTable, MetaData, insert, text
from sqlalchemy.exc import SQLAlchemyError, NoSuchTableError
from ai.common.table import Table
from ai.common.schema import Answer, Question, QuestionType
from rocketlib.types import IInvokeLLM
from rocketlib import debug, error, warning
from .IGlobal import IGlobal
from .sqlRegex import is_sql_safe
import re
import json


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def beginInstance(self) -> None:
        pass

    def endInstance(self) -> None:
        pass

    def _buildSQLQuery(self, text: str = '') -> Question:
        # Format schema tuples into a more readable form for the LLM
        def describe_schema(schema: dict[str, list[tuple[str, str]]]) -> str:
            def simplify_type(sql_type: str) -> str:
                # Strip any trailing COLLATE or irrelevant clauses
                return sql_type.split('COLLATE')[0].strip().upper()

            lines = []

            for table_name, columns in schema.items():
                if not columns:
                    continue
                lines.append(f'Table `{table_name}`:')
                for name, sql_type in columns:
                    lines.append(f'  {name}: {simplify_type(sql_type)}')
                lines.append('')  # Add a blank line between tables

            return '\n'.join(lines).strip()

        # Database information
        db_schema_description = describe_schema(self.IGlobal.db_schema)

        # Setup a question to ask the LLM
        question: Question = Question(type=QuestionType.QUESTION, role='You are a technical assistant.')

        # Provide Question
        question.addQuestion(text)

        # Add database schema for context
        question.addContext(db_schema_description)

        # Indicate we want a JSON response
        question.expectJson = True

        question.addInstruction(
            'SQL Query Generation Guidelines',
            """Generate a query based only on the tables provided in context.
            """,
        )

        question.addInstruction(
            'LIMIT',
            """
            Limit the results to 250 unless instructed otherwise by the provided question.
            """,
        )

        question.addInstruction(
            'Formatting',
            """
            Do not wrap the SQL query in markdown (e.g., no triple backticks or language identifiers) and abide by formatting in the provided examples.
            """,
        )

        question.addInstruction(
            'Commands',
            """
            You are only permitted to use SELECT. Avoid any unsafe operations (e.g., DELETE, UPDATE, INSERT).
            """,
        )

        question.addInstruction(
            'Ambiguity',
            """
            If the user's question is ambiguous, make reasonable assumptions and attempt to craft a query.
            If you infer that the user's question or command is entirely unrelated to querying the database, attempt to answer the question in a manner similar to the provided by the example.
            """,
        )

        question.addExample(
            """
        Tell me the salaries of department managers""",
            {
                'isValid': 'true',
                'query': """SELECT dm.emp_no, e.first_name, e.last_name, s.salary
            FROM dept_manager dm
            JOIN employees e ON dm.emp_no = e.emp_no
            JOIN salaries s ON dm.emp_no = s.emp_no
            WHERE CURRENT_DATE BETWEEN s.from_date AND s.to_date
            LIMIT 250""",
            },
        )

        question.addExample(
            """
        When did the Visigoths sack Rome?""",
            {'isValid': 'false', 'query': """The Visigoths sacked Rome in 410 AD, under the leadership of their king, Alaric I."""},
        )

        # Trigger the question
        result = self.instance.invoke('llm', IInvokeLLM(op='ask', question=question))

        if not result or not result.answer:
            raise ValueError('LLM failed to return a SQL query.')

        return result.answer

    def _executeSQLQuery(self, query: str) -> list[dict] | None:
        """
        Execute the SQL query and returns a list of rows.
        """
        try:
            # Begin a transaction block
            with self.IGlobal.session.begin():
                result = self.IGlobal.session.execute(text(query))
                rows = result.fetchall()

                # Extract column names for dictionary conversion
                column_names = result.keys()

                # Return rows as list of dicts
                return [dict(zip(column_names, row)) for row in rows]

        except SQLAlchemyError as e:
            print(f'Error executing SQL query: {e}')
            self.IGlobal.session.rollback()
            return None

    # Format return values to properly use generate_markdown_table
    def _formatResultAsMarkdown(self, result):
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

    def writeQuestions(self, question: Question):
        question_text = question.questions[0].text if question.questions and len(question.questions) > 0 else None

        if not question_text:
            print('No question text provided.')
            return

        lanes = self.instance.getListeners()

        try:
            query_json = self._buildSQLQuery(question_text)
            is_valid_query = query_json.get('isValid', '').lower() == 'true'
            sql_query = query_json.get('query')

            # If we have a valid query that is safe, execute it
            if is_valid_query and sql_query and is_sql_safe(sql_query):
                result = self._executeSQLQuery(sql_query)
            # Else just return the output generated from the LLM
            else:
                result = sql_query

            if 'text' in lanes:
                self.instance.writeText(str(result))

            if 'table' in lanes and is_valid_query and result:
                markdown = self._formatResultAsMarkdown(result)
                self.instance.writeTable(markdown)

            if 'answers' in lanes:
                answer = Answer()
                if is_valid_query and result:
                    markdown = self._formatResultAsMarkdown(result)
                    answer.setAnswer(markdown)
                else:
                    answer.setAnswer(str(result))
                self.instance.writeAnswers(answer)

        except Exception as e:
            print(f'Error handling question: {e}')
            self.IGlobal.session.rollback()

    def _parseMarkdownTable(self, markdown: str) -> List[Dict[str, Any]]:
        """Parse a markdown table string into a list of dictionaries."""
        lines = [line.strip() for line in markdown.strip().split('\n') if line.strip()]
        if len(lines) < 2:
            return []

        header_idx = 0
        for i, line in enumerate(lines):
            if re.match(r'^\|[\s\-\|:]+\|$', line):
                header_idx = i
                break

        if header_idx == 0:
            return []

        header_line = lines[header_idx - 1]
        headers = [cell.strip() for cell in header_line.split('|')[1:-1]]

        rows = []
        for line in lines[header_idx + 1:]:
            if not line.startswith('|'):
                continue
            cells = [cell.strip() for cell in line.split('|')[1:-1]]
            if len(cells) == len(headers):
                row = dict(zip(headers, cells))
                rows.append(row)

        return rows

    def writeTable(self, markdown: str):
        """Handle markdown table data from OCR or other sources."""
        if not markdown or not markdown.strip():
            debug('No table data provided.')
            return

        rows = self._parseMarkdownTable(markdown)

        if not rows:
            warning(f'Could not parse markdown table data. Raw data: {markdown[:200]}...')
            return

        try:
            self._insertData(rows)
        except Exception as e:
            error(f'Error inserting table data: {e}')
            self.IGlobal.session.rollback()

    def _insertData(self, items: List[Dict[str, Any]]):
        """Insert data into the MySQL table, creating the table if it doesn't exist."""
        if not items:
            debug('No items to insert.')
            return

        table_exists = self.IGlobal._tableExists(self.IGlobal.table)

        if not table_exists:
            debug(f'Table "{self.IGlobal.table}" does not exist. Creating it from data structure...')
            if not self.IGlobal._createTableFromData(self.IGlobal.table, items):
                error(f'Failed to create table "{self.IGlobal.table}". Please create it manually in your MySQL database before running the pipeline. Example: CREATE TABLE `{self.IGlobal.table}` (column_name VARCHAR(255), ...)')
                raise Exception(f'Table "{self.IGlobal.table}" does not exist and could not be created automatically.')
            debug(f'Successfully created table "{self.IGlobal.table}" from data structure.')

        if not self.IGlobal.schema:
            table_schema = self.IGlobal._getTableSchema(self.IGlobal.table)
            if table_schema:
                self.IGlobal.schema = {name: (col_type, '') for name, col_type in table_schema}
            else:
                error(f'Unable to retrieve schema for table "{self.IGlobal.table}"')
                raise Exception(f'Table "{self.IGlobal.table}" schema could not be retrieved.')

        schema = self.IGlobal.schema
        metadata = MetaData()
        engine = self.IGlobal.engine

        try:
            table = SQLTable(self.IGlobal.table, metadata, autoload_with=engine)
        except NoSuchTableError:
            error(f'Table "{self.IGlobal.table}" does not exist in database "{self.IGlobal.database}". Please create it manually before running the pipeline. Example: CREATE TABLE `{self.IGlobal.table}` (column_name VARCHAR(255), ...)')
            raise

        def prepare_value(value):
            """Convert complex Python types to MySQL-compatible values."""
            if value is None:
                return None
            elif isinstance(value, (list, dict)):
                return json.dumps(value)
            elif isinstance(value, bool):
                return 1 if value else 0
            else:
                return value

        insert_values = []
        for item in items:
            if not isinstance(item, dict):
                continue

            values = {}
            if schema:
                for colname in schema.keys():
                    item_lower_keys = {k.lower(): k for k in item.keys()}
                    if colname.lower() in item_lower_keys:
                        original_key = item_lower_keys[colname.lower()]
                        raw_value = item[original_key]
                        values[colname] = prepare_value(raw_value)
                    else:
                        values[colname] = None
            else:
                for key, raw_value in item.items():
                    values[key] = prepare_value(raw_value)

            insert_values.append(values)

        if insert_values:
            try:
                with self.IGlobal.session.begin():
                    self.IGlobal.session.execute(insert(table), insert_values)
                    self.IGlobal.session.commit()
                debug(f"Inserted {len(insert_values)} records into the table '{self.IGlobal.table}'.")
            except Exception as e:
                error(f'Error inserting data into table "{self.IGlobal.table}": {e}')
                self.IGlobal.session.rollback()
                raise
        else:
            debug('No records to insert.')

    def writeAnswers(self, answer: Answer):
        items = answer.getJson()

        if not items:
            debug('No items to insert.')
            return

        try:
            self._insertData(items)
        except Exception as e:
            error(f'Error in writeAnswers: {e}')
            self.IGlobal.session.rollback()
