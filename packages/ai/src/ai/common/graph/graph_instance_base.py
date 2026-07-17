# =============================================================================
# RocketRide Engine
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

"""Abstract IInstance layer shared by every graph database node.

Everything a graph node does beyond talking to its own engine lives here: the
agent tool calls, the natural-language-to-Cypher translation with EXPLAIN
validation and repair-on-error, and the pipeline lane handlers.

A concrete node implements ``_db_display_name()`` and ``_db_dialect()`` and
inherits the rest. See ``nodes/src/nodes/graph_falkordb/IInstance.py``.
"""

from __future__ import annotations

import json

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from rocketlib import IInstanceBase, error, tool_function, warning
from rocketlib.types import IInvokeLLM

from ai.common.schema import Answer, Question, QuestionType
from ai.common.table import Table
from ai.common.utils import normalize_tool_input, parse_bool, require_str

from .cypher_safety import is_cypher_safe
from .graph_global_base import DEFAULT_MAX_EXECUTE_ROWS, GraphGlobalBase

DEFAULT_ROW_LIMIT = 250


class GraphInstanceBase(IInstanceBase, ABC):
    """Abstract base for the IInstance layer of any graph database node."""

    IGlobal: GraphGlobalBase

    # ------------------------------------------------------------------
    # Abstract interface
    # ------------------------------------------------------------------

    @abstractmethod
    def _db_display_name(self) -> str:
        """Human-readable engine name used in tool descriptions (e.g. 'FalkorDB')."""

    @abstractmethod
    def _db_dialect(self) -> str:
        """Machine-readable engine identifier (e.g. 'falkordb', 'neo4j').

        Surfaced to SDK callers via the ``dialect`` tool so an application can
        tell it is talking to a graph database rather than a relational one.
        """

    def _query_language(self) -> str:
        """Query language name for the LLM prompt. Override for non-Cypher engines."""
        return 'Cypher'

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
                    'description': f'Maximum number of rows to return (default {DEFAULT_ROW_LIMIT}, max {DEFAULT_MAX_EXECUTE_ROWS}).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'rows': {'type': 'array', 'items': {'type': 'object'}},
                'query': {'type': 'string', 'description': 'The generated read-only query that was executed.'},
                'row_limit': {'type': 'integer'},
                'truncated': {'type': 'boolean', 'description': 'True if rows were cut at the row limit.'},
                'valid': {'type': 'boolean'},
                'error': {'type': 'string'},
                'answer': {
                    'type': 'string',
                    'description': 'LLM text response when the question is not a graph query.',
                },
            },
        },
        description=lambda self: (
            f'Accepts a natural-language description of the data you want, converts it to a safe read-only '
            f'{self._query_language()} query, runs it against the {self._db_display_name()} graph database, and returns the '
            f'result rows. No schema lookup or {self._query_language()} knowledge required -- just describe what you need. '
            f'Describe the end result you want, not intermediate steps -- this tool can handle traversals, '
            f'aggregations and multi-hop paths in a single request.'
        ),
    )
    def get_data(self, args):
        """Translate natural language into a graph query and execute it."""
        args = normalize_tool_input(args, tool_name='get_data')
        question = require_str(args, 'question', tool_name='get_data')

        # Clamp to the driver's own row ceiling so truncation is computed against
        # the limit actually enforced, not a larger number the caller asked for.
        limit = min(self._clamp_limit(args.get('limit')), self.IGlobal.read_row_cap)

        generated = self.get_query({'question': question, 'limit': limit})
        if not generated.get('valid'):
            return generated

        query = generated['query']
        try:
            # Ask for one row past the limit so a full page reads as truncated.
            rows = self.IGlobal._run_query(query, limit=limit)
        except Exception as e:
            return {'valid': False, 'error': str(e), 'query': query, 'rows': []}

        # Enforce the limit here too: the LLM is told to add a LIMIT clause, but a
        # dropped or ignored clause must not stream an unbounded result to the caller.
        capped = rows[:limit]
        return {
            'valid': True,
            'rows': [self._sanitize_row(row) for row in capped],
            'query': query,
            'row_limit': limit,
            'truncated': len(rows) > limit,
        }

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema={
            'type': 'object',
            'properties': {
                'labels': {'type': 'array', 'items': {'type': 'string'}},
                'nodes': {'type': 'object', 'description': 'Map of node label to its properties and types.'},
                'relationships': {
                    'type': 'array',
                    'items': {'type': 'object'},
                    'description': 'Relationship types with their start and end labels.',
                },
                'error': {'type': 'string'},
            },
        },
        description=lambda self: (
            f'Returns the {self._db_display_name()} graph schema: node labels with their properties, and the '
            f'relationship types connecting them. Do NOT call this preemptively -- only when get_data fails '
            f'or returns unexpected results.'
        ),
    )
    def get_schema(self, args):
        """Return the reflected graph schema."""
        schema = self.IGlobal.graph_schema or {}
        nodes = schema.get('nodes', {})
        return {
            'labels': list(nodes.keys()),
            'nodes': {label: [{'property': p, 'type': t} for p, t in props] for label, props in nodes.items()},
            'relationships': schema.get('relationships', []),
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['question'],
            'properties': {
                'question': {'type': 'string', 'description': 'Natural-language question to convert into a query'},
                'limit': {'type': 'integer'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'query': {'type': 'string'},
                'valid': {'type': 'boolean'},
                'error': {'type': 'string'},
                'answer': {'type': 'string'},
            },
        },
        description=lambda self: (
            f'Accepts a natural-language description and returns the equivalent read-only {self._query_language()} query '
            f'without executing it. Only use when the user explicitly asks to see the query -- for actual data '
            f'retrieval, use get_data instead.'
        ),
    )
    def get_query(self, args):
        """Translate natural language into a graph query without executing it."""
        args = normalize_tool_input(args, tool_name='get_query')
        question = require_str(args, 'question', tool_name='get_query')

        limit = self._clamp_limit(args.get('limit'))
        result = self._buildQuery(question, limit=limit)

        query = result.get('query', '')
        if not parse_bool(result.get('isValid', False)) or not query:
            # An error means the query was built but kept failing EXPLAIN — surface
            # it as an error, not as a prose answer holding broken Cypher.
            if result.get('error'):
                return {'error': result['error'], 'query': query, 'valid': False}
            # Otherwise the LLM decided this wasn't a graph question — pass its prose through.
            return {'answer': query, 'valid': False}
        if not is_cypher_safe(query):
            return {'error': 'Generated query contains write or admin clauses', 'query': query, 'valid': False}
        return {'query': query, 'valid': True}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
            'properties': {
                'query': {'type': 'string', 'description': 'Raw query to execute.'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'rows': {'type': 'array', 'items': {'type': 'object'}},
                'affected_rows': {'type': 'integer'},
            },
        },
        description=lambda self: (
            f'Execute a raw {self._query_language()} statement against this {self._db_display_name()} graph. '
            f'Bypasses LLM translation and the read-only gate, so writes are possible. '
            f'Disabled unless the node owner enables allow_execute.'
        ),
    )
    def execute(self, args):
        """Execute a raw statement, bypassing translation and the read-only gate."""
        args = normalize_tool_input(args, tool_name='execute')
        query = require_str(args, 'query', tool_name='execute')

        if not self.IGlobal.allow_execute:
            raise ValueError('execute tool is disabled for this node (set allow_execute=true)')

        result = self.IGlobal._run_query_raw(query)
        return {
            'rows': [self._sanitize_row(row) for row in result.get('rows', [])],
            'affected_rows': result.get('affected_rows', 0),
        }

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema={
            'type': 'object',
            'properties': {'dialect': {'type': 'string', 'description': 'Graph engine identifier.'}},
        },
        description='Return the graph engine dialect (e.g. neo4j, falkordb).',
    )
    def dialect(self, args):
        """Return the graph engine dialect."""
        return {'dialect': self._db_dialect()}

    # ------------------------------------------------------------------
    # Sanitization helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _clamp_limit(raw: Any) -> int:
        """Clamp a caller-supplied row limit into the allowed range."""
        if raw is None:
            return DEFAULT_ROW_LIMIT
        try:
            return max(1, min(int(raw), DEFAULT_MAX_EXECUTE_ROWS))
        except (TypeError, ValueError):
            return DEFAULT_ROW_LIMIT

    @classmethod
    def _sanitize_value(cls, val):
        """Convert a graph value (node, edge, temporal, primitive) to JSON-safe data."""
        if val is None or isinstance(val, (str, int, float, bool)):
            return val
        # Numeric-but-not-native (Decimal, numpy scalars) -> JSON number, matching
        # db_instance_base so the same value serialises the same across node types.
        if hasattr(val, '__float__'):
            return float(val)
        if isinstance(val, dict):
            return {str(k): cls._sanitize_value(v) for k, v in val.items()}
        if isinstance(val, (list, tuple)):
            return [cls._sanitize_value(v) for v in val]
        if isinstance(val, bytes):
            return val.decode('utf-8', errors='replace')
        if hasattr(val, 'isoformat'):
            return val.isoformat()
        return str(val)

    @classmethod
    def _sanitize_row(cls, row):
        """Ensure every value in a result row is JSON-serializable."""
        if isinstance(row, dict):
            return {k: cls._sanitize_value(v) for k, v in row.items()}
        return cls._sanitize_value(row)

    # ------------------------------------------------------------------
    # Query generation
    # ------------------------------------------------------------------

    def _buildQuery(self, question_text: str, *, limit: int = DEFAULT_ROW_LIMIT) -> Dict:
        """Generate a query, validate it with EXPLAIN, and retry with the error on failure.

        Each rejected query is fed back to the LLM together with the engine's own
        error message, so it can repair the statement rather than guess again.
        """
        previous_query: Optional[str] = None
        last_error: Optional[str] = None
        result: Dict = {}

        for attempt in range(self.IGlobal.max_validation_attempts):
            result = self._buildQueryOnce(
                question_text,
                limit=limit,
                previous_query=previous_query,
                error_message=last_error,
            )

            query = result.get('query', '')

            # Not a graph question, or the safety gate rejects it — no point in EXPLAIN.
            if not parse_bool(result.get('isValid', False)) or not query or not is_cypher_safe(query):
                return result

            ok, explain_error = self.IGlobal._validate_query(query)
            if ok:
                return result

            warning(
                f'Query validation attempt {attempt + 1}/{self.IGlobal.max_validation_attempts} failed: {explain_error}'
            )
            previous_query = query
            last_error = explain_error

        warning(
            f'Query validation failed after {self.IGlobal.max_validation_attempts} attempt(s); rejecting the query.'
        )
        # Every EXPLAIN attempt failed. Force isValid false so callers do not run
        # a query the database already rejected; keep the last query for context
        # and the error so callers can tell this apart from a non-graph question.
        result['isValid'] = False
        result['error'] = last_error or 'Query validation failed'
        return result

    def _buildQueryOnce(
        self,
        question_text: str,
        *,
        limit: int = DEFAULT_ROW_LIMIT,
        previous_query: Optional[str] = None,
        error_message: Optional[str] = None,
    ) -> Dict:
        """Single LLM call: translate a natural-language question into a graph query."""
        language = self._query_language()

        question: Question = Question(type=QuestionType.QUESTION, role='You are a technical assistant.')
        question.addQuestion(question_text)

        if self.IGlobal.db_description:
            question.addContext(f'Graph description: {self.IGlobal.db_description}')

        question.addContext(self._describe_schema(self.IGlobal.graph_schema))
        question.expectJson = True

        question.addInstruction(
            f'{language} Query Generation Guidelines',
            'Generate a query using only the node labels, properties and relationship types provided in context.',
        )
        question.addInstruction(
            'LIMIT',
            f'Limit the results to {limit} rows.',
        )
        question.addInstruction(
            'Formatting',
            'Do not wrap the query in markdown (no triple backticks or language identifiers).',
        )
        question.addInstruction(
            'Commands',
            'You are only permitted to read. Use MATCH/RETURN and read-only procedures. Never emit CREATE, '
            'MERGE, SET, DELETE, REMOVE or DROP.',
        )
        question.addInstruction(
            'Ambiguity',
            "If the user's question is ambiguous, make reasonable assumptions and attempt to craft a query. If "
            'the question is entirely unrelated to querying the graph, answer it directly as in the example.',
        )

        question.addExample(
            'Which people know Alice?',
            {
                'isValid': 'true',
                'query': 'MATCH (p:Person)-[:KNOWS]->(a:Person)\nWHERE a.name = "Alice"\nRETURN p.name\nLIMIT 250',
            },
        )
        question.addExample(
            'When did the Visigoths sack Rome?',
            {
                'isValid': 'false',
                'query': 'The Visigoths sacked Rome in 410 AD, under the leadership of their king, Alaric I.',
            },
        )

        if previous_query and error_message:
            question.addContext(
                f'Your previous attempt produced the following query:\n\n{previous_query}\n\n'
                f'The database rejected it with this error:\n\n{error_message}\n\nPlease fix the query and try again.'
            )

        result = self.instance.invoke(IInvokeLLM.Ask(question=question))

        if not result or not result.answer:
            raise ValueError(f'LLM failed to return a {language} query.')

        return result.answer

    @staticmethod
    def _describe_schema(schema: Dict[str, Any]) -> str:
        """Format the reflected schema into a compact text block for the LLM prompt."""
        lines: List[str] = []

        for label, props in (schema.get('nodes') or {}).items():
            lines.append(f'Node :{label}')
            for prop_name, prop_type in props:
                lines.append(f'  {prop_name}: {prop_type}')
            lines.append('')

        relationships = schema.get('relationships') or []
        if relationships:
            lines.append('Relationships:')
            for rel in relationships:
                start = rel.get('start') or '?'
                end = rel.get('end') or '?'
                lines.append(f'  (:{start})-[:{rel.get("type", "")}]->(:{end})')

        return '\n'.join(lines).strip()

    def _formatResultAsMarkdown(self, result: Any) -> str:
        """Convert query result rows to a markdown table."""
        headers = None
        data: List[List[str]] = []

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
            # (headers, rows) shape, kept in step with db_instance_base so the two
            # copies do not silently diverge.
            headers, rows = result
            data = [[str(cell) for cell in row] for row in rows]
        else:
            data = [[str(result)]]

        return Table.generate_markdown_table(data, headers)

    # ------------------------------------------------------------------
    # Pipeline lane handlers
    # ------------------------------------------------------------------

    def writeQuestions(self, question: Question) -> None:
        """Answer a question off the questions lane: translate, execute, emit."""
        question_text = question.questions[0].text if question.questions else None

        if not question_text:
            warning('No question text provided.')
            return

        lanes = self.instance.getListeners()

        # DIALECT and EXECUTE are also exposed as tool functions. They stay on the
        # lane for SDK callers that already send these QuestionTypes to db_neo4j.
        if question.type == QuestionType.DIALECT:
            if 'answers' in lanes:
                answer = Answer()
                answer.setAnswer(json.dumps({'dialect': self._db_dialect()}))
                self.instance.writeAnswers(answer)
            return

        if question.type == QuestionType.EXECUTE:
            self._answerExecute(question_text, lanes)
            return

        try:
            generated = self._buildQuery(question_text)
            query = generated.get('query', '')
            is_valid = parse_bool(generated.get('isValid', False))

            # The EXPLAIN repair loop gave up: `query` still holds the broken Cypher,
            # not an answer. Emit the error instead of printing it as a prose answer.
            if generated.get('error'):
                self._emitError(generated['error'], lanes)
                return
            # The LLM claimed a valid query but it carries a write/admin clause: same
            # rule — surface the rejection, never emit the unsafe query as prose.
            if is_valid and query and not is_cypher_safe(query):
                self._emitError('Generated query contains write or admin clauses', lanes)
                return

            executed = is_valid and bool(query)
            # When the LLM decides it isn't a graph question, `query` holds its prose answer.
            result = self.IGlobal._run_query(query) if executed else query

            self._emit(result, lanes, executed=executed)

        except Exception as e:
            error(f'Error handling question: {e}')

    def _emitError(self, message: str, lanes) -> None:
        """Emit a validation/safety error to the wired lanes, never a broken query as prose."""
        if 'text' in lanes:
            self.instance.writeText(message)
        if 'answers' in lanes:
            answer = Answer()
            answer.setAnswer(json.dumps({'error': message}))
            self.instance.writeAnswers(answer)

    def _answerExecute(self, statement: str, lanes) -> None:
        """Run a raw statement from the EXECUTE lane path and emit the result."""
        if not self.IGlobal.allow_execute:
            warning('QuestionType.EXECUTE is disabled for this node (set allow_execute=true to enable).')
            return
        try:
            result = self.IGlobal._run_query_raw(statement)
            rows = result.get('rows', [])
            affected = result.get('affected_rows', 0)
            markdown = self._formatResultAsMarkdown(rows) if rows else None

            if 'text' in lanes:
                self.instance.writeText(markdown if markdown else f'{affected} rows affected')

            if 'table' in lanes and rows:
                self.instance.writeTable(markdown)

            if 'answers' in lanes:
                answer = Answer()
                answer.setAnswer(json.dumps(result, default=str))
                self.instance.writeAnswers(answer)

        except Exception as e:
            error(f'Error handling execute question: {e}')

    def _emit(self, result: Any, lanes, *, executed: bool) -> None:
        """Write a query result to whichever of the text/table/answers lanes are wired."""
        if 'text' in lanes:
            self.instance.writeText(str(result))

        if 'table' in lanes and executed and result:
            self.instance.writeTable(self._formatResultAsMarkdown(result))

        if 'answers' in lanes:
            answer = Answer()
            answer.setAnswer(self._formatResultAsMarkdown(result) if executed and result else str(result))
            self.instance.writeAnswers(answer)
