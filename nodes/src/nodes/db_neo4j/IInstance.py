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
Instance-level state for the Neo4J database node.

Handles pipeline lane traffic (questions, table, answers), translates
natural-language questions to Cypher via the connected LLM, executes
queries, and inserts data as graph nodes.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional

from rocketlib import IInstanceBase, error, warning
from ai.common.schema import Answer, Question, QuestionType
from ai.common.table import Table
from ai.common.tools import ToolsBase
from rocketlib.types import IInvokeLLM

from .IGlobal import IGlobal
from .neo4j_driver import Neo4JDriver


# ---------------------------------------------------------------------------
# Cypher safety check — read-only queries only
# ---------------------------------------------------------------------------

_UNSAFE_CYPHER = re.compile(
    r'\b(?:CREATE|MERGE|DELETE|DETACH\s+DELETE|SET|REMOVE|DROP|'
    r'CALL\s+apoc\.(?:create|merge|delete|periodic\.commit|refactor))\b',
    re.IGNORECASE,
)


def _is_cypher_safe(cypher: str) -> bool:
    """Return True when the Cypher statement is read-only (MATCH/RETURN/CALL schema only)."""
    # Strip both single-line and block comments before checking.
    stripped = re.sub(r'//[^\n]*', '', cypher)
    stripped = re.sub(r'/\*.*?\*/', '', stripped, flags=re.DOTALL)
    return not bool(_UNSAFE_CYPHER.search(stripped))


class IInstance(IInstanceBase):
    """Neo4J-specific instance state."""

    # Narrow the type so IDE tooling resolves IGlobal attributes directly.
    IGlobal: IGlobal

    _driver: Optional[ToolsBase] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def beginInstance(self) -> None:
        """Instantiate the Neo4J tool driver for this pipeline instance."""
        self._driver = Neo4JDriver(instance=self)

    def endInstance(self) -> None:
        """Clean up instance-level resources (driver is stateless; nothing to do)."""
        pass

    def invoke(self, param: Any) -> Any:
        """Dispatch a tool invocation to the Neo4J driver."""
        if self._driver is None:
            raise RuntimeError('Neo4J driver not initialized')
        return self._driver.handle_invoke(param)

    # ------------------------------------------------------------------
    # Pipeline lane handlers
    # ------------------------------------------------------------------

    def writeQuestions(self, question: Question) -> None:
        """Translate a natural-language question to Cypher, execute it, emit results."""
        question_text = question.questions[0].text if question.questions else None

        if not question_text:
            warning('No question text provided.')
            return

        lanes = self.instance.getListeners()

        try:
            query_json = self._buildCypherQuery(question_text)
            is_valid = query_json.get('isValid', '').lower() == 'true'
            cypher = query_json.get('query', '')

            executed = is_valid and bool(cypher) and _is_cypher_safe(cypher)

            if executed:
                result = self.IGlobal._run_query(cypher)
            else:
                result = cypher

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

    # def writeTable(self, markdown: str) -> None:
    #     """Parse an incoming markdown table and insert rows as graph nodes."""
    #     if not markdown or not markdown.strip():
    #         debug('No table data provided.')
    #         return
    #
    #     headers, items = Table.parse_markdown_table(markdown)
    #
    #     if not headers or not items:
    #         warning(f'Could not parse markdown table. Raw data: {markdown[:200]}...')
    #         return
    #
    #     rows = [dict(zip(headers, row)) for row in items]
    #
    #     try:
    #         self._insertData(rows)
    #     except Exception as e:
    #         error(f'Error inserting table data: {e}')

    # def writeAnswers(self, answer: Answer) -> None:
    #     """Extract JSON rows from an Answer and insert them as graph nodes."""
    #     items = answer.getJson()
    #
    #     if not items:
    #         debug('No items to insert.')
    #         return
    #
    #     try:
    #         self._insertData(items)
    #     except Exception as e:
    #         error(f'Error in writeAnswers: {e}')

    # ------------------------------------------------------------------
    # Cypher query building
    # ------------------------------------------------------------------

    def _buildCypherQuery(self, question_text: str, *, limit: int = 250) -> Dict:
        """Generate a Cypher query, validate with EXPLAIN, retry on failure.

        Mirrors the retry logic in DatabaseInstanceBase._buildSQLQuery.
        """
        previous_cypher: Optional[str] = None
        last_error: Optional[str] = None
        result: Dict = {}

        for attempt in range(self.IGlobal.max_validation_attempts):
            result = self._buildCypherQueryOnce(
                question_text,
                limit=limit,
                previous_cypher=previous_cypher,
                error_message=last_error,
            )

            is_valid = result.get('isValid', '').lower() == 'true'
            cypher = result.get('query', '')

            if not is_valid or not cypher or not _is_cypher_safe(cypher):
                return result

            ok, explain_error = self.IGlobal._validate_query(cypher)
            if ok:
                return result

            warning(f'Cypher validation attempt {attempt + 1}/{self.IGlobal.max_validation_attempts} failed: {explain_error}')
            previous_cypher = cypher
            last_error = explain_error

        warning(f'Cypher validation failed after {self.IGlobal.max_validation_attempts} attempt(s); returning last result.')
        return result

    def _buildCypherQueryOnce(
        self,
        question_text: str,
        *,
        limit: int = 250,
        previous_cypher: Optional[str] = None,
        error_message: Optional[str] = None,
    ) -> Dict:
        """Single LLM call: translate a natural-language question into Cypher."""

        def describe_schema(schema: Dict) -> str:
            lines = []
            nodes = schema.get('nodes', {})
            for label, props in nodes.items():
                lines.append(f'Node :{label}')
                for prop_name, prop_type in props:
                    lines.append(f'  {prop_name}: {prop_type}')
                lines.append('')
            for rel in schema.get('relationships', []):
                rel_type = rel.get('type', '')
                start = rel.get('start', '')
                end = rel.get('end', '')
                if start and end:
                    lines.append(f'Relationship :{rel_type}')
                    lines.append(f'  (:{start})-[:{rel_type}]->(:{end})')
                elif rel_type:
                    lines.append(f'Relationship :{rel_type}')
                lines.append('')
            return '\n'.join(lines).strip()

        schema_description = describe_schema(self.IGlobal.graph_schema)

        question: Question = Question(type=QuestionType.QUESTION, role='You are a technical assistant.')
        question.addQuestion(question_text)

        if self.IGlobal.db_description:
            question.addContext(f'Graph description: {self.IGlobal.db_description}')

        if schema_description:
            question.addContext(schema_description)

        question.expectJson = True

        question.addInstruction(
            'Cypher Query Generation Guidelines',
            'Generate a Cypher query based only on the node labels and relationship types provided in context.',
        )
        question.addInstruction(
            'LIMIT',
            f'Limit the results to {limit} rows using LIMIT {limit} at the end of the query.',
        )
        question.addInstruction(
            'Formatting',
            'Do not wrap the Cypher query in markdown (e.g., no triple backticks) and abide by formatting in the provided examples.',
        )
        question.addInstruction(
            'Commands',
            'You are only permitted to use MATCH, OPTIONAL MATCH, WITH, WHERE, RETURN, ORDER BY, SKIP, and LIMIT. Avoid any write operations (CREATE, MERGE, DELETE, DETACH DELETE, SET, REMOVE, DROP).',
        )
        question.addInstruction(
            'Ambiguity',
            "If the user's question is ambiguous, make reasonable assumptions and attempt to craft a query. If you infer that the user's question is entirely unrelated to querying the graph, attempt to answer the question in a manner similar to the provided examples.",
        )

        question.addExample(
            "Who are Alice's colleagues?",
            {
                'isValid': 'true',
                'query': (f"MATCH (alice:Person {{name: 'Alice'}})-[:WORKS_WITH]->(colleague:Person)\nRETURN colleague.name AS name, colleague.role AS role\nLIMIT {limit}"),
            },
        )
        question.addExample(
            'When did the Visigoths sack Rome?',
            {
                'isValid': 'false',
                'query': 'The Visigoths sacked Rome in 410 AD, under the leadership of their king, Alaric I.',
            },
        )

        if previous_cypher and error_message:
            question.addContext(f'Your previous attempt produced the following Cypher:\n\n{previous_cypher}\n\nNeo4J rejected it with this error:\n\n{error_message}\n\nPlease fix the query and try again.')

        result = self.instance.invoke('llm', IInvokeLLM(op='ask', question=question))

        if not result or not result.answer:
            raise ValueError('LLM failed to return a Cypher query.')

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
                headers = list(first.keys())
                data = [[str(row.get(key, '')) for key in headers] for row in result]
            elif isinstance(first, (list, tuple)):
                data = [[str(cell) for cell in row] for row in result]
            else:
                data = [[str(row)] for row in result]
        else:
            data = [[str(result)]]

        return Table.generate_markdown_table(data, headers)

    # ------------------------------------------------------------------
    # Data insertion
    # ------------------------------------------------------------------

    # def _insertData(self, items: List[Dict[str, Any]]) -> None:
    #     """Insert a list of dicts as graph nodes with the configured label.
    #
    #     Uses MERGE on a synthetic ``_id`` property (MD5 of sorted key-value pairs)
    #     so repeated runs are idempotent.  All other properties are set via SET.
    #     """
    #     if not items:
    #         debug('No items to insert.')
    #         return
    #
    #     label = self.IGlobal.label
    #
    #     inserted = 0
    #     with self.IGlobal.driver.session(database=self.IGlobal.database) as session:
    #         for item in items:
    #             if not isinstance(item, dict):
    #                 continue
    #
    #             # Serialise complex values so they can be stored as Neo4J properties.
    #             props = {k: _prepare_property(v) for k, v in item.items() if v is not None}
    #
    #             if not props:
    #                 continue
    #
    #             # Build a stable identity key from sorted property values so that
    #             # MERGE is idempotent when the same row is inserted more than once.
    #             import hashlib, json as _json
    #             identity = hashlib.md5(
    #                 _json.dumps(props, sort_keys=True, default=str).encode()
    #             ).hexdigest()
    #             props['_id'] = identity
    #
    #             cypher = (
    #                 f'MERGE (n:{label} {{_id: $_id}}) '
    #                 'SET n += $props'
    #             )
    #             try:
    #                 session.run(cypher, {'_id': identity, 'props': props})
    #                 inserted += 1
    #             except Exception as e:
    #                 error(f'Error inserting node: {e}')
    #
    #     debug(f'Inserted {inserted} node(s) with label :{label}.')


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# def _prepare_property(value: Any) -> Any:
#     """Convert a Python value to a Neo4J-storable property."""
#     import json as _json
#     if value is None:
#         return None
#     if isinstance(value, bool):
#         return value
#     if isinstance(value, (int, float, str)):
#         return value
#     if isinstance(value, (list, dict)):
#         return _json.dumps(value)
#     return str(value)
