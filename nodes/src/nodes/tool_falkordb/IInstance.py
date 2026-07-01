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

"""
FalkorDB tool node instance.

Exposes ``query`` (run Cypher against a graph), ``list_graphs`` and
``get_schema`` as agent tools. Queries run read-only via GRAPH.RO_QUERY
(write rejection enforced server-side) unless writes are enabled in config.
"""

from __future__ import annotations

import datetime

from redis.exceptions import RedisError

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input

from .IGlobal import IGlobal


def _serialize_value(value):
    """Convert FalkorDB result cells (Node/Edge/Path/temporals) to plain JSON-safe data."""
    # Graph entities are duck-typed: falkordb.Node has labels+properties,
    # Edge has relation+src_node/dest_node, Path has nodes()/edges().
    if hasattr(value, 'labels') and hasattr(value, 'properties'):
        return {
            'id': getattr(value, 'id', None),
            'labels': list(value.labels or []),
            'properties': _serialize_value(value.properties),
        }
    if hasattr(value, 'relation') and hasattr(value, 'properties'):
        return {
            'id': getattr(value, 'id', None),
            'type': value.relation,
            'src': getattr(value, 'src_node', None),
            'dst': getattr(value, 'dest_node', None),
            'properties': _serialize_value(value.properties),
        }
    if hasattr(value, 'nodes') and hasattr(value, 'edges') and callable(getattr(value, 'nodes', None)):
        return {
            'nodes': [_serialize_value(n) for n in value.nodes()],
            'edges': [_serialize_value(e) for e in value.edges()],
        }
    if isinstance(value, dict):
        return {str(k): _serialize_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_serialize_value(v) for v in value]
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _header_names(header) -> list:
    """Extract column names from a QueryResult header ([type, name] pairs or strings)."""
    names = []
    for entry in header or []:
        if isinstance(entry, (list, tuple)) and len(entry) >= 2:
            names.append(str(entry[1]))
        else:
            names.append(str(entry))
    return names


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


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def _select_graph(self, args):
        """Resolve the target graph from args or config default."""
        graph_name = args.get('graph')
        if graph_name is not None and (not isinstance(graph_name, str) or not graph_name.strip()):
            raise ValueError('"graph" must be a non-empty string when provided')
        graph_name = (graph_name or self.IGlobal.graph_name).strip()
        return self.IGlobal.client.select_graph(graph_name), graph_name

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
            f'Run a Cypher query against the FalkorDB graph database '
            f'(default graph: "{self.IGlobal.graph_name}"). '
            + (
                'Reads AND writes (CREATE/MERGE/SET/DELETE) are allowed.'
                if self.IGlobal.allow_writes
                else 'Read-only: write clauses (CREATE/MERGE/SET/DELETE) are rejected by the server.'
            )
            + f' At most {self.IGlobal.max_rows} rows are returned.'
        ),
    )
    def query(self, args):
        """Run Cypher against the selected graph."""
        args = normalize_tool_input(args, tool_name='falkordb')
        cypher = args.get('cypher')
        if not cypher or not isinstance(cypher, str) or not cypher.strip():
            raise ValueError('"cypher" is required and must be a non-empty string')
        params = args.get('params')
        if params is not None and not isinstance(params, dict):
            raise ValueError('"params" must be an object when provided')

        try:
            graph, _ = self._select_graph(args)
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
            graphs = self.IGlobal.client.list_graphs()
        except RedisError as e:
            return {'error': str(e), 'graphs': []}
        return {'graphs': [str(g) for g in graphs or []]}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'graph': {
                    'type': 'string',
                    'description': 'Graph to inspect; defaults to the graph configured on the node.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'labels': {'type': 'array', 'items': {'type': 'string'}},
                'relationship_types': {'type': 'array', 'items': {'type': 'string'}},
                'property_keys': {'type': 'array', 'items': {'type': 'string'}},
                'error': {'type': 'string', 'description': 'Error message if the call failed.'},
            },
        },
        description=(
            'Return the graph schema: node labels, relationship types and property keys. '
            'Use when a query returns unexpected results or you need to discover the data model.'
        ),
    )
    def get_schema(self, args):
        """Return labels, relationship types and property keys of a graph."""
        args = normalize_tool_input(args, tool_name='falkordb')

        def _column(graph, procedure: str) -> list:
            result = graph.ro_query(f'CALL {procedure}()', timeout=self.IGlobal.query_timeout_ms)
            return [str(row[0]) for row in (result.result_set or [])]

        try:
            graph, _ = self._select_graph(args)
            return {
                'labels': _column(graph, 'db.labels'),
                'relationship_types': _column(graph, 'db.relationshipTypes'),
                'property_keys': _column(graph, 'db.propertyKeys'),
            }
        except RedisError as e:
            return {'error': str(e), 'labels': [], 'relationship_types': [], 'property_keys': []}
