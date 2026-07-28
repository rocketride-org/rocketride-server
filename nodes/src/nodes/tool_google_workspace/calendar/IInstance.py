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
Google Calendar tool node instance.

Exposes the Calendar v3 surface as agent tools: list/get/create/update/move/
delete events (including recurring-series instances and natural-language
quick-add), query free/busy, and manage calendars and access-control (ACL)
rules. Write operations require the ``write`` tier; deleting events or calendars
additionally requires the ``allowDelete`` flag, and ACL rules that expose the
calendar beyond individual grantees (scopeType ``default``/``domain``) require
the ``allowPublicSharing`` flag.

Operational targets (calendarId, eventId, ruleId) are always invoke-time
parameters — never node config. calendarId defaults to ``'primary'``.
"""

from __future__ import annotations

from rocketlib import tool_function

from ai.common.utils import (
    int_arg,
    normalize_tool_input,
    optional_str,
    optional_str_list,
    require_str,
    require_str_list,
)

from ..IInstance import GoogleToolInstanceBase
from .client import (
    SERVICE,
    clean_acl_list,
    clean_acl_rule,
    clean_calendar,
    clean_calendar_list,
    clean_event,
    clean_event_list,
    clean_freebusy,
    execute,
)
from .IGlobal import IGlobal

# sendUpdates controls whether attendee invitations / notifications go out.
# We ALWAYS send it explicitly: Google's implicit default is 'none', which would
# silently NOT notify attendees; the documented node default is 'all'.
_SEND_UPDATES = ('all', 'externalOnly', 'none')
_DEFAULT_SEND_UPDATES = 'all'

# ACL roles accepted by acl_insert.
_ACL_ROLES = ('reader', 'writer', 'owner', 'freeBusyReader')
_ACL_SCOPE_TYPES = ('user', 'group', 'domain', 'default')

_DEFAULT_MAX_RESULTS = 50
_MAX_RESULTS_CAP = 250


class IInstance(GoogleToolInstanceBase):
    IGlobal: IGlobal
    SERVICE = SERVICE

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def _require_delete(self, op: str) -> None:
        """Gate deletion behind the ``allowDelete`` flag (checked after the write tier).

        event_delete / calendar_delete permanently remove data; the write tier
        alone is not consent, so the destructive gate must also be enabled
        explicitly in the node config.
        """
        self._access().require_flag('allowDelete', op)

    @staticmethod
    def _calendar_id(args: dict) -> str:
        """Read the target calendarId, defaulting to 'primary' when omitted."""
        value = args.get('calendarId')
        if value is None or value == '':
            return 'primary'
        if not isinstance(value, str) or not value.strip():
            raise ValueError('"calendarId" must be a non-empty string')
        return value.strip()

    @staticmethod
    def _opt_clearable_str(args: dict, key: str, op: str) -> str | None:
        """Read an optional string that may be empty to clear an existing field."""
        value = args.get(key)
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError(f'{op}: "{key}" must be a string')
        return value

    @staticmethod
    def _require_obj(args: dict, key: str, op: str) -> dict:
        """Validate a required non-empty object (e.g. an event start/end)."""
        value = args.get(key)
        if not isinstance(value, dict) or not value:
            raise ValueError(f'{op}: "{key}" must be a non-empty object')
        return value

    @staticmethod
    def _opt_obj(args: dict, key: str, op: str) -> dict | None:
        """Validate an optional non-empty object when present."""
        value = args.get(key)
        if value is None:
            return None
        if not isinstance(value, dict) or not value:
            raise ValueError(f'{op}: "{key}" must be a non-empty object')
        return value

    @staticmethod
    def _opt_attendees(args: dict, op: str) -> list | None:
        """Validate an optional attendees list of objects (each carrying at least an email)."""
        value = args.get('attendees')
        if value is None:
            return None
        if not isinstance(value, list) or not all(isinstance(a, dict) for a in value):
            raise ValueError(f'{op}: "attendees" must be a list of attendee objects, e.g. [{{"email": "a@b.com"}}]')
        return value

    # =======================================================================
    # DIAGNOSTICS
    # =======================================================================

    @tool_function(
        description=(
            'Check the Google Calendar connection and verify that the granted OAuth scopes cover the '
            "node's configured access tier. Call this when a Calendar operation fails with a scope or "
            'permission error. Returns connection_ok: true when the required scopes are present.'
        ),
        input_schema={'type': 'object', 'properties': {}, 'required': []},
    )
    def check_connection(self, args: dict) -> dict:
        """Check Calendar connection status and whether granted OAuth scopes cover the access tier. Read-only."""
        return self._check_connection_impl(probe=lambda s: execute(s.calendarList().list(maxResults=1)))

    # =======================================================================
    # EVENTS — read
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': [],
            'properties': {
                'calendarId': {'type': 'string', 'description': "Calendar id (default 'primary')"},
                'timeMin': {'type': 'string', 'description': 'RFC3339 lower bound (exclusive) for event end times'},
                'timeMax': {'type': 'string', 'description': 'RFC3339 upper bound (exclusive) for event start times'},
                'q': {'type': 'string', 'description': 'Free-text search over event fields'},
                'maxResults': {
                    'type': 'integer',
                    'description': 'Max events per page, clamped to 1..250 (default 50)',
                },
                'singleEvents': {
                    'type': 'boolean',
                    'description': 'Expand recurring events into single instances (needed for reliable ordering)',
                },
                'pageToken': {
                    'type': 'string',
                    'description': 'nextPageToken from a prior page to fetch the next page',
                },
                'syncToken': {
                    'type': 'string',
                    'description': (
                        'nextSyncToken from a prior full sync. Returns only events changed since then '
                        '(incremental sync). Do not combine with timeMin/timeMax/q.'
                    ),
                },
            },
        },
        description=(
            'List events on a calendar. Returns {events, nextPageToken, nextSyncToken}. '
            'For incremental sync, run once (optionally with a time window), store the returned '
            'nextSyncToken, and pass it back as syncToken next time to receive only changes since. '
            'nextSyncToken is present only on the last page of a fully-consumed listing. '
            'Cleaned events include id, status, summary, description, location, htmlLink, start, end, '
            'organizer, recurrence, attendees, created, and updated when present. Read-only.'
        ),
    )
    def event_list(self, args: dict) -> dict:
        """List events on a calendar, with optional incremental sync via syncToken. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        params: dict = {
            'calendarId': self._calendar_id(args),
            'maxResults': int_arg(args, 'maxResults', default=_DEFAULT_MAX_RESULTS, lo=1, hi=_MAX_RESULTS_CAP),
        }
        for key in ('timeMin', 'timeMax', 'q', 'pageToken', 'syncToken'):
            val = optional_str(args, key, tool_name='event_list')
            if val is not None:
                params[key] = val
        if 'syncToken' in params and any(key in params for key in ('timeMin', 'timeMax', 'q')):
            raise ValueError('event_list: "syncToken" cannot be combined with "timeMin", "timeMax", or "q"')
        single = args.get('singleEvents')
        if single is not None:
            if not isinstance(single, bool):
                raise ValueError('event_list: "singleEvents" must be a boolean')
            params['singleEvents'] = single
        data = execute(self._svc().events().list(**params))
        return clean_event_list(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['eventId'],
            'properties': {
                'calendarId': {'type': 'string', 'description': "Calendar id (default 'primary')"},
                'eventId': {'type': 'string', 'description': 'The event id to fetch'},
            },
        },
        description=(
            'Get a single event by id. Returns the cleaned event. '
            'Cleaned events include id, status, summary, description, location, htmlLink, start, end, '
            'organizer, recurrence, attendees, created, and updated when present. Read-only.'
        ),
    )
    def event_get(self, args: dict) -> dict:
        """Get a single event by id. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        cal_id = self._calendar_id(args)
        event_id = require_str(args, 'eventId', tool_name='event_get')
        data = execute(self._svc().events().get(calendarId=cal_id, eventId=event_id))
        return clean_event(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['eventId'],
            'properties': {
                'calendarId': {'type': 'string', 'description': "Calendar id (default 'primary')"},
                'eventId': {'type': 'string', 'description': 'The recurring-series event id to expand'},
                'maxResults': {
                    'type': 'integer',
                    'description': 'Max instances per page, clamped to 1..250 (default 50)',
                },
                'pageToken': {'type': 'string', 'description': 'nextPageToken from a prior page'},
            },
        },
        description=(
            'Expand a recurring event into its individual instances (occurrences). '
            'Returns {events, nextPageToken}. '
            'Cleaned events include id, status, summary, description, location, htmlLink, start, end, '
            'organizer, recurrence, attendees, created, and updated when present. Read-only.'
        ),
    )
    def event_instances(self, args: dict) -> dict:
        """Expand a recurring event into its individual instances. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        cal_id = self._calendar_id(args)
        event_id = require_str(args, 'eventId', tool_name='event_instances')
        params: dict = {
            'calendarId': cal_id,
            'eventId': event_id,
            'maxResults': int_arg(args, 'maxResults', default=_DEFAULT_MAX_RESULTS, lo=1, hi=_MAX_RESULTS_CAP),
        }
        page_token = optional_str(args, 'pageToken', tool_name='event_instances')
        if page_token is not None:
            params['pageToken'] = page_token
        data = execute(self._svc().events().instances(**params))
        return clean_event_list(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['timeMin', 'timeMax', 'calendarIds'],
            'properties': {
                'timeMin': {'type': 'string', 'description': 'RFC3339 start of the query window'},
                'timeMax': {'type': 'string', 'description': 'RFC3339 end of the query window'},
                'calendarIds': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Calendar ids to query free/busy for (e.g. ["primary", "team@x.com"])',
                },
            },
        },
        description=(
            'Query free/busy information across one or more calendars in a time window. '
            'Returns {timeMin, timeMax, calendars} where each calendar has its busy ranges and any errors. Read-only.'
        ),
    )
    def freebusy_query(self, args: dict) -> dict:
        """Query free/busy ranges across calendars in a time window. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        time_min = require_str(args, 'timeMin', tool_name='freebusy_query')
        time_max = require_str(args, 'timeMax', tool_name='freebusy_query')
        ids = require_str_list(args, 'calendarIds', tool_name='freebusy_query')
        body = {'timeMin': time_min, 'timeMax': time_max, 'items': [{'id': c} for c in ids]}
        data = execute(self._svc().freebusy().query(body=body))
        return clean_freebusy(data)

    # =======================================================================
    # CALENDARS / ACL — read
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': [],
            'properties': {
                'maxResults': {
                    'type': 'integer',
                    'description': 'Max calendars per page, clamped to 1..250 (default 50)',
                },
                'pageToken': {'type': 'string', 'description': 'nextPageToken from a prior page'},
                'syncToken': {'type': 'string', 'description': 'nextSyncToken for incremental calendar-list sync'},
            },
        },
        description=(
            "List the calendars on the user's calendar list. Returns {calendars, nextPageToken, nextSyncToken}. "
            'Read-only.'
        ),
    )
    def calendar_list(self, args: dict) -> dict:
        """List the calendars on the user's calendar list. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        params: dict = {
            'maxResults': int_arg(args, 'maxResults', default=_DEFAULT_MAX_RESULTS, lo=1, hi=_MAX_RESULTS_CAP)
        }
        for key in ('pageToken', 'syncToken'):
            val = optional_str(args, key, tool_name='calendar_list')
            if val is not None:
                params[key] = val
        data = execute(self._svc().calendarList().list(**params))
        return clean_calendar_list(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': [],
            'properties': {
                'calendarId': {'type': 'string', 'description': "Calendar id (default 'primary')"},
            },
        },
        description='Get a calendar resource (metadata: id, summary, timeZone, description). Read-only.',
    )
    def calendar_get(self, args: dict) -> dict:
        """Get a calendar resource by id. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        cal_id = self._calendar_id(args)
        data = execute(self._svc().calendars().get(calendarId=cal_id))
        return clean_calendar(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': [],
            'properties': {
                'calendarId': {'type': 'string', 'description': "Calendar id (default 'primary')"},
                'pageToken': {'type': 'string', 'description': 'nextPageToken from a prior page'},
            },
        },
        description=(
            "List a calendar's access-control (ACL) rules (who can see/edit it and at what role). "
            'Returns {rules, nextPageToken}. Read-only.'
        ),
    )
    def acl_list(self, args: dict) -> dict:
        """List a calendar's ACL rules. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        params: dict = {'calendarId': self._calendar_id(args)}
        page_token = optional_str(args, 'pageToken', tool_name='acl_list')
        if page_token is not None:
            params['pageToken'] = page_token
        data = execute(self._svc().acl().list(**params))
        return clean_acl_list(data)

    # =======================================================================
    # EVENTS — write
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['summary', 'start', 'end'],
            'properties': {
                'calendarId': {'type': 'string', 'description': "Calendar id (default 'primary')"},
                'summary': {'type': 'string', 'description': 'Event title'},
                'start': {
                    'type': 'object',
                    'description': 'Event start, e.g. {"dateTime": "2026-07-11T09:00:00-07:00"} or {"date": "2026-07-11"}',
                },
                'end': {'type': 'object', 'description': 'Event end, same shape as start'},
                'description': {'type': 'string', 'description': 'Event description (optional)'},
                'location': {'type': 'string', 'description': 'Event location (optional)'},
                'attendees': {
                    'type': 'array',
                    'items': {'type': 'object'},
                    'description': 'Attendee objects, e.g. [{"email": "a@b.com"}] (optional)',
                },
                'recurrence': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'RRULE/RDATE/EXDATE lines, e.g. ["RRULE:FREQ=WEEKLY;COUNT=5"] (optional)',
                },
                'sendUpdates': {
                    'type': 'string',
                    'enum': list(_SEND_UPDATES),
                    'description': "Who to notify: 'all' (default), 'externalOnly', or 'none'",
                },
            },
        },
        description=(
            'Create an event. Pass start/end objects through as given. attendees receive invitations at '
            "write tier per sendUpdates (default 'all' — invites are expected to go out, this is not "
            'gated). Cleaned events include id, status, summary, description, location, htmlLink, start, end, '
            'organizer, recurrence, attendees, created, and updated when present. Requires the write tier.'
        ),
    )
    def event_create(self, args: dict) -> dict:
        """Create an event; sends attendee invitations per sendUpdates (default all). Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        self._access().require_write('event_create')
        cal_id = self._calendar_id(args)
        summary = require_str(args, 'summary', tool_name='event_create')
        body: dict = {
            'summary': summary,
            'start': self._require_obj(args, 'start', 'event_create'),
            'end': self._require_obj(args, 'end', 'event_create'),
        }
        self._apply_optional_event_fields(args, body, 'event_create', clearable=False)
        send_updates = self._enum_arg(args, 'sendUpdates', _SEND_UPDATES, _DEFAULT_SEND_UPDATES)
        data = execute(self._svc().events().insert(calendarId=cal_id, body=body, sendUpdates=send_updates))
        return clean_event(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['eventId'],
            'properties': {
                'calendarId': {'type': 'string', 'description': "Calendar id (default 'primary')"},
                'eventId': {'type': 'string', 'description': 'The event id to update'},
                'summary': {'type': 'string', 'description': 'New title (optional)'},
                'start': {'type': 'object', 'description': 'New start object (optional)'},
                'end': {'type': 'object', 'description': 'New end object (optional)'},
                'description': {'type': 'string', 'description': 'New description (optional)'},
                'location': {'type': 'string', 'description': 'New location (optional)'},
                'attendees': {
                    'type': 'array',
                    'items': {'type': 'object'},
                    'description': 'New attendee list (optional)',
                },
                'recurrence': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'New recurrence lines (optional)',
                },
                'sendUpdates': {
                    'type': 'string',
                    'enum': list(_SEND_UPDATES),
                    'description': "Who to notify: 'all' (default), 'externalOnly', or 'none'",
                },
            },
        },
        description=(
            'Partially update an event (events.patch semantics): only the fields you pass are changed, '
            "others are left as-is. Notifies attendees per sendUpdates (default 'all'). "
            'Cleaned events include id, status, summary, description, location, htmlLink, start, end, '
            'organizer, recurrence, attendees, created, and updated when present. Requires the write tier.'
        ),
    )
    def event_update(self, args: dict) -> dict:
        """Partially update an event (patch semantics). Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        self._access().require_write('event_update')
        cal_id = self._calendar_id(args)
        event_id = require_str(args, 'eventId', tool_name='event_update')
        body: dict = {}
        summary = optional_str(args, 'summary', tool_name='event_update')
        if summary is not None:
            body['summary'] = summary
        start = self._opt_obj(args, 'start', 'event_update')
        if start is not None:
            body['start'] = start
        end = self._opt_obj(args, 'end', 'event_update')
        if end is not None:
            body['end'] = end
        self._apply_optional_event_fields(args, body, 'event_update', clearable=True)
        if not body:
            raise ValueError('event_update: provide at least one field to change')
        send_updates = self._enum_arg(args, 'sendUpdates', _SEND_UPDATES, _DEFAULT_SEND_UPDATES)
        data = execute(
            self._svc().events().patch(calendarId=cal_id, eventId=event_id, body=body, sendUpdates=send_updates)
        )
        return clean_event(data)

    def _apply_optional_event_fields(self, args: dict, body: dict, op: str, *, clearable: bool) -> None:
        """Attach the shared optional event fields (description/location/attendees/recurrence) to a body.

        ``clearable``: update ops accept empty strings to clear a field; create
        ops reject them (explicit intent, not inferred from the op label).
        """

        def _strict_reader(a: dict, key: str, o: str):
            return optional_str(a, key, tool_name=o)

        string_reader = self._opt_clearable_str if clearable else _strict_reader
        description = string_reader(args, 'description', op)
        if description is not None:
            body['description'] = description
        location = string_reader(args, 'location', op)
        if location is not None:
            body['location'] = location
        attendees = self._opt_attendees(args, op)
        if attendees is not None:
            body['attendees'] = attendees
        recurrence = optional_str_list(args, 'recurrence', tool_name=op)
        if recurrence is not None:
            body['recurrence'] = recurrence

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['eventId', 'destination'],
            'properties': {
                'calendarId': {'type': 'string', 'description': "Source calendar id (default 'primary')"},
                'eventId': {'type': 'string', 'description': 'The event id to move'},
                'destination': {'type': 'string', 'description': 'Destination calendar id to move the event into'},
                'sendUpdates': {
                    'type': 'string',
                    'enum': list(_SEND_UPDATES),
                    'description': "Who to notify: 'all' (default), 'externalOnly', or 'none'",
                },
            },
        },
        description=(
            'Move an event from one calendar to another. Notifies attendees per sendUpdates '
            "(default 'all'). Cleaned events include id, status, summary, description, location, htmlLink, "
            'start, end, organizer, recurrence, attendees, created, and updated when present. '
            'Requires the write tier.'
        ),
    )
    def event_move(self, args: dict) -> dict:
        """Move an event to another calendar. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        self._access().require_write('event_move')
        cal_id = self._calendar_id(args)
        event_id = require_str(args, 'eventId', tool_name='event_move')
        destination = require_str(args, 'destination', tool_name='event_move')
        send_updates = self._enum_arg(args, 'sendUpdates', _SEND_UPDATES, _DEFAULT_SEND_UPDATES)
        data = execute(
            self._svc()
            .events()
            .move(calendarId=cal_id, eventId=event_id, destination=destination, sendUpdates=send_updates)
        )
        return clean_event(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['text'],
            'properties': {
                'calendarId': {'type': 'string', 'description': "Calendar id (default 'primary')"},
                'text': {
                    'type': 'string',
                    'description': 'Natural-language event text, e.g. "Lunch with Sam tomorrow at noon"',
                },
                'sendUpdates': {
                    'type': 'string',
                    'enum': list(_SEND_UPDATES),
                    'description': "Who to notify: 'all' (default), 'externalOnly', or 'none'",
                },
            },
        },
        description=(
            'Create an event from a natural-language phrase (Google parses date/time/title). '
            "Notifies attendees per sendUpdates (default 'all'). "
            'Returns the created event. Cleaned events include id, status, summary, description, location, '
            'htmlLink, start, end, organizer, recurrence, attendees, created, and updated when present. '
            'Requires the write tier.'
        ),
    )
    def event_quick_add(self, args: dict) -> dict:
        """Create an event from a natural-language phrase (quickAdd). Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        self._access().require_write('event_quick_add')
        cal_id = self._calendar_id(args)
        text = require_str(args, 'text', tool_name='event_quick_add')
        send_updates = self._enum_arg(args, 'sendUpdates', _SEND_UPDATES, _DEFAULT_SEND_UPDATES)
        data = execute(self._svc().events().quickAdd(calendarId=cal_id, text=text, sendUpdates=send_updates))
        return clean_event(data)

    # =======================================================================
    # CALENDARS / ACL — write
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['summary'],
            'properties': {
                'summary': {'type': 'string', 'description': 'Title for the new calendar'},
                'timeZone': {'type': 'string', 'description': 'IANA time zone, e.g. "America/Los_Angeles" (optional)'},
                'description': {'type': 'string', 'description': 'Calendar description (optional)'},
            },
        },
        description='Create a new secondary calendar. Returns its id and metadata. Requires the write tier.',
    )
    def calendar_create(self, args: dict) -> dict:
        """Create a new secondary calendar. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        self._access().require_write('calendar_create')
        summary = require_str(args, 'summary', tool_name='calendar_create')
        body: dict = {'summary': summary}
        time_zone = optional_str(args, 'timeZone', tool_name='calendar_create')
        if time_zone is not None:
            body['timeZone'] = time_zone
        description = optional_str(args, 'description', tool_name='calendar_create')
        if description is not None:
            body['description'] = description
        data = execute(self._svc().calendars().insert(body=body))
        return clean_calendar(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': [],
            'properties': {
                'calendarId': {'type': 'string', 'description': "Calendar id (default 'primary')"},
                'summary': {'type': 'string', 'description': 'New title (optional)'},
                'timeZone': {'type': 'string', 'description': 'New IANA time zone (optional)'},
                'description': {'type': 'string', 'description': 'New description (optional)'},
            },
        },
        description=(
            'Partially update a calendar (calendars.patch semantics): only the fields you pass are '
            'changed. Requires the write tier.'
        ),
    )
    def calendar_update(self, args: dict) -> dict:
        """Partially update a calendar (patch semantics). Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        self._access().require_write('calendar_update')
        cal_id = self._calendar_id(args)
        body: dict = {}
        for key in ('summary', 'timeZone'):
            val = optional_str(args, key, tool_name='calendar_update')
            if val is not None:
                body[key] = val
        # description may be an empty string to clear the existing value.
        description = self._opt_clearable_str(args, 'description', 'calendar_update')
        if description is not None:
            body['description'] = description
        if not body:
            raise ValueError('calendar_update: provide at least one field to change')
        data = execute(self._svc().calendars().patch(calendarId=cal_id, body=body))
        return clean_calendar(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['role', 'scopeType'],
            'properties': {
                'calendarId': {'type': 'string', 'description': "Calendar id (default 'primary')"},
                'role': {
                    'type': 'string',
                    'enum': list(_ACL_ROLES),
                    'description': 'Access role to grant: reader, writer, owner, or freeBusyReader',
                },
                'scopeType': {
                    'type': 'string',
                    'enum': list(_ACL_SCOPE_TYPES),
                    'description': (
                        'Grantee scope type: "user", "group", "domain", or "default" (public). '
                        '"default" and "domain" expose the calendar broadly and require the '
                        'allowPublicSharing flag.'
                    ),
                },
                'scopeValue': {
                    'type': 'string',
                    'description': 'The email/domain the scope refers to (omit for scopeType "default")',
                },
            },
        },
        description=(
            'Grant a calendar access-control rule (share the calendar) at the given role and scope. '
            "Rules with scopeType 'default' (anyone on the internet) or 'domain' (a whole domain) "
            'additionally require the allowPublicSharing flag. '
            'This is a sharing change (write tier), not a deletion. Requires the write tier.'
        ),
    )
    def acl_insert(self, args: dict) -> dict:
        """Grant a calendar ACL rule (share the calendar). Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        self._access().require_write('acl_insert')
        cal_id = self._calendar_id(args)
        role = self._enum_arg(args, 'role', _ACL_ROLES, None)
        if role is None:
            raise ValueError(f'acl_insert: "role" is required and must be one of {list(_ACL_ROLES)}')
        scope_type = self._enum_arg(args, 'scopeType', _ACL_SCOPE_TYPES, None)
        if scope_type is None:
            raise ValueError(f'acl_insert: "scopeType" is required and must be one of {list(_ACL_SCOPE_TYPES)}')
        if scope_type in ('default', 'domain'):
            # Exposure gate: 'default' shares with anyone on the internet and
            # 'domain' with a whole domain. Like tool_drive's sharing gate, the
            # write tier alone is not consent for that blast radius.
            self._access().require_flag(
                'allowPublicSharing',
                f'acl_insert (scopeType={scope_type!r} exposes the calendar beyond individual grantees)',
            )
        scope: dict = {'type': scope_type}
        scope_value = optional_str(args, 'scopeValue', tool_name='acl_insert')
        if scope_type != 'default' and scope_value is None:
            raise ValueError(f'acl_insert: "scopeValue" is required for scopeType {scope_type!r}')
        if scope_value is not None:
            scope['value'] = scope_value
        body = {'role': role, 'scope': scope}
        data = execute(self._svc().acl().insert(calendarId=cal_id, body=body))
        return clean_acl_rule(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['ruleId'],
            'properties': {
                'calendarId': {'type': 'string', 'description': "Calendar id (default 'primary')"},
                'ruleId': {'type': 'string', 'description': 'The ACL rule id to remove (from acl_list)'},
            },
        },
        description=(
            'Remove a calendar access-control rule (revoke sharing). This is a sharing change at the '
            'write tier — it is NOT gated by allowDelete (that flag guards event/calendar deletion). '
            'Requires the write tier.'
        ),
    )
    def acl_delete(self, args: dict) -> dict:
        """Remove a calendar ACL rule (revoke sharing). Write tier; not allowDelete-gated."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        self._access().require_write('acl_delete')
        cal_id = self._calendar_id(args)
        rule_id = require_str(args, 'ruleId', tool_name='acl_delete')
        execute(self._svc().acl().delete(calendarId=cal_id, ruleId=rule_id))
        return {'deletedRuleId': rule_id}

    # =======================================================================
    # EVENTS / CALENDARS — delete (write tier + allowDelete flag)
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['eventId'],
            'properties': {
                'calendarId': {'type': 'string', 'description': "Calendar id (default 'primary')"},
                'eventId': {'type': 'string', 'description': 'The event id to delete'},
                'sendUpdates': {
                    'type': 'string',
                    'enum': list(_SEND_UPDATES),
                    'description': "Who to notify of the cancellation: 'all' (default), 'externalOnly', or 'none'",
                },
            },
        },
        description=(
            'Permanently delete an event (irreversible). Notifies attendees per sendUpdates '
            "(default 'all'). Requires the write tier AND the allowDelete flag."
        ),
    )
    def event_delete(self, args: dict) -> dict:
        """Permanently delete an event. Requires the write tier AND allowDelete."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        self._access().require_write('event_delete')
        self._require_delete('event_delete')
        cal_id = self._calendar_id(args)
        event_id = require_str(args, 'eventId', tool_name='event_delete')
        send_updates = self._enum_arg(args, 'sendUpdates', _SEND_UPDATES, _DEFAULT_SEND_UPDATES)
        execute(self._svc().events().delete(calendarId=cal_id, eventId=event_id, sendUpdates=send_updates))
        return {'deletedEventId': event_id}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['calendarId'],
            'properties': {
                'calendarId': {'type': 'string', 'description': 'The calendar id to delete (secondary calendars only)'},
            },
        },
        description=(
            'Permanently delete a secondary calendar (irreversible). Requires the write tier AND the allowDelete flag.'
        ),
    )
    def calendar_delete(self, args: dict) -> dict:
        """Permanently delete a secondary calendar. Requires the write tier AND allowDelete."""
        args = normalize_tool_input(args, tool_name='tool_calendar')
        self._access().require_write('calendar_delete')
        self._require_delete('calendar_delete')
        cal_id = require_str(args, 'calendarId', tool_name='calendar_delete')
        execute(self._svc().calendars().delete(calendarId=cal_id))
        return {'deletedCalendarId': cal_id}
