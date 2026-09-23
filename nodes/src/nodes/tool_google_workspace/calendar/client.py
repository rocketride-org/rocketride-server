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

"""Google Calendar-specific service bindings and response cleaners."""

from __future__ import annotations

import functools

from .. import google_client

SERVICE = google_client.GoogleService(
    product='Google Calendar',
    api='calendar',
    version='v3',
    superset_scopes=frozenset({'https://www.googleapis.com/auth/calendar'}),
)

execute = functools.partial(google_client.execute, SERVICE)


# ---------------------------------------------------------------------------
# Response cleaners
# ---------------------------------------------------------------------------


def _clean_attendee(att: dict | None) -> dict:
    """Compact a single attendee: email + responseStatus."""
    if not isinstance(att, dict):
        return {}
    return {k: att[k] for k in ('email', 'responseStatus') if k in att}


def clean_event(ev: dict | None) -> dict:
    """Compact a Calendar event into an agent-friendly shape."""
    if not isinstance(ev, dict):
        return {}
    out: dict = {
        'id': ev.get('id'),
        'status': ev.get('status'),
        'summary': ev.get('summary'),
        'description': ev.get('description'),
        'location': ev.get('location'),
        'htmlLink': ev.get('htmlLink'),
        'start': ev.get('start'),
        'end': ev.get('end'),
        'organizer': ev.get('organizer'),
        'recurrence': ev.get('recurrence'),
        'created': ev.get('created'),
        'updated': ev.get('updated'),
    }
    if ev.get('attendees') is not None:
        out['attendees'] = [_clean_attendee(a) for a in ev.get('attendees') or []]
    return {k: v for k, v in out.items() if v is not None}


def clean_event_list(resp: dict | None) -> dict:
    """Compact an events list/instances response: events + sync/page tokens.

    ``nextSyncToken`` is only present on a fully-consumed (last-page) result and
    is what an agent passes back as ``syncToken`` for the next incremental sync.
    """
    if not isinstance(resp, dict):
        return {}
    out: dict = {'events': [clean_event(e) for e in resp.get('items') or []]}
    if resp.get('nextPageToken') is not None:
        out['nextPageToken'] = resp.get('nextPageToken')
    if resp.get('nextSyncToken') is not None:
        out['nextSyncToken'] = resp.get('nextSyncToken')
    return out


def clean_calendar(cal: dict | None) -> dict:
    """Compact a calendar resource (from calendars() or a calendarList entry)."""
    if not isinstance(cal, dict):
        return {}
    out: dict = {
        'id': cal.get('id'),
        'summary': cal.get('summary'),
        'timeZone': cal.get('timeZone'),
        'description': cal.get('description'),
        'primary': cal.get('primary'),
    }
    return {k: v for k, v in out.items() if v is not None}


def clean_calendar_list(resp: dict | None) -> dict:
    """Compact a calendarList().list response: calendars + sync/page tokens."""
    if not isinstance(resp, dict):
        return {}
    out: dict = {'calendars': [clean_calendar(c) for c in resp.get('items') or []]}
    if resp.get('nextPageToken') is not None:
        out['nextPageToken'] = resp.get('nextPageToken')
    if resp.get('nextSyncToken') is not None:
        out['nextSyncToken'] = resp.get('nextSyncToken')
    return out


def clean_acl_rule(rule: dict | None) -> dict:
    """Compact an ACL rule: id, role, and scope (type + value)."""
    if not isinstance(rule, dict):
        return {}
    out: dict = {k: rule[k] for k in ('id', 'role', 'scope') if k in rule}
    return out


def clean_acl_list(resp: dict | None) -> dict:
    """Compact an acl().list response: the ACL rules + optional page token."""
    if not isinstance(resp, dict):
        return {}
    out: dict = {'rules': [clean_acl_rule(r) for r in resp.get('items') or []]}
    if resp.get('nextPageToken') is not None:
        out['nextPageToken'] = resp.get('nextPageToken')
    return out


def clean_freebusy(resp: dict | None) -> dict:
    """Compact a freebusy().query response: per-calendar busy ranges + errors."""
    if not isinstance(resp, dict):
        return {}
    calendars: dict = {}
    for cal_id, cal in (resp.get('calendars') or {}).items():
        entry: dict = {'busy': (cal or {}).get('busy') or []}
        if (cal or {}).get('errors'):
            entry['errors'] = cal['errors']
        calendars[cal_id] = entry
    return {
        'timeMin': resp.get('timeMin'),
        'timeMax': resp.get('timeMax'),
        'calendars': calendars,
    }
