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

"""FalkorDB graph node instance.

Inherits the graph tool surface (``get_data``, ``get_schema``, ``get_query``,
``execute``, ``dialect``) and the questions lane from ``GraphInstanceBase``.

Adds the two tools specific to FalkorDB, which hosts many graphs on one server:
``query`` (parameterised read-only Cypher against any graph) and ``list_graphs``.
"""

from __future__ import annotations

from redis.exceptions import RedisError

from rocketlib import tool_function

from ai.common.graph import GraphInstanceBase
from ai.common.utils import normalize_tool_input

from .IGlobal import IGlobal, _header_names, _serialize_value


class IInstance(GraphInstanceBase):
    IGlobal: IGlobal

    def _db_display_name(self) -> str:
        return 'FalkorDB'

    def _db_dialect(self) -> str:
        return 'falkordb'

    # ------------------------------------------------------------------
    # FalkorDB-specific tools
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['cypher'],
            'properties': {
                'cypher': {
                    'type': 'string',
                    'description': 'Cypher query to execute. Use $name placeholders with "params" for values — never inline user data into the query string.',
                },
                'params': {
                    'type': 'object',
                    'description': 'Parameter values referenced as $name in the query (injection-safe).',
                },
                'graph': {
                    'type': 'string',
                    'description': 'Graph to query; defaults to the graph configured on the node.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'columns': {'type': 'array', 'items': {'type': 'string'}},
                'rows': {
                    'type': 'array',
                    'items': {'type': 'array'},
                    'description': 'Result rows; nodes/edges are serialized to objects.',
                },
                'row_count': {'type': 'integer'},
                'truncated': {'type': 'boolean', 'description': 'True if rows were cut at the configured cap.'},
                'stats': {
                    'type': 'object',
                    'description': 'Write counters (only when writes are enabled and occurred).',
                },
                'error': {'type': 'string', 'description': 'Error message if the query failed.'},
            },
        },
        description=lambda self: (
            f'Run a Cypher query you have already written against the FalkorDB graph database '
            f'(default graph: "{self.IGlobal.graph_name}"). To query by describing what you want in plain '
            f'language instead, use get_data. '
            + (
                'Reads AND writes (CREATE/MERGE/SET/DELETE) are allowed.'
                if self.IGlobal.allow_writes
                else 'Read-only: write clauses (CREATE/MERGE/SET/DELETE) are rejected by the server.'
            )
            + f' At most {self.IGlobal.max_rows} rows are returned.'
        ),
    )
    def query(self, args):
        """Run caller-supplied Cypher against the selected graph."""
        args = normalize_tool_input(args, tool_name='falkordb')
        cypher = args.get('cypher')
        if not cypher or not isinstance(cypher, str) or not cypher.strip():
            raise ValueError('"cypher" is required and must be a non-empty string')
        params = args.get('params')
        if params is not None and not isinstance(params, dict):
            raise ValueError('"params" must be an object when provided')

        try:
            graph = self.IGlobal.select_graph(args.get('graph'))
            # Writes go through GRAPH.QUERY only when the node owner enabled them;
            # otherwise GRAPH.RO_QUERY makes the server reject them.
            run = graph.query if self.IGlobal.allow_writes else graph.ro_query
            result = run(cypher, params=params or None, timeout=self.IGlobal.query_timeout_ms)
        except RedisError as e:
            return {'error': str(e), 'columns': [], 'rows': [], 'row_count': 0, 'truncated': False}

        cap = self.IGlobal.max_rows
        raw_rows = result.result_set or []
        rows = [[_serialize_value(cell) for cell in row] for row in raw_rows[:cap]]

        out = {
            'columns': _header_names(getattr(result, 'header', None)),
            'rows': rows,
            'row_count': len(rows),
            'truncated': len(raw_rows) > cap,
        }
        if self.IGlobal.allow_writes:
            stats = _write_stats(result)
            if stats:
                out['stats'] = stats
        return out

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema={
            'type': 'object',
            'properties': {
                'graphs': {'type': 'array', 'items': {'type': 'string'}},
                'error': {'type': 'string', 'description': 'Error message if the call failed.'},
            },
        },
        description='List the graph names that exist in this FalkorDB instance.',
    )
    def list_graphs(self, args):
        """List graphs on the server."""
        try:
            return {'graphs': self.IGlobal.list_graphs()}
        except RedisError as e:
            return {'error': str(e), 'graphs': []}


def _write_stats(result) -> dict:
    """Collect non-zero write counters from a QueryResult."""
    stats = {}
    for attr in (
        'nodes_created',
        'nodes_deleted',
        'relationships_created',
        'relationships_deleted',
        'properties_set',
        'properties_removed',
        'labels_added',
        'indices_created',
    ):
        try:
            value = getattr(result, attr, 0) or 0
        except (RedisError, ValueError, TypeError):
            value = 0
        if value:
            stats[attr] = value
    return stats
