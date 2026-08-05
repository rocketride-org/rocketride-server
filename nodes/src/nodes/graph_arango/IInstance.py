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
Instance-level state for the ArangoDB database node.

Handles pipeline lane traffic (questions, table, answers), translates
natural-language questions to AQL via the connected LLM, executes queries,
and returns rows. Read-only by design.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

from rocketlib import IInstanceBase, tool_function, error, warning
from ai.common.schema import Answer, Question, QuestionType
from ai.common.table import Table
from rocketlib.types import IInvokeLLM

from .IGlobal import DEFAULT_MAX_EXECUTE_ROWS, IGlobal
from .utils import _parse_is_valid


class IInstance(IInstanceBase):
    """ArangoDB-specific instance state."""

    IGlobal: IGlobal

    # ------------------------------------------------------------------
    # Tool methods
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
                    'description': f'Maximum number of rows to return (default 250, max {DEFAULT_MAX_EXECUTE_ROWS}).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'rows': {
                    'type': 'array',
                    'description': 'Result rows returned by the AQL query.',
                    'items': {'type': 'object'},
                },
                'aql': {'type': 'string', 'description': 'The generated AQL query that was executed.'},
                'row_limit': {'type': 'integer', 'description': 'The row cap applied to this query.'},
                'error': {'type': 'string', 'description': 'Error message if query generation or execution failed.'},
                'answer': {
                    'type': 'string',
                    'description': 'LLM text response when the question is not a database query.',
                },
            },
        },
        description=(
            'Accepts a natural-language description of the data you want, '
            'converts it to a safe read-only AQL query, executes it against the '
            'ArangoDB database, and returns the result rows. Works across documents '
            'and graphs. No schema lookup or AQL knowledge required — just describe '
            'what you need. Results may be large — consider using peek or store.'
        ),
    )
    def get_data(self, args):
        """Translate natural language to AQL and execute."""
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object')
        question = args.get('question')
        if not question or not isinstance(question, str) or not question.strip():
            raise ValueError('"question" is required and must be a non-empty string')

        limit = _clamp_limit(args.get('limit'))
        aql_result = self.get_aql({'question': question.strip(), 'limit': limit})
        if not aql_result.get('valid'):
            return aql_result

        aql = aql_result['aql']
        try:
            rows = self.IGlobal._run_query(aql)
        except Exception as e:
            return {'error': str(e), 'aql': aql, 'rows': []}
        return {'rows': rows[:limit], 'aql': aql, 'row_limit': limit}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'collection': {
                    'type': 'string',
                    'description': 'Optional collection name to filter the schema to a single collection.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'collections': {
                    'type': 'object',
                    'description': 'Map of collection name to {type, fields} (type is document or edge).',
                },
                'graphs': {'type': 'array', 'description': 'Named graphs with their edge definitions.'},
                'views': {'type': 'array', 'description': 'ArangoSearch views.'},
                'database': {'type': 'string'},
            },
        },
        description=(
            'Returns the ArangoDB schema: collections (document and edge) with their sampled fields and types, named graphs, and ArangoSearch views. Do NOT call this preemptively — only use when get_data fails or returns unexpected results.'
        ),
    )
    def get_schema(self, args):
        """Return the cached multi-model schema."""
        if args is not None and not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object or empty')
        if not args:
            args = {}

        schema = self.IGlobal.graph_schema
        collection_filter = args.get('collection')

        collections = schema.get('collections', {})
        graphs = schema.get('graphs', [])
        views = schema.get('views', [])

        if collection_filter:
            info = collections.get(collection_filter)
            if info is None:
                return {'error': f'Collection {collection_filter} not found'}
            collections = {collection_filter: info}

        return {
            'database': self.IGlobal.database,
            'collections': {
                name: {
                    'type': info.get('type', 'document'),
                    'fields': [{'field': f, 'type': t} for f, t in info.get('fields', [])],
                    'indexed_fields': info.get('indexed_fields', []),
                }
                for name, info in collections.items()
            },
            'graphs': graphs,
            'views': views,
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['question'],
            'properties': {
                'question': {
                    'type': 'string',
                    'description': 'Natural-language question to convert into an AQL query',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'aql': {'type': 'string', 'description': 'The generated read-only AQL query.'},
                'valid': {'type': 'boolean', 'description': 'Whether a valid, safe AQL query was generated.'},
                'error': {'type': 'string', 'description': 'Error message if the generated AQL was unsafe.'},
                'answer': {
                    'type': 'string',
                    'description': 'LLM text response when the question is not a database query.',
                },
            },
        },
        description=(
            'Accepts a natural-language description and returns the equivalent read-only AQL query without executing it. Only use when the user explicitly asks to see the AQL — for actual data retrieval, use get_data instead.'
        ),
    )
    def get_aql(self, args):
        """Translate natural language to AQL without executing."""
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object')
        question = args.get('question')
        if not question or not isinstance(question, str) or not question.strip():
            raise ValueError('"question" is required and must be a non-empty string')

        limit = _clamp_limit(args.get('limit'))
        result = self._buildAqlQuery(question.strip(), limit=limit)
        is_valid = _parse_is_valid(result.get('isValid', False))
        aql = result.get('query', '')

        # is_valid means the query passed the EXPLAIN-plan read-only gate in
        # _buildAqlQuery, so it is already known safe — no keyword re-check here.
        if is_valid and aql:
            return {'aql': aql, 'valid': True}
        # Not valid: an EXPLAIN-validation failure carries an 'error'; a genuine
        # off-topic question does not (its 'query' is the LLM's plain-text answer).
        if result.get('error'):
            return {'error': result['error'], 'aql': aql, 'valid': False}
        return {'answer': aql, 'valid': False}

    # ------------------------------------------------------------------
    # Pipeline lane handlers
    # ------------------------------------------------------------------

    def writeQuestions(self, question: Question) -> None:
        """Translate a natural-language question to AQL, execute it, emit results."""
        question_text = question.questions[0].text if question.questions else None

        if not question_text:
            warning('No question text provided.')
            return

        lanes = self.instance.getListeners()

        # DIALECT: dialect-discovery request — emit {'dialect': 'arango'} on the
        # answers lane so SDK callers can tell they're talking to ArangoDB.
        if question.type == QuestionType.DIALECT:
            if 'answers' in lanes:
                answer = Answer()
                answer.setAnswer(json.dumps({'dialect': 'arango'}))
                self.instance.writeAnswers(answer)
            return

        # EXECUTE: caller passes raw AQL; bypass LLM translation + safety check.
        if question.type == QuestionType.EXECUTE:
            if not self.IGlobal.allow_execute:
                warning('QuestionType.EXECUTE is disabled for this node (set allow_execute=true to enable).')
                return
            try:
                execute_result = self.IGlobal._run_query_raw(question_text)
                rows = execute_result['rows']
                affected = execute_result['affected_rows']
                markdown = self._formatResultAsMarkdown(rows) if rows else None

                if 'text' in lanes:
                    self.instance.writeText(markdown if markdown else f'{affected} rows affected')

                if 'table' in lanes and rows:
                    self.instance.writeTable(markdown)

                if 'answers' in lanes:
                    answer = Answer()
                    answer.setAnswer(json.dumps(execute_result, default=str))
                    self.instance.writeAnswers(answer)
            except Exception as e:
                error(f'Error handling execute question: {e}')
            return

        try:
            query_json = self._buildAqlQuery(question_text)
            is_valid = _parse_is_valid(query_json.get('isValid', False))
            aql = query_json.get('query', '')

            # is_valid already means EXPLAIN-plan-approved read-only (see _buildAqlQuery).
            executed = is_valid and bool(aql)

            if executed:
                result = self.IGlobal._run_query(aql)
            else:
                # Off-topic question -> the LLM's text answer; exhausted validation
                # -> the EXPLAIN error (don't emit the rejected query as an answer).
                result = query_json.get('error') or aql

            if 'text' in lanes:
                self.instance.writeText(str(result))

            if 'table' in lanes and executed and result:
                self.instance.writeTable(self._formatResultAsMarkdown(result))

            if 'answers' in lanes:
                answer = Answer()
                if executed and result:
                    answer.setAnswer(self._formatResultAsMarkdown(result))
                else:
                    answer.setAnswer(str(result))
                self.instance.writeAnswers(answer)

        except Exception as e:
            error(f'Error handling question: {e}')

    # ------------------------------------------------------------------
    # AQL query building
    # ------------------------------------------------------------------

    def _buildAqlQuery(self, question_text: str, *, limit: int = 250) -> Dict:
        """Generate an AQL query, validate with EXPLAIN, retry on failure."""
        previous_aql: Optional[str] = None
        last_error: Optional[str] = None
        result: Dict = {}

        for attempt in range(self.IGlobal.max_validation_attempts):
            result = self._buildAqlQueryOnce(
                question_text,
                limit=limit,
                previous_aql=previous_aql,
                error_message=last_error,
            )

            is_valid = _parse_is_valid(result.get('isValid', False))
            aql = result.get('query', '')

            if not is_valid or not aql:
                return result

            # The EXPLAIN-plan modification check is the authoritative read-only
            # gate — it accepts a valid read even when it references a field or
            # collection named like a write keyword, and rejects a genuine write.
            ok, explain_error = self.IGlobal._validate_query(aql)
            if ok:
                return result

            warning(
                f'AQL validation attempt {attempt + 1}/{self.IGlobal.max_validation_attempts} failed: {explain_error}'
            )
            previous_aql = aql
            last_error = explain_error

        warning(
            f'AQL validation failed after {self.IGlobal.max_validation_attempts} attempt(s); marking the query invalid.'
        )
        # Retries exhausted: the query never passed EXPLAIN, so it is NOT valid.
        # Flag it (and carry the last error) so callers report a failure rather
        # than treating a rejected query as valid.
        result['isValid'] = False
        if last_error:
            result['error'] = str(last_error)
        return result

    def _buildAqlQueryOnce(
        self,
        question_text: str,
        *,
        limit: int = 250,
        previous_aql: Optional[str] = None,
        error_message: Optional[str] = None,
    ) -> Dict:
        """Single LLM call: translate a natural-language question into AQL."""

        def describe_schema(schema: Dict) -> str:
            lines = []
            collections = schema.get('collections', {})
            for name, info in collections.items():
                ctype = info.get('type', 'document')
                lines.append(f'Collection {name} ({ctype})')
                for field_name, field_type in info.get('fields', []):
                    lines.append(f'  {field_name}: {field_type}')
                indexed = info.get('indexed_fields') or []
                if indexed:
                    lines.append(f'  indexed: {", ".join(indexed)}')
                lines.append('')
            graphs = schema.get('graphs', [])
            if graphs:
                lines.append('Named graphs:')
                for graph in graphs:
                    lines.append(f'  Graph {graph.get("name", "")}')
                    for ed in graph.get('edge_definitions', []):
                        frm = ', '.join(ed.get('from', []))
                        to = ', '.join(ed.get('to', []))
                        lines.append(f'    ({frm}) -[{ed.get("edge", "")}]-> ({to})')
                lines.append('')
            views = schema.get('views', [])
            if views:
                names = ', '.join(v.get('name', '') for v in views)
                lines.append(f'ArangoSearch views: {names}')
                lines.append('')
            return '\n'.join(lines).strip()

        schema_description = describe_schema(self.IGlobal.graph_schema)

        question: Question = Question(type=QuestionType.QUESTION, role='You are a technical assistant.')
        question.addQuestion(question_text)

        if self.IGlobal.db_description:
            question.addContext(f'Database description: {self.IGlobal.db_description}')

        if schema_description:
            question.addContext(schema_description)

        question.expectJson = True

        question.addInstruction(
            'AQL Query Generation Guidelines',
            'Generate an AQL query based only on the collections and fields provided in context.',
        )
        question.addInstruction(
            'LIMIT', f'Limit the results to {limit} rows using LIMIT {limit} near the end of the query.'
        )
        question.addInstruction(
            'Formatting',
            'Do not wrap the AQL query in markdown (e.g., no triple backticks) and abide by formatting in the provided examples.',
        )
        question.addInstruction(
            'Commands',
            'You are only permitted to use read operations: FOR, FILTER, SORT, LIMIT, LET, COLLECT, RETURN, and graph traversals. Avoid any write operations (INSERT, UPDATE, REPLACE, REMOVE, UPSERT).',
        )
        question.addInstruction(
            'Ambiguity',
            "If the user's question is ambiguous, make reasonable assumptions and attempt to craft a query. If you infer that the user's question is entirely unrelated to querying the database, attempt to answer the question in a manner similar to the provided examples.",
        )

        question.addExample(
            'Show me 5 users in California',
            {
                'isValid': 'true',
                'query': f"FOR u IN users\n  FILTER u.state == 'CA'\n  LIMIT {limit}\n  RETURN u",
            },
        )
        question.addExample(
            'Which people does Alice know, up to two hops away?',
            {
                'isValid': 'true',
                'query': f"FOR v, e, p IN 1..2 OUTBOUND 'persons/alice' knows\n  LIMIT {limit}\n  RETURN DISTINCT v.name",
            },
        )
        question.addExample(
            'When did the Visigoths sack Rome?',
            {
                'isValid': 'false',
                'query': 'The Visigoths sacked Rome in 410 AD, under the leadership of their king, Alaric I.',
            },
        )

        if previous_aql and error_message:
            question.addContext(
                f'Your previous attempt produced the following AQL:\n\n{previous_aql}\n\nArangoDB rejected it with this error:\n\n{error_message}\n\nPlease fix the query and try again.'
            )

        result = self.instance.invoke(IInvokeLLM.Ask(question=question))

        if not result or not result.answer:
            raise ValueError('LLM failed to return an AQL query.')

        return result.answer

    # ------------------------------------------------------------------
    # Result formatting
    # ------------------------------------------------------------------

    def _formatResultAsMarkdown(self, result: Any) -> str:
        """Convert a query result (list of dicts) to a markdown table string."""
        headers = None
        data = []

        if isinstance(result, list) and result:
            first = result[0]
            if isinstance(first, dict):
                # Union of keys across all rows (first-seen order) — ArangoDB is
                # schemaless, so later rows may carry fields the first row lacks.
                headers = []
                for row in result:
                    for key in row:
                        if key not in headers:
                            headers.append(key)
                data = [[str(row.get(key, '')) for key in headers] for row in result]
            elif isinstance(first, (list, tuple)):
                data = [[str(cell) for cell in row] for row in result]
            else:
                data = [[str(row)] for row in result]
        else:
            data = [[str(result)]]

        return Table.generate_markdown_table(data, headers)


def _clamp_limit(raw_limit) -> int:
    """Clamp a user-supplied limit to [1, DEFAULT_MAX_EXECUTE_ROWS]."""
    try:
        return max(1, min(int(raw_limit), DEFAULT_MAX_EXECUTE_ROWS)) if raw_limit is not None else 250
    except (ValueError, TypeError):
        return 250
