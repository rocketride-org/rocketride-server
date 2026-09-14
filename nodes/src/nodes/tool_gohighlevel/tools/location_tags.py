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

"""Location tag tools: the tag definitions a sub-account holds, not the tags on a contact."""

from __future__ import annotations

from typing import Any

from ..tool_groups import gohighlevel_tool
from ._base import (
    LIST_OUTPUT,
    RECORD_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    body_from,
    require_id,
    schema,
)

#: Fields kept from a tag definition. The whole record is three keys, so this drops nothing
#: GoHighLevel documents; it exists to keep the shape stable if the vendor adds more.
_TAG_READ_KEYS = ('id', 'name', 'locationId')

#: Body fields accepted by location_tags_create and location_tags_update.
#:
#: The vendor DTO is one property wide and declares it required on both operations, so create
#: and update share the tuple and the props outright rather than drifting the way the contact
#: DTOs do.
_TAG_WRITE_KEYS = ('name',)

_TAG_WRITE_PROPS = {
    'name': STR('Tag name as it appears in the GoHighLevel UI, for example "vip".'),
}

#: Said on every tool here, because the distinction is the one an agent gets wrong: these five
#: tools manage the sub-account's tag vocabulary, and none of them touches a contact.
_DEFINITION_NOTE = (
    'This is the sub-account tag vocabulary, not the tags on any contact. To tag or untag a '
    'contact use contact_tags_add and contact_tags_remove, which also create a name that does '
    'not exist yet.'
)

_TAG_RECORD_OUTPUT = RECORD_OUTPUT('The tag definition: id, name and the sub-account it belongs to.')


def _clean_tag(tag: Any) -> dict:
    """Trim a tag definition to the fields this node returns."""
    if not isinstance(tag, dict):
        return {}
    return {key: tag[key] for key in _TAG_READ_KEYS if key in tag}


class LocationTagsMixin(GoHighLevelToolsBase):
    """Tools for the ``location_tags`` group."""

    @gohighlevel_tool(
        group='location_tags',
        input_schema=schema(),
        description=(
            'List every tag defined on the configured sub-account, with the id of each. Use it to resolve a tag '
            'id before location_tags_update or location_tags_delete, or to check which names already exist '
            f'before tagging contacts. {_DEFINITION_NOTE} Takes no parameters: GoHighLevel offers this endpoint '
            'no filter and no paging, and the whole vocabulary comes back in one response.'
        ),
        output_schema=LIST_OUTPUT(
            'Always null: this endpoint returns every tag in one response, so there is no next page.',
            items='The tag definitions on the sub-account, each holding id, name and locationId.',
        ),
    )
    def location_tags_list(self, args):
        args = self._args(args, 'location_tags_list')
        return self._list(f'/locations/{self._location()}/tags', key='tags', cleaner=_clean_tag)

    @gohighlevel_tool(
        group='location_tags',
        writes=True,
        input_schema=schema(required=['name'], **_TAG_WRITE_PROPS),
        description=(
            'Define a new tag on the configured sub-account and return it with its id. Needed only to create a '
            'tag nothing carries yet: contact_tags_add already creates any name it does not find. '
            f'{_DEFINITION_NOTE}'
        ),
        output_schema=_TAG_RECORD_OUTPUT,
    )
    def location_tags_create(self, args):
        args = self._args(args, 'location_tags_create')
        body = body_from(args, _TAG_WRITE_KEYS)
        return self._write('POST', f'/locations/{self._location()}/tags', _clean_tag, key='tag', body=body)

    @gohighlevel_tool(
        group='location_tags',
        input_schema=schema(required=['tagId'], tagId=STR('Id of the tag. Get tag ids from location_tags_list.')),
        description=(
            'Get one tag definition by id. There is no lookup by name, so resolve the id with location_tags_list '
            f'first. {_DEFINITION_NOTE}'
        ),
        output_schema=_TAG_RECORD_OUTPUT,
    )
    def location_tags_get(self, args):
        args = self._args(args, 'location_tags_get')
        tag_id = require_id(args, 'tagId', 'location_tags_get')
        return self._get(f'/locations/{self._location()}/tags/{tag_id}', _clean_tag, key='tag')

    @gohighlevel_tool(
        group='location_tags',
        writes=True,
        input_schema=schema(
            required=['tagId', 'name'],
            tagId=STR('Id of the tag to rename. Get tag ids from location_tags_list.'),
            **_TAG_WRITE_PROPS,
        ),
        description=(
            'Rename a tag definition. The name is the only field a tag has, so this is a rename and nothing else, '
            f'and GoHighLevel requires it. {_DEFINITION_NOTE}'
        ),
        output_schema=_TAG_RECORD_OUTPUT,
    )
    def location_tags_update(self, args):
        args = self._args(args, 'location_tags_update')
        tag_id = require_id(args, 'tagId', 'location_tags_update')
        body = body_from(args, _TAG_WRITE_KEYS)
        return self._write('PUT', f'/locations/{self._location()}/tags/{tag_id}', _clean_tag, key='tag', body=body)

    @gohighlevel_tool(
        group='location_tags',
        writes=True,
        input_schema=schema(
            required=['tagId'],
            tagId=STR('Id of the tag to delete. Get tag ids from location_tags_list.'),
        ),
        description=(
            'Delete a tag definition from the sub-account. This removes the tag itself rather than removing it '
            'from one contact, which is contact_tags_remove. GoHighLevel does not state what happens to contacts '
            'already carrying the tag, so treat it as irreversible and check location_tags_list afterwards.'
        ),
        output_schema=RECORD_OUTPUT(
            'Whether the delete succeeded, under deleted, with the raw GoHighLevel response under data.'
        ),
    )
    def location_tags_delete(self, args):
        args = self._args(args, 'location_tags_delete')
        tag_id = require_id(args, 'tagId', 'location_tags_delete')
        return self._delete(f'/locations/{self._location()}/tags/{tag_id}')
