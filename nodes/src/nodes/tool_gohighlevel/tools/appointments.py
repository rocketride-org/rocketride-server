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

"""Appointment tools: calendar events, the appointment record, free slots and blocked slots."""

from __future__ import annotations

from typing import Any

from ..gohighlevel_client import date_keyed
from ..tool_groups import gohighlevel_tool
from ._base import (
    ARR,
    BOOL,
    ENUM,
    INT,
    LIST_OUTPUT,
    RECORD_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    body_from,
    params_from,
    require_id,
    require_text,
    schema,
)

#: Fields kept from a calendar event.
#:
#: One tuple covers three response shapes on purpose. GET /calendars/events and
#: GET /calendars/blocked-slots both answer CalendarEventDTO, the appointment writes answer
#: AppointmentSchemaResponse and the block-slot writes answer BlockedSlotSuccessfulResponseDto,
#: and the latter two are subsets of the first apart from meetingLocationType. Keeping one tuple
#: means a blocked slot and an appointment come back looking alike, which is what they are on
#: the wire: a blocked slot is a calendar event with no contact.
#:
#: startTime, endTime, dateAdded and dateUpdated are passed through untouched. The spec declares
#: all four as objects and sends ISO 8601 strings, and the vendor docs repo has an open bug for
#: appointment responses missing dateAdded and dateUpdated entirely, so nothing here may assume
#: a type or a presence.
_EVENT_READ_KEYS = (
    'id',
    'locationId',
    'calendarId',
    'contactId',
    'groupId',
    'title',
    'appointmentStatus',
    'assignedUserId',
    'users',
    'address',
    'meetingLocationType',
    'meetingLocationId',
    'notes',
    'description',
    'isRecurring',
    'rrule',
    'masterEventId',
    'startTime',
    'endTime',
    'dateAdded',
    'dateUpdated',
    'assignedResources',
    'createdBy',
)

#: Body fields shared by appointment_create and appointment_update.
#:
#: ``locationId`` is absent because the node supplies it from config on the create, and because
#: AppointmentEditSchema has no such property at all. ``contactId`` is absent for the same
#: reason: it is a create-only field, so an appointment cannot be moved to another contact.
#:
#: There is no ``extra`` escape hatch on this module. Both appointment DTOs are fully enumerated
#: here, GoHighLevel rejects an undeclared property with a 4xx rather than ignoring it, and the
#: shared EXTRA_DESC text is about contact custom fields and tags, neither of which exists on a
#: calendar endpoint. Offering it would advertise fields that can only fail.
_APPOINTMENT_WRITE_KEYS = (
    'calendarId',
    'title',
    'startTime',
    'endTime',
    'appointmentStatus',
    'assignedUserId',
    'address',
    'description',
    'meetingLocationType',
    'meetingLocationId',
    'overrideLocationConfig',
    'ignoreDateRange',
    'ignoreFreeSlotValidation',
    'toNotify',
    'rrule',
)

#: How an appointment carries its timezone, stated once because create, update and the free-slots
#: read all need it. This is the single most expensive thing to get wrong here: there is no
#: timezone field anywhere on an appointment, so a start time written without an offset is read
#: in whatever zone GoHighLevel picks and the booking silently lands in the wrong hour.
_APPOINTMENT_TIMEZONE_DESC = (
    'Appointments carry no timezone field: the numeric offset inside startTime is the only timezone '
    'information the appointment has. Take a slot string from appointment_free_slots_list and send it '
    'back unchanged rather than converting it or dropping the offset.'
)

_APPOINTMENT_WRITE_PROPS = {
    'calendarId': STR('Id of the calendar to book on. Get calendar ids from calendar_list.'),
    'title': STR('Title of the appointment, as it shows on the calendar.'),
    'startTime': STR(
        'Start time as ISO 8601 carrying a numeric offset, for example "2021-06-23T03:30:00+05:30". '
        f'{_APPOINTMENT_TIMEZONE_DESC}'
    ),
    'endTime': STR(
        'End time, in the same form as startTime. Leave it out to let GoHighLevel derive it from the '
        'slot duration configured on the calendar.'
    ),
    'appointmentStatus': ENUM(
        'Status of the appointment. Reads can also return "active" and "completed", which GoHighLevel '
        'sets itself and does not accept here.',
        ('new', 'confirmed', 'cancelled', 'showed', 'noshow', 'invalid'),
    ),
    'assignedUserId': STR('Id of the user who owns the appointment. Get user ids from user_list_by_location.'),
    'address': STR('Appointment address: a street address, a meeting URL or a phone number.'),
    'description': STR('Longer description of the appointment.'),
    'meetingLocationType': ENUM(
        'Where the meeting happens. Passing address sets this to "custom" unless you say otherwise.',
        ('custom', 'zoom', 'gmeet', 'phone', 'address', 'ms_teams', 'google'),
    ),
    'meetingLocationId': STR(
        'Id of a meeting location already configured on the calendar. The ids are on the calendar '
        'record under locationConfigurations and teamMembers[].locationConfigurations.'
    ),
    'overrideLocationConfig': BOOL(
        'Whether to override the meeting-location configuration on the calendar. Send true when you '
        'pass meetingLocationType on its own and false when you pass meetingLocationId on its own.'
    ),
    'ignoreDateRange': BOOL(
        'Whether to ignore the minimum scheduling notice and the bookable date range on the calendar.'
    ),
    'ignoreFreeSlotValidation': BOOL(
        'Whether to book the time even when it is not a free slot. This also overrides ignoreDateRange, '
        'and rrule is applied only when it is true.'
    ),
    'toNotify': BOOL('Whether the sub-account automations run for this appointment. Send false to book quietly.'),
    'rrule': STR(
        'Recurrence rule in iCalendar (RFC 5545) form, for example "RRULE:FREQ=DAILY;INTERVAL=1;COUNT=5". '
        'GoHighLevel applies it only when ignoreFreeSlotValidation is true, and it derives each instance '
        'from startTime rather than from a DTSTART line.'
    ),
}

#: Body keys and schema properties for appointment_create only. ``contactId`` is required there and
#: undeclared on the update DTO, so each operation sends what its own DTO declares.
_APPOINTMENT_CREATE_KEYS = _APPOINTMENT_WRITE_KEYS + ('contactId',)
_APPOINTMENT_CREATE_PROPS = {
    **_APPOINTMENT_WRITE_PROPS,
    'contactId': STR(
        'Id of the contact the appointment is booked for. Get contact ids from contact_search. An '
        'appointment cannot be moved to another contact afterwards, so this cannot be changed by '
        'appointment_update.'
    ),
}

#: Body fields shared by blocked_slot_create and blocked_slot_update. ``locationId`` is supplied
#: from config on both.
_BLOCKED_SLOT_WRITE_KEYS = ('calendarId', 'assignedUserId', 'title', 'startTime', 'endTime')

#: What GoHighLevel says about the two owner fields on a blocked slot, stated once because the
#: create and the update contradict themselves in the same way. Both request schemas list
#: ``calendarId`` under ``required`` while the field description on both fields says either
#: calendarId or assignedUserId can be set and not both. This node requires one of the two rather
#: than requiring calendarId: refusing the user-owned form locally would make a documented request
#: impossible, and there is no live evidence either way because the trial sub-account has no
#: calendars.
_BLOCKED_SLOT_OWNER_DESC = (
    'Pass either calendarId or assignedUserId. GoHighLevel documents that only one of the two may be '
    'set, while its own schema marks calendarId required, so if a request carrying only assignedUserId '
    'is rejected, send calendarId instead.'
)

_BLOCKED_SLOT_WRITE_PROPS = {
    'calendarId': STR(f'Id of the calendar whose time is blocked. {_BLOCKED_SLOT_OWNER_DESC}'),
    'assignedUserId': STR(f'Id of the user whose time is blocked. {_BLOCKED_SLOT_OWNER_DESC}'),
    'title': STR('Title of the block, as it shows on the calendar.'),
    'startTime': STR(
        'Start of the block as ISO 8601 carrying a numeric offset, for example "2021-06-23T03:30:00+05:30". '
        'A blocked slot carries no timezone field either, so the offset is the only timezone it has.'
    ),
    'endTime': STR('End of the block, in the same form as startTime.'),
}

#: The three parameters that say whose events to read. Both window endpoints declare all three
#: optional and then reject a request carrying none of them.
_EVENT_SCOPE_KEYS = ('calendarId', 'userId', 'groupId')

_EVENT_SCOPE_DESC = (
    'Say whose events to read with exactly one of calendarId, userId or groupId. GoHighLevel declares all '
    'three optional and then requires one of them, and it documents no behaviour for sending more than one.'
)

#: Schema properties shared by the two window-bounded reads.
#:
#: startTime and endTime here are epoch milliseconds declared as strings, which is neither the
#: offset-bearing ISO string an appointment body takes nor the epoch number free-slots takes. Three
#: spellings of the same instant across four endpoints in one group, so each one says its own.
_EVENT_WINDOW_PROPS = {
    'calendarId': STR(f'Id of the calendar to read. {_EVENT_SCOPE_DESC}'),
    'userId': STR(f'Id of the user who owns the events. {_EVENT_SCOPE_DESC}'),
    'groupId': STR(f'Id of the calendar group to read. {_EVENT_SCOPE_DESC}'),
    'startTime': STR('Start of the window, in epoch milliseconds, for example "1680373800000".'),
    'endTime': STR('End of the window, in epoch milliseconds, for example "1680978599999".'),
}

_DAY_MS = 24 * 60 * 60 * 1000

#: The free-slots window GoHighLevel accepts, stated verbatim in the parameter descriptions of both
#: startDate and endDate: "Date range cannot be more than 31 days". Checked locally so a too-wide
#: window costs nothing instead of a request against a measured 25-request/10s budget.
_FREE_SLOTS_MAX_RANGE_MS = 31 * _DAY_MS

#: Envelope keys ``GET /calendars/events/appointments/{eventId}`` has been seen to use.
#:
#: The live API answers ``{"appointment": {...}, "traceId": ...}``. Both published specs declare
#: ``event`` instead, and neither spelling appears on the sibling create and update, which answer
#: the record bare. The wire spelling is listed first because it is what a real call returns, the
#: spec spelling second so a vendor correction does not break this the other way round.
#:
#: This is the only route in the group that wraps at all, so the tuple stays here rather than
#: being applied across the module: the create and the update are live-confirmed bare, and naming
#: a key they do not send would only invite the same guess in reverse.
_APPOINTMENT_GET_KEYS = ('appointment', 'event')

_EVENT_ID_DESC = (
    'Id of the event. For a recurring appointment this is either the id of the whole series or the id of '
    'one instance, which is spelled "<seriesId>_<startEpochMs>_<durationSeconds>". Pass the series id to '
    'change every occurrence and an instance id to change one.'
)

_EVENT_ITEMS = 'The calendar events in the window, each trimmed to the fields this node returns.'

_EVENT_RECORD_OUTPUT = RECORD_OUTPUT(
    'The calendar event, trimmed to the fields this node returns. Times are ISO 8601 strings carrying a '
    'numeric offset, and there is no separate timezone field.'
)


def _clean_event(event: Any) -> dict:
    """Trim a calendar event, an appointment or a blocked slot to the fields this node returns."""
    if not isinstance(event, dict):
        return {}
    return {key: event[key] for key in _EVENT_READ_KEYS if key in event}


def _require_any_of(values: dict, keys: tuple[str, ...], tool: str, note: str = '') -> None:
    """Fail locally when a request carries none of the fields its endpoint needs.

    A copy of the helper in ``contacts.py``, which says it belongs in ``_base.py`` as soon as a
    second module needs one. This is that second module, with four call sites of its own, and the
    two copies should be collapsed into ``_base`` when the modules are wired together.
    """
    if any(values.get(key) is not None for key in keys):
        return
    listed = ', '.join(f'"{key}"' for key in keys)
    message = f'{tool}: pass at least one of {listed}.'
    raise ValueError(f'{message} {note}' if note else message)


def _require_epoch_ms(args: dict, key: str, tool: str) -> int:
    """Read a required epoch-millisecond timestamp, whether it arrives as a number or as a string.

    The four time-window parameters in this group are declared as strings on /calendars/events and
    /calendars/blocked-slots and as numbers on free-slots, for the same unit. Accepting either form
    and letting each tool render what its own endpoint declares is cheaper than making the agent
    track which of the two it is talking to.
    """
    value = args.get(key)
    if not isinstance(value, bool) and isinstance(value, (int, str)):
        try:
            return int(value)
        except (TypeError, ValueError):
            pass
    raise ValueError(f'{tool}: "{key}" is required and must be a time in epoch milliseconds, for example 1680373800000')


def _free_slot_range(args: dict, tool: str) -> tuple[int, int]:
    """Read the free-slots window and enforce the 31-day cap before spending a request on it.

    The cap is the vendor's own, stated verbatim in the parameter descriptions of both startDate and
    endDate: "Date range cannot be more than 31 days". Checking it here turns a rejected request into
    a message naming the width that was asked for, and saves a call against a measured
    25-request/10s budget.
    """
    start = _require_epoch_ms(args, 'startDate', tool)
    end = _require_epoch_ms(args, 'endDate', tool)
    if end < start:
        raise ValueError(f'{tool}: "endDate" is before "startDate". Both are times in epoch milliseconds.')
    if end - start > _FREE_SLOTS_MAX_RANGE_MS:
        days = (end - start) // _DAY_MS
        raise ValueError(
            f'{tool}: GoHighLevel allows a range of at most 31 days and this one spans {days}. '
            f'Ask for a narrower range, or walk the period 31 days at a time.'
        )
    return start, end


def _window_params(args: dict, tool: str) -> dict:
    """Query parameters for the two reads bounded by a time window rather than by a cursor."""
    params = params_from(args, _EVENT_SCOPE_KEYS)
    _require_any_of(params, _EVENT_SCOPE_KEYS, tool, 'GoHighLevel expects exactly one of the three.')
    # Sent as strings: both endpoints declare these two as strings even though they hold a number.
    params['startTime'] = str(_require_epoch_ms(args, 'startTime', tool))
    params['endTime'] = str(_require_epoch_ms(args, 'endTime', tool))
    return params


class AppointmentsMixin(GoHighLevelToolsBase):
    """Tools for the ``appointments`` group."""

    # -- appointments ------------------------------------------------------

    @gohighlevel_tool(
        group='appointments',
        input_schema=schema(required=['startTime', 'endTime'], **_EVENT_WINDOW_PROPS),
        description=(
            'List the appointments and other events on a calendar, a user or a calendar group inside a time '
            'window. The window is the only bound this endpoint has: it takes no page size and no cursor, so '
            'every event it finds comes back in one response and next is always null. Ask for a narrower window '
            'rather than a page. Blocked time does not appear here, it comes from blocked_slot_list. Times come '
            'back as ISO 8601 strings carrying a numeric offset.'
        ),
        output_schema=LIST_OUTPUT(
            'Always null: this endpoint returns every event in the window in one response, so there is no next '
            'page. Narrow startTime and endTime to get less.',
            items=_EVENT_ITEMS,
        ),
    )
    def appointment_list(self, args):
        args = self._args(args, 'appointment_list')
        params = _window_params(args, 'appointment_list')
        params['locationId'] = self._location()
        return self._list('/calendars/events', key='events', cleaner=_clean_event, params=params)

    @gohighlevel_tool(
        group='appointments',
        input_schema=schema(required=['eventId'], eventId=STR(_EVENT_ID_DESC)),
        description=(
            'Get one appointment by id. Times come back as ISO 8601 strings carrying a numeric offset, which is '
            'the form appointment_create and appointment_update take. The same appointment read through '
            'contact_appointments_list comes back as a naive "YYYY-MM-DD HH:mm:ss" string with no zone at all, so '
            'do not compare the two as text.'
        ),
        output_schema=_EVENT_RECORD_OUTPUT,
    )
    def appointment_get(self, args):
        args = self._args(args, 'appointment_get')
        event_id = require_id(args, 'eventId', 'appointment_get')
        return self._get(f'/calendars/events/appointments/{event_id}', _clean_event, key=_APPOINTMENT_GET_KEYS)

    @gohighlevel_tool(
        group='appointments',
        writes=True,
        input_schema=schema(
            required=['calendarId', 'contactId', 'startTime'],
            **_APPOINTMENT_CREATE_PROPS,
        ),
        description=(
            'Book an appointment for a contact on a calendar. The reliable flow is appointment_free_slots_list '
            'first, then send one of the slot strings it returned back here as startTime unchanged: '
            f'{_APPOINTMENT_TIMEZONE_DESC} endTime is optional and GoHighLevel derives it from the slot duration '
            'on the calendar. A start time that is not a free slot is rejected unless '
            'ignoreFreeSlotValidation is true.'
        ),
        output_schema=_EVENT_RECORD_OUTPUT,
    )
    def appointment_create(self, args):
        args = self._args(args, 'appointment_create')
        # Checked here rather than left to the schema: "required" in an input schema is advisory in
        # this node, and GoHighLevel answers a missing body field with a 400 that does not name it.
        require_id(args, 'calendarId', 'appointment_create')
        require_id(args, 'contactId', 'appointment_create')
        require_text(args, 'startTime', 'appointment_create')
        body = body_from(args, _APPOINTMENT_CREATE_KEYS, tool='appointment_create')
        body['locationId'] = self._location()
        return self._write('POST', '/calendars/events/appointments', _clean_event, body=body)

    @gohighlevel_tool(
        group='appointments',
        writes=True,
        input_schema=schema(
            required=['eventId'],
            eventId=STR(_EVENT_ID_DESC),
            **_APPOINTMENT_WRITE_PROPS,
        ),
        description=(
            'Update an appointment: reschedule it, reassign it, or change its status. Only the fields you pass '
            'are changed. The contact cannot be changed, because GoHighLevel does not accept contactId on an '
            f'update even though appointment_create requires it. {_APPOINTMENT_TIMEZONE_DESC} To cancel an '
            'appointment rather than remove it, set appointmentStatus to "cancelled": appointment_delete deletes '
            'the record outright.'
        ),
        output_schema=_EVENT_RECORD_OUTPUT,
    )
    def appointment_update(self, args):
        args = self._args(args, 'appointment_update')
        event_id = require_id(args, 'eventId', 'appointment_update')
        body = body_from(args, _APPOINTMENT_WRITE_KEYS, tool='appointment_update')
        return self._write('PUT', f'/calendars/events/appointments/{event_id}', _clean_event, body=body)

    @gohighlevel_tool(
        group='appointments',
        writes=True,
        input_schema=schema(required=['eventId'], eventId=STR(_EVENT_ID_DESC)),
        description=(
            'Delete a calendar event by id. This is the only delete in the calendar-event family, so it removes '
            'an appointment and a blocked slot alike. Setting appointmentStatus to "cancelled" through '
            'appointment_update keeps the record and its history, which is usually what a cancellation means.'
        ),
        output_schema=RECORD_OUTPUT(
            'Whether the delete succeeded, under deleted, with the raw GoHighLevel response under data.'
        ),
    )
    def appointment_delete(self, args):
        args = self._args(args, 'appointment_delete')
        event_id = require_id(args, 'eventId', 'appointment_delete')
        # This DELETE declares a required JSON body whose schema has no properties, so an empty
        # object is sent rather than nothing.
        return self._delete(f'/calendars/events/{event_id}', body={})

    # -- free slots --------------------------------------------------------

    @gohighlevel_tool(
        group='appointments',
        input_schema=schema(
            required=['calendarId', 'startDate', 'endDate'],
            calendarId=STR('Id of the calendar to read availability from. Get calendar ids from calendar_list.'),
            startDate=INT('Start of the range, in epoch milliseconds, for example 1680373800000.'),
            endDate=INT(
                'End of the range, in epoch milliseconds. It may be at most 31 days after startDate, which this '
                'tool checks before sending.'
            ),
            timezone=STR(
                'IANA timezone name the slots are returned in, for example "America/Los_Angeles". Leave it out '
                'to get the timezone configured on the calendar. Set it to the contact timezone when you are '
                'booking on their behalf, because the offsets in the answer are what the booking will carry.'
            ),
            userId=STR('Read availability for one user on the calendar rather than for the whole calendar.'),
            userIds=ARR('Read availability for several users on the calendar, by user id.'),
        ),
        description=(
            'Find the times a calendar can be booked, before calling appointment_create. The answer is not a '
            'list: it is an object keyed by date ("YYYY-MM-DD"), and each date holds {"slots": [...]} whose '
            'entries are ISO 8601 strings carrying a numeric offset. Send one of those strings back as the '
            'startTime of appointment_create exactly as it arrived. The range may span at most 31 days, so walk '
            'a longer period 31 days at a time.'
        ),
        output_schema=RECORD_OUTPUT(
            'An object keyed by date in "YYYY-MM-DD" form, each value holding a slots array of ISO 8601 strings '
            'carrying a numeric offset. A date with no availability is absent rather than empty, and an empty '
            'object means nothing is bookable in the range. Keys that are not dates, such as the traceId '
            'GoHighLevel puts beside them, are dropped.'
        ),
    )
    def appointment_free_slots_list(self, args):
        args = self._args(args, 'appointment_free_slots_list')
        calendar_id = require_id(args, 'calendarId', 'appointment_free_slots_list')
        start, end = _free_slot_range(args, 'appointment_free_slots_list')
        params = params_from(args, ('timezone', 'userId', 'userIds'))
        # Sent as numbers: this endpoint names the window startDate and endDate and declares both as
        # numbers, while /calendars/events names the same unit startTime and endTime and declares
        # both as strings.
        params['startDate'] = start
        params['endDate'] = end
        return self._get(f'/calendars/{calendar_id}/free-slots', date_keyed, params=params)

    # -- blocked slots -----------------------------------------------------

    @gohighlevel_tool(
        group='appointments',
        input_schema=schema(required=['startTime', 'endTime'], **_EVENT_WINDOW_PROPS),
        description=(
            'List the blocked time on a calendar, a user or a calendar group inside a time window: the periods '
            'that are deliberately unavailable rather than booked. Like appointment_list it has no page size and '
            'no cursor, so everything in the window comes back at once and next is always null. Blocked slots '
            'come back in the same shape as appointments, without a contact.'
        ),
        output_schema=LIST_OUTPUT(
            'Always null: this endpoint returns every blocked slot in the window in one response, so there is no '
            'next page. Narrow startTime and endTime to get less.',
            items='The blocked slots in the window, each trimmed to the fields this node returns.',
        ),
    )
    def blocked_slot_list(self, args):
        args = self._args(args, 'blocked_slot_list')
        params = _window_params(args, 'blocked_slot_list')
        params['locationId'] = self._location()
        # Blocked slots come back under "events", not under "blockedSlots": this endpoint shares its
        # response schema with /calendars/events.
        return self._list('/calendars/blocked-slots', key='events', cleaner=_clean_event, params=params)

    @gohighlevel_tool(
        group='appointments',
        writes=True,
        input_schema=schema(required=['startTime', 'endTime'], **_BLOCKED_SLOT_WRITE_PROPS),
        description=(
            'Block a period on a calendar or on a user so it cannot be booked. '
            f'{_BLOCKED_SLOT_OWNER_DESC} Use appointment_delete to remove the block again: GoHighLevel has no '
            'dedicated block-slot delete.'
        ),
        output_schema=RECORD_OUTPUT('The blocked slot, trimmed to the fields this node returns.'),
    )
    def blocked_slot_create(self, args):
        args = self._args(args, 'blocked_slot_create')
        require_text(args, 'startTime', 'blocked_slot_create')
        require_text(args, 'endTime', 'blocked_slot_create')
        body = body_from(args, _BLOCKED_SLOT_WRITE_KEYS, tool='blocked_slot_create')
        _require_any_of(body, ('calendarId', 'assignedUserId'), 'blocked_slot_create', _BLOCKED_SLOT_OWNER_DESC)
        body['locationId'] = self._location()
        return self._write('POST', '/calendars/events/block-slots', _clean_event, body=body)

    @gohighlevel_tool(
        group='appointments',
        writes=True,
        input_schema=schema(
            required=['eventId'],
            eventId=STR(_EVENT_ID_DESC),
            **_BLOCKED_SLOT_WRITE_PROPS,
        ),
        description=(
            f'Move or retitle a blocked slot. Only the fields you pass are changed. {_BLOCKED_SLOT_OWNER_DESC}'
        ),
        output_schema=RECORD_OUTPUT('The blocked slot after the change, trimmed to the fields this node returns.'),
    )
    def blocked_slot_update(self, args):
        args = self._args(args, 'blocked_slot_update')
        event_id = require_id(args, 'eventId', 'blocked_slot_update')
        body = body_from(args, _BLOCKED_SLOT_WRITE_KEYS, tool='blocked_slot_update')
        _require_any_of(body, ('calendarId', 'assignedUserId'), 'blocked_slot_update', _BLOCKED_SLOT_OWNER_DESC)
        body['locationId'] = self._location()
        return self._write('PUT', f'/calendars/events/block-slots/{event_id}', _clean_event, body=body)
