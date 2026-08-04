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

"""Saved-filter tools. Filter ids feed the filter_id parameter of the list tools."""

from __future__ import annotations

from ..pipedrive_client import clean_filter
from ..tool_groups import pipedrive_tool
from ._base import (
    ARR,
    ENUM,
    INT,
    OBJ,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    params_from,
    passthrough,
    require_id,
    require_text,
    schema,
)

_FILTER_TYPES = ['deals', 'leads', 'org', 'people', 'products', 'activity', 'projects']

_CONDITIONS_DESC = (
    'Filter condition tree. Pipedrive expects a nested AND/OR structure, e.g. '
    '{"glue": "and", "conditions": [{"glue": "and", "conditions": [{"object": "deal", '
    '"field_id": "1", "operator": "=", "value": "open"}]}]}. Call filter_helpers_get for the '
    'field ids and operators this account accepts.'
)


class FiltersMixin(PipedriveToolsBase):
    """Tools for the ``filters`` group."""

    @pipedrive_tool(
        group='filters',
        input_schema=schema(type=ENUM('Only filters of this type.', _FILTER_TYPES)),
        description='List saved filters. Pass a returned filter id as filter_id to the list tools to reuse a filter the user already built in the UI.',
    )
    def filter_list(self, args):
        args = args_of(args)
        data = self._call('GET', '/filters', params=params_from(args, ('type',)))
        return {'items': [clean_filter(f) for f in (data or [])]}

    @pipedrive_tool(
        group='filters',
        input_schema=schema(required=['filter_id'], filter_id=INT('Filter id.')),
        description='Get a single filter, including its condition tree.',
    )
    def filter_get(self, args):
        args = args_of(args)
        return self._get(f'/filters/{require_id(args, "filter_id", "filter_get")}', passthrough)

    @pipedrive_tool(
        group='filters',
        input_schema=schema(
            required=['name', 'conditions', 'type'],
            name=STR('Filter name.'),
            conditions=OBJ(_CONDITIONS_DESC),
            type=ENUM('What the filter applies to.', _FILTER_TYPES),
        ),
        description='Create a saved filter.',
    )
    def filter_create(self, args):
        args = args_of(args)
        require_text(args, 'name', 'filter_create')
        require_text(args, 'type', 'filter_create')
        if not isinstance(args.get('conditions'), dict):
            raise ValueError('filter_create: "conditions" is required and must be an object')
        return self._write('POST', '/filters', passthrough, body=body_from(args, ('name', 'conditions', 'type')))

    @pipedrive_tool(
        group='filters',
        input_schema=schema(
            required=['filter_id'],
            filter_id=INT('Filter id to update.'),
            name=STR('New filter name.'),
            conditions=OBJ(_CONDITIONS_DESC),
        ),
        description='Update a saved filter.',
    )
    def filter_update(self, args):
        args = args_of(args)
        filter_id = require_id(args, 'filter_id', 'filter_update')
        return self._write('PUT', f'/filters/{filter_id}', passthrough, body=body_from(args, ('name', 'conditions')))

    @pipedrive_tool(
        group='filters',
        input_schema=schema(required=['filter_id'], filter_id=INT('Filter id to delete.')),
        description='Delete a saved filter.',
    )
    def filter_delete(self, args):
        args = args_of(args)
        return self._delete(f'/filters/{require_id(args, "filter_id", "filter_delete")}')

    @pipedrive_tool(
        group='filters',
        input_schema=schema(required=['ids'], ids=ARR('Filter ids to delete.', 'integer')),
        description='Delete multiple saved filters in one call.',
    )
    def filter_delete_bulk(self, args):
        return self._delete_bulk('/filters', args_of(args), 'filter_delete_bulk')

    @pipedrive_tool(
        group='filters',
        input_schema=schema(),
        description='Get the field ids, operators and value formats that filter conditions accept. Call this before building a filter.',
    )
    def filter_helpers_get(self, args):
        args_of(args)
        return self._call('GET', '/filters/helpers')
