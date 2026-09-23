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

"""Neo4J graph node instance.

Inherits the graph tool surface (``get_data``, ``get_schema``, ``get_query``,
``execute``, ``dialect``) and the questions lane from ``GraphInstanceBase``.
"""

from __future__ import annotations

from rocketlib import tool_function

from ai.common.graph import GraphInstanceBase
from ai.common.utils import normalize_tool_input, optional_str

from .IGlobal import IGlobal


class IInstance(GraphInstanceBase):
    IGlobal: IGlobal

    def _db_display_name(self) -> str:
        return 'Neo4J'

    def _db_dialect(self) -> str:
        return 'neo4j'

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'label': {
                    'type': 'string',
                    'description': 'Optional node label to filter the schema to a single node type.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'labels': {'type': 'array', 'items': {'type': 'string'}},
                'nodes': {'type': 'object', 'description': 'Map of node label to its properties and types.'},
                'relationships': {'type': 'array', 'items': {'type': 'object'}},
                'database': {'type': 'string', 'description': 'The Neo4J database the schema was read from.'},
                'error': {'type': 'string'},
            },
        },
        description=lambda self: (
            f'Returns the {self._db_display_name()} graph schema: node labels with their properties, and the '
            f'relationship types connecting them. Optionally filter to a single node label. Do NOT call this '
            f'preemptively -- only when get_data fails or returns unexpected results.'
        ),
    )
    def get_schema(self, args):
        """Return the reflected schema, optionally filtered to one node label.

        Overrides the base ``get_schema`` to keep Neo4J's ``label`` filter and
        ``database`` key, which the previous tool surface exposed.
        """
        args = normalize_tool_input(args, tool_name='get_schema')
        label_filter = optional_str(args, 'label', tool_name='get_schema')

        schema = self.IGlobal.graph_schema or {}
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
            'labels': list(nodes.keys()),
            'nodes': {label: [{'property': p, 'type': t} for p, t in props] for label, props in nodes.items()},
            'relationships': rels,
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['question'],
            'properties': {
                'question': {'type': 'string', 'description': 'Natural-language question to convert into Cypher'},
                'limit': {'type': 'integer'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'cypher': {'type': 'string', 'description': 'The generated Cypher MATCH statement.'},
                'query': {'type': 'string'},
                'valid': {'type': 'boolean'},
                'error': {'type': 'string'},
                'answer': {'type': 'string'},
            },
        },
        description=(
            'Deprecated alias for get_query, kept so agents written against the previous Neo4J tool '
            'surface keep working. Prefer get_query.'
        ),
    )
    def get_cypher(self, args):
        """Deprecated alias for the get_query tool.

        The old tool returned the statement under ``cypher``; get_query returns it
        under ``query``. Mirror it so agents reading ``result['cypher']`` still work.
        """
        out = self.get_query(args)
        if isinstance(out, dict) and 'query' in out:
            out = {**out, 'cypher': out['query']}
        return out
