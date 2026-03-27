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
Tool-provider driver for the Neo4J database node.

Exposes three tools to LLM agents:

- ``neo4j.get_data``   — natural language → Cypher → execute → rows (primary)
- ``neo4j.get_schema`` — return graph schema (node labels, rel types, properties)
- ``neo4j.get_cypher`` — natural language → Cypher without executing (preview)
"""

from __future__ import annotations

from typing import Any, Dict, List

from ai.common.tools import ToolsBase


class Neo4JDriver(ToolsBase):
    """Tool-provider driver for Neo4J.

    Registers three Cypher-oriented tools under the ``neo4j`` namespace.
    All tool logic delegates back to IInstance (for query building) and
    IGlobal (for schema and execution) so the driver itself stays thin.
    """

    _SERVER_NAME = 'neo4j'

    LIMIT_DEFAULT: int = 250
    LIMIT_MAX: int = 25_000

    def __init__(self, *, instance: Any):
        """Initialise the driver, holding a reference to the owning IInstance."""
        self._instance = instance

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[Dict[str, Any]]:
        """Return the MCP tool descriptors for the three Neo4J tools."""
        db_desc = getattr(self._instance.IGlobal, 'db_description', '') or ''
        desc_prefix = f'{db_desc} ' if db_desc else ''

        return [
            {
                'name': 'neo4j.get_data',
                'summary': ('PRIMARY tool for Neo4J — accepts natural language, no setup required. Use this first.'),
                'description': (
                    f'{desc_prefix}'
                    'Accepts a natural-language description of the graph data you want, '
                    'converts it to a safe Cypher MATCH query, executes it against the Neo4J '
                    'graph database, and returns the result rows. '
                    'No schema lookup or Cypher knowledge required — just describe what you need. '
                    'Results may be large — consider using peek or store.'
                ),
                'inputSchema': {
                    'type': 'object',
                    'required': ['question'],
                    'properties': {
                        'question': {
                            'type': 'string',
                            'description': 'Natural-language description of the graph data you want to retrieve',
                        },
                        'limit': {
                            'type': 'integer',
                            'description': 'Maximum number of rows to return (default 250, max 25000).',
                        },
                    },
                },
                'outputSchema': {
                    'type': 'object',
                    'properties': {
                        'rows': {
                            'type': 'array',
                            'description': 'Result rows returned by the Cypher query.',
                            'items': {'type': 'object'},
                        },
                        'cypher': {'type': 'string', 'description': 'The generated Cypher query that was executed.'},
                        'row_limit': {'type': 'integer', 'description': 'The row cap applied to this query.'},
                        'error': {'type': 'string', 'description': 'Error message if query generation or execution failed.'},
                        'answer': {'type': 'string', 'description': 'LLM text response when the question is not a graph query.'},
                    },
                },
            },
            {
                'name': 'neo4j.get_schema',
                'summary': 'FALLBACK ONLY — Neo4J graph schema lookup. Use only if get_data fails.',
                'description': (f'{desc_prefix}Returns the Neo4J graph schema: node labels with their properties and types, and relationship types with their start and end node labels. Do NOT call this preemptively — only use when get_data fails or returns unexpected results.'),
                'inputSchema': {
                    'type': 'object',
                    'properties': {
                        'label': {
                            'type': 'string',
                            'description': 'Optional node label to filter schema to a single node type.',
                        },
                    },
                },
                'outputSchema': {
                    'type': 'object',
                    'properties': {
                        'nodes': {
                            'type': 'object',
                            'description': 'Map of node label to list of {property, type} objects.',
                        },
                        'relationships': {
                            'type': 'array',
                            'description': 'List of {type, start, end} relationship descriptors.',
                        },
                        'database': {'type': 'string'},
                    },
                },
            },
            {
                'name': 'neo4j.get_cypher',
                'summary': 'Convert a natural-language question to a Neo4J Cypher MATCH without executing it.',
                'description': (f'{desc_prefix}Accepts a natural-language description and returns the equivalent Cypher MATCH statement without executing it. Only use when the user explicitly asks to see the Cypher — for actual data retrieval, use get_data instead.'),
                'inputSchema': {
                    'type': 'object',
                    'required': ['question'],
                    'properties': {
                        'question': {
                            'type': 'string',
                            'description': 'Natural-language question to convert into a Cypher query',
                        },
                    },
                },
                'outputSchema': {
                    'type': 'object',
                    'properties': {
                        'cypher': {'type': 'string', 'description': 'The generated Cypher MATCH statement.'},
                        'valid': {'type': 'boolean', 'description': 'Whether a valid, safe Cypher query was generated.'},
                        'error': {'type': 'string', 'description': 'Error message if the generated Cypher was unsafe.'},
                        'answer': {'type': 'string', 'description': 'LLM text response when the question is not a graph query.'},
                    },
                },
            },
        ]

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:
        """Validate and dispatch a tool call to the appropriate handler."""
        if input_obj is None:
            input_obj = {}
        if not isinstance(input_obj, dict):
            raise ValueError('Tool input must be a JSON object (dict)')

        self._tool_validate(tool_name=tool_name, input_obj=input_obj)
        name = _strip_ns(tool_name)

        if name == 'get_schema':
            return self._invoke_get_schema(input_obj)
        elif name == 'get_cypher':
            return self._invoke_get_cypher(input_obj)
        elif name == 'get_data':
            return self._invoke_get_data(input_obj)

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:
        """Raise ValueError if the tool input is missing required fields."""
        name = _strip_ns(tool_name)

        if name == 'get_schema':
            if input_obj is not None and not isinstance(input_obj, dict):
                raise ValueError('Tool input must be a JSON object or empty')

        elif name in ('get_cypher', 'get_data'):
            if not isinstance(input_obj, dict):
                raise ValueError('Tool input must be a JSON object')
            question = input_obj.get('question')
            if not question or not isinstance(question, str) or not question.strip():
                raise ValueError('"question" is required and must be a non-empty string')

        else:
            raise ValueError(f'Unknown tool {tool_name!r} (expected get_schema, get_cypher, or get_data)')

    # ------------------------------------------------------------------
    # Tool implementations
    # ------------------------------------------------------------------

    def _invoke_get_schema(self, input_obj: Dict[str, Any]) -> Dict[str, Any]:
        """Return the cached graph schema, optionally filtered to a single node label."""
        schema = self._instance.IGlobal.graph_schema
        label_filter = input_obj.get('label')

        nodes = schema.get('nodes', {})
        rels = schema.get('relationships', [])

        if label_filter:
            filtered = nodes.get(label_filter)
            if filtered is None:
                return {'error': f'Node label :{label_filter} not found'}
            nodes = {label_filter: filtered}
            rels = [r for r in rels if r.get('start') == label_filter or r.get('end') == label_filter]

        return {
            'database': self._instance.IGlobal.database,
            'nodes': {label: [{'property': p, 'type': t} for p, t in props] for label, props in nodes.items()},
            'relationships': rels,
        }

    def _invoke_get_cypher(self, input_obj: Dict[str, Any]) -> Dict[str, Any]:
        """Translate a natural-language question to Cypher without executing it."""
        from .IInstance import _is_cypher_safe

        question = self._get_question(input_obj)
        limit = self._get_limit(input_obj)

        result = self._instance._buildCypherQuery(question, limit=limit)
        is_valid = result.get('isValid', '').lower() == 'true'
        cypher = result.get('query', '')

        if is_valid and cypher and _is_cypher_safe(cypher):
            return {'cypher': cypher, 'valid': True}
        elif is_valid and cypher:
            return {'error': 'Generated query contains unsafe Cypher', 'cypher': cypher, 'valid': False}
        else:
            return {'answer': cypher, 'valid': False}

    def _invoke_get_data(self, input_obj: Dict[str, Any]) -> Dict[str, Any]:
        """Translate a natural-language question to Cypher, execute it, and return rows."""
        limit = self._get_limit(input_obj)

        cypher_result = self._invoke_get_cypher({'question': self._get_question(input_obj), 'limit': limit})
        if not cypher_result.get('valid'):
            return cypher_result

        cypher = cypher_result['cypher']

        try:
            rows = self._instance.IGlobal._run_query(cypher)
        except Exception as e:
            return {'error': str(e), 'cypher': cypher, 'rows': []}

        return {'rows': rows, 'cypher': cypher, 'row_limit': limit}

    # ------------------------------------------------------------------
    # Input helpers
    # ------------------------------------------------------------------

    def _get_question(self, input_obj: Dict[str, Any]) -> str:
        """Extract and normalise the question string from a tool input object.

        Args:
            input_obj (Dict[str, Any]): Tool input object containing the ``question`` key.

        Returns:
            str: The question string with leading/trailing whitespace stripped.
        """
        return input_obj['question'].strip()

    def _get_limit(self, input_obj: Dict[str, Any]) -> int:
        """Extract and clamp the row limit from a tool input object.

        Args:
            input_obj (Dict[str, Any]): Tool input object optionally containing a ``limit`` key.

        Returns:
            int: Clamped limit between 1 and ``LIMIT_MAX``, or ``LIMIT_DEFAULT`` if not provided.
        """
        raw_limit = input_obj.get('limit')
        try:
            return max(1, min(int(raw_limit), self.LIMIT_MAX)) if raw_limit is not None else self.LIMIT_DEFAULT
        except (ValueError, TypeError):
            return self.LIMIT_DEFAULT


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _strip_ns(tool_name: str) -> str:
    """Strip the 'neo4j.' namespace prefix from a tool name."""
    prefix = 'neo4j.'
    return tool_name[len(prefix) :] if tool_name.startswith(prefix) else tool_name
