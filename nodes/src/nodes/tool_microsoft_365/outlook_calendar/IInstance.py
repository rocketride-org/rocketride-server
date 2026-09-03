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
Outlook Calendar tool node instance.

Exposes the Microsoft Graph calendar API as agent tools: list/read events
(including calendarView expansion of recurring series), create/update/delete
events, respond to invitations, find meeting times, get free/busy schedules,
list/create calendars, and delta-sync a calendar view. Operates on the
acting user's calendar.

Two access tiers gate the surface (``nodes.core.microsoft_access.OUTLOOK_CALENDAR``):
``readonly`` (Calendars.Read) and ``write`` (Calendars.ReadWrite, the
default). No gate flags — unlike Outlook Mail's hard-delete flag, calendar
event deletion needs only the write tier.

Event ``start``/``end`` values are Graph ``dateTimeTimeZone`` objects
(``{'dateTime': 'YYYY-MM-DDTHH:MM:SS', 'timeZone': 'UTC'}``). Tools accept
either a plain ISO-ish string (wrapped as UTC) or an already-shaped dict —
see :func:`client.event_datetime`. ``attendees`` is a list of email
addresses, mapped to Graph's recipient shape via :func:`client.attendee_list`.
Attendee invites (create/update event) are sent by Graph itself once the
event is written — the write tier is what gates the Graph call, not the
`send` of the resulting invite email.

Operational targets (event id, calendar id) are always invoke-time
parameters — never node config.
"""

from __future__ import annotations

from rocketlib import tool_function

from ai.common.utils import (
    int_arg,
    normalize_tool_input,
    optional_str,
    require_str,
    require_str_list,
)

from .. import graph_client
from ..IInstance import MicrosoftToolInstanceBase
from .client import (
    CALENDAR_SELECT,
    EVENT_SELECT,
    MAX_TOP,
    SERVICE,
    _seg,
    attendee_list,
    clean_calendar,
    clean_event,
    event_datetime,
    request,
)
from .IGlobal import IGlobal

_RESPONSE_VALUES = ('accept', 'decline', 'tentativelyAccept')


class IInstance(MicrosoftToolInstanceBase):
    IGlobal: IGlobal
    SERVICE = SERVICE

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def _base(self) -> str:
        return graph_client.user_base(self.IGlobal.cfg)

    def _event(self, event_id: str) -> str:
        return f'{self._base()}/events/{_seg(event_id)}'

    def _calendar_events_base(self, calendar: str) -> str:
        """Return the events-container path: the default calendar, or a specific one by id."""
        return f'{self._base()}/calendars/{_seg(calendar)}' if calendar else self._base()

    @staticmethod
    def _dt_arg(args: dict, key: str, op: str) -> dict:
        """Validate and build a Graph ``dateTimeTimeZone`` value from a required string/dict arg."""
        value = args.get(key)
        if value is None or (isinstance(value, str) and not value.strip()):
            raise ValueError(f'{op}: "{key}" is required')
        if not isinstance(value, (str, dict)):
            raise ValueError(f'{op}: "{key}" must be a string or a {{dateTime, timeZone}} object')
        return event_datetime(value)

    @staticmethod
    def _attendees_arg(args: dict, op: str) -> list[dict] | None:
        """Validate the optional ``attendees`` list-of-emails arg; None means "not supplied"."""
        attendees = args.get('attendees')
        if attendees is None:
            return None
        if not isinstance(attendees, list) or not all(isinstance(e, str) and e.strip() for e in attendees):
            raise ValueError(f'{op}: "attendees" must be a list of email address strings')
        return attendee_list(attendees)

    def _compose_event(self, args: dict, op: str) -> dict:
        """Build a full Graph ``event`` body for create_event (subject/start/end required)."""
        out: dict = {
            'subject': require_str(args, 'subject', tool_name=op),
            'start': self._dt_arg(args, 'start', op),
            'end': self._dt_arg(args, 'end', op),
        }
        body = optional_str(args, 'body', default='', tool_name=op) or ''
        if body:
            out['body'] = {'contentType': 'Text', 'content': body}
        attendees = self._attendees_arg(args, op)
        if attendees:
            out['attendees'] = attendees
        location = optional_str(args, 'location', default='', tool_name=op) or ''
        if location:
            out['location'] = {'displayName': location}
        return out

    # =======================================================================
    # DIAGNOSTICS
    # =======================================================================

    @tool_function(
        description=(
            'Check the Outlook Calendar/Graph connection and verify that the granted OAuth scopes cover '
            "the node's configured access tier. Call this when an Outlook Calendar operation fails with a "
            'scope or permission error. Returns connection_ok: true when the required scopes are present.'
        ),
        input_schema={'type': 'object', 'properties': {}, 'required': []},
    )
    def outlook_calendar_check_connection(self, args: dict) -> dict:
        """Check the Outlook Calendar connection and whether granted OAuth scopes cover the access tier. Read-only."""
        base = self._base()

        def _probe(auth):
            request(auth, 'GET', f'{base}/calendar')

        return self._check_connection_impl(probe=_probe)

    # =======================================================================
    # EVENTS — read
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['start', 'end'],
            'properties': {
                'start': {'type': 'string', 'description': "Window start, ISO 8601 e.g. '2026-08-11T00:00:00'"},
                'end': {'type': 'string', 'description': "Window end, ISO 8601 e.g. '2026-08-18T00:00:00'"},
                'calendar': {
                    'type': 'string',
                    'description': 'Calendar id to list from; empty/omitted uses the default calendar',
                },
            },
        },
        description=(
            'List events in a calendar view between start and end (calendarView — recurring series are '
            'expanded into their individual occurrences). Uses the default calendar unless "calendar" is given. '
            f'Returns at most {MAX_TOP} events per call; "next_link" is the Graph @odata.nextLink continuation URL '
            'when the window holds more, else null — narrow the window to page through them.'
        ),
    )
    def outlook_calendar_list_events(self, args: dict) -> dict:
        """List events in a calendar view between start and end. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_outlook_calendar')
        op = 'outlook_calendar_list_events'
        start = require_str(args, 'start', tool_name=op)
        end = require_str(args, 'end', tool_name=op)
        calendar = optional_str(args, 'calendar', default='', tool_name=op) or ''
        params = {'startDateTime': start, 'endDateTime': end, '$top': MAX_TOP, '$select': EVENT_SELECT}
        data = request(self.IGlobal.auth, 'GET', f'{self._calendar_events_base(calendar)}/calendarView', params=params)
        return {
            'events': [clean_event(e) for e in data.get('value') or []],
            'next_link': data.get('@odata.nextLink'),
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['event_id'],
            'properties': {
                'event_id': {'type': 'string', 'description': 'Event id'},
            },
        },
        description='Get a single calendar event by id.',
    )
    def outlook_calendar_get_event(self, args: dict) -> dict:
        """Get a single calendar event by id. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_outlook_calendar')
        event_id = require_str(args, 'event_id', tool_name='outlook_calendar_get_event')
        data = request(self.IGlobal.auth, 'GET', self._event(event_id))
        return clean_event(data)

    # =======================================================================
    # EVENTS — write
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['subject', 'start', 'end'],
            'properties': {
                'subject': {'type': 'string', 'description': 'Event subject/title'},
                'start': {
                    'oneOf': [
                        {'type': 'string'},
                        {
                            'type': 'object',
                            'required': ['dateTime', 'timeZone'],
                            'properties': {
                                'dateTime': {'type': 'string'},
                                'timeZone': {'type': 'string'},
                            },
                        },
                    ],
                    'description': (
                        "Start time: ISO 8601 string e.g. '2026-08-11T14:00:00' (treated as UTC), or a Graph "
                        '{dateTime, timeZone} object for a specific time zone'
                    ),
                },
                'end': {
                    'oneOf': [
                        {'type': 'string'},
                        {
                            'type': 'object',
                            'required': ['dateTime', 'timeZone'],
                            'properties': {
                                'dateTime': {'type': 'string'},
                                'timeZone': {'type': 'string'},
                            },
                        },
                    ],
                    'description': (
                        "End time: ISO 8601 string e.g. '2026-08-11T14:30:00' (treated as UTC), or a Graph "
                        '{dateTime, timeZone} object for a specific time zone'
                    ),
                },
                'body': {'type': 'string', 'description': 'Event description/body text'},
                'attendees': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Attendee email addresses. Graph sends them an invite once the event is created.',
                },
                'location': {'type': 'string', 'description': 'Location display name'},
                'calendar': {
                    'type': 'string',
                    'description': 'Calendar id to create the event in; empty/omitted uses the default calendar',
                },
            },
        },
        description=(
            'Create a calendar event. Uses the default calendar unless "calendar" is given. Any '
            '"attendees" are invited by Graph as part of creating the event. Requires the write tier.'
        ),
    )
    def outlook_calendar_create_event(self, args: dict) -> dict:
        """Create a calendar event, optionally inviting attendees. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_calendar')
        op = 'outlook_calendar_create_event'
        self.IGlobal.access.require_write(op)
        calendar = optional_str(args, 'calendar', default='', tool_name=op) or ''
        event = self._compose_event(args, op)
        data = request(self.IGlobal.auth, 'POST', f'{self._calendar_events_base(calendar)}/events', json_body=event)
        return clean_event(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['event_id'],
            'properties': {
                'event_id': {'type': 'string', 'description': 'Event id to update'},
                'subject': {'type': 'string', 'description': 'New subject/title'},
                'start': {
                    'oneOf': [
                        {'type': 'string'},
                        {
                            'type': 'object',
                            'required': ['dateTime', 'timeZone'],
                            'properties': {
                                'dateTime': {'type': 'string'},
                                'timeZone': {'type': 'string'},
                            },
                        },
                    ],
                    'description': 'New start time: ISO 8601 string (treated as UTC) or a Graph {dateTime, timeZone} object',
                },
                'end': {
                    'oneOf': [
                        {'type': 'string'},
                        {
                            'type': 'object',
                            'required': ['dateTime', 'timeZone'],
                            'properties': {
                                'dateTime': {'type': 'string'},
                                'timeZone': {'type': 'string'},
                            },
                        },
                    ],
                    'description': 'New end time: ISO 8601 string (treated as UTC) or a Graph {dateTime, timeZone} object',
                },
                'body': {'type': 'string', 'description': 'New description/body text'},
                'attendees': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': (
                        'Replacement attendee email addresses. Graph (re)sends invites/updates to the new '
                        'list as part of the update.'
                    ),
                },
                'location': {'type': 'string', 'description': 'New location display name'},
            },
        },
        description=(
            'Update a calendar event. Only the fields provided are changed (PATCH) — omitted fields are '
            'left as-is. Requires the write tier.'
        ),
    )
    def outlook_calendar_update_event(self, args: dict) -> dict:
        """Update a calendar event, changing only the fields provided. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_calendar')
        op = 'outlook_calendar_update_event'
        self.IGlobal.access.require_write(op)
        event_id = require_str(args, 'event_id', tool_name=op)
        patch: dict = {}
        subject = optional_str(args, 'subject', default=None, tool_name=op)
        if subject is not None:
            patch['subject'] = subject
        if args.get('start') is not None:
            patch['start'] = self._dt_arg(args, 'start', op)
        if args.get('end') is not None:
            patch['end'] = self._dt_arg(args, 'end', op)
        body = optional_str(args, 'body', default=None, tool_name=op)
        if body is not None:
            patch['body'] = {'contentType': 'Text', 'content': body}
        attendees = self._attendees_arg(args, op)
        if attendees is not None:
            patch['attendees'] = attendees
        location = optional_str(args, 'location', default=None, tool_name=op)
        if location is not None:
            patch['location'] = {'displayName': location}
        if not patch:
            raise ValueError(f'{op}: at least one field to update must be provided')
        data = request(self.IGlobal.auth, 'PATCH', self._event(event_id), json_body=patch)
        return clean_event(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['event_id'],
            'properties': {
                'event_id': {'type': 'string', 'description': 'Event id to delete'},
            },
        },
        description='Delete a calendar event. Requires the write tier.',
    )
    def outlook_calendar_delete_event(self, args: dict) -> dict:
        """Delete a calendar event. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_calendar')
        op = 'outlook_calendar_delete_event'
        self.IGlobal.access.require_write(op)
        event_id = require_str(args, 'event_id', tool_name=op)
        request(self.IGlobal.auth, 'DELETE', self._event(event_id))
        return {'deleted': event_id}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['event_id', 'response'],
            'properties': {
                'event_id': {'type': 'string', 'description': 'Event id to respond to'},
                'response': {
                    'type': 'string',
                    'enum': list(_RESPONSE_VALUES),
                    'description': "One of 'accept', 'decline', 'tentativelyAccept'",
                },
                'comment': {'type': 'string', 'description': 'Optional comment to include with the response'},
            },
        },
        description='Respond to a meeting invitation (accept/decline/tentatively accept). Requires the write tier.',
    )
    def outlook_calendar_respond(self, args: dict) -> dict:
        """Respond to a meeting invitation. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_calendar')
        op = 'outlook_calendar_respond'
        self.IGlobal.access.require_write(op)
        event_id = require_str(args, 'event_id', tool_name=op)
        response = self._enum_arg(args, 'response', _RESPONSE_VALUES, None)
        if response is None:
            raise ValueError(f'{op}: "response" is required and must be one of {list(_RESPONSE_VALUES)}')
        comment = optional_str(args, 'comment', default='', tool_name=op) or ''
        request(self.IGlobal.auth, 'POST', f'{self._event(event_id)}/{response}', json_body={'comment': comment})
        return {'responded': event_id, 'response': response}

    # =======================================================================
    # SCHEDULING — read-class (no write guard)
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['attendees'],
            'properties': {
                'attendees': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Attendee email addresses to find a common meeting time for',
                },
                'duration_minutes': {
                    'type': 'integer',
                    'description': 'Desired meeting length in minutes (default 30)',
                },
                'window_start': {
                    'type': 'string',
                    'description': 'Search window start, ISO 8601; omit to let Graph pick a default window',
                },
                'window_end': {
                    'type': 'string',
                    'description': 'Search window end, ISO 8601; omit to let Graph pick a default window',
                },
            },
        },
        description=(
            'Suggest meeting times that work for a set of attendees. NOTE: findMeetingTimes needs a '
            "delegated (signed-in user) context on Microsoft's side and may not be supported under "
            'app-only (client-credentials) authentication — expect a Graph error there.'
        ),
    )
    def outlook_calendar_find_meeting_times(self, args: dict) -> dict:
        """Suggest meeting times for a set of attendees. May be unsupported under app-only auth."""
        args = normalize_tool_input(args, tool_name='tool_outlook_calendar')
        op = 'outlook_calendar_find_meeting_times'
        attendees = require_str_list(args, 'attendees', tool_name=op)
        duration_minutes = int_arg(args, 'duration_minutes', default=30, lo=5, hi=480, tool_name=op)
        window_start = optional_str(args, 'window_start', default='', tool_name=op) or ''
        window_end = optional_str(args, 'window_end', default='', tool_name=op) or ''
        if bool(window_start) != bool(window_end):
            raise ValueError(f'{op}: "window_start" and "window_end" must be provided together')
        body: dict = {
            'attendees': attendee_list(attendees),
            'meetingDuration': f'PT{duration_minutes}M',
        }
        if window_start and window_end:
            body['timeConstraint'] = {
                'timeslots': [{'start': event_datetime(window_start), 'end': event_datetime(window_end)}]
            }
        data = request(self.IGlobal.auth, 'POST', f'{self._base()}/findMeetingTimes', json_body=body)
        return {'suggestions': data.get('meetingTimeSuggestions') or []}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['emails', 'start', 'end'],
            'properties': {
                'emails': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Mailbox email addresses to get free/busy schedule information for',
                },
                'start': {
                    'oneOf': [
                        {'type': 'string'},
                        {
                            'type': 'object',
                            'required': ['dateTime', 'timeZone'],
                            'properties': {
                                'dateTime': {'type': 'string'},
                                'timeZone': {'type': 'string'},
                            },
                        },
                    ],
                    'description': (
                        "Window start: ISO 8601 string e.g. '2026-08-11T00:00:00' (treated as UTC), or a Graph "
                        '{dateTime, timeZone} object'
                    ),
                },
                'end': {
                    'oneOf': [
                        {'type': 'string'},
                        {
                            'type': 'object',
                            'required': ['dateTime', 'timeZone'],
                            'properties': {
                                'dateTime': {'type': 'string'},
                                'timeZone': {'type': 'string'},
                            },
                        },
                    ],
                    'description': (
                        "Window end: ISO 8601 string e.g. '2026-08-11T23:59:59' (treated as UTC), or a Graph "
                        '{dateTime, timeZone} object'
                    ),
                },
            },
        },
        description='Get free/busy schedule information for a set of mailboxes over a time window.',
    )
    def outlook_calendar_get_schedule(self, args: dict) -> dict:
        """Get free/busy schedule information for a set of mailboxes. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_outlook_calendar')
        op = 'outlook_calendar_get_schedule'
        emails = require_str_list(args, 'emails', tool_name=op)
        body = {
            'schedules': emails,
            'startTime': self._dt_arg(args, 'start', op),
            'endTime': self._dt_arg(args, 'end', op),
        }
        data = request(self.IGlobal.auth, 'POST', f'{self._base()}/calendar/getSchedule', json_body=body)
        return {'schedules': data.get('value') or []}

    # =======================================================================
    # CALENDARS
    # =======================================================================

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description="List the calendars in the acting user's mailbox.",
    )
    def outlook_calendar_list_calendars(self, args: dict) -> dict:
        """List the calendars in the mailbox. Read-only."""
        normalize_tool_input(args, tool_name='tool_outlook_calendar')
        data = request(
            self.IGlobal.auth, 'GET', f'{self._base()}/calendars', params={'$top': 100, '$select': CALENDAR_SELECT}
        )
        return {'calendars': [clean_calendar(c) for c in data.get('value') or []]}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['name'],
            'properties': {
                'name': {'type': 'string', 'description': 'Name for the new calendar'},
            },
        },
        description='Create a new calendar. Requires the write tier.',
    )
    def outlook_calendar_create_calendar(self, args: dict) -> dict:
        """Create a new calendar. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_calendar')
        op = 'outlook_calendar_create_calendar'
        self.IGlobal.access.require_write(op)
        name = require_str(args, 'name', tool_name=op)
        data = request(self.IGlobal.auth, 'POST', f'{self._base()}/calendars', json_body={'name': name})
        return clean_calendar(data)

    # =======================================================================
    # DELTA SYNC — read-class (no write guard)
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'start': {
                    'type': 'string',
                    'description': 'Window start for the first sync call, ISO 8601. Required unless delta_link is given.',
                },
                'end': {
                    'type': 'string',
                    'description': 'Window end for the first sync call, ISO 8601. Required unless delta_link is given.',
                },
                'delta_link': {
                    'type': 'string',
                    'description': (
                        'The deltaLink returned by a previous call, to fetch only what changed since then. '
                        'Omit on the first call.'
                    ),
                },
            },
        },
        description=(
            'Sync a calendar view incrementally. First call with "start"/"end"; pass the returned '
            '"delta_link" back in on subsequent calls to fetch only what changed. Returns {events, '
            'delta_link, next_link}.'
        ),
    )
    def outlook_calendar_delta_sync(self, args: dict) -> dict:
        """Sync a calendar view incrementally, using a caller-provided delta_link after the first call. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_outlook_calendar')
        op = 'outlook_calendar_delta_sync'
        delta_link = optional_str(args, 'delta_link', default='', tool_name=op) or ''
        if delta_link:
            data = request(self.IGlobal.auth, 'GET', delta_link)
        else:
            start = require_str(args, 'start', tool_name=op)
            end = require_str(args, 'end', tool_name=op)
            params = {'startDateTime': start, 'endDateTime': end}
            data = request(self.IGlobal.auth, 'GET', f'{self._base()}/calendarView/delta', params=params)
        return {
            'events': [clean_event(e) for e in data.get('value') or []],
            'delta_link': data.get('@odata.deltaLink'),
            'next_link': data.get('@odata.nextLink'),
        }
