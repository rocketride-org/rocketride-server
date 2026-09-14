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

"""Custom value tools: the sub-account merge tags that fill placeholders in messages and templates."""

from __future__ import annotations

from ..tool_groups import gohighlevel_tool
from ._base import (
    LIST_OUTPUT,
    RECORD_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    passthrough,
    require_id,
    require_text,
    schema,
)

#: Sub-account path these tools hang off. The camelCase ``customValues`` segment is
#: load-bearing: GoHighLevel answers ``/locations/{id}/customvalues`` with a 401 that reads
#: like a credential failure rather than with a 404.
_PATH = '/locations/{location}/customValues'

#: Body fields shared by custom_value_create and custom_value_update.
#:
#: Both operations declare exactly these two and both declare both of them required, so the
#: update is a full replace rather than a patch. There is no ``extra`` escape hatch on either
#: tool: the DTO has no third property, and GoHighLevel rejects an undeclared one with a 422
#: rather than ignoring it, so ``extra`` here could only ever turn a working call into an error.
_CUSTOM_VALUE_WRITE_KEYS = ('name', 'value')

_CUSTOM_VALUE_WRITE_PROPS = {
    'name': STR(
        'Name of the custom value, for example "Support Email". GoHighLevel builds the merge tag out of it: '
        'a value named "Custom Field" comes back with fieldKey "{{ custom_values.custom_field }}".'
    ),
    'value': STR('Text the merge tag expands to.'),
}

#: What a custom value read returns, stated once because four tools return one.
_CUSTOM_VALUE_SHAPE = (
    'Each record carries id, name, value, locationId and fieldKey, where fieldKey is the whole merge tag '
    'literal ("{{ custom_values.support_email }}") rather than a bare key, so it can be pasted into a '
    'message or template as it stands.'
)

_CUSTOM_VALUE_RECORD_OUTPUT = RECORD_OUTPUT(f'The custom value, as GoHighLevel returns it. {_CUSTOM_VALUE_SHAPE}')


class CustomValuesMixin(GoHighLevelToolsBase):
    """Tools for the ``custom_values`` group."""

    @gohighlevel_tool(
        group='custom_values',
        input_schema=schema(),
        description=(
            'List the custom values on the configured sub-account. Custom values are sub-account wide merge '
            'tags, one name and one string each, used to fill placeholders in messages and templates with '
            'things like an office address or a support email. They are not per contact: contact data lives in '
            'custom fields, which custom_field_list covers. Returns the values under items, all of them in one '
            f'response, so there is no cursor. A sub-account with none returns an empty list rather than an '
            f'error. {_CUSTOM_VALUE_SHAPE}'
        ),
        output_schema=LIST_OUTPUT(
            'Always null: this endpoint returns every custom value in one response, so there is no next page.',
            items=f'The custom values on the sub-account, as GoHighLevel returns them. {_CUSTOM_VALUE_SHAPE}',
        ),
    )
    def custom_value_list(self, args):
        args = self._args(args, 'custom_value_list')
        return self._list(_PATH.format(location=self._location()), key='customValues', cleaner=passthrough)

    @gohighlevel_tool(
        group='custom_values',
        input_schema=schema(
            required=['customValueId'],
            customValueId=STR('Id of the custom value. Get it from custom_value_list.'),
        ),
        description=(
            'Get one custom value by id. Use it to read the current value before custom_value_update replaces '
            f'it, since that update overwrites both fields. {_CUSTOM_VALUE_SHAPE}'
        ),
        output_schema=_CUSTOM_VALUE_RECORD_OUTPUT,
    )
    def custom_value_get(self, args):
        args = self._args(args, 'custom_value_get')
        value_id = require_id(args, 'customValueId', 'custom_value_get')
        path = _PATH.format(location=self._location())
        return self._get(f'{path}/{value_id}', passthrough, key='customValue')

    @gohighlevel_tool(
        group='custom_values',
        writes=True,
        input_schema=schema(required=['name', 'value'], **_CUSTOM_VALUE_WRITE_PROPS),
        description=(
            'Create a custom value on the configured sub-account. Both name and value are required. The merge '
            'tag comes back under fieldKey, ready to paste into a message or template. Read custom_value_list '
            'first when a value for this purpose may already exist: custom_value_update changes an existing '
            'one, and this tool does not.'
        ),
        output_schema=_CUSTOM_VALUE_RECORD_OUTPUT,
    )
    def custom_value_create(self, args):
        args = self._args(args, 'custom_value_create')
        body = {
            'name': require_text(args, 'name', 'custom_value_create'),
            'value': require_text(args, 'value', 'custom_value_create'),
        }
        return self._write('POST', _PATH.format(location=self._location()), passthrough, key='customValue', body=body)

    @gohighlevel_tool(
        group='custom_values',
        writes=True,
        input_schema=schema(
            required=['customValueId', 'name', 'value'],
            customValueId=STR('Id of the custom value to update.'),
            **_CUSTOM_VALUE_WRITE_PROPS,
        ),
        description=(
            'Replace a custom value. This is a full replace rather than a patch: GoHighLevel requires both name '
            'and value on every call, so read the record with custom_value_get first and send back the field you '
            'do not mean to change. The merge tag under fieldKey is built from the name, so send the current '
            'name unless a rename is what you want.'
        ),
        output_schema=_CUSTOM_VALUE_RECORD_OUTPUT,
    )
    def custom_value_update(self, args):
        args = self._args(args, 'custom_value_update')
        value_id = require_id(args, 'customValueId', 'custom_value_update')
        body = {
            'name': require_text(args, 'name', 'custom_value_update'),
            'value': require_text(args, 'value', 'custom_value_update'),
        }
        path = _PATH.format(location=self._location())
        return self._write('PUT', f'{path}/{value_id}', passthrough, key='customValue', body=body)

    @gohighlevel_tool(
        group='custom_values',
        writes=True,
        input_schema=schema(
            required=['customValueId'],
            customValueId=STR('Id of the custom value to delete.'),
        ),
        description=(
            'Delete a custom value from the configured sub-account. Every message and template that references '
            'its merge tag loses what the tag expanded to, so check what uses it before deleting.'
        ),
        output_schema=RECORD_OUTPUT(
            'Whether the delete succeeded, under deleted, with the raw GoHighLevel response under data.'
        ),
    )
    def custom_value_delete(self, args):
        args = self._args(args, 'custom_value_delete')
        value_id = require_id(args, 'customValueId', 'custom_value_delete')
        path = _PATH.format(location=self._location())
        return self._delete(f'{path}/{value_id}')
