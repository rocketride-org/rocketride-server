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

"""Activity tools: calls, meetings and tasks, plus activity types and fields."""

from __future__ import annotations

from ..pipedrive_client import clean_activity, clean_field
from ..tool_groups import pipedrive_tool
from ._base import (
    ARR,
    BOOL,
    ENUM,
    EXTRA,
    INT,
    PAGING,
    STR,
    UTC_TIME_DESC,
    PipedriveToolsBase,
    args_of,
    body_from,
    params_from,
    passthrough,
    require_id,
    require_text,
    schema,
)

_ACTIVITY_WRITE_KEYS = (
    'subject',
    'type',
    'due_date',
    'due_time',
    'duration',
    'done',
    'busy_flag',
    'note',
    'public_description',
    'location',
    'user_id',
    'deal_id',
    'lead_id',
    'person_id',
    'org_id',
    'project_id',
    'participants',
    'attendees',
)

_ACTIVITY_WRITE_PROPS = {
    'subject': STR('Activity subject line.'),
    'type': STR(
        'Activity type key, e.g. "call", "meeting", "task", "deadline", "email", "lunch". See activity_type_list for the keys configured in this account.'
    ),
    # `due_date` carries the zone note too, and not only `due_time`: the pair is
    # one instant, and converting the hour past midnight moves the day with it.
    # A converted time beside an unconverted date is a booking on the wrong day.
    'due_date': STR(f'Due date, YYYY-MM-DD. {UTC_TIME_DESC}'),
    'due_time': STR(f'Due time, HH:MM. {UTC_TIME_DESC}'),
    'duration': STR(
        'Duration, HH:MM. A LENGTH, not a time of day - no timezone applies and converting '
        'it is a corruption. A two-hour meeting is "02:00" wherever it is held.'
    ),
    'done': INT('0 for not done, 1 for done.'),
    'busy_flag': BOOL('Whether the activity marks the user as busy in the calendar.'),
    'note': STR('Note body (HTML is accepted).'),
    'public_description': STR('Description shown to calendar invitees.'),
    'location': STR('Location of the activity.'),
    'user_id': INT('Owner user id. Defaults to the authenticated user.'),
    'deal_id': INT('Deal this activity belongs to.'),
    'lead_id': STR('Lead uuid this activity belongs to.'),
    'person_id': INT('Person this activity belongs to.'),
    'org_id': INT('Organization this activity belongs to.'),
    'project_id': INT('Project this activity belongs to.'),
    'participants': {
        'type': 'array',
        'items': {'type': 'object'},
        'description': 'Participants, e.g. [{"person_id": 1, "primary_flag": true}].',
    },
    'attendees': {
        'type': 'array',
        'items': {'type': 'object'},
        'description': 'Calendar attendees, e.g. [{"email": "a@example.com"}].',
    },
    'extra': EXTRA(),
}


class ActivitiesMixin(PipedriveToolsBase):
    """Tools for the ``activities`` group."""

    @pipedrive_tool(
        group='activities',
        input_schema=schema(
            **PAGING(),
            user_id=INT('Only activities owned by this user id. Use 0 for all users the token can see.'),
            filter_id=INT('Apply a saved filter by id (see filter_list).'),
            type=STR('Comma-separated activity type keys to include, e.g. "call,meeting".'),
            done=INT('0 for pending activities, 1 for completed. Omit for both.'),
            start_date=STR(
                'Only activities due on or after this date, YYYY-MM-DD. Filters the UTC due_date, '
                'so a range that means a whole day to a person may need widening by one day at each end.'
            ),
            end_date=STR('Only activities due on or before this date, YYYY-MM-DD. Same UTC caveat as start_date.'),
        ),
        description='List activities, optionally filtered by owner, type, completion state or due-date range.',
    )
    def activity_list(self, args):
        args = args_of(args)
        return self._list(
            '/activities',
            args,
            clean_activity,
            extra=params_from(args, ('user_id', 'filter_id', 'type', 'done', 'start_date', 'end_date')),
        )

    @pipedrive_tool(
        group='activities',
        input_schema=schema(required=['activity_id'], activity_id=INT('Activity id.')),
        description='Get a single activity by id.',
    )
    def activity_get(self, args):
        args = args_of(args)
        return self._get(f'/activities/{require_id(args, "activity_id", "activity_get")}', clean_activity)

    @pipedrive_tool(
        group='activities',
        input_schema=schema(required=['subject'], **_ACTIVITY_WRITE_PROPS),
        description='Create an activity (call, meeting, task, ...) and optionally link it to a deal, person or organization.',
    )
    def activity_create(self, args):
        args = args_of(args)
        require_text(args, 'subject', 'activity_create')
        return self._write('POST', '/activities', clean_activity, body=body_from(args, _ACTIVITY_WRITE_KEYS))

    @pipedrive_tool(
        group='activities',
        input_schema=schema(
            required=['activity_id'], activity_id=INT('Activity id to update.'), **_ACTIVITY_WRITE_PROPS
        ),
        description='Update an activity. Pass done=1 to mark it complete.',
    )
    def activity_update(self, args):
        args = args_of(args)
        activity_id = require_id(args, 'activity_id', 'activity_update')
        return self._write(
            'PUT', f'/activities/{activity_id}', clean_activity, body=body_from(args, _ACTIVITY_WRITE_KEYS)
        )

    @pipedrive_tool(
        group='activities',
        input_schema=schema(required=['activity_id'], activity_id=INT('Activity id to delete.')),
        description='Delete an activity.',
    )
    def activity_delete(self, args):
        args = args_of(args)
        return self._delete(f'/activities/{require_id(args, "activity_id", "activity_delete")}')

    @pipedrive_tool(
        group='activities',
        input_schema=schema(required=['ids'], ids=ARR('Activity ids to delete.', 'integer')),
        description='Delete multiple activities in one call.',
    )
    def activity_delete_bulk(self, args):
        return self._delete_bulk('/activities', args_of(args), 'activity_delete_bulk')

    # -- activity types ---------------------------------------------------

    @pipedrive_tool(
        group='activities',
        input_schema=schema(),
        description='List the activity types configured in this Pipedrive account, with the key to pass as activity "type".',
    )
    def activity_type_list(self, args):
        args_of(args)
        data = self._call('GET', '/activityTypes')
        return {'items': list(data or [])}

    @pipedrive_tool(
        group='activities',
        input_schema=schema(
            required=['name', 'icon_key'],
            name=STR('Display name of the activity type.'),
            icon_key=STR('Icon key, e.g. "call", "meeting", "task", "email", "deadline", "lunch".'),
            color=STR('6-character hex colour without the "#".'),
            order_nr=INT('Position of the type in the list.'),
        ),
        description='Create a custom activity type.',
    )
    def activity_type_create(self, args):
        args = args_of(args)
        require_text(args, 'name', 'activity_type_create')
        require_text(args, 'icon_key', 'activity_type_create')
        return self._write(
            'POST', '/activityTypes', passthrough, body=body_from(args, ('name', 'icon_key', 'color', 'order_nr'))
        )

    @pipedrive_tool(
        group='activities',
        input_schema=schema(
            required=['activity_type_id'],
            activity_type_id=INT('Activity type id to update.'),
            name=STR('New display name.'),
            icon_key=STR('New icon key.'),
            color=STR('New 6-character hex colour without the "#".'),
            order_nr=INT('New position in the list.'),
        ),
        description='Update an activity type.',
    )
    def activity_type_update(self, args):
        args = args_of(args)
        type_id = require_id(args, 'activity_type_id', 'activity_type_update')
        return self._write(
            'PUT',
            f'/activityTypes/{type_id}',
            passthrough,
            body=body_from(args, ('name', 'icon_key', 'color', 'order_nr')),
        )

    @pipedrive_tool(
        group='activities',
        input_schema=schema(required=['activity_type_id'], activity_type_id=INT('Activity type id to delete.')),
        description='Delete an activity type.',
    )
    def activity_type_delete(self, args):
        args = args_of(args)
        type_id = require_id(args, 'activity_type_id', 'activity_type_delete')
        return self._delete(f'/activityTypes/{type_id}')

    @pipedrive_tool(
        group='activities',
        input_schema=schema(required=['ids'], ids=ARR('Activity type ids to delete.', 'integer')),
        description='Delete multiple activity types in one call.',
    )
    def activity_type_delete_bulk(self, args):
        return self._delete_bulk('/activityTypes', args_of(args), 'activity_type_delete_bulk')

    # -- activity fields --------------------------------------------------

    @pipedrive_tool(
        group='activities',
        input_schema=schema(**PAGING()),
        description='List the activity fields, including custom fields and their 40-character keys.',
    )
    def activity_field_list(self, args):
        args = args_of(args)
        return self._list('/activityFields', args, clean_field)

    # -- convenience ------------------------------------------------------

    @pipedrive_tool(
        group='activities',
        input_schema=schema(
            required=['activity_id'],
            activity_id=INT('Activity id to mark as done.'),
            done=ENUM('Set to "0" to reopen the activity instead.', ['0', '1']),
        ),
        description='Mark an activity as done (or reopen it with done="0").',
    )
    def activity_mark_done(self, args):
        args = args_of(args)
        activity_id = require_id(args, 'activity_id', 'activity_mark_done')
        done = 0 if str(args.get('done', '1')) == '0' else 1
        return self._write('PUT', f'/activities/{activity_id}', clean_activity, body={'done': done})
