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
InsForge tool node instance.

Exposes an InsForge project's REST surface as agent tools: PostgREST-style
record CRUD, RPC calls, and storage listing / download / delete.

Read tools are always available. Every tool that mutates data is gated behind
the node's ``allow_writes`` switch, which is off by default, so binding this
node to an agent cannot change the backend unless an operator opted in.
"""

from __future__ import annotations

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input, require_dict, require_str

from .insforge_client import (
    DEFAULT_LIMIT,
    FILTER_OPERATORS,
    MAX_LIMIT,
    call,
    clamp_limit,
    encode_filters,
    require_identifier,
    require_object_key,
    rows_envelope,
)
from .IGlobal import IGlobal

_FILTERS_DESC = (
    'Filters as an object mapping column -> "operator.value", PostgREST style. '
    f'Operators: {", ".join(sorted(FILTER_OPERATORS))}. '
    'Example: {"status": "eq.active", "views": "gte.100"}. '
    'For "in", comma-separate inside parentheses: {"id": "in.(1,2,3)"}. '
    'For null tests use {"deleted_at": "is.null"}.'
)

_SELECT_DESC = 'Comma-separated columns to return, e.g. "id,title,created_at". Omit for all columns.'

_ORDER_DESC = 'Sort as "column.direction", e.g. "created_at.desc". Omit for the table default.'

_TABLE_DESC = 'Table name, e.g. "posts".'


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def _base(self) -> str:
        return self.IGlobal.base_url

    def _token(self) -> str:
        return self.IGlobal.token

    def _require_writes(self, operation: str) -> None:
        """Block a mutating tool unless the operator enabled writes.

        Raises:
            ValueError: If writes are disabled, with a message telling the agent
                this is a configuration limit rather than something to retry.
        """
        if not self.IGlobal.allow_writes:
            raise ValueError(
                f'{operation} is disabled: this InsForge node is read-only. '
                f'An operator must enable "Allow writes" in the node configuration. '
                f'Do not retry.'
            )

    def _records_path(self, table: str) -> str:
        return f'/api/database/records/{require_identifier(table, kind="table")}'

    @staticmethod
    def _require_filters(args: dict, *, operation: str) -> dict:
        """Encode filters and refuse to run an unfiltered update or delete.

        Raises:
            ValueError: If no filter was supplied. PostgREST applies an empty
                filter set to every row, so an omitted filter would rewrite or
                empty the whole table.
        """
        params = encode_filters(args.get('filters'))
        if not params:
            raise ValueError(
                f'{operation} requires at least one filter — without one it would affect every row in the table.'
            )
        return params

    # =======================================================================
    # DATABASE - READ
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'table': {'type': 'string', 'description': _TABLE_DESC},
                'filters': {'type': 'object', 'description': _FILTERS_DESC},
                'select': {'type': 'string', 'description': _SELECT_DESC},
                'order': {'type': 'string', 'description': _ORDER_DESC},
                'limit': {
                    'type': 'integer',
                    'description': f'Maximum rows to return (default 100, max {MAX_LIMIT}).',
                },
                'offset': {'type': 'integer', 'description': 'Rows to skip, for paging through a large result.'},
            },
            'required': ['table'],
        },
        description=(
            'Query rows from a table in the InsForge project. Returns {count, rows, query}. '
            'Start here to inspect data; use filters to narrow the result rather than pulling whole tables.'
        ),
    )
    def records_select(self, args):
        args = normalize_tool_input(args, tool_name='tool_insforge')
        table = require_str(args, 'table', tool_name='tool_insforge')

        params = encode_filters(args.get('filters'))
        params['limit'] = clamp_limit(args.get('limit'))
        if args.get('select'):
            params['select'] = str(args['select']).strip()
        if args.get('order'):
            params['order'] = str(args['order']).strip()
        if args.get('offset'):
            params['offset'] = int(args['offset'])

        rows = call(self._token(), self._base(), 'GET', self._records_path(table), params=params)
        return rows_envelope(rows, query={'table': table, **params})

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'function': {'type': 'string', 'description': 'Name of the database function to call.'},
                'args': {'type': 'object', 'description': 'Arguments passed to the function as a JSON object.'},
            },
            'required': ['function'],
        },
        description=(
            'Call a Postgres function (RPC) exposed by the InsForge project and return its result. '
            'Use for logic the project already implements server-side rather than reassembling it from queries.'
        ),
    )
    def rpc_call(self, args):
        args = normalize_tool_input(args, tool_name='tool_insforge')
        function = require_identifier(
            require_str(args, 'function', tool_name='tool_insforge'),
            kind='function',
        )

        payload = args.get('args') or {}
        if not isinstance(payload, dict):
            raise ValueError('args must be an object mapping parameter name -> value.')

        # An RPC can mutate, and nothing in the name reveals whether it does,
        # so it is gated with the other write tools.
        self._require_writes('rpc_call')

        result = call(self._token(), self._base(), 'POST', f'/api/database/rpc/{function}', json=payload)
        return {'function': function, 'result': result}

    # =======================================================================
    # DATABASE - WRITE
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'table': {'type': 'string', 'description': _TABLE_DESC},
                'records': {
                    'type': 'array',
                    'items': {'type': 'object'},
                    'description': 'Rows to insert, each an object of column -> value.',
                },
            },
            'required': ['table', 'records'],
        },
        description=(
            'Insert one or more rows into a table and return the inserted rows. '
            'Requires the node to have writes enabled.'
        ),
    )
    def records_insert(self, args):
        args = normalize_tool_input(args, tool_name='tool_insforge')
        self._require_writes('records_insert')

        table = require_str(args, 'table', tool_name='tool_insforge')
        records = args.get('records')
        if not isinstance(records, list) or not records:
            raise ValueError('records must be a non-empty array of objects.')
        for row in records:
            require_dict(row, tool_name='tool_insforge')

        rows = call(
            self._token(),
            self._base(),
            'POST',
            self._records_path(table),
            json=records,
            extra_headers={'Prefer': 'return=representation', 'Content-Type': 'application/json'},
        )
        return rows_envelope(rows, query={'table': table, 'operation': 'insert'})

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'table': {'type': 'string', 'description': _TABLE_DESC},
                'records': {
                    'type': 'array',
                    'items': {'type': 'object'},
                    'description': 'Rows to insert or merge, each including the conflict key.',
                },
                'on_conflict': {
                    'type': 'string',
                    'description': 'Comma-separated columns forming the unique key to merge on, e.g. "email".',
                },
            },
            'required': ['table', 'records'],
        },
        description=(
            'Insert rows, merging into any that already exist on the conflict key, and return the result. '
            'Requires the node to have writes enabled.'
        ),
    )
    def records_upsert(self, args):
        args = normalize_tool_input(args, tool_name='tool_insforge')
        self._require_writes('records_upsert')

        table = require_str(args, 'table', tool_name='tool_insforge')
        records = args.get('records')
        if not isinstance(records, list) or not records:
            raise ValueError('records must be a non-empty array of objects.')
        for row in records:
            require_dict(row, tool_name='tool_insforge')

        params = {}
        if args.get('on_conflict'):
            params['on_conflict'] = str(args['on_conflict']).strip()

        rows = call(
            self._token(),
            self._base(),
            'POST',
            self._records_path(table),
            params=params,
            json=records,
            extra_headers={
                'Prefer': 'resolution=merge-duplicates,return=representation',
                'Content-Type': 'application/json',
            },
        )
        return rows_envelope(rows, query={'table': table, 'operation': 'upsert', **params})

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'table': {'type': 'string', 'description': _TABLE_DESC},
                'values': {'type': 'object', 'description': 'Columns to set, as an object of column -> new value.'},
                'filters': {'type': 'object', 'description': _FILTERS_DESC},
            },
            'required': ['table', 'values', 'filters'],
        },
        description=(
            'Update the rows matching the filters and return them. At least one filter is required. '
            'Requires the node to have writes enabled.'
        ),
    )
    def records_update(self, args):
        args = normalize_tool_input(args, tool_name='tool_insforge')
        self._require_writes('records_update')

        table = require_str(args, 'table', tool_name='tool_insforge')
        values = require_dict(args.get('values'), tool_name='tool_insforge')
        if not values:
            raise ValueError('values must contain at least one column to set.')

        params = self._require_filters(args, operation='records_update')

        rows = call(
            self._token(),
            self._base(),
            'PATCH',
            self._records_path(table),
            params=params,
            json=values,
            extra_headers={'Prefer': 'return=representation', 'Content-Type': 'application/json'},
        )
        return rows_envelope(rows, query={'table': table, 'operation': 'update', **params})

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'table': {'type': 'string', 'description': _TABLE_DESC},
                'filters': {'type': 'object', 'description': _FILTERS_DESC},
            },
            'required': ['table', 'filters'],
        },
        description=(
            'Delete the rows matching the filters and return them. At least one filter is required. '
            'Requires the node to have writes enabled.'
        ),
    )
    def records_delete(self, args):
        args = normalize_tool_input(args, tool_name='tool_insforge')
        self._require_writes('records_delete')

        table = require_str(args, 'table', tool_name='tool_insforge')
        params = self._require_filters(args, operation='records_delete')

        rows = call(
            self._token(),
            self._base(),
            'DELETE',
            self._records_path(table),
            params=params,
            extra_headers={'Prefer': 'return=representation'},
        )
        return rows_envelope(rows, query={'table': table, 'operation': 'delete', **params})

    # =======================================================================
    # STORAGE
    # =======================================================================

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description='List the storage buckets in the InsForge project.',
    )
    def storage_list_buckets(self, args):
        normalize_tool_input(args, tool_name='tool_insforge')
        buckets = call(self._token(), self._base(), 'GET', '/api/storage/buckets')
        return {'buckets': buckets}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'bucket': {'type': 'string', 'description': 'Bucket name.'},
                'prefix': {'type': 'string', 'description': 'Only list keys starting with this prefix.'},
                'search': {'type': 'string', 'description': 'Substring to match against object keys.'},
                'limit': {
                    'type': 'integer',
                    'description': f'Maximum objects to return (default {DEFAULT_LIMIT}, max {MAX_LIMIT}).',
                },
                'offset': {'type': 'integer', 'description': 'Objects to skip, for paging.'},
            },
            'required': ['bucket'],
        },
        description='List the objects in a storage bucket, with their metadata and URLs.',
    )
    def storage_list_objects(self, args):
        args = normalize_tool_input(args, tool_name='tool_insforge')
        bucket = require_identifier(
            require_str(args, 'bucket', tool_name='tool_insforge'),
            kind='bucket',
        )

        params = {'limit': clamp_limit(args.get('limit'))}
        for key in ('prefix', 'search'):
            if args.get(key):
                params[key] = str(args[key]).strip()
        if args.get('offset'):
            params['offset'] = int(args['offset'])

        result = call(
            self._token(),
            self._base(),
            'GET',
            f'/api/storage/buckets/{bucket}/objects',
            params=params,
        )
        return {'bucket': bucket, 'objects': result, 'query': params}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'bucket': {'type': 'string', 'description': 'Bucket name.'},
                'object_key': {
                    'type': 'string',
                    'description': 'Object key within the bucket, e.g. "docs/report.pdf".',
                },
            },
            'required': ['bucket', 'object_key'],
        },
        description=(
            'Get a download URL for a stored object. Returns the direct or presigned URL rather than the file '
            'bytes, so large binaries never enter the conversation.'
        ),
    )
    def storage_get_download_url(self, args):
        args = normalize_tool_input(args, tool_name='tool_insforge')
        bucket = require_identifier(
            require_str(args, 'bucket', tool_name='tool_insforge'),
            kind='bucket',
        )
        object_key = require_object_key(require_str(args, 'object_key', tool_name='tool_insforge'))

        result = call(
            self._token(),
            self._base(),
            'GET',
            f'/api/storage/buckets/{bucket}/download-strategy/objects/{object_key}',
        )
        return {'bucket': bucket, 'object_key': args['object_key'], 'download': result}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'bucket': {'type': 'string', 'description': 'Bucket name.'},
                'object_key': {'type': 'string', 'description': 'Object key to delete.'},
            },
            'required': ['bucket', 'object_key'],
        },
        description='Delete an object from a storage bucket. Requires the node to have writes enabled.',
    )
    def storage_delete_object(self, args):
        args = normalize_tool_input(args, tool_name='tool_insforge')
        self._require_writes('storage_delete_object')

        bucket = require_identifier(
            require_str(args, 'bucket', tool_name='tool_insforge'),
            kind='bucket',
        )
        object_key = require_object_key(require_str(args, 'object_key', tool_name='tool_insforge'))

        call(
            self._token(),
            self._base(),
            'DELETE',
            f'/api/storage/buckets/{bucket}/objects/{object_key}',
        )
        return {'bucket': bucket, 'object_key': args['object_key'], 'deleted': True}
