# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Instance-level state for the Neo4J database node.

Handles pipeline lane traffic (questions, table, answers), translates
natural-language questions to Cypher via the connected LLM, executes
queries, and inserts data as graph nodes.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from rocketlib import IInstanceBase, tool_function, error, warning
from ai.common.schema import Answer, Question, QuestionType
from ai.common.table import Table
from rocketlib.types import IInvokeLLM

from .IGlobal import IGlobal
from .utils import _is_cypher_safe, _parse_is_valid


class IInstance(IInstanceBase):
    """Neo4J-specific instance state."""

    IGlobal: IGlobal

    # ------------------------------------------------------------------
    # Tool methods
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['question'],
            'properties': {
                'question': {'type': 'string', 'description': 'Natural-language description of the graph data you want to retrieve'},
                'limit': {'type': 'integer', 'description': 'Maximum number of rows to return (default 250, max 25000).'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'rows': {'type': 'array', 'description': 'Result rows returned by the Cypher query.', 'items': {'type': 'object'}},
                'cypher': {'type': 'string', 'description': 'The generated Cypher query that was executed.'},
                'row_limit': {'type': 'integer', 'description': 'The row cap applied to this query.'},
                'error': {'type': 'string', 'description': 'Error message if query generation or execution failed.'},
                'answer': {'type': 'string', 'description': 'LLM text response when the question is not a graph query.'},
            },
        },
        description=(
            'Accepts a natural-language description of the graph data you want, '
            'converts it to a safe Cypher MATCH query, executes it against the Neo4J '
            'graph database, and returns the result rows. '
            'No schema lookup or Cypher knowledge required — just describe what you need. '
            'Results may be large — consider using peek or store.'
        ),
    )
    def get_data(self, args):
        """Translate natural language to Cypher and execute."""
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object')
        question = args.get('question')
        if not question or not isinstance(question, str) or not question.strip():
            raise ValueError('"question" is required and must be a non-empty string')

        limit = _clamp_limit(args.get('limit'))
        cypher_result = self.get_cypher({'question': question.strip(), 'limit': limit})
        if not cypher_result.get('valid'):
            return cypher_result

        cypher = cypher_result['cypher']
        try:
            rows = self.IGlobal._run_query(cypher)
        except Exception as e:
            return {'error': str(e), 'cypher': cypher, 'rows': []}
        return {'rows': rows, 'cypher': cypher, 'row_limit': limit}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'label': {'type': 'string', 'description': 'Optional node label to filter schema to a single node type.'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'nodes': {'type': 'object', 'description': 'Map of node label to list of {property, type} objects.'},
                'relationships': {'type': 'array', 'description': 'List of {type, start, end} relationship descriptors.'},
                'database': {'type': 'string'},
            },
        },
        description=('Returns the Neo4J graph schema: node labels with their properties and types, and relationship types with their start and end node labels. Do NOT call this preemptively — only use when get_data fails or returns unexpected results.'),
    )
    def get_schema(self, args):
        """Return the cached graph schema."""
        if args is not None and not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object or empty')
        if not args:
            args = {}

        schema = self.IGlobal.graph_schema
        label_filter = args.get('label')

        nodes = schema.get('nodes', {})
        rels = schema.get('relationships', [])

        if label_filter:
            filtered = nodes.get(label_filter)
            if filtered is None:
                return {'error': f'Node label :{label_filter} not found'}
            nodes = {label_filter: filtered}
            rels = [r for r in rels if r.get('start') == label_filter or r.get('end') == label_filter]

        return {
            'database': self.IGlobal.database,
            'nodes': {label: [{'property': p, 'type': t} for p, t in props] for label, props in nodes.items()},
            'relationships': rels,
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['question'],
            'properties': {
                'question': {'type': 'string', 'description': 'Natural-language question to convert into a Cypher query'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'cypher': {'type': 'string', 'description': 'The generated Cypher MATCH statement.'},
                'valid': {'type': 'boolean', 'description': 'Whether a valid, safe Cypher query was generated.'},
                'error': {'type': 'string', 'description': 'Error message if the generated Cypher was unsafe.'},
                'answer': {'type': 'string', 'description': 'LLM text response when the question is not a graph query.'},
            },
        },
        description=('Accepts a natural-language description and returns the equivalent Cypher MATCH statement without executing it. Only use when the user explicitly asks to see the Cypher — for actual data retrieval, use get_data instead.'),
    )
    def get_cypher(self, args):
        """Translate natural language to Cypher without executing."""
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object')
        question = args.get('question')
        if not question or not isinstance(question, str) or not question.strip():
            raise ValueError('"question" is required and must be a non-empty string')

        limit = _clamp_limit(args.get('limit'))
        result = self._buildCypherQuery(question.strip(), limit=limit)
        is_valid = _parse_is_valid(result.get('isValid', False))
        cypher = result.get('query', '')

        if is_valid and cypher and _is_cypher_safe(cypher):
            return {'cypher': cypher, 'valid': True}
        elif is_valid and cypher:
            return {'error': 'Generated query contains unsafe Cypher', 'cypher': cypher, 'valid': False}
        else:
            return {'answer': cypher, 'valid': False}

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
            is_valid = _parse_is_valid(query_json.get('isValid', False))
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

    # ------------------------------------------------------------------
    # Cypher query building
    # ------------------------------------------------------------------

    def _buildCypherQuery(self, question_text: str, *, limit: int = 250) -> Dict:
        """Generate a Cypher query, validate with EXPLAIN, retry on failure."""
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

            is_valid = _parse_is_valid(result.get('isValid', False))
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

        question.addInstruction('Cypher Query Generation Guidelines', 'Generate a Cypher query based only on the node labels and relationship types provided in context.')
        question.addInstruction('LIMIT', f'Limit the results to {limit} rows using LIMIT {limit} at the end of the query.')
        question.addInstruction('Formatting', 'Do not wrap the Cypher query in markdown (e.g., no triple backticks) and abide by formatting in the provided examples.')
        question.addInstruction('Commands', 'You are only permitted to use MATCH, OPTIONAL MATCH, WITH, WHERE, RETURN, ORDER BY, SKIP, and LIMIT. Avoid any write operations (CREATE, MERGE, DELETE, DETACH DELETE, SET, REMOVE, DROP).')
        question.addInstruction('Ambiguity', "If the user's question is ambiguous, make reasonable assumptions and attempt to craft a query. If you infer that the user's question is entirely unrelated to querying the graph, attempt to answer the question in a manner similar to the provided examples.")

        question.addExample(
            "Who are Alice's colleagues?",
            {'isValid': 'true', 'query': f"MATCH (alice:Person {{name: 'Alice'}})-[:WORKS_WITH]->(colleague:Person)\nRETURN colleague.name AS name, colleague.role AS role\nLIMIT {limit}"},
        )
        question.addExample(
            'When did the Visigoths sack Rome?',
            {'isValid': 'false', 'query': 'The Visigoths sacked Rome in 410 AD, under the leadership of their king, Alaric I.'},
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


def _clamp_limit(raw_limit) -> int:
    """Clamp a user-supplied limit to [1, 25000]."""
    try:
        return max(1, min(int(raw_limit), 25000)) if raw_limit is not None else 250
    except (ValueError, TypeError):
        return 250
