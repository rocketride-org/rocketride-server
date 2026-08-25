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

"""Calendar tools: the bookable calendar record and the scheduling configuration on it."""

from __future__ import annotations

from typing import Any

from ..tool_groups import gohighlevel_tool
from ._base import (
    BOOL,
    ENUM,
    INT,
    LIST_OUTPUT,
    MIXED_ARR,
    NUM,
    OBJ,
    RECORD_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    body_from,
    bool_params,
    params_from,
    passthrough,
    require_id,
    require_text,
    schema,
)

# Nothing here passes ``version=``. Every path in this module starts with /calendars, which
# ``version_for`` already maps to 2021-04-15. Do not send v3: it is a Version header value
# rather than a URL prefix, it changes the appointment schemas, and this node pins v2.

#: Fields kept from a calendar record in a listing.
#:
#: A CalendarDTO carries roughly 55 configuration fields, and GET /calendars/ has no
#: pagination at all, so a sub-account with twenty calendars would otherwise spend a thousand
#: fields on a question the agent asked to find one id. The listing is therefore an index and
#: calendar_get is the detail view: it returns the record untrimmed, because every field on it
#: is a setting somebody chose and there is no way to guess which one is being looked for.
_CALENDAR_SUMMARY_KEYS = (
    'id',
    'locationId',
    'name',
    'description',
    'slug',
    'widgetSlug',
    'groupId',
    'calendarType',
    'eventType',
    'isActive',
    'slotDuration',
    'slotDurationUnit',
)

#: Body fields accepted by calendar_create and calendar_update.
#:
#: This is the scheduling half of CalendarCreateDTO: what the calendar is, who is on it, how
#: long a slot is and when it can be booked. The booking-widget, payment and notification-email
#: half is reachable through ``extra`` instead, named field by field in :data:`_CALENDAR_EXTRA`.
#: Typing all 55 fields would put a schema larger than the rest of this node's tools combined
#: in front of an agent that mostly wants to read calendars.
#:
#: ``locationId`` is absent: the node supplies it from config on create, and CalendarUpdateDTO
#: does not declare it at all. ``notifications`` and ``meetingLocation`` are absent because
#: GoHighLevel flags both deprecated in the spec, in favour of the calendar notification
#: endpoints (not in this PR) and of ``locationConfigurations``.
_CALENDAR_WRITE_KEYS = (
    'name',
    'description',
    'slug',
    'groupId',
    'isActive',
    'eventType',
    'eventTitle',
    'teamMembers',
    'locationConfigurations',
    'slotDuration',
    'slotDurationUnit',
    'slotInterval',
    'slotIntervalUnit',
    'slotBuffer',
    'preBuffer',
    'preBufferUnit',
    'appoinmentPerSlot',
    'appoinmentPerDay',
    'allowBookingAfter',
    'allowBookingAfterUnit',
    'allowBookingFor',
    'allowBookingForUnit',
    'openHours',
    'availabilityType',
    'availabilities',
    'enableRecurring',
    'recurring',
    'formId',
    'stickyContact',
    'autoConfirm',
    'allowReschedule',
    'allowCancellation',
    'notes',
)

#: Fields CalendarCreateDTO declares and CalendarUpdateDTO does not.
#:
#: ``calendarType`` is the interesting one: the kind of calendar is fixed at creation, and the
#: update body has no property for it. ``slotBufferUnit`` looks like an oversight in the vendor
#: spec (``preBufferUnit`` survives on update and its twin does not), but GoHighLevel answers a
#: property it does not declare with a 422 rather than ignoring it, so update does not offer it.
#: Same policy as contacts: when the two DTOs disagree, each operation sends what its own DTO
#: declares.
_CALENDAR_CREATE_ONLY_KEYS = ('calendarType', 'slotBufferUnit')

#: The ``extra`` escape hatch for calendars.
#:
#: Deliberately not :func:`EXTRA`, whose text is about contacts: it tells the agent to send
#: customFields and warns it off tags, and a calendar has neither. Sending either here would be
#: a 422 rather than a no-op, so the shared wording would be actively misleading.
_CALENDAR_EXTRA = OBJ(
    'Any further GoHighLevel calendar fields to send verbatim, merged into the request body after the typed '
    'parameters. The typed parameters cover the scheduling configuration; the booking-widget and payment fields '
    'go here, namely widgetType, widgetSlug, eventColor, pixelId, formSubmitType, formSubmitRedirectURL, '
    'formSubmitThanksMessage, guestType, consentLabel, calendarCoverImage, lookBusyConfig, isLivePaymentMode, '
    'googleInvitationEmails, alertEmail, shouldSendAlertEmailsToAssignedMember, shouldAssignContactToTeamMember '
    'and shouldSkipAssigningContactForExisting. GoHighLevel rejects a property it does not declare with a 422, '
    'so send only names from the GoHighLevel calendar create and update bodies.'
)

_CALENDAR_WRITE_PROPS = {
    'name': STR('Name of the calendar, as it shows in the GoHighLevel UI and on the booking page.'),
    'description': STR('Description of the calendar.'),
    'slug': STR(
        'URL slug for this calendar booking page. There is no endpoint that checks whether a calendar slug is '
        'free: calendar_group_slug_check validates a group slug, not this one.'
    ),
    'groupId': STR('Id of the calendar group this calendar belongs to. Get group ids from calendar_group_list.'),
    'isActive': BOOL('Whether the calendar is live. Set it to false to leave the calendar as a draft.'),
    'eventType': ENUM(
        'How a round robin calendar spreads bookings across its team members.',
        ('RoundRobin_OptimizeForAvailability', 'RoundRobin_OptimizeForEqualDistribution'),
    ),
    'eventTitle': STR('Title given to a booked appointment. GoHighLevel templates it, for example "{{contact.name}}".'),
    'teamMembers': MIXED_ARR(
        'Users who take bookings on this calendar, each an object of the form {"userId": "<id>", "priority": 0.5, '
        '"isPrimary": false, "locationConfigurations": [...]}. priority is 0, 0.5 or 1. GoHighLevel requires team '
        'members on round_robin, collective, class_booking and service_booking calendars, a personal calendar takes '
        'exactly one, and a collective calendar needs exactly one member marked isPrimary. Get user ids from '
        'user_list_by_location.'
    ),
    'locationConfigurations': MIXED_ARR(
        'Where the meeting happens, each an object of the form {"kind": "physical", "location": "<address>"}. kind is '
        'one of custom, zoom_conference, google_conference, inbound_call, outbound_call, physical, booker or '
        'ms_teams_conference, and the three conference kinds take no location. This replaces meetingLocation, which '
        'GoHighLevel has deprecated.'
    ),
    'slotDuration': NUM('How long one booking slot is, in slotDurationUnit. GoHighLevel defaults it to 30 minutes.'),
    'slotDurationUnit': ENUM('Unit for slotDuration.', ('mins', 'hours')),
    'slotInterval': NUM(
        'Gap between the start of one bookable slot and the start of the next, in slotIntervalUnit. This is what '
        'spaces the slots shown on the booking page, and it is separate from how long a meeting lasts.'
    ),
    'slotIntervalUnit': ENUM('Unit for slotInterval.', ('mins', 'hours')),
    'slotBuffer': NUM('Padding kept free after an appointment, in slotBufferUnit.'),
    'preBuffer': NUM('Padding kept free before an appointment, in preBufferUnit.'),
    'preBufferUnit': ENUM('Unit for preBuffer.', ('mins', 'hours')),
    'appoinmentPerSlot': NUM(
        'Maximum bookings per slot per team member, or seats per slot on a class booking calendar. The missing "t" '
        'is how GoHighLevel spells the field, and this node sends it exactly as it is.'
    ),
    'appoinmentPerDay': NUM(
        'Maximum bookings allowed on one day. Misspelled the same way in the GoHighLevel API and sent as it is.'
    ),
    'allowBookingAfter': NUM('Minimum notice before a slot can be booked, in allowBookingAfterUnit.'),
    'allowBookingAfterUnit': ENUM('Unit for allowBookingAfter.', ('hours', 'days', 'weeks', 'months')),
    'allowBookingFor': NUM('How far into the future booking is allowed, in allowBookingForUnit.'),
    'allowBookingForUnit': ENUM('Unit for allowBookingFor.', ('days', 'weeks', 'months')),
    'openHours': MIXED_ARR(
        'Standard weekly availability, each entry an object of the form {"daysOfTheWeek": [1, 2], "hours": '
        '[{"openHour": 9, "openMinute": 0, "closeHour": 17, "closeMinute": 0}]}. Days run 0 to 6 with Sunday as 0, '
        'and the hours are 24-hour local time. Use availabilities for one-off dates instead.'
    ),
    'availabilityType': INT(
        'Which availability the calendar honours: 1 for the custom availabilities only, 0 for the open hours only. '
        'Leave it unset and GoHighLevel uses both.'
    ),
    'availabilities': MIXED_ARR(
        'Availability for specific dates, each an object of the form {"date": "2023-09-24T00:00:00.000Z", "hours": '
        '[...], "deleted": false}, where the date is midnight local time written with a Z. On calendar_update an '
        'entry that changes or removes an existing custom availability must also carry its "id".'
    ),
    'enableRecurring': BOOL(
        'Whether bookings on this calendar repeat. GoHighLevel only allows it on a calendar with exactly one team '
        'member.'
    ),
    'recurring': OBJ(
        'Recurrence rules, as an object of the form {"freq": "WEEKLY", "count": 4, "bookingOption": "skip", '
        '"bookingOverlapDefaultStatus": "confirmed"}. freq is DAILY, WEEKLY or MONTHLY, count is at most 24, '
        'bookingOption is skip, continue or book_next and says what to do when a repeat slot is taken, and '
        'bookingOverlapDefaultStatus is confirmed or new.'
    ),
    'formId': STR('Id of the form shown on the booking page.'),
    'stickyContact': BOOL('Whether the booking page prefills from the contact who last used that browser.'),
    'autoConfirm': BOOL('Whether a new booking is confirmed straight away rather than left for review.'),
    'allowReschedule': BOOL('Whether the person who booked can reschedule from their confirmation.'),
    'allowCancellation': BOOL('Whether the person who booked can cancel from their confirmation.'),
    'notes': STR(
        'Internal notes about the calendar itself, shown in the GoHighLevel UI. These are not appointment notes, '
        'which belong to a booked appointment and live in the appointment_notes tool group.'
    ),
    'extra': _CALENDAR_EXTRA,
}

#: Body keys and schema properties for calendar_create, which adds the two fields the update
#: body does not declare.
_CALENDAR_CREATE_KEYS = _CALENDAR_WRITE_KEYS + _CALENDAR_CREATE_ONLY_KEYS
_CALENDAR_CREATE_PROPS = {
    **_CALENDAR_WRITE_PROPS,
    'calendarType': ENUM(
        'What kind of calendar this is. It is fixed once the calendar exists: calendar_update cannot change it, so '
        'a different kind means a new calendar.',
        ('round_robin', 'event', 'class_booking', 'collective', 'service_booking', 'personal'),
    ),
    'slotBufferUnit': ENUM(
        'Unit for slotBuffer. GoHighLevel accepts it only when the calendar is created, so calendar_update does '
        'not offer it.',
        ('mins', 'hours'),
    ),
}

_CALENDAR_RECORD_OUTPUT = RECORD_OUTPUT(
    'The whole calendar record as GoHighLevel returns it, which is the scheduling configuration in full: the '
    'identifiers, the team members, the slot sizing, the open hours and the custom availabilities. The id is under '
    '"id", not "calendarId".'
)


def _calendar_summary(calendar: Any) -> dict:
    """Trim a calendar record to what identifies it in a listing.

    Detail is calendar_get's job. See :data:`_CALENDAR_SUMMARY_KEYS` for why the list route
    does not return whole records.
    """
    if not isinstance(calendar, dict):
        return {}
    return {key: calendar[key] for key in _CALENDAR_SUMMARY_KEYS if key in calendar}


class CalendarsMixin(GoHighLevelToolsBase):
    """Tools for the ``calendars`` group."""

    @gohighlevel_tool(
        group='calendars',
        input_schema=schema(
            groupId=STR('Only return calendars in this calendar group. Get group ids from calendar_group_list.'),
            showDrafted=BOOL(
                'Whether to include calendars that are not live yet. GoHighLevel includes them by default.'
            ),
        ),
        description=(
            'List the calendars in the configured sub-account. Start here to resolve the calendarId that the '
            'appointment tools need to read free slots, list events and book. The whole set comes back in one '
            'response: this endpoint has no pagination, no filter beyond groupId and no search. Records are '
            'summaries carrying the id, name, slug, group, type and slot duration; call calendar_get for the '
            'rest of a calendar configuration. A sub-account with no calendars returns an empty list rather '
            'than an error.'
        ),
        output_schema=LIST_OUTPUT(
            'Always null: this endpoint returns every calendar in one response, so there is no next page.',
            items=(
                'The calendars in the sub-account, each trimmed to id, locationId, name, description, slug, '
                'widgetSlug, groupId, calendarType, eventType, isActive and the slot duration.'
            ),
        ),
    )
    def calendar_list(self, args):
        args = self._args(args, 'calendar_list')
        params = params_from(args, ('groupId',))
        params.update(bool_params(args, ('showDrafted',)))
        params['locationId'] = self._location()
        return self._list('/calendars/', key='calendars', cleaner=_calendar_summary, params=params)

    @gohighlevel_tool(
        group='calendars',
        input_schema=schema(required=['calendarId'], calendarId=STR('Id of the calendar.')),
        description=(
            'Get one calendar by id, with its whole configuration: team members, slot sizing, booking window, open '
            'hours and custom availabilities. Use it before calendar_update, since an update only changes the '
            'fields it is given and this is the only way to see what the others hold. calendar_list returns '
            'summaries rather than this.'
        ),
        output_schema=_CALENDAR_RECORD_OUTPUT,
    )
    def calendar_get(self, args):
        args = self._args(args, 'calendar_get')
        calendar_id = require_id(args, 'calendarId', 'calendar_get')
        return self._get(f'/calendars/{calendar_id}', passthrough, key='calendar')

    @gohighlevel_tool(
        group='calendars',
        writes=True,
        input_schema=schema(required=['name'], **_CALENDAR_CREATE_PROPS),
        description=(
            'Create a calendar in the configured sub-account. Only name is required, and everything else falls back '
            'to a GoHighLevel default, but a calendar left on the defaults takes 30 minute bookings around the '
            'clock: set calendarType, teamMembers and openHours to get something usable. calendarType and '
            'slotBufferUnit can only be set here, because the update body does not accept them. GoHighLevel '
            'requires team members on round_robin, collective, class_booking and service_booking calendars.'
        ),
        output_schema=_CALENDAR_RECORD_OUTPUT,
    )
    def calendar_create(self, args):
        args = self._args(args, 'calendar_create')
        # The name is checked here rather than left to the API. The schema marks it required, but
        # the local argument check only rejects parameters that were not declared, so a create
        # without a name would otherwise reach GoHighLevel and come back as vendor validation text.
        body = body_from(args, _CALENDAR_CREATE_KEYS, tool='calendar_create')
        body['name'] = require_text(args, 'name', 'calendar_create')
        body['locationId'] = self._location()
        return self._write('POST', '/calendars/', passthrough, key='calendar', body=body)

    @gohighlevel_tool(
        group='calendars',
        writes=True,
        input_schema=schema(
            required=['calendarId'],
            calendarId=STR('Id of the calendar to update.'),
            **_CALENDAR_WRITE_PROPS,
        ),
        description=(
            'Update a calendar. Only the fields you pass are changed, but the array fields are replaced whole '
            'rather than merged: sending teamMembers, openHours, availabilities or locationConfigurations discards '
            'what was there, so read the calendar with calendar_get first and send the full array back with your '
            'change in it. An entry in availabilities that edits an existing custom date must carry its id. '
            'GoHighLevel does not accept calendarType or slotBufferUnit on an update, so this tool does not offer '
            'them even though calendar_create does.'
        ),
        output_schema=_CALENDAR_RECORD_OUTPUT,
    )
    def calendar_update(self, args):
        args = self._args(args, 'calendar_update')
        calendar_id = require_id(args, 'calendarId', 'calendar_update')
        body = body_from(args, _CALENDAR_WRITE_KEYS, tool='calendar_update')
        return self._write('PUT', f'/calendars/{calendar_id}', passthrough, key='calendar', body=body)

    @gohighlevel_tool(
        group='calendars',
        writes=True,
        input_schema=schema(required=['calendarId'], calendarId=STR('Id of the calendar to delete.')),
        description=(
            'Delete a calendar by id. This takes its appointments with it and there is no undo, so confirm the '
            'calendar with calendar_get first. To take a calendar off the booking page without destroying it, call '
            'calendar_update with isActive false instead.'
        ),
        output_schema=RECORD_OUTPUT(
            'Whether the delete succeeded, under deleted, with the raw GoHighLevel response under data.'
        ),
    )
    def calendar_delete(self, args):
        args = self._args(args, 'calendar_delete')
        calendar_id = require_id(args, 'calendarId', 'calendar_delete')
        return self._delete(f'/calendars/{calendar_id}')
