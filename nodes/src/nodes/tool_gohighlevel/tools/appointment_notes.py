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

"""Appointment note tools: the notes attached to one calendar appointment."""

from __future__ import annotations

from typing import Any

from ..gohighlevel_client import paginated
from ..tool_groups import gohighlevel_tool
from ._base import (
    LIST_OUTPUT,
    PAGING_OFFSET,
    RECORD_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    body_from,
    offset_params,
    require_id,
    require_text,
    schema,
)

#: Fields kept from an appointment note. GetNoteSchema declares exactly these six and marks none of
#: them required, so every one is optional on the way out.
#:
#: ``dateAdded`` is ISO 8601 in UTC with milliseconds and a trailing Z, which is a third date format
#: inside the calendars area: the appointment itself carries a numeric offset instead, and the
#: window parameters on the event reads are epoch milliseconds.
_NOTE_READ_KEYS = ('id', 'body', 'userId', 'contactId', 'dateAdded', 'createdBy')

#: Body fields shared by appointment_notes_create and appointment_notes_update. NotesDTO declares
#: these two and nothing else, on both operations, so the two writes share one tuple and one props
#: dict. There is no ``extra`` escape hatch for the same reason as on the appointment writes: the
#: DTO is fully covered here, and GoHighLevel rejects an undeclared property rather than ignoring it.
_NOTE_WRITE_KEYS = ('body', 'userId')

_NOTE_WRITE_PROPS = {
    'body': STR('Text of the note, up to 5000 characters.'),
    'userId': STR(
        'Id of the user the note is attributed to. Get user ids from user_list_by_location. Leave it out '
        'to let GoHighLevel attribute the note to the owner of the token.'
    ),
}

_NOTE_RECORD_OUTPUT = RECORD_OUTPUT(
    'The note, trimmed to the fields this node returns. dateAdded is ISO 8601 in UTC with a trailing Z, '
    'unlike the offset-bearing times on the appointment itself.'
)


def _clean_note(note: Any) -> dict:
    """Trim an appointment note to the fields this node returns."""
    if not isinstance(note, dict):
        return {}
    return {key: note[key] for key in _NOTE_READ_KEYS if key in note}


class AppointmentNotesMixin(GoHighLevelToolsBase):
    """Tools for the ``appointment_notes`` group."""

    @gohighlevel_tool(
        group='appointment_notes',
        input_schema=schema(
            required=['appointmentId'],
            appointmentId=STR('Id of the appointment. Get appointment ids from appointment_list.'),
            **PAGING_OFFSET('appointment_notes_list'),
        ),
        description=(
            'List the notes written on one appointment. This one pages by offset and caps the page at 20 '
            'records, which is the lowest cap in this node: next is the offset to ask for next, and it is null '
            'once GoHighLevel says there is nothing after this page. GoHighLevel reports no total here, so total '
            'is always null.'
        ),
        output_schema=LIST_OUTPUT(
            'Offset for the next page: pass it back as the offset parameter. Null when GoHighLevel reports no '
            'more notes after this page.',
            items='The notes on this page, each trimmed to the fields this node returns.',
        ),
    )
    def appointment_notes_list(self, args):
        args = self._args(args, 'appointment_notes_list')
        appointment_id = require_id(args, 'appointmentId', 'appointment_notes_list')
        params, limit = offset_params(args, 'appointment_notes_list')
        payload, records = self._fetch(
            'GET',
            f'/calendars/appointments/{appointment_id}/notes',
            key='notes',
            params=params,
        )
        # This is the one endpoint in the calendars area that states whether another page exists, so
        # its own hasMore wins over the short-page rule. The cursor is derived from the offset that
        # was actually sent rather than from the argument, which may have been absent or unusable.
        has_more = payload.get('hasMore') if isinstance(payload, dict) else None
        next_offset = params['offset'] + len(records) if records else None
        return paginated(
            [_clean_note(record) for record in records],
            next_cursor=next_offset,
            has_more=has_more,
            requested_limit=limit,
        )

    @gohighlevel_tool(
        group='appointment_notes',
        writes=True,
        input_schema=schema(
            required=['appointmentId', 'body'],
            appointmentId=STR('Id of the appointment to write the note on.'),
            **_NOTE_WRITE_PROPS,
        ),
        description=(
            'Write a note on an appointment. These notes belong to the appointment, not to the contact: use '
            'contact_notes_create for a note that should stay on the contact record after the appointment is over.'
        ),
        output_schema=_NOTE_RECORD_OUTPUT,
    )
    def appointment_notes_create(self, args):
        args = self._args(args, 'appointment_notes_create')
        appointment_id = require_id(args, 'appointmentId', 'appointment_notes_create')
        require_text(args, 'body', 'appointment_notes_create')
        body = body_from(args, _NOTE_WRITE_KEYS, tool='appointment_notes_create')
        return self._write(
            'POST',
            f'/calendars/appointments/{appointment_id}/notes',
            _clean_note,
            key='note',
            body=body,
        )

    @gohighlevel_tool(
        group='appointment_notes',
        writes=True,
        input_schema=schema(
            required=['appointmentId', 'noteId', 'body'],
            appointmentId=STR('Id of the appointment the note is on.'),
            noteId=STR('Id of the note to change. Get note ids from appointment_notes_list.'),
            **_NOTE_WRITE_PROPS,
        ),
        description=(
            'Replace the text of a note on an appointment. This is not a partial update: body is required and '
            'the note text becomes exactly what you send, so read the note first when you mean to append to it.'
        ),
        output_schema=_NOTE_RECORD_OUTPUT,
    )
    def appointment_notes_update(self, args):
        args = self._args(args, 'appointment_notes_update')
        appointment_id = require_id(args, 'appointmentId', 'appointment_notes_update')
        note_id = require_id(args, 'noteId', 'appointment_notes_update')
        require_text(args, 'body', 'appointment_notes_update')
        body = body_from(args, _NOTE_WRITE_KEYS, tool='appointment_notes_update')
        # noteId is in the path template but is missing from the declared parameters of both this
        # operation and the delete below, which is a defect in the published spec rather than a real
        # quirk: the rendered vendor documentation does list it. Substituted here by hand.
        return self._write(
            'PUT',
            f'/calendars/appointments/{appointment_id}/notes/{note_id}',
            _clean_note,
            key='note',
            body=body,
        )

    @gohighlevel_tool(
        group='appointment_notes',
        writes=True,
        input_schema=schema(
            required=['appointmentId', 'noteId'],
            appointmentId=STR('Id of the appointment the note is on.'),
            noteId=STR('Id of the note to delete.'),
        ),
        description='Delete a note from an appointment.',
        output_schema=RECORD_OUTPUT(
            'Whether the delete succeeded, under deleted, with the raw GoHighLevel response under data.'
        ),
    )
    def appointment_notes_delete(self, args):
        args = self._args(args, 'appointment_notes_delete')
        appointment_id = require_id(args, 'appointmentId', 'appointment_notes_delete')
        note_id = require_id(args, 'noteId', 'appointment_notes_delete')
        return self._delete(f'/calendars/appointments/{appointment_id}/notes/{note_id}')
