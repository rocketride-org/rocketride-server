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

"""Person tools: contacts, their deals, activities, files and followers."""

from __future__ import annotations

from ..pipedrive_client import (
    clean_activity,
    clean_deal,
    clean_file,
    clean_mail_message,
    clean_person,
    clean_search_item,
    paginated,
    paginated_v2,
)
from ..tool_groups import pipedrive_tool
from ._base import (
    ARR,
    BOOL,
    ENUM,
    EXTRA,
    INT,
    PAGING,
    PAGING_V2,
    STR,
    UTC_TIME_DESC,
    PipedriveToolsBase,
    args_of,
    body_from,
    paging_params,
    paging_params_v2,
    params_from,
    passthrough,
    require_id,
    require_text,
    schema,
)

_PERSON_WRITE_KEYS = (
    'name',
    'owner_id',
    'org_id',
    'email',
    'phone',
    'label',
    'visible_to',
    'marketing_status',
    'add_time',
)

_CONTACT_ARRAY_DESC = (
    'Array of contact entries. Each entry is an object like '
    '{"value": "a@example.com", "primary": true, "label": "work"}. '
    'A plain array of strings is also accepted and the first entry becomes primary.'
)

_PERSON_WRITE_PROPS = {
    'name': STR('Full name of the person.'),
    'owner_id': INT('Owner user id. Defaults to the authenticated user.'),
    'org_id': INT('Organization id this person belongs to.'),
    'email': {'type': 'array', 'items': {'type': 'object'}, 'description': _CONTACT_ARRAY_DESC},
    'phone': {'type': 'array', 'items': {'type': 'object'}, 'description': _CONTACT_ARRAY_DESC},
    'label': INT('Person label id.'),
    'visible_to': ENUM('Visibility group id.', ['1', '3', '5', '7']),
    'marketing_status': ENUM(
        'Consent status for marketing emails.', ['no_consent', 'unsubscribed', 'subscribed', 'archived']
    ),
    'add_time': STR(f'Creation timestamp, YYYY-MM-DD HH:MM:SS. Use to backdate an imported record. {UTC_TIME_DESC}'),
    'extra': EXTRA(),
}


def _normalize_contacts(args: dict) -> None:
    """Accept a plain list of strings for email/phone and expand it to Pipedrive's shape."""
    for key in ('email', 'phone'):
        value = args.get(key)
        if isinstance(value, str):
            value = [value]
        if isinstance(value, list) and value and all(isinstance(v, str) for v in value):
            args[key] = [{'value': v, 'primary': i == 0} for i, v in enumerate(value)]


class PersonsMixin(PipedriveToolsBase):
    """Tools for the ``persons`` group."""

    @pipedrive_tool(
        group='persons',
        input_schema=schema(
            **PAGING(),
            user_id=INT('Only persons owned by this user id.'),
            filter_id=INT('Apply a saved filter by id (see filter_list).'),
            first_char=STR('Only persons whose name starts with this letter (case-insensitive).'),
            sort=STR('Sort clause, e.g. "update_time DESC, id ASC".'),
        ),
        description='List persons (contacts), optionally filtered by owner, saved filter or first letter.',
    )
    def person_list(self, args):
        args = args_of(args)
        return self._list(
            '/persons', args, clean_person, extra=params_from(args, ('user_id', 'filter_id', 'first_char', 'sort'))
        )

    @pipedrive_tool(
        group='persons',
        input_schema=schema(required=['person_id'], person_id=INT('Person id.')),
        description='Get a single person by id, including emails, phones and custom fields.',
    )
    def person_get(self, args):
        args = args_of(args)
        return self._get(f'/persons/{require_id(args, "person_id", "person_get")}', clean_person)

    @pipedrive_tool(
        group='persons',
        input_schema=schema(
            required=['term'],
            term=STR('Search term, at least 2 characters (1 when exact_match is true).'),
            fields=STR('Comma-separated fields to search in: custom_fields, email, notes, phone, name.'),
            exact_match=BOOL('Require an exact, case-sensitive match.'),
            organization_id=INT('Only persons in this organization.'),
            include_fields=STR('Extra fields to include, e.g. "person.picture".'),
            **PAGING_V2(),
        ),
        description='Search persons by name, email, phone, notes or custom field values.',
    )
    def person_search(self, args):
        # v2: Pipedrive retired /api/v1/persons/search (404 "Unknown method .").
        args = args_of(args)
        params = paging_params_v2(args)
        params['term'] = require_text(args, 'term', 'person_search')
        params.update(params_from(args, ('fields', 'exact_match', 'organization_id', 'include_fields')))
        envelope = self._call_envelope_v2('GET', '/persons/search', params=params)
        items = ((envelope.get('data') or {}).get('items')) or []
        return paginated_v2(envelope, [clean_search_item(i) for i in items])

    @pipedrive_tool(
        group='persons',
        input_schema=schema(required=['name'], **_PERSON_WRITE_PROPS),
        description='Create a person (contact).',
    )
    def person_create(self, args):
        args = args_of(args)
        require_text(args, 'name', 'person_create')
        _normalize_contacts(args)
        return self._write('POST', '/persons', clean_person, body=body_from(args, _PERSON_WRITE_KEYS))

    @pipedrive_tool(
        group='persons',
        input_schema=schema(required=['person_id'], person_id=INT('Person id to update.'), **_PERSON_WRITE_PROPS),
        description='Update a person. Only the fields you pass are changed; passing email or phone replaces the whole list.',
    )
    def person_update(self, args):
        args = args_of(args)
        person_id = require_id(args, 'person_id', 'person_update')
        _normalize_contacts(args)
        return self._write('PUT', f'/persons/{person_id}', clean_person, body=body_from(args, _PERSON_WRITE_KEYS))

    @pipedrive_tool(
        group='persons',
        input_schema=schema(required=['person_id'], person_id=INT('Person id to delete.')),
        description='Delete a person.',
    )
    def person_delete(self, args):
        args = args_of(args)
        return self._delete(f'/persons/{require_id(args, "person_id", "person_delete")}')

    @pipedrive_tool(
        group='persons',
        input_schema=schema(
            required=['person_id', 'merge_with_id'],
            person_id=INT('Person id that will be merged away.'),
            merge_with_id=INT('Person id that survives the merge.'),
        ),
        description='Merge one person into another. The source person is removed.',
    )
    def person_merge(self, args):
        args = args_of(args)
        person_id = require_id(args, 'person_id', 'person_merge')
        merge_with_id = require_id(args, 'merge_with_id', 'person_merge')
        return self._write('PUT', f'/persons/{person_id}/merge', clean_person, body={'merge_with_id': merge_with_id})

    @pipedrive_tool(
        group='persons',
        input_schema=schema(required=['ids'], ids=ARR('Person ids to delete.', 'integer')),
        description='Delete multiple persons in one call.',
    )
    def person_delete_bulk(self, args):
        return self._delete_bulk('/persons', args_of(args), 'person_delete_bulk')

    # -- related records --------------------------------------------------

    @pipedrive_tool(
        group='persons',
        input_schema=schema(
            required=['person_id'],
            person_id=INT('Person id.'),
            status=ENUM(
                'Only deals with this status (default all_not_deleted).',
                ['open', 'won', 'lost', 'deleted', 'all_not_deleted'],
            ),
            sort=STR('Sort clause, e.g. "add_time DESC".'),
            **PAGING(),
        ),
        description='List deals associated with a person.',
    )
    def person_deals_list(self, args):
        args = args_of(args)
        person_id = require_id(args, 'person_id', 'person_deals_list')
        return self._list(f'/persons/{person_id}/deals', args, clean_deal, extra=params_from(args, ('status', 'sort')))

    @pipedrive_tool(
        group='persons',
        input_schema=schema(
            required=['person_id'],
            person_id=INT('Person id.'),
            done=INT('0 for pending activities, 1 for completed. Omit for both.'),
            exclude=STR('Comma-separated activity ids to leave out.'),
            **PAGING(),
        ),
        description='List activities associated with a person.',
    )
    def person_activities_list(self, args):
        args = args_of(args)
        person_id = require_id(args, 'person_id', 'person_activities_list')
        return self._list(
            f'/persons/{person_id}/activities', args, clean_activity, extra=params_from(args, ('done', 'exclude'))
        )

    @pipedrive_tool(
        group='persons',
        input_schema=schema(required=['person_id'], person_id=INT('Person id.'), sort=STR('Sort clause.'), **PAGING()),
        description='List files attached to a person.',
    )
    def person_files_list(self, args):
        args = args_of(args)
        person_id = require_id(args, 'person_id', 'person_files_list')
        return self._list(f'/persons/{person_id}/files', args, clean_file, extra=params_from(args, ('sort',)))

    @pipedrive_tool(
        group='persons',
        input_schema=schema(
            required=['person_id'],
            person_id=INT('Person id.'),
            all_changes=STR('Set to "1" to include changes from automations and integrations.'),
            items=STR('Comma-separated update types to include.'),
            **PAGING(),
        ),
        description='Get the update history (flow) of a person.',
    )
    def person_updates_list(self, args):
        args = args_of(args)
        person_id = require_id(args, 'person_id', 'person_updates_list')
        params = paging_params(args)
        params.update(params_from(args, ('all_changes', 'items')))
        envelope = self._call_envelope('GET', f'/persons/{person_id}/flow', params=params)
        data = envelope.get('data') if isinstance(envelope, dict) else None
        return paginated(envelope, list(data or []))

    @pipedrive_tool(
        group='persons',
        input_schema=schema(required=['person_id'], person_id=INT('Person id.'), **PAGING()),
        description='List email messages associated with a person.',
    )
    def person_mail_messages_list(self, args):
        args = args_of(args)
        person_id = require_id(args, 'person_id', 'person_mail_messages_list')
        return self._list(f'/persons/{person_id}/mailMessages', args, clean_mail_message)

    @pipedrive_tool(
        group='persons',
        input_schema=schema(required=['person_id'], person_id=INT('Person id.'), **PAGING()),
        description='List products associated with a person through their deals.',
    )
    def person_products_list(self, args):
        args = args_of(args)
        person_id = require_id(args, 'person_id', 'person_products_list')
        return self._list(f'/persons/{person_id}/products', args, passthrough)

    @pipedrive_tool(
        group='persons',
        input_schema=schema(required=['person_id'], person_id=INT('Person id.')),
        description='List users who have permission to see or edit a person.',
    )
    def person_permitted_users_list(self, args):
        args = args_of(args)
        person_id = require_id(args, 'person_id', 'person_permitted_users_list')
        return {'user_ids': self._call('GET', f'/persons/{person_id}/permittedUsers')}

    # -- followers --------------------------------------------------------

    @pipedrive_tool(
        group='persons',
        input_schema=schema(required=['person_id'], person_id=INT('Person id.'), **PAGING()),
        description='List followers of a person.',
    )
    def person_followers_list(self, args):
        args = args_of(args)
        person_id = require_id(args, 'person_id', 'person_followers_list')
        return self._list(f'/persons/{person_id}/followers', args, passthrough)

    @pipedrive_tool(
        group='persons',
        input_schema=schema(
            required=['person_id', 'user_id'], person_id=INT('Person id.'), user_id=INT('User id to add as follower.')
        ),
        description='Add a follower to a person.',
    )
    def person_follower_add(self, args):
        args = args_of(args)
        person_id = require_id(args, 'person_id', 'person_follower_add')
        user_id = require_id(args, 'user_id', 'person_follower_add')
        return self._write('POST', f'/persons/{person_id}/followers', passthrough, body={'user_id': user_id})

    @pipedrive_tool(
        group='persons',
        input_schema=schema(
            required=['person_id', 'follower_id'],
            person_id=INT('Person id.'),
            follower_id=INT('Follower id (from person_followers_list, not the user id).'),
        ),
        description='Remove a follower from a person.',
    )
    def person_follower_delete(self, args):
        args = args_of(args)
        person_id = require_id(args, 'person_id', 'person_follower_delete')
        follower_id = require_id(args, 'follower_id', 'person_follower_delete')
        return self._delete(f'/persons/{person_id}/followers/{follower_id}')
