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

"""Outlook Calendar service bindings, event body builders, and response cleaners."""

from __future__ import annotations

import functools
import urllib.parse

from .. import graph_client

SERVICE = graph_client.GraphService(product='Outlook Calendar', superset_scopes=frozenset({'Calendars.ReadWrite'}))

token_scope_report = functools.partial(graph_client.token_scope_report, SERVICE)
request = functools.partial(graph_client.request, SERVICE)

# Graph's ceiling this node applies to list_events' $top.
MAX_TOP = 100


def _seg(value: str) -> str:
    """URL-encode a single path segment (event/calendar ids may contain '!' etc.)."""
    return urllib.parse.quote(value, safe='')


# ---------------------------------------------------------------------------
# Event body builders
# ---------------------------------------------------------------------------


def event_datetime(value: str | dict) -> dict:
    """Build a Graph ``dateTimeTimeZone`` value from a plain string or pass an already-shaped dict through.

    A plain ``'YYYY-MM-DDTHH:MM:SS'`` string is wrapped as
    ``{'dateTime': value, 'timeZone': 'UTC'}``. A dict is assumed to already
    be shaped like ``{'dateTime': ..., 'timeZone': ...}`` and is passed
    through unchanged, so callers that already know a specific time zone can
    supply it directly.
    """
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        return {'dateTime': value, 'timeZone': 'UTC'}
    raise ValueError(f'event_datetime: expected a string or dict, got {type(value).__name__}')


def attendee_list(emails: list[str]) -> list[dict]:
    """Build a Graph ``attendees`` array: ``[{'emailAddress': {'address': e}, 'type': 'required'}, ...]``."""
    return [{'emailAddress': {'address': e}, 'type': 'required'} for e in emails]


# ---------------------------------------------------------------------------
# Response cleaners
# ---------------------------------------------------------------------------

_EVENT_FIELDS = (
    'id',
    'subject',
    'start',
    'end',
    'isAllDay',
    'isCancelled',
    'seriesMasterId',
    'recurrence',
    'webLink',
    'bodyPreview',
)

_CALENDAR_FIELDS = ('id', 'name', 'isDefaultCalendar', 'canEdit')

# $select strings for list endpoints, built from the cleaner field tuples so
# the wire request and the response cleaner can never drift apart.
EVENT_SELECT = ','.join(_EVENT_FIELDS + ('location', 'organizer', 'attendees', 'onlineMeeting'))
CALENDAR_SELECT = ','.join(_CALENDAR_FIELDS + ('owner',))


def clean_event(event: dict | None) -> dict:
    """Compact a Graph event to the fields agents actually need."""
    if not isinstance(event, dict):
        return {}
    out = {k: event.get(k) for k in _EVENT_FIELDS if k in event}
    location = event.get('location') or {}
    if location:
        out['location'] = {'displayName': location.get('displayName')}
    organizer = (event.get('organizer') or {}).get('emailAddress') or {}
    if organizer:
        out['organizer'] = {'emailAddress': organizer}
    attendees = event.get('attendees')
    if attendees is not None:
        out['attendees'] = [
            {
                'emailAddress': (a.get('emailAddress') or {}),
                'status': a.get('status'),
            }
            for a in attendees
        ]
    online_meeting = event.get('onlineMeeting') or {}
    if online_meeting:
        out['onlineMeeting'] = {'joinUrl': online_meeting.get('joinUrl')}
    return out


def clean_calendar(calendar: dict | None) -> dict:
    """Compact a Graph calendar to the fields agents actually need.

    ``owner`` is already an ``emailAddress``-typed object on the Graph
    calendar resource (``{'name': ..., 'address': ...}``), unlike an event's
    ``organizer`` which nests one level deeper — so it is passed through
    as-is rather than unwrapped.
    """
    if not isinstance(calendar, dict):
        return {}
    out = {k: calendar.get(k) for k in _CALENDAR_FIELDS if k in calendar}
    if 'owner' in calendar:
        out['owner'] = calendar.get('owner')
    return out
