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
import math
import re

from abc import ABC, abstractmethod
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from rocketlib import IInstanceBase, error, tool_function, warning
from rocketlib.types import IInvokeLLM

from ai.common.schema import Answer, Question, QuestionType
from ai.common.table import Table
from ai.common.utils import normalize_tool_input, parse_bool, require_str

from .cypher_safety import check_read_query_statement, is_cypher_safe
from .graph_errors import GraphToolError, driver_detail
from .graph_global_base import DEFAULT_MAX_EXECUTE_ROWS, DEFAULT_READ_QUERY_LIMIT, GraphGlobalBase
from .normalize import DEFAULT_ELEMENT_LIMIT, DEFAULT_VALUE_LIMIT, GraphBudgetExceeded, GraphNormalizer
from .schema import empty_block

DEFAULT_ROW_LIMIT = 250

MAX_CYPHER_LENGTH = 100_000
MAX_PARAM_DEPTH = 32
MAX_PARAM_VALUES = 10_000
INT64_MIN, INT64_MAX = -(2**63), 2**63 - 1
_PARAM_NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
_READ_QUERY_FIELDS = frozenset({'cypher', 'params', 'limit'})
_EXECUTE_SHAPES = ('legacy', 'graph')

# Shared by read_query and execute(shape='graph').
GRAPH_RESULT_SCHEMA = {
    'type': 'object',
    'properties': {
        'columns': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Column names, in order; may repeat.'},
        'rows': {
            'type': 'array',
            'items': {'type': 'array'},
            'description': 'Positional rows. Nodes, relationships, paths, temporals, points, large numbers and '
            'bytes are tagged objects with an "@kind" key; user map keys starting with "@" carry one extra "@".',
        },
        'row_limit': {'type': 'integer', 'description': 'The row limit actually applied.'},
        'truncated': {'type': 'boolean'},
        'truncated_by': {'type': ['string', 'null'], 'enum': [None, 'rows', 'elements', 'values']},
        'element_limit': {'type': 'integer'},
        'elements': {'type': 'integer', 'description': 'Graph elements (nodes + relationships) in this response.'},
        'value_limit': {'type': 'integer'},
        'values': {'type': 'integer', 'description': 'JSON values (scalars, containers, tags) in this response.'},
    },
}

# The schema v2 block get_schema and refresh_schema return under 'schema'.
SCHEMA_V2_PROPERTY = {
    'type': 'object',
    'description': 'Schema v2: labels and relationship types with all observed property types, '
    'endpoints, counts, sampled/truncated flags, refreshed_at, and stale/error after a failed refresh.',
}


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
                'schema': SCHEMA_V2_PROPERTY,
            },
        },
        description=lambda self: (
            f'Returns the {self._db_display_name()} graph schema: node labels with their properties, and the '
            f'relationship types connecting them. Do NOT call this preemptively -- only when get_data fails '
            f'or returns unexpected results.'
        ),
    )
    def get_schema(self, args):
        """Return the reflected graph schema (legacy keys plus the v2 ``schema`` block)."""
        schema = self.IGlobal.graph_schema or {}
        nodes = schema.get('nodes', {})
        return {
            'labels': list(nodes.keys()),
            'nodes': {label: [{'property': p, 'type': t} for p, t in props] for label, props in nodes.items()},
            'relationships': schema.get('relationships', []),
            'schema': self._schema_block(),
        }

    def _schema_block(self) -> Dict[str, Any]:
        block = self.IGlobal.schema_snapshot
        if block is None:
            block = empty_block(source='startup', error='The schema has not been reflected yet')
        return block

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema={
            'type': 'object',
            'properties': {
                'labels': {'type': 'array', 'items': {'type': 'string'}},
                'nodes': {'type': 'object'},
                'relationships': {'type': 'array', 'items': {'type': 'object'}},
                'schema': SCHEMA_V2_PROPERTY,
            },
        },
        description=lambda self: (
            f'Re-read the {self._db_display_name()} graph schema now (bounded and sampled) and return it like '
            f'get_schema. If the refresh fails, the previous schema is kept and marked stale with the error.'
        ),
    )
    def refresh_schema(self, args):
        """Reflect the schema again, publish it all-or-nothing, and return it."""
        args = normalize_tool_input(args, tool_name='refresh_schema')
        if args:
            raise GraphToolError(
                f'Invalid refresh_schema input: unexpected field(s) {", ".join(map(repr, sorted(args)))}'
            )
        self.IGlobal.refresh_schema_snapshot(source='refresh')
        return self.get_schema({})

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
        input_schema=lambda self: self._execute_input_schema(),
        output_schema={
            'type': 'object',
            'properties': {
                # columns, row_limit, truncated, ... come with shape "graph" only.
                **GRAPH_RESULT_SCHEMA['properties'],
                'rows': {
                    'type': 'array',
                    'items': {'type': ['object', 'array']},
                    'description': 'Shape "legacy" (the default): one object per row, keyed by column name. '
                    'Shape "graph": positional rows as read_query returns them, with the other read_query '
                    'fields (columns, row_limit, truncated, ...).',
                },
                'affected_rows': {
                    'type': 'integer',
                    'description': 'Both shapes. The summed write counters on Neo4j and FalkorDB; the number of '
                    'result rows on Apache AGE, which reports no write counters.',
                },
                'truncated': {
                    'type': 'boolean',
                    'description': (
                        'Shape "graph": the result was cut, see truncated_by. Shape "legacy": present and true when '
                        'a write returned more rows than the row cap on an engine that cannot roll back: the write '
                        'is saved and only the first rows are returned.'
                    ),
                },
            },
        },
        description=lambda self: (
            f'Execute a raw {self._query_language()} statement against this {self._db_display_name()} graph. '
            f'Bypasses LLM translation and the read-only gate, so writes are possible. '
            f'Disabled unless the node owner enables allow_execute.'
        ),
    )
    def execute(self, args):
        """Execute a raw statement, bypassing translation and the read-only gate.

        Args:
            args (dict): ``query`` (str) — the raw statement; ``sql`` is accepted
                in its place, which is the key ``client.database.query`` sends.
                ``params`` (dict, optional) — values for ``$name`` placeholders.
                ``shape`` (str, optional) — ``'legacy'`` (the default) or
                ``'graph'`` for the read_query envelope.

        Returns:
            dict: ``{'rows': [...], 'affected_rows': int}``, plus ``'truncated': True`` when
            the driver reports a saved write whose result passed the row cap; with shape
            ``'graph'``, the read_query envelope plus ``affected_rows``.

        Raises:
            ValueError: execute is disabled, the statement is missing,
                ``params`` is not an object / not supported by this driver, or
                the call carries a ``session_id`` / ``row_mode`` other than
                ``'object'`` (graph nodes have neither).
        """
        args = normalize_tool_input(args, tool_name='execute')
        # A disabled node reports that first, whatever the arguments are.
        if not self.IGlobal.allow_execute:
            raise ValueError('execute tool is disabled for this node (set allow_execute=true)')

        key = 'sql' if 'query' not in args and 'sql' in args else 'query'
        query = require_str(args, key, tool_name='execute')
        shape = args.get('shape', 'legacy')
        if shape is None:
            shape = 'legacy'
        if shape not in _EXECUTE_SHAPES:
            raise ValueError(f'execute: "shape" must be one of {", ".join(_EXECUTE_SHAPES)} (got {shape!r})')
        params = self._execute_params(args.get('params'))
        # client.database.query also forwards these SQL-node options; refuse
        # them rather than run outside the transaction or in another row shape.
        if args.get('session_id'):
            raise ValueError('execute: graph nodes have no transactions, so "session_id" is not supported')
        if (args.get('row_mode') or 'object') != 'object':
            raise ValueError('execute: graph nodes return row objects, so "row_mode" must be \'object\'')

        if shape == 'graph':
            # Never retried: a write may already have happened.
            row_limit = self.IGlobal.execute_graph_cap

            def consume(columns, rows):
                return self._graph_envelope(columns, rows, row_limit)

            try:
                if params:
                    envelope, affected = self.IGlobal._raw_query_rows(query, row_limit + 1, consume, params=params)
                else:
                    envelope, affected = self.IGlobal._raw_query_rows(query, row_limit + 1, consume)
            except GraphToolError:
                raise
            except NotImplementedError as e:
                raise GraphToolError('execute with shape "graph" is not available on this node', str(e)) from e
            except Exception as e:
                raise self._graph_error(e) from e
            return {**envelope, 'affected_rows': int(affected or 0)}

        if params:
            result = self.IGlobal._run_query_raw(query, params=params)
        else:
            result = self.IGlobal._run_query_raw(query)
        out = {
            'rows': [self._sanitize_row(row) for row in result.get('rows', [])],
            'affected_rows': result.get('affected_rows', 0),
        }
        if result.get('truncated'):
            out['truncated'] = True
        return out

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['cypher'],
            'additionalProperties': False,
            'properties': {
                'cypher': {
                    'type': 'string',
                    'description': 'One read-only Cypher statement. Put values in params as $name; never splice them '
                    'into the text.',
                },
                'params': {
                    'type': 'object',
                    'description': 'Values for $name placeholders (null, boolean, number, string, list, map). '
                    'Graph ids are strings: elementId(n) = $id on Neo4j, id(n) = toInteger($id) elsewhere.',
                },
                'limit': {
                    'type': 'integer',
                    'minimum': 1,
                    'description': f'Maximum rows to return (default {DEFAULT_READ_QUERY_LIMIT}; capped by the node).',
                },
            },
        },
        output_schema=GRAPH_RESULT_SCHEMA,
        description=lambda self: (
            f'Run a read-only {self._query_language()} statement you wrote against the {self._db_display_name()} '
            f'graph and return positional rows with nodes, relationships and paths in one documented shape. '
            f'Read-only whatever the node allows elsewhere; writes are refused.'
        ),
    )
    def read_query(self, args):
        """Run caller-written Cypher read-only and return the graph result envelope."""
        cypher, params, limit = self._read_query_args(args)
        # read_query's statement rule, the same for every engine, ahead of the
        # driver's own read boundary.
        check_read_query_statement(cypher)
        row_limit = min(limit, self.IGlobal.read_query_cap)

        def consume(columns, rows):
            return self._graph_envelope(columns, rows, row_limit)

        try:
            return self.IGlobal._read_query_rows(cypher, params, row_limit + 1, consume)
        except GraphToolError:
            raise
        except NotImplementedError as e:
            raise GraphToolError('read_query is not available on this node', str(e)) from e
        except Exception as e:
            raise self._graph_error(e) from e

    # ------------------------------------------------------------------
    # read_query helpers (also used by execute shape='graph')
    # ------------------------------------------------------------------

    def _read_query_args(self, args) -> Tuple[str, Optional[Dict[str, Any]], int]:
        """Validate read_query input at runtime: the transport does not enforce schemas."""
        if args is not None and not isinstance(args, (dict, str)) and not hasattr(args, 'model_dump'):
            raise GraphToolError(f'Invalid read_query input: expected an object, got {type(args).__name__}')
        args = normalize_tool_input(args, tool_name='read_query')
        unknown = sorted(set(args) - _READ_QUERY_FIELDS)
        if unknown:
            raise GraphToolError(f'Invalid read_query input: unknown field(s) {", ".join(map(repr, unknown))}')

        cypher = args.get('cypher')
        if not isinstance(cypher, str) or not cypher.strip():
            raise GraphToolError('Invalid read_query input: "cypher" must be a non-empty string')
        if len(cypher) > MAX_CYPHER_LENGTH:
            raise GraphToolError(
                f'Invalid read_query input: "cypher" is {len(cypher):,} characters (limit {MAX_CYPHER_LENGTH:,})'
            )

        params = args.get('params')
        if params is not None:
            if not isinstance(params, dict):
                raise GraphToolError(
                    f'Invalid read_query input: "params" must be an object, got {type(params).__name__}'
                )
            for name in params:
                if not isinstance(name, str) or not _PARAM_NAME.fullmatch(name):
                    raise GraphToolError(
                        f'Invalid read_query input: parameter name {name!r} must match [A-Za-z_][A-Za-z0-9_]*'
                    )
            self._check_param_value(params, 'params', 0, [0])
            params = params or None

        limit = args.get('limit')
        if limit is None:
            limit = DEFAULT_READ_QUERY_LIMIT
        elif isinstance(limit, bool) or not isinstance(limit, int):
            raise GraphToolError(f'Invalid read_query input: "limit" must be an integer >= 1 (got {limit!r})')
        elif limit < 1:
            raise GraphToolError(f'Invalid read_query input: "limit" must be an integer >= 1 (got {limit})')
        return cypher, params, limit

    @classmethod
    def _check_param_value(cls, value: Any, where: str, depth: int, count: List[int]) -> None:
        count[0] += 1
        if count[0] > MAX_PARAM_VALUES:
            raise GraphToolError(f'Invalid read_query input: params hold more than {MAX_PARAM_VALUES:,} values')
        if depth > MAX_PARAM_DEPTH:
            raise GraphToolError(f'Invalid read_query input: {where} is nested more than {MAX_PARAM_DEPTH} levels')
        if value is None or isinstance(value, (bool, str)):
            return
        if isinstance(value, int):
            if not INT64_MIN <= value <= INT64_MAX:
                raise GraphToolError(f'Invalid read_query input: {where} is outside the 64-bit integer range')
            return
        if isinstance(value, float):
            if not math.isfinite(value):
                raise GraphToolError(f'Invalid read_query input: {where} is not a finite number')
            return
        if isinstance(value, list):
            for i, item in enumerate(value):
                cls._check_param_value(item, f'{where}[{i}]', depth + 1, count)
            return
        if isinstance(value, dict):
            for key, item in value.items():
                if not isinstance(key, str):
                    raise GraphToolError(f'Invalid read_query input: {where} has a non-string key')
                if '`' in key:
                    raise GraphToolError(f'Invalid read_query input: map key {key!r} in {where} contains a back-quote')
                cls._check_param_value(item, f'{where}.{key}', depth + 1, count)
            return
        raise GraphToolError(f'Invalid read_query input: {where} has unsupported type {type(value).__name__}')

    def _graph_envelope(self, columns: List[str], rows: Iterable[Sequence[Any]], row_limit: int) -> Dict[str, Any]:
        """Normalize positional driver rows into the read_query envelope, enforcing budgets.

        ``rows`` should yield at most ``row_limit + 1`` rows: one extra row
        tells a full page apart from a truncated one. A row that would push the
        response past its element or value budget is dropped whole (the
        response stays consistent) and truncation is reported; if the very
        first row alone is over a budget, the query is refused instead.
        """
        normalizer = GraphNormalizer(
            self.IGlobal._graph_adapter(), element_limit=DEFAULT_ELEMENT_LIMIT, value_limit=DEFAULT_VALUE_LIMIT
        )
        out: List[List[Any]] = []
        truncated_by: Optional[str] = None
        for raw in rows:
            if len(out) >= row_limit:
                truncated_by = 'rows'
                break
            mark = normalizer.checkpoint()
            try:
                out.append(normalizer.row(list(raw)))
            except GraphBudgetExceeded as e:
                normalizer.rollback(mark)
                if not out:
                    what = 'graph elements' if e.kind == 'elements' else 'values'
                    raise GraphToolError(
                        f'Refused: the first row holds more than {e.limit:,} {what}',
                        'Narrow the query, for example with LIMIT before collect() or a smaller variable-length range.',
                    ) from None
                truncated_by = e.kind
                break
            except ValueError as e:
                raise GraphToolError('Query result cannot be represented', str(e)) from e
        return {
            'columns': [str(c) for c in columns],
            'rows': out,
            'row_limit': row_limit,
            'truncated': truncated_by is not None,
            'truncated_by': truncated_by,
            'element_limit': normalizer.element_limit,
            'elements': normalizer.elements,
            'value_limit': normalizer.value_limit,
            'values': normalizer.values,
        }

    def _graph_error(self, exc: BaseException) -> GraphToolError:
        """Shared formatter: driver exception -> "<headline>\n<detail>"."""
        described = None
        try:
            described = self.IGlobal._describe_error(exc)
        except Exception:
            described = None
        if described:
            headline, detail = described
            return GraphToolError(headline, detail)
        return GraphToolError('Query failed', driver_detail(exc))

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema={
            'type': 'object',
            'properties': {
                'dialect': {'type': 'string', 'description': 'Graph engine identifier.'},
                'engine': {'type': 'object', 'description': '{name, version, edition}'},
                'database': {'type': ['string', 'null']},
                'graph': {'type': ['string', 'null']},
                'allow_execute': {'type': 'boolean'},
                'capabilities': {'type': 'object'},
                'limits': {'type': 'object'},
                'read_boundary': {'type': 'string'},
                'read_boundary_verified': {'type': 'boolean'},
            },
        },
        description='Return the graph engine dialect, version, database/graph, capabilities and limits.',
    )
    def dialect(self, args):
        """Return the engine identity, capabilities and limits (no credentials or hosts)."""
        identity = self.IGlobal._engine_identity()
        glb = self.IGlobal
        max_rows = glb.read_query_cap
        return {
            'dialect': self._db_dialect(),
            'engine': identity.get('engine') or {'name': self._db_display_name(), 'version': None, 'edition': None},
            'database': identity.get('database'),
            'graph': identity.get('graph'),
            'allow_execute': bool(getattr(glb, 'allow_execute', False)),
            'capabilities': {
                'read_query': True,
                'refresh_schema': True,
                'execute_shape_graph': True,
                'params': True,
                'shortest_path': bool(identity.get('shortest_path', True)),
            },
            'limits': {
                # What read_query returns when the caller sends no limit.
                'default_rows': min(DEFAULT_READ_QUERY_LIMIT, max_rows),
                'max_rows': max_rows,
                'max_elements': DEFAULT_ELEMENT_LIMIT,
                'max_values': DEFAULT_VALUE_LIMIT,
                'statement_timeout_ms': glb.statement_timeout_ms,
                'server_result_cap': identity.get('server_result_cap'),
            },
            'read_boundary': identity.get('read_boundary', 'read_only_tx'),
            'read_boundary_verified': bool(identity.get('read_boundary_verified', False)),
        }

    # ------------------------------------------------------------------
    # Sanitization helpers
    # ------------------------------------------------------------------

    def _execute_input_schema(self) -> Dict[str, Any]:
        """Input schema of the execute tool for this driver.

        Returns:
            Dict[str, Any]: JSON schema; ``params`` is listed only when the
            driver sets ``supports_execute_params``, so agents are not offered
            an argument the node would refuse.
        """
        properties: Dict[str, Any] = {'query': {'type': 'string', 'description': 'Raw query to execute.'}}
        if getattr(getattr(self, 'IGlobal', None), 'supports_execute_params', False):
            properties['params'] = {
                'type': 'object',
                'description': (
                    'Values for $name placeholders in the query, keyed by name '
                    '(e.g. {"rows": [...]} for UNWIND $rows). Values are bound, not '
                    'pasted into the query text, so they need no escaping and do not '
                    'count toward the query length limit.'
                ),
            }
        properties['shape'] = {
            'type': 'string',
            'enum': list(_EXECUTE_SHAPES),
            'description': 'Result shape: "legacy" (default, rows as objects) or "graph" (the read_query '
            'envelope plus affected_rows).',
        }
        return {'type': 'object', 'required': ['query'], 'properties': properties}

    def _execute_params(self, raw: Any) -> Optional[Dict[str, Any]]:
        """Validate the execute tool's ``params``; None when there are none.

        Args:
            raw (Any): The ``params`` value from the tool input.

        Returns:
            Optional[Dict[str, Any]]: The bound values, or None for a missing
            or empty value (an empty list included — the SQL-shaped SDK call
            may send one).

        Raises:
            ValueError: ``params`` is not an object, or the driver cannot bind them.
        """
        if raw is None or (isinstance(raw, (dict, list)) and not raw):
            return None
        if not isinstance(raw, dict):
            raise ValueError(
                'execute: "params" must be an object keyed by placeholder name, e.g. '
                '{"rows": [...]} for $rows; positional lists are not supported for graph queries'
            )
        if not self.IGlobal.supports_execute_params:
            raise ValueError(f'execute: "params" is not supported by the {self._db_display_name()} node')
        return raw

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

        engine_rules = self.IGlobal._prompt_rules()
        if engine_rules:
            question.addInstruction('Target engine', '\n'.join(engine_rules))

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
            notice = ''
            if result.get('truncated'):
                # No '|' in it, so Table.parse_markdown_table skips it as a non-table line.
                notice = f'\n\nThe statement is saved, but its result was cut to the first {len(rows)} rows.'

            if 'text' in lanes:
                self.instance.writeText((markdown if markdown else f'{affected} rows affected') + notice)

            if 'table' in lanes and rows:
                self.instance.writeTable(markdown + notice)

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
