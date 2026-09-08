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
Custom field tools for deals, persons, organizations and products.

The four Pipedrive field endpoints are identical apart from their path, so these
tools take an ``entity`` parameter instead of shipping the same five operations
four times over. Activity and note fields live with their own resources
(``activity_field_list``, ``note_field_list``).
"""

from __future__ import annotations

from ..pipedrive_client import clean_field
from ..tool_groups import pipedrive_tool
from ._base import (
    ARR,
    BOOL,
    ENUM,
    EXTRA,
    INT,
    PAGING,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    require_id,
    require_text,
    schema,
)

_FIELD_PATHS = {
    'deal': '/dealFields',
    'person': '/personFields',
    'organization': '/organizationFields',
    'product': '/productFields',
}

_ENTITY = ENUM('Which record type the field belongs to.', sorted(_FIELD_PATHS))

_FIELD_TYPE_DESC = (
    'Field type. One of: varchar (text up to 255), varchar_auto (autocomplete text), text (long text), '
    'double (number), monetary, date, daterange, time, timerange, user, org, people, phone, address, '
    'enum (single option), set (multiple options), visible_to, int, address.'
)


def _path(args: dict, tool: str) -> str:
    entity = require_text(args, 'entity', tool)
    try:
        return _FIELD_PATHS[entity]
    except KeyError:
        raise ValueError(f'{tool}: "entity" must be one of {", ".join(sorted(_FIELD_PATHS))}') from None


class FieldsMixin(PipedriveToolsBase):
    """Tools for the ``fields`` group."""

    @pipedrive_tool(
        group='fields',
        input_schema=schema(required=['entity'], entity=_ENTITY, **PAGING()),
        description='List the fields of deals, persons, organizations or products, including custom fields and the 40-character keys used to read and write them.',
    )
    def field_list(self, args):
        args = args_of(args)
        return self._list(_path(args, 'field_list'), args, clean_field)

    @pipedrive_tool(
        group='fields',
        input_schema=schema(required=['entity', 'field_id'], entity=_ENTITY, field_id=INT('Field id.')),
        description='Get a single field definition, including its options for enum and set fields.',
    )
    def field_get(self, args):
        args = args_of(args)
        base = _path(args, 'field_get')
        field_id = require_id(args, 'field_id', 'field_get')
        return self._get(f'{base}/{field_id}', clean_field)

    @pipedrive_tool(
        group='fields',
        input_schema=schema(
            required=['entity', 'name', 'field_type'],
            entity=_ENTITY,
            name=STR('Display name of the field.'),
            field_type=STR(_FIELD_TYPE_DESC),
            options=ARR('Options for enum and set fields, e.g. [{"label": "Gold"}, {"label": "Silver"}].', 'object'),
            add_visible_flag=BOOL('Whether the field appears in the "add new" dialog (default true).'),
            extra=EXTRA(),
        ),
        description='Create a custom field on deals, persons, organizations or products.',
    )
    def field_create(self, args):
        args = args_of(args)
        base = _path(args, 'field_create')
        require_text(args, 'name', 'field_create')
        require_text(args, 'field_type', 'field_create')
        body = body_from(args, ('name', 'field_type', 'options', 'add_visible_flag'))
        return self._write('POST', base, clean_field, body=body)

    @pipedrive_tool(
        group='fields',
        input_schema=schema(
            required=['entity', 'field_id'],
            entity=_ENTITY,
            field_id=INT('Field id to update.'),
            name=STR('New display name.'),
            options=ARR(
                'Full option list for enum and set fields. Include existing options with their ids, or they are removed.',
                'object',
            ),
            add_visible_flag=BOOL('Whether the field appears in the "add new" dialog.'),
            extra=EXTRA(),
        ),
        description='Update a custom field. Field type cannot be changed after creation.',
    )
    def field_update(self, args):
        args = args_of(args)
        base = _path(args, 'field_update')
        field_id = require_id(args, 'field_id', 'field_update')
        body = body_from(args, ('name', 'options', 'add_visible_flag'))
        return self._write('PUT', f'{base}/{field_id}', clean_field, body=body)

    @pipedrive_tool(
        group='fields',
        input_schema=schema(required=['entity', 'field_id'], entity=_ENTITY, field_id=INT('Field id to delete.')),
        description='Delete a custom field. The data stored in it is lost.',
    )
    def field_delete(self, args):
        args = args_of(args)
        base = _path(args, 'field_delete')
        field_id = require_id(args, 'field_id', 'field_delete')
        return self._delete(f'{base}/{field_id}')

    @pipedrive_tool(
        group='fields',
        input_schema=schema(required=['entity', 'ids'], entity=_ENTITY, ids=ARR('Field ids to delete.', 'integer')),
        description='Delete multiple custom fields in one call.',
    )
    def field_delete_bulk(self, args):
        args = args_of(args)
        return self._delete_bulk(_path(args, 'field_delete_bulk'), args, 'field_delete_bulk')
