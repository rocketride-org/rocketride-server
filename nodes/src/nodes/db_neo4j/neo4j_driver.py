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

from .utils import _is_cypher_safe, _parse_is_valid, _strip_ns, _validate_identifier


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
        """Return the MCP tool descriptors for Neo4J tools (read + write)."""
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
            {
                'name': 'neo4j.create_node',
                'summary': 'Create a node in the Neo4J graph database with a given label and properties.',
                'description': (
                    f'{desc_prefix}'
                    'Creates a new node (or merges on a key property to avoid duplicates) in the '
                    'Neo4J graph database. Specify the label and a dictionary of properties. '
                    'If merge_key is provided, MERGE is used instead of CREATE so that existing '
                    'nodes with the same key value are updated rather than duplicated.'
                ),
                'inputSchema': {
                    'type': 'object',
                    'required': ['label', 'properties'],
                    'properties': {
                        'label': {
                            'type': 'string',
                            'description': 'Node label (e.g. Person, Company, Event)',
                        },
                        'properties': {
                            'type': 'object',
                            'description': 'Property key-value pairs to set on the node',
                        },
                        'merge_key': {
                            'type': 'string',
                            'description': 'Optional property name to use as the MERGE identity key (idempotent upsert). If omitted, CREATE is used.',
                        },
                    },
                },
                'outputSchema': {
                    'type': 'object',
                    'properties': {
                        'node': {'type': 'object', 'description': 'The created/merged node with its properties.'},
                        'error': {'type': 'string', 'description': 'Error message if creation failed.'},
                    },
                },
            },
            {
                'name': 'neo4j.create_relationship',
                'summary': 'Create a relationship between two nodes in the Neo4J graph database.',
                'description': (f'{desc_prefix}Creates a directed relationship between two nodes identified by their labels and a match property. Uses MERGE to avoid duplicate relationships.'),
                'inputSchema': {
                    'type': 'object',
                    'required': ['from_label', 'from_match', 'to_label', 'to_match', 'rel_type'],
                    'properties': {
                        'from_label': {
                            'type': 'string',
                            'description': 'Label of the source node (e.g. Person)',
                        },
                        'from_match': {
                            'type': 'object',
                            'description': 'Properties to match the source node (e.g. {"name": "Alice"})',
                        },
                        'to_label': {
                            'type': 'string',
                            'description': 'Label of the target node (e.g. Company)',
                        },
                        'to_match': {
                            'type': 'object',
                            'description': 'Properties to match the target node (e.g. {"name": "Acme"})',
                        },
                        'rel_type': {
                            'type': 'string',
                            'description': 'Relationship type (e.g. WORKS_AT, KNOWS, LOCATED_IN)',
                        },
                        'properties': {
                            'type': 'object',
                            'description': 'Optional properties to set on the relationship',
                        },
                    },
                },
                'outputSchema': {
                    'type': 'object',
                    'properties': {
                        'relationship': {'type': 'object', 'description': 'The created relationship.'},
                        'error': {'type': 'string', 'description': 'Error message if creation failed.'},
                    },
                },
            },
            {
                'name': 'neo4j.run_cypher',
                'summary': 'Execute a raw Cypher query (read or write) against the Neo4J database.',
                'description': (
                    f'{desc_prefix}Executes an arbitrary Cypher statement, including write operations (CREATE, MERGE, SET, DELETE). Use with caution — prefer the dedicated create_node and create_relationship tools for simple mutations. Use this for complex graph operations, bulk imports, or advanced traversals.'
                ),
                'inputSchema': {
                    'type': 'object',
                    'required': ['cypher'],
                    'properties': {
                        'cypher': {
                            'type': 'string',
                            'description': 'The Cypher statement to execute',
                        },
                        'params': {
                            'type': 'object',
                            'description': 'Optional parameter map to bind into the Cypher statement',
                        },
                    },
                },
                'outputSchema': {
                    'type': 'object',
                    'properties': {
                        'rows': {
                            'type': 'array',
                            'description': 'Result rows returned by the query.',
                            'items': {'type': 'object'},
                        },
                        'error': {'type': 'string', 'description': 'Error message if execution failed.'},
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
        elif name == 'create_node':
            return self._invoke_create_node(input_obj)
        elif name == 'create_relationship':
            return self._invoke_create_relationship(input_obj)
        elif name == 'run_cypher':
            return self._invoke_run_cypher(input_obj)
        else:
            raise ValueError(f'Unknown tool {tool_name!r}')

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

        elif name == 'create_node':
            if not isinstance(input_obj, dict):
                raise ValueError('Tool input must be a JSON object')
            if not input_obj.get('label') or not isinstance(input_obj['label'], str):
                raise ValueError('"label" is required and must be a non-empty string')
            if not isinstance(input_obj.get('properties'), dict):
                raise ValueError('"properties" is required and must be a JSON object')

        elif name == 'create_relationship':
            if not isinstance(input_obj, dict):
                raise ValueError('Tool input must be a JSON object')
            for field in ('from_label', 'to_label', 'rel_type'):
                if not input_obj.get(field) or not isinstance(input_obj[field], str):
                    raise ValueError(f'"{field}" is required and must be a non-empty string')
            for field in ('from_match', 'to_match'):
                if not isinstance(input_obj.get(field), dict) or not input_obj[field]:
                    raise ValueError(f'"{field}" is required and must be a non-empty JSON object')

        elif name == 'run_cypher':
            if not isinstance(input_obj, dict):
                raise ValueError('Tool input must be a JSON object')
            cypher = input_obj.get('cypher')
            if not cypher or not isinstance(cypher, str) or not cypher.strip():
                raise ValueError('"cypher" is required and must be a non-empty string')

        else:
            raise ValueError(f'Unknown tool {tool_name!r}')

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
        question = self._get_question(input_obj)
        limit = self._get_limit(input_obj)

        result = self._instance._buildCypherQuery(question, limit=limit)
        is_valid = _parse_is_valid(result.get('isValid', False))
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
    # Write tool implementations
    # ------------------------------------------------------------------

    def _invoke_create_node(self, input_obj: Dict[str, Any]) -> Dict[str, Any]:
        """Create (or merge) a node with the given label and properties."""
        label = input_obj['label'].strip()
        props = input_obj['properties']
        merge_key = input_obj.get('merge_key')

        # Sanitise label: only allow alphanumeric and underscore.
        if not label.isidentifier():
            return {'error': f'Invalid node label: {label!r}'}

        # Validate all property keys to prevent Cypher injection.
        for key in props:
            _validate_identifier(key, 'property key')

        # Validate merge_key if provided.
        if merge_key:
            _validate_identifier(merge_key, 'merge_key')

        try:
            if merge_key and merge_key in props:
                cypher = f'MERGE (n:{label} {{{merge_key}: $merge_val}}) SET n += $props RETURN n'
                params = {'merge_val': props[merge_key], 'props': props}
            else:
                cypher = f'CREATE (n:{label}) SET n = $props RETURN n'
                params = {'props': props}

            rows = self._instance.IGlobal._run_write_query(cypher, params)
            return {'node': rows[0] if rows else {}}
        except Exception as e:
            return {'error': str(e)}

    def _invoke_create_relationship(self, input_obj: Dict[str, Any]) -> Dict[str, Any]:
        """Create a relationship between two nodes matched by properties."""
        from_label = input_obj['from_label'].strip()
        from_match = input_obj['from_match']
        to_label = input_obj['to_label'].strip()
        to_match = input_obj['to_match']
        rel_type = input_obj['rel_type'].strip()
        rel_props = input_obj.get('properties') or {}

        # Sanitise identifiers.
        for ident in (from_label, to_label, rel_type):
            if not ident.isidentifier():
                return {'error': f'Invalid identifier: {ident!r}'}

        # Validate all property keys from match dicts to prevent Cypher injection.
        for key in from_match:
            _validate_identifier(key, 'from_match property key')
        for key in to_match:
            _validate_identifier(key, 'to_match property key')
        for key in rel_props:
            _validate_identifier(key, 'relationship property key')

        try:
            # Build MATCH clauses using parameterised property lookups.
            from_conditions = ' AND '.join(f'a.{k} = $from_{k}' for k in from_match)
            to_conditions = ' AND '.join(f'b.{k} = $to_{k}' for k in to_match)

            cypher = f'MATCH (a:{from_label}) WHERE {from_conditions} MATCH (b:{to_label}) WHERE {to_conditions} MERGE (a)-[r:{rel_type}]->(b) '
            if rel_props:
                cypher += 'SET r += $rel_props '
            cypher += 'RETURN type(r) AS type, properties(r) AS properties'

            params: Dict[str, Any] = {}
            for k, v in from_match.items():
                params[f'from_{k}'] = v
            for k, v in to_match.items():
                params[f'to_{k}'] = v
            if rel_props:
                params['rel_props'] = rel_props

            rows = self._instance.IGlobal._run_write_query(cypher, params)
            return {'relationship': rows[0] if rows else {}}
        except Exception as e:
            return {'error': str(e)}

    def _invoke_run_cypher(self, input_obj: Dict[str, Any]) -> Dict[str, Any]:
        """Execute an arbitrary Cypher statement (read or write)."""
        cypher = input_obj['cypher'].strip()
        params = input_obj.get('params') or {}

        try:
            # Use write path so both reads and writes succeed.
            rows = self._instance.IGlobal._run_write_query(cypher, params)
            return {'rows': rows}
        except Exception as e:
            return {'error': str(e)}

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
