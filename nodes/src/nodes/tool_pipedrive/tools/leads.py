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

"""Lead tools: the lead inbox, its labels and its sources."""

from __future__ import annotations

from ..pipedrive_client import clean_lead, clean_search_item, paginated_v2
from ..tool_groups import pipedrive_tool
from ._base import (
    ARR,
    BOOL,
    ENUM,
    EXTRA,
    INT,
    OBJ,
    PAGING,
    PAGING_V2,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    paging_params_v2,
    params_from,
    passthrough,
    path_segment,
    require_text,
    schema,
)

_LEAD_WRITE_KEYS = (
    'title',
    'owner_id',
    'label_ids',
    'person_id',
    'organization_id',
    'value',
    'expected_close_date',
    'visible_to',
    'was_seen',
    'origin_id',
    'channel',
    'channel_id',
)

_LEAD_WRITE_PROPS = {
    'title': STR('Lead title.'),
    'owner_id': INT('Owner user id. Defaults to the authenticated user.'),
    'label_ids': ARR('Lead label uuids to apply (see lead_label_list).'),
    'person_id': INT('Linked person id. A lead must be linked to a person or an organization.'),
    'organization_id': INT('Linked organization id.'),
    'value': OBJ('Lead value, e.g. {"amount": 5000, "currency": "USD"}.'),
    'expected_close_date': STR('Expected close date, YYYY-MM-DD.'),
    'visible_to': ENUM('Visibility group id.', ['1', '3', '5', '7']),
    'was_seen': BOOL('Whether the lead has been opened by a user.'),
    'channel': INT('Marketing channel id the lead came from.'),
    'channel_id': STR('Optional identifier within the marketing channel.'),
    'origin_id': STR('Free-text id of the system this lead originated from.'),
    'extra': EXTRA(),
}


class LeadsMixin(PipedriveToolsBase):
    """Tools for the ``leads`` group."""

    @pipedrive_tool(
        group='leads',
        input_schema=schema(
            **PAGING(),
            archived_status=ENUM('Which leads to include (default all).', ['archived', 'not_archived', 'all']),
            owner_id=INT('Only leads owned by this user id.'),
            person_id=INT('Only leads linked to this person.'),
            organization_id=INT('Only leads linked to this organization.'),
            filter_id=INT('Apply a saved filter by id.'),
            sort=STR(
                'Sort clause: id, title, owner_id, creator_id, was_seen, expected_close_date, next_activity_id, add_time or update_time, with ASC/DESC.'
            ),
        ),
        description='List leads from the Leads Inbox.',
    )
    def lead_list(self, args):
        args = args_of(args)
        return self._list(
            '/leads',
            args,
            clean_lead,
            extra=params_from(
                args, ('archived_status', 'owner_id', 'person_id', 'organization_id', 'filter_id', 'sort')
            ),
        )

    @pipedrive_tool(
        group='leads',
        input_schema=schema(required=['lead_id'], lead_id=STR('Lead uuid.')),
        description='Get a single lead by its uuid.',
    )
    def lead_get(self, args):
        args = args_of(args)
        return self._get(f'/leads/{path_segment(require_text(args, "lead_id", "lead_get"))}', clean_lead)

    @pipedrive_tool(
        group='leads',
        input_schema=schema(
            required=['term'],
            term=STR('Search term, at least 2 characters (1 when exact_match is true).'),
            fields=STR('Comma-separated fields to search in: custom_fields, notes, title.'),
            exact_match=BOOL('Require an exact, case-sensitive match.'),
            person_id=INT('Only leads linked to this person.'),
            organization_id=INT('Only leads linked to this organization.'),
            include_fields=STR('Extra fields to include, e.g. "lead.was_seen".'),
            **PAGING_V2(),
        ),
        description='Search leads by title, notes or custom field values.',
    )
    def lead_search(self, args):
        # v2: Pipedrive retired /api/v1/leads/search (404 "Unknown method .").
        args = args_of(args)
        params = paging_params_v2(args)
        params['term'] = require_text(args, 'term', 'lead_search')
        params.update(params_from(args, ('fields', 'exact_match', 'person_id', 'organization_id', 'include_fields')))
        envelope = self._call_envelope_v2('GET', '/leads/search', params=params)
        items = ((envelope.get('data') or {}).get('items')) or []
        return paginated_v2(envelope, [clean_search_item(i) for i in items])

    @pipedrive_tool(
        group='leads',
        input_schema=schema(required=['title'], **_LEAD_WRITE_PROPS),
        description='Create a lead. Link it to a person or an organization (at least one is required).',
    )
    def lead_create(self, args):
        args = args_of(args)
        require_text(args, 'title', 'lead_create')
        return self._write('POST', '/leads', clean_lead, body=body_from(args, _LEAD_WRITE_KEYS))

    @pipedrive_tool(
        group='leads',
        input_schema=schema(
            required=['lead_id'],
            lead_id=STR('Lead uuid to update.'),
            is_archived=BOOL('Archive or unarchive the lead.'),
            **_LEAD_WRITE_PROPS,
        ),
        description='Update a lead. Only the fields you pass are changed.',
    )
    def lead_update(self, args):
        args = args_of(args)
        lead_id = require_text(args, 'lead_id', 'lead_update')
        body = body_from(args, (*_LEAD_WRITE_KEYS, 'is_archived'))
        return self._write('PATCH', f'/leads/{path_segment(lead_id)}', clean_lead, body=body)

    @pipedrive_tool(
        group='leads',
        input_schema=schema(required=['lead_id'], lead_id=STR('Lead uuid to delete.')),
        description='Delete a lead.',
    )
    def lead_delete(self, args):
        args = args_of(args)
        return self._delete(f'/leads/{path_segment(require_text(args, "lead_id", "lead_delete"))}')

    @pipedrive_tool(
        group='leads',
        input_schema=schema(required=['lead_id'], lead_id=STR('Lead uuid.')),
        description='List users who have permission to see or edit a lead.',
    )
    def lead_permitted_users_list(self, args):
        args = args_of(args)
        lead_id = require_text(args, 'lead_id', 'lead_permitted_users_list')
        return {'user_ids': self._call('GET', f'/leads/{path_segment(lead_id)}/permittedUsers')}

    # -- labels -----------------------------------------------------------

    @pipedrive_tool(
        group='leads',
        input_schema=schema(),
        description='List the lead labels configured in this account, with the uuids to pass as label_ids.',
    )
    def lead_label_list(self, args):
        args_of(args)
        data = self._call('GET', '/leadLabels')
        return {'items': list(data or [])}

    @pipedrive_tool(
        group='leads',
        input_schema=schema(
            required=['name', 'color'],
            name=STR('Label name.'),
            color=ENUM(
                'Label colour.',
                ['green', 'blue', 'red', 'yellow', 'purple', 'gray'],
            ),
        ),
        description='Create a lead label.',
    )
    def lead_label_create(self, args):
        args = args_of(args)
        require_text(args, 'name', 'lead_label_create')
        require_text(args, 'color', 'lead_label_create')
        return self._write('POST', '/leadLabels', passthrough, body=body_from(args, ('name', 'color')))

    @pipedrive_tool(
        group='leads',
        input_schema=schema(
            required=['label_id'],
            label_id=STR('Lead label uuid to update.'),
            name=STR('New label name.'),
            color=ENUM('New label colour.', ['green', 'blue', 'red', 'yellow', 'purple', 'gray']),
        ),
        description='Update a lead label.',
    )
    def lead_label_update(self, args):
        args = args_of(args)
        label_id = require_text(args, 'label_id', 'lead_label_update')
        return self._write(
            'PATCH', f'/leadLabels/{path_segment(label_id)}', passthrough, body=body_from(args, ('name', 'color'))
        )

    @pipedrive_tool(
        group='leads',
        input_schema=schema(required=['label_id'], label_id=STR('Lead label uuid to delete.')),
        description='Delete a lead label.',
    )
    def lead_label_delete(self, args):
        args = args_of(args)
        return self._delete(f'/leadLabels/{path_segment(require_text(args, "label_id", "lead_label_delete"))}')

    # -- sources ----------------------------------------------------------

    @pipedrive_tool(
        group='leads',
        input_schema=schema(),
        description='List the lead sources available in this account.',
    )
    def lead_source_list(self, args):
        args_of(args)
        data = self._call('GET', '/leadSources')
        return {'items': list(data or [])}
