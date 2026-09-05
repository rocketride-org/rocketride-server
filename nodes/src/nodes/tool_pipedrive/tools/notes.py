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

"""Note tools: notes on deals, persons, organizations and leads, plus their comments."""

from __future__ import annotations

from ..pipedrive_client import clean_field, clean_note
from ..tool_groups import pipedrive_tool
from ._base import (
    ENUM,
    INT,
    PAGING,
    STR,
    UTC_TIME_DESC,
    PipedriveToolsBase,
    args_of,
    body_from,
    params_from,
    passthrough,
    path_segment,
    require_id,
    require_text,
    schema,
)

_NOTE_WRITE_KEYS = (
    'content',
    'deal_id',
    'person_id',
    'org_id',
    'lead_id',
    'project_id',
    'user_id',
    'add_time',
    'pinned_to_deal_flag',
    'pinned_to_person_flag',
    'pinned_to_organization_flag',
    'pinned_to_lead_flag',
)

_NOTE_WRITE_PROPS = {
    'content': STR('Note body. HTML is accepted.'),
    'deal_id': INT('Deal the note is attached to.'),
    'person_id': INT('Person the note is attached to.'),
    'org_id': INT('Organization the note is attached to.'),
    'lead_id': STR('Lead uuid the note is attached to.'),
    'project_id': INT('Project the note is attached to.'),
    'user_id': INT('Author user id. Defaults to the authenticated user.'),
    'add_time': STR(f'Creation timestamp, YYYY-MM-DD HH:MM:SS. Use to backdate an imported record. {UTC_TIME_DESC}'),
    'pinned_to_deal_flag': ENUM('Pin the note to the deal.', ['0', '1']),
    'pinned_to_person_flag': ENUM('Pin the note to the person.', ['0', '1']),
    'pinned_to_organization_flag': ENUM('Pin the note to the organization.', ['0', '1']),
    'pinned_to_lead_flag': ENUM('Pin the note to the lead.', ['0', '1']),
}


class NotesMixin(PipedriveToolsBase):
    """Tools for the ``notes`` group."""

    @pipedrive_tool(
        group='notes',
        input_schema=schema(
            **PAGING(),
            user_id=INT('Only notes written by this user id.'),
            deal_id=INT('Only notes attached to this deal.'),
            person_id=INT('Only notes attached to this person.'),
            org_id=INT('Only notes attached to this organization.'),
            lead_id=STR('Only notes attached to this lead uuid.'),
            start_date=STR(
                'Only notes added on or after this date, YYYY-MM-DD. Filters the UTC add_time, so a '
                'range that means a whole day to a person may need widening by one day at each end.'
            ),
            end_date=STR('Only notes added on or before this date, YYYY-MM-DD. Same UTC caveat as start_date.'),
            sort=STR('Sort clause, e.g. "add_time DESC".'),
        ),
        description='List notes, optionally filtered by the record they are attached to or by date.',
    )
    def note_list(self, args):
        args = args_of(args)
        return self._list(
            '/notes',
            args,
            clean_note,
            extra=params_from(
                args, ('user_id', 'deal_id', 'person_id', 'org_id', 'lead_id', 'start_date', 'end_date', 'sort')
            ),
        )

    @pipedrive_tool(
        group='notes',
        input_schema=schema(required=['note_id'], note_id=INT('Note id.')),
        description='Get a single note by id.',
    )
    def note_get(self, args):
        args = args_of(args)
        return self._get(f'/notes/{require_id(args, "note_id", "note_get")}', clean_note)

    @pipedrive_tool(
        group='notes',
        input_schema=schema(required=['content'], **_NOTE_WRITE_PROPS),
        description='Create a note. Attach it by passing at least one of deal_id, person_id, org_id, lead_id or project_id.',
    )
    def note_create(self, args):
        args = args_of(args)
        require_text(args, 'content', 'note_create')
        return self._write('POST', '/notes', clean_note, body=body_from(args, _NOTE_WRITE_KEYS))

    @pipedrive_tool(
        group='notes',
        input_schema=schema(required=['note_id'], note_id=INT('Note id to update.'), **_NOTE_WRITE_PROPS),
        description='Update a note.',
    )
    def note_update(self, args):
        args = args_of(args)
        note_id = require_id(args, 'note_id', 'note_update')
        return self._write('PUT', f'/notes/{note_id}', clean_note, body=body_from(args, _NOTE_WRITE_KEYS))

    @pipedrive_tool(
        group='notes',
        input_schema=schema(required=['note_id'], note_id=INT('Note id to delete.')),
        description='Delete a note.',
    )
    def note_delete(self, args):
        args = args_of(args)
        return self._delete(f'/notes/{require_id(args, "note_id", "note_delete")}')

    # -- comments ---------------------------------------------------------

    @pipedrive_tool(
        group='notes',
        input_schema=schema(required=['note_id'], note_id=INT('Note id.'), **PAGING()),
        description='List comments on a note.',
    )
    def note_comment_list(self, args):
        args = args_of(args)
        note_id = require_id(args, 'note_id', 'note_comment_list')
        return self._list(f'/notes/{note_id}/comments', args, passthrough)

    @pipedrive_tool(
        group='notes',
        input_schema=schema(
            required=['note_id', 'comment_id'], note_id=INT('Note id.'), comment_id=STR('Comment uuid.')
        ),
        description='Get a single comment on a note.',
    )
    def note_comment_get(self, args):
        args = args_of(args)
        note_id = require_id(args, 'note_id', 'note_comment_get')
        comment_id = require_text(args, 'comment_id', 'note_comment_get')
        return self._call('GET', f'/notes/{note_id}/comments/{path_segment(comment_id)}')

    @pipedrive_tool(
        group='notes',
        input_schema=schema(
            required=['note_id', 'content'], note_id=INT('Note id.'), content=STR('Comment body. HTML is accepted.')
        ),
        description='Add a comment to a note.',
    )
    def note_comment_create(self, args):
        args = args_of(args)
        note_id = require_id(args, 'note_id', 'note_comment_create')
        content = require_text(args, 'content', 'note_comment_create')
        return self._write('POST', f'/notes/{note_id}/comments', passthrough, body={'content': content})

    @pipedrive_tool(
        group='notes',
        input_schema=schema(
            required=['note_id', 'comment_id', 'content'],
            note_id=INT('Note id.'),
            comment_id=STR('Comment uuid.'),
            content=STR('New comment body.'),
        ),
        description='Update a comment on a note.',
    )
    def note_comment_update(self, args):
        args = args_of(args)
        note_id = require_id(args, 'note_id', 'note_comment_update')
        comment_id = require_text(args, 'comment_id', 'note_comment_update')
        content = require_text(args, 'content', 'note_comment_update')
        return self._write(
            'PUT', f'/notes/{note_id}/comments/{path_segment(comment_id)}', passthrough, body={'content': content}
        )

    @pipedrive_tool(
        group='notes',
        input_schema=schema(
            required=['note_id', 'comment_id'], note_id=INT('Note id.'), comment_id=STR('Comment uuid to delete.')
        ),
        description='Delete a comment from a note.',
    )
    def note_comment_delete(self, args):
        args = args_of(args)
        note_id = require_id(args, 'note_id', 'note_comment_delete')
        comment_id = require_text(args, 'comment_id', 'note_comment_delete')
        return self._delete(f'/notes/{note_id}/comments/{path_segment(comment_id)}')

    # -- fields -----------------------------------------------------------

    @pipedrive_tool(
        group='notes',
        input_schema=schema(**PAGING()),
        description='List the note fields available in this account.',
    )
    def note_field_list(self, args):
        args = args_of(args)
        return self._list('/noteFields', args, clean_field)
