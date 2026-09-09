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

"""Calendar group tools: the folders calendars are filed under, and their shared booking page."""

from __future__ import annotations

from typing import Any

from ai.common.utils import require_bool

from ..gohighlevel_client import normalize_success
from ..tool_groups import gohighlevel_tool
from ._base import (
    BOOL,
    LIST_OUTPUT,
    RECORD_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    body_from,
    passthrough,
    require_id,
    require_text,
    schema,
)

# Every path here starts with /calendars, so ``version_for`` already sends Version 2021-04-15
# and nothing in this module passes ``version=``. v3 is a header value rather than a URL
# prefix, and this node does not send it.

#: Body fields shared by calendar_group_create and calendar_group_update.
#:
#: All three are required by both operations, which is the unusual part: GroupUpdateDTO marks
#: name, description and slug required, so PUT /calendars/groups/{groupId} is a whole-record
#: replacement rather than a patch. There is no get-by-id for a group either, so the values to
#: resend come from calendar_group_list. calendar_group_update states that in its description.
#:
#: ``locationId`` is absent: the node supplies it from config on create, and the update body
#: does not declare it. ``isActive`` is create-only for the same reason, and changing it later
#: is what calendar_group_status_set is for.
#:
#: There is no ``extra`` on these tools, unlike the calendar ones. The group body is four
#: fields wide and all four are typed here, so ``extra`` could only carry a property
#: GoHighLevel does not declare, which is a 422 rather than a no-op.
_GROUP_WRITE_KEYS = ('name', 'description', 'slug')

_GROUP_WRITE_PROPS = {
    'name': STR('Name of the group, as it shows in the GoHighLevel UI.'),
    'description': STR(
        'Description of the group. GoHighLevel requires the field on both the create and the update, so pass an '
        'empty string when the group needs no description.'
    ),
    'slug': STR(
        'URL slug for the group booking page, for example "15-mins". Check it with calendar_group_slug_check '
        'first: GoHighLevel rejects a slug that is already taken in this sub-account.'
    ),
}

_GROUP_RECORD_OUTPUT = RECORD_OUTPUT(
    'The group as GoHighLevel returns it: id, locationId, name, description, slug and isActive. The id is under '
    '"id", not "groupId".'
)


def _group_body(args: dict, keys: tuple[str, ...], tool: str) -> dict:
    """Assemble a group create or update body, with the three fields both operations require.

    The local argument check only rejects parameters a tool does not declare, so a required one
    that was left out still reaches GoHighLevel and comes back as vendor validation text. Name
    and slug are checked as non-empty strings; ``description`` is only checked for presence,
    because a group with nothing to say about it still has to send the field.
    """
    body = body_from(args, keys, tool=tool)
    require_text(args, 'name', tool)
    require_text(args, 'slug', tool)
    if not isinstance(body.get('description'), str):
        raise ValueError(
            f'{tool}: "description" is required. GoHighLevel declares it on both the create and the update body, '
            f'so pass an empty string when the group needs no description.'
        )
    return body


def _flag_result(payload: Any) -> dict:
    """Outcome of a call whose whole answer is a success flag.

    The flag is spelled ``succeded``, ``succeeded`` or ``success`` depending on the endpoint,
    so it is read through normalize_success rather than by name.
    """
    return {'ok': normalize_success(payload)}


def _slug_result(payload: Any) -> dict:
    """Answer of the slug check, kept as three states rather than two.

    ``available`` stays None when GoHighLevel sends no flag. Coercing that to False would tell
    the agent the slug is taken, which is a different claim from not knowing.
    """
    if not isinstance(payload, dict):
        return {'available': None}
    return {'available': payload.get('available')}


class CalendarGroupsMixin(GoHighLevelToolsBase):
    """Tools for the ``calendar_groups`` group."""

    @gohighlevel_tool(
        group='calendar_groups',
        input_schema=schema(),
        description=(
            'List the calendar groups in the configured sub-account. A group is a folder of calendars with its own '
            'booking page, and its id is what calendar_list filters on and what a calendar carries as groupId. This '
            'is also the only way to read one group: GoHighLevel has no get-by-id for a group, so read the record '
            'from here before calendar_group_update, which needs every field resent. The whole set comes back in '
            'one response, so there is no cursor, and a sub-account with no groups returns an empty list rather '
            'than an error.'
        ),
        output_schema=LIST_OUTPUT(
            'Always null: this endpoint returns every group in one response, so there is no next page.',
            items='The calendar groups, each carrying id, locationId, name, description, slug and isActive.',
        ),
    )
    def calendar_group_list(self, args):
        args = self._args(args, 'calendar_group_list')
        params = {'locationId': self._location()}
        return self._list('/calendars/groups', key='groups', cleaner=passthrough, params=params)

    @gohighlevel_tool(
        group='calendar_groups',
        writes=True,
        input_schema=schema(
            required=['name', 'description', 'slug'],
            isActive=BOOL('Whether the group is live. Set it to false to create it hidden.'),
            **_GROUP_WRITE_PROPS,
        ),
        description=(
            'Create a calendar group in the configured sub-account. Name, description and slug are all required by '
            'GoHighLevel, so send an empty description rather than omitting it. Call calendar_group_slug_check '
            'first if the slug matters: a taken slug is rejected. Put a calendar in the group afterwards by sending '
            'the new group id as groupId to calendar_create or calendar_update.'
        ),
        output_schema=_GROUP_RECORD_OUTPUT,
    )
    def calendar_group_create(self, args):
        args = self._args(args, 'calendar_group_create')
        body = _group_body(args, _GROUP_WRITE_KEYS + ('isActive',), 'calendar_group_create')
        body['locationId'] = self._location()
        return self._write('POST', '/calendars/groups', passthrough, key='group', body=body)

    @gohighlevel_tool(
        group='calendar_groups',
        writes=True,
        input_schema=schema(
            required=['groupId', 'name', 'description', 'slug'],
            groupId=STR('Id of the group to update.'),
            **_GROUP_WRITE_PROPS,
        ),
        description=(
            'Replace the name, description and slug of a calendar group. This is not a partial update: GoHighLevel '
            'requires all three on every call, so read the group from calendar_group_list and resend the fields you '
            'are not changing, or they are overwritten with whatever you pass. It cannot change isActive; use '
            'calendar_group_status_set for that.'
        ),
        output_schema=_GROUP_RECORD_OUTPUT,
    )
    def calendar_group_update(self, args):
        args = self._args(args, 'calendar_group_update')
        group_id = require_id(args, 'groupId', 'calendar_group_update')
        body = _group_body(args, _GROUP_WRITE_KEYS, 'calendar_group_update')
        return self._write('PUT', f'/calendars/groups/{group_id}', passthrough, key='group', body=body)

    @gohighlevel_tool(
        group='calendar_groups',
        writes=True,
        input_schema=schema(
            required=['groupId', 'isActive'],
            groupId=STR('Id of the group.'),
            isActive=BOOL('True to enable the group, false to disable it.'),
        ),
        description=(
            'Enable or disable a calendar group without deleting it. Disabling takes the group booking page down '
            'and leaves the group and its calendars in place, so this is the reversible alternative to '
            'calendar_group_delete. Returns only a success flag, not the group.'
        ),
        output_schema=RECORD_OUTPUT('ok is true when GoHighLevel reported the change as successful.'),
    )
    def calendar_group_status_set(self, args):
        args = self._args(args, 'calendar_group_status_set')
        group_id = require_id(args, 'groupId', 'calendar_group_status_set')
        # Read strictly rather than through body_from: isActive is the whole request, an absent
        # one would send an empty body that GoHighLevel answers with a 400, and a coerced one
        # would quietly disable the group when the agent meant to enable it.
        body = {'isActive': require_bool(args, 'isActive', tool_name='calendar_group_status_set')}
        return self._write('PUT', f'/calendars/groups/{group_id}/status', _flag_result, body=body)

    @gohighlevel_tool(
        group='calendar_groups',
        writes=True,
        input_schema=schema(required=['groupId'], groupId=STR('Id of the group to delete.')),
        description=(
            'Delete a calendar group. Use calendar_group_status_set with isActive false instead when the group '
            'should only come off the booking page, since a delete cannot be undone.'
        ),
        output_schema=RECORD_OUTPUT(
            'Whether the delete succeeded, under deleted, with the raw GoHighLevel response under data.'
        ),
    )
    def calendar_group_delete(self, args):
        args = self._args(args, 'calendar_group_delete')
        group_id = require_id(args, 'groupId', 'calendar_group_delete')
        return self._delete(f'/calendars/groups/{group_id}')

    @gohighlevel_tool(
        group='calendar_groups',
        input_schema=schema(required=['slug'], slug=STR('The slug to check, for example "15-mins".')),
        description=(
            'Check whether a calendar group slug is free in the configured sub-account, before creating or renaming '
            'a group. It changes nothing. It does check group slugs only: there is no equivalent for a calendar '
            'slug. GoHighLevel puts this behind its calendar group write permission even though it only reads, so '
            'a token without that permission gets a 401 here.'
        ),
        output_schema=RECORD_OUTPUT(
            'available is true when the slug is free and false when it is taken. It is null when GoHighLevel '
            'answered without the flag, which means unknown rather than taken.'
        ),
    )
    def calendar_group_slug_check(self, args):
        args = self._args(args, 'calendar_group_slug_check')
        slug = require_text(args, 'slug', 'calendar_group_slug_check')
        body = {'locationId': self._location(), 'slug': slug}
        return _slug_result(self._call('POST', '/calendars/groups/validate-slug', body=body))
