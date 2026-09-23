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

"""Contact note tools: the free-text notes attached to one contact."""

from __future__ import annotations

from typing import Any

from ..tool_groups import gohighlevel_tool
from ._base import (
    BOOL,
    LIST_OUTPUT,
    RECORD_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    body_from,
    require_id,
    require_text,
    schema,
)

#: Fields kept from a note record.
#:
#: ``dateUpdated`` is not in the vendor response schema and is kept anyway: the declared
#: response schemas on this surface are documented as unreliable, the design brief records
#: notes as carrying both ISO-8601 timestamps, and a key the payload does not have is simply
#: absent from the projection rather than an error.
_NOTE_READ_KEYS = (
    'id',
    'contactId',
    'body',
    'title',
    'color',
    'pinned',
    'userId',
    'dateAdded',
    'dateUpdated',
)

#: Body fields accepted by contact_notes_create and contact_notes_update.
#:
#: NotesDTO and UpdateNoteDTO declare exactly the same five properties, so unlike contacts
#: there is no create-versus-update drift here and one tuple serves both. They differ only in
#: what they require: create requires ``body``, update requires nothing.
_NOTE_WRITE_KEYS = ('body', 'title', 'color', 'pinned', 'userId')

_NOTE_WRITE_PROPS = {
    'body': STR('Text of the note. This is the note itself, not a summary of it.'),
    'title': STR('Short heading shown above the note in the GoHighLevel UI.'),
    'color': STR('Colour of the note in the GoHighLevel UI, as a hex string, for example "#FFAA00".'),
    'pinned': BOOL('Whether to pin the note to the top of the contact note list.'),
    'userId': STR(
        'Id of the GoHighLevel user to record as the note author. Get user ids from user_list_by_location. '
        'Omit it to let GoHighLevel attribute the note to whoever the token belongs to.'
    ),
}

_NOTE_RECORD_OUTPUT = RECORD_OUTPUT('The note, trimmed to the fields this node returns.')


def _clean_note(note: Any) -> dict:
    """Trim a note record to the fields this node returns."""
    if not isinstance(note, dict):
        return {}
    return {key: note[key] for key in _NOTE_READ_KEYS if key in note}


class ContactNotesMixin(GoHighLevelToolsBase):
    """Tools for the ``contact_notes`` group."""

    @gohighlevel_tool(
        group='contact_notes',
        input_schema=schema(required=['contactId'], contactId=STR('Id of the contact.')),
        description=(
            'List the notes on a contact. Read this before writing a new note, so a call summary is appended to '
            'the history rather than repeating what is already there. Returns notes under items, newest first as '
            'GoHighLevel orders them. The whole list comes back in one response, so there is no cursor and no '
            'limit parameter: a contact with hundreds of notes returns hundreds of notes.'
        ),
        output_schema=LIST_OUTPUT(
            'Always null: this endpoint returns every note in one response, so there is no next page.',
            items='The notes on the contact, each trimmed to the fields this node returns.',
        ),
    )
    def contact_notes_list(self, args):
        args = self._args(args, 'contact_notes_list')
        contact_id = require_id(args, 'contactId', 'contact_notes_list')
        return self._list(f'/contacts/{contact_id}/notes', key='notes', cleaner=_clean_note)

    @gohighlevel_tool(
        group='contact_notes',
        input_schema=schema(
            required=['contactId', 'noteId'],
            contactId=STR('Id of the contact the note belongs to.'),
            noteId=STR('Id of the note. Get note ids from contact_notes_list.'),
        ),
        description=(
            'Get one note by id. Both ids are needed: a note is addressed through its contact, so a note id on '
            'its own does not identify anything. Use contact_notes_list when you have the contact but not the '
            'note id.'
        ),
        output_schema=_NOTE_RECORD_OUTPUT,
    )
    def contact_notes_get(self, args):
        args = self._args(args, 'contact_notes_get')
        contact_id = require_id(args, 'contactId', 'contact_notes_get')
        # The path template spells this one "{id}". It is exposed as noteId because a parameter
        # called "id" beside contactId reads as the contact's own id, and a path placeholder is
        # never sent as a named parameter, so the vendor never sees this name.
        note_id = require_id(args, 'noteId', 'contact_notes_get')
        return self._get(f'/contacts/{contact_id}/notes/{note_id}', _clean_note, key='note')

    @gohighlevel_tool(
        group='contact_notes',
        writes=True,
        input_schema=schema(
            required=['contactId', 'body'],
            contactId=STR('Id of the contact to attach the note to.'),
            **_NOTE_WRITE_PROPS,
        ),
        description=(
            'Write a note on a contact. This is the right place for a call summary, a research finding or '
            'anything a human should read on the record later, and it is the only durable free-text store on a '
            'contact: everything else on the contact is a typed field. body is required. Notes are never '
            'deduplicated by GoHighLevel, so list the existing notes first if the same summary may already be '
            'there.'
        ),
        output_schema=_NOTE_RECORD_OUTPUT,
    )
    def contact_notes_create(self, args):
        args = self._args(args, 'contact_notes_create')
        contact_id = require_id(args, 'contactId', 'contact_notes_create')
        require_text(args, 'body', 'contact_notes_create')
        body = body_from(args, _NOTE_WRITE_KEYS)
        return self._write('POST', f'/contacts/{contact_id}/notes', _clean_note, key='note', body=body)

    @gohighlevel_tool(
        group='contact_notes',
        writes=True,
        input_schema=schema(
            required=['contactId', 'noteId'],
            contactId=STR('Id of the contact the note belongs to.'),
            noteId=STR('Id of the note to update. Get note ids from contact_notes_list.'),
            **_NOTE_WRITE_PROPS,
        ),
        description=(
            'Update a note. Only the fields you pass are changed, and body replaces the whole note text rather '
            'than appending to it: read the note with contact_notes_get first when you mean to add to it. Prefer '
            'contact_notes_create for a new observation, so the history stays intact.'
        ),
        output_schema=_NOTE_RECORD_OUTPUT,
    )
    def contact_notes_update(self, args):
        args = self._args(args, 'contact_notes_update')
        contact_id = require_id(args, 'contactId', 'contact_notes_update')
        note_id = require_id(args, 'noteId', 'contact_notes_update')
        body = body_from(args, _NOTE_WRITE_KEYS)
        return self._write('PUT', f'/contacts/{contact_id}/notes/{note_id}', _clean_note, key='note', body=body)

    @gohighlevel_tool(
        group='contact_notes',
        writes=True,
        input_schema=schema(
            required=['contactId', 'noteId'],
            contactId=STR('Id of the contact the note belongs to.'),
            noteId=STR('Id of the note to delete. Get note ids from contact_notes_list.'),
        ),
        description=(
            'Delete a note. The note text is gone afterwards and there is no undo, so read it with '
            'contact_notes_get first if it may still be wanted.'
        ),
        output_schema=RECORD_OUTPUT(
            'Whether the delete succeeded, under deleted, with the raw GoHighLevel response under data.'
        ),
    )
    def contact_notes_delete(self, args):
        args = self._args(args, 'contact_notes_delete')
        contact_id = require_id(args, 'contactId', 'contact_notes_delete')
        note_id = require_id(args, 'noteId', 'contact_notes_delete')
        return self._delete(f'/contacts/{contact_id}/notes/{note_id}')
