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

"""Custom field tools: the contact and opportunity field definitions on a sub-account."""

from __future__ import annotations

from ..tool_groups import gohighlevel_tool
from ._base import (
    ARR,
    BOOL,
    ENUM,
    EXTRA,
    LIST_OUTPUT,
    MIXED_ARR,
    NUM,
    RECORD_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    body_from,
    params_from,
    passthrough,
    require_id,
    require_text,
    schema,
)

#: Sub-account path these tools hang off. The camelCase ``customFields`` segment is
#: load-bearing: GoHighLevel answers a mis-cased path with a 401 that reads like a credential
#: failure rather than with a 404, so this is built once instead of being spelled per tool.
_PATH = '/locations/{location}/customFields'

#: Body fields shared by custom_field_create and custom_field_update.
#:
#: ``dataType`` is deliberately absent. CreateCustomFieldsDTO declares it and requires it;
#: UpdateCustomFieldsDTO declares it nowhere, and GoHighLevel rejects an undeclared property
#: with a 422 rather than ignoring it, so offering it on the update would show the agent a
#: parameter whose only outcome is a hard vendor error. Create gets its own key tuple and its
#: own schema, which is the same create-versus-update policy contacts.py sets out.
_CUSTOM_FIELD_WRITE_KEYS = (
    'name',
    'placeholder',
    'model',
    'position',
    'acceptedFormat',
    'isMultipleFile',
    'maxNumberOfFiles',
    'textBoxListOptions',
)

#: The three parameters whose names change between what you send and what you read back.
#:
#: Stated on every tool in this module that returns a record, because it is the one way to
#: lose data here without an error: a record read from this node fed back into an update
#: silently drops the picklist options and the file settings, since the update declares none
#: of the three names the read uses.
_FIELD_RENAME_NOTE = (
    'Three parameters change name between the write and the read: textBoxListOptions comes back as '
    'picklistOptions, isMultipleFile as isMultiFileAllowed and maxNumberOfFiles as maxFileLimit, so a '
    'record read here cannot be sent back to custom_field_update unchanged.'
)

_CUSTOM_FIELD_ITEMS = (
    f'The custom field definitions on the sub-account, as GoHighLevel returns them. Each carries id, '
    f'name, fieldKey, dataType, model and the display settings. {_FIELD_RENAME_NOTE}'
)

_CUSTOM_FIELD_RECORD_OUTPUT = RECORD_OUTPUT(
    f'The custom field definition, as GoHighLevel returns it. {_FIELD_RENAME_NOTE}'
)

_CUSTOM_FIELD_WRITE_PROPS = {
    'name': STR('Name of the field as it shows in the GoHighLevel UI, for example "Pincode".'),
    'placeholder': STR('Placeholder text shown in the empty input.'),
    'model': ENUM(
        'Which record type the field belongs to. Defaults to contact when omitted.',
        ('contact', 'opportunity'),
    ),
    'position': NUM('Where the field sits in the form, 0-based. 0 when omitted.'),
    'acceptedFormat': ARR(
        'File extensions a FILE_UPLOAD field accepts, each with its leading dot, for example '
        '[".pdf", ".docx"]. Ignored by every other field type.'
    ),
    'isMultipleFile': BOOL('Whether a FILE_UPLOAD field takes more than one file. Read back as isMultiFileAllowed.'),
    'maxNumberOfFiles': NUM('How many files a FILE_UPLOAD field takes. Read back as maxFileLimit.'),
    'textBoxListOptions': MIXED_ARR(
        'Options for a field that offers a fixed set of choices, each an object of the form '
        '{"label": "First", "prefillValue": ""}. Read back as picklistOptions, which is a plain array of '
        'strings, so the two shapes are not interchangeable.'
    ),
    'extra': EXTRA(),
}

#: Body keys and schema properties for custom_field_create only, which is the shared set plus
#: the field type. GoHighLevel requires it on create and accepts it on nothing else.
_CUSTOM_FIELD_CREATE_KEYS = _CUSTOM_FIELD_WRITE_KEYS + ('dataType',)
_CUSTOM_FIELD_CREATE_PROPS = {
    **_CUSTOM_FIELD_WRITE_PROPS,
    'dataType': STR(
        'Type of the field, for example "TEXT". GoHighLevel publishes no list of the accepted values for '
        'this endpoint; the values it documents on its newer custom fields API are TEXT, LARGE_TEXT, '
        'NUMERICAL, PHONE, MONETORY, CHECKBOX, SINGLE_OPTIONS, MULTIPLE_OPTIONS, DATE, TEXTBOX_LIST, '
        'FILE_UPLOAD and RADIO. The type cannot be changed after the field exists.'
    ),
}


class CustomFieldsMixin(GoHighLevelToolsBase):
    """Tools for the ``custom_fields`` group."""

    @gohighlevel_tool(
        group='custom_fields',
        input_schema=schema(
            model=ENUM(
                'Which fields to return. Omit for every field on the sub-account.',
                ('contact', 'opportunity', 'all'),
            ),
        ),
        description=(
            'List the custom field definitions on the configured sub-account. Call this before any write that '
            'sets a custom field: contact and opportunity writes address fields by id, and this is the only tool '
            'that turns a field name an operator would recognise into that id. Returns the fields under items, '
            'all of them in one response, so there is no cursor. A sub-account with no custom fields returns an '
            f'empty list rather than an error. {_FIELD_RENAME_NOTE}'
        ),
        output_schema=LIST_OUTPUT(
            'Always null: this endpoint returns every custom field in one response, so there is no next page.',
            items=_CUSTOM_FIELD_ITEMS,
        ),
    )
    def custom_field_list(self, args):
        args = self._args(args, 'custom_field_list')
        params = params_from(args, ('model',))
        path = _PATH.format(location=self._location())
        return self._list(path, key='customFields', cleaner=passthrough, params=params)

    @gohighlevel_tool(
        group='custom_fields',
        input_schema=schema(
            required=['customFieldId'],
            customFieldId=STR(
                'Id of the custom field, or its field key, for example "contact.first_name" or '
                '"opportunity.pipeline_id". Get either from custom_field_list.'
            ),
        ),
        description=(
            'Get one custom field definition. This is the only tool in the group that accepts a field key in '
            'place of an id, so use it to resolve a key you already have; custom_field_update and '
            f'custom_field_delete take the id only. {_FIELD_RENAME_NOTE}'
        ),
        output_schema=_CUSTOM_FIELD_RECORD_OUTPUT,
    )
    def custom_field_get(self, args):
        args = self._args(args, 'custom_field_get')
        field_id = require_id(args, 'customFieldId', 'custom_field_get')
        path = _PATH.format(location=self._location())
        return self._get(f'{path}/{field_id}', passthrough, key='customField')

    @gohighlevel_tool(
        group='custom_fields',
        writes=True,
        input_schema=schema(required=['name', 'dataType'], **_CUSTOM_FIELD_CREATE_PROPS),
        description=(
            'Create a custom field definition on the configured sub-account. This adds a field to every contact '
            'or opportunity in the sub-account, so read custom_field_list first and reuse a field that already '
            'covers what you need. name and dataType are both required, and dataType is the one setting '
            f'custom_field_update cannot change afterwards. {_FIELD_RENAME_NOTE}'
        ),
        output_schema=_CUSTOM_FIELD_RECORD_OUTPUT,
    )
    def custom_field_create(self, args):
        args = self._args(args, 'custom_field_create')
        body = body_from(args, _CUSTOM_FIELD_CREATE_KEYS, tool='custom_field_create')
        body['name'] = require_text(args, 'name', 'custom_field_create')
        body['dataType'] = require_text(args, 'dataType', 'custom_field_create')
        path = _PATH.format(location=self._location())
        return self._write('POST', path, passthrough, key='customField', body=body)

    @gohighlevel_tool(
        group='custom_fields',
        writes=True,
        input_schema=schema(
            required=['customFieldId', 'name'],
            customFieldId=STR('Id of the custom field to update. A field key is not accepted here.'),
            **_CUSTOM_FIELD_WRITE_PROPS,
        ),
        description=(
            'Update a custom field definition. GoHighLevel requires name on every update, so pass the field '
            'current name when you are changing something else and do not mean to rename it. dataType is not '
            'accepted on an update, so the type of an existing field cannot be changed here even though '
            'custom_field_create sets one. This changes the field for every record in the sub-account, not for '
            f'one contact. {_FIELD_RENAME_NOTE}'
        ),
        output_schema=_CUSTOM_FIELD_RECORD_OUTPUT,
    )
    def custom_field_update(self, args):
        args = self._args(args, 'custom_field_update')
        field_id = require_id(args, 'customFieldId', 'custom_field_update')
        body = body_from(args, _CUSTOM_FIELD_WRITE_KEYS, tool='custom_field_update')
        body['name'] = require_text(args, 'name', 'custom_field_update')
        path = _PATH.format(location=self._location())
        return self._write('PUT', f'{path}/{field_id}', passthrough, key='customField', body=body)

    @gohighlevel_tool(
        group='custom_fields',
        writes=True,
        input_schema=schema(
            required=['customFieldId'],
            customFieldId=STR('Id of the custom field to delete. A field key is not accepted here.'),
        ),
        description=(
            'Delete a custom field definition from the configured sub-account. This removes the field itself, '
            'across every contact and opportunity in the sub-account, rather than clearing the value one record '
            'holds, so it is not the way to blank a single contact field. Take the id from custom_field_list.'
        ),
        output_schema=RECORD_OUTPUT(
            'Whether the delete succeeded, under deleted, with the raw GoHighLevel response under data.'
        ),
    )
    def custom_field_delete(self, args):
        args = self._args(args, 'custom_field_delete')
        field_id = require_id(args, 'customFieldId', 'custom_field_delete')
        path = _PATH.format(location=self._location())
        return self._delete(f'{path}/{field_id}')
