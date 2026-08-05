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

"""Organization tools, plus the organization relationship graph."""

from __future__ import annotations

from ..pipedrive_client import (
    clean_activity,
    clean_deal,
    clean_file,
    clean_mail_message,
    clean_organization,
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

_ORG_WRITE_KEYS = ('name', 'owner_id', 'address', 'label', 'visible_to', 'add_time')

_ORG_WRITE_PROPS = {
    'name': STR('Organization name.'),
    'owner_id': INT('Owner user id. Defaults to the authenticated user.'),
    'address': STR('Postal address as a single line.'),
    'label': INT('Organization label id.'),
    'visible_to': ENUM('Visibility group id.', ['1', '3', '5', '7']),
    'add_time': STR('Creation timestamp, YYYY-MM-DD HH:MM:SS. Use to backdate an imported record.'),
    'extra': EXTRA(),
}


class OrganizationsMixin(PipedriveToolsBase):
    """Tools for the ``organizations`` and ``org_relationships`` groups."""

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(
            **PAGING(),
            user_id=INT('Only organizations owned by this user id.'),
            filter_id=INT('Apply a saved filter by id (see filter_list).'),
            first_char=STR('Only organizations whose name starts with this letter.'),
            sort=STR('Sort clause, e.g. "update_time DESC, id ASC".'),
        ),
        description='List organizations (companies), optionally filtered by owner, saved filter or first letter.',
    )
    def organization_list(self, args):
        args = args_of(args)
        return self._list(
            '/organizations',
            args,
            clean_organization,
            extra=params_from(args, ('user_id', 'filter_id', 'first_char', 'sort')),
        )

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(required=['org_id'], org_id=INT('Organization id.')),
        description='Get a single organization by id, including its custom fields.',
    )
    def organization_get(self, args):
        args = args_of(args)
        return self._get(f'/organizations/{require_id(args, "org_id", "organization_get")}', clean_organization)

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(
            required=['term'],
            term=STR('Search term, at least 2 characters (1 when exact_match is true).'),
            fields=STR('Comma-separated fields to search in: address, custom_fields, notes, name.'),
            exact_match=BOOL('Require an exact, case-sensitive match.'),
            **PAGING_V2(),
        ),
        description='Search organizations by name, address, notes or custom field values.',
    )
    def organization_search(self, args):
        # v2: Pipedrive retired /api/v1/organizations/search (404 "Unknown method .").
        args = args_of(args)
        params = paging_params_v2(args)
        params['term'] = require_text(args, 'term', 'organization_search')
        params.update(params_from(args, ('fields', 'exact_match')))
        envelope = self._call_envelope_v2('GET', '/organizations/search', params=params)
        items = ((envelope.get('data') or {}).get('items')) or []
        return paginated_v2(envelope, [clean_search_item(i) for i in items])

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(required=['name'], **_ORG_WRITE_PROPS),
        description='Create an organization.',
    )
    def organization_create(self, args):
        args = args_of(args)
        require_text(args, 'name', 'organization_create')
        return self._write('POST', '/organizations', clean_organization, body=body_from(args, _ORG_WRITE_KEYS))

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(required=['org_id'], org_id=INT('Organization id to update.'), **_ORG_WRITE_PROPS),
        description='Update an organization. Only the fields you pass are changed.',
    )
    def organization_update(self, args):
        args = args_of(args)
        org_id = require_id(args, 'org_id', 'organization_update')
        return self._write('PUT', f'/organizations/{org_id}', clean_organization, body=body_from(args, _ORG_WRITE_KEYS))

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(required=['org_id'], org_id=INT('Organization id to delete.')),
        description='Delete an organization.',
    )
    def organization_delete(self, args):
        args = args_of(args)
        return self._delete(f'/organizations/{require_id(args, "org_id", "organization_delete")}')

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(
            required=['org_id', 'merge_with_id'],
            org_id=INT('Organization id that will be merged away.'),
            merge_with_id=INT('Organization id that survives the merge.'),
        ),
        description='Merge one organization into another. The source organization is removed.',
    )
    def organization_merge(self, args):
        args = args_of(args)
        org_id = require_id(args, 'org_id', 'organization_merge')
        merge_with_id = require_id(args, 'merge_with_id', 'organization_merge')
        return self._write(
            'PUT', f'/organizations/{org_id}/merge', clean_organization, body={'merge_with_id': merge_with_id}
        )

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(required=['ids'], ids=ARR('Organization ids to delete.', 'integer')),
        description='Delete multiple organizations in one call.',
    )
    def organization_delete_bulk(self, args):
        return self._delete_bulk('/organizations', args_of(args), 'organization_delete_bulk')

    # -- related records --------------------------------------------------

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(
            required=['org_id'],
            org_id=INT('Organization id.'),
            status=ENUM(
                'Only deals with this status (default all_not_deleted).',
                ['open', 'won', 'lost', 'deleted', 'all_not_deleted'],
            ),
            sort=STR('Sort clause, e.g. "add_time DESC".'),
            only_primary_association=INT('Set to 1 to exclude deals linked only through a person.'),
            **PAGING(),
        ),
        description='List deals associated with an organization.',
    )
    def organization_deals_list(self, args):
        args = args_of(args)
        org_id = require_id(args, 'org_id', 'organization_deals_list')
        return self._list(
            f'/organizations/{org_id}/deals',
            args,
            clean_deal,
            extra=params_from(args, ('status', 'sort', 'only_primary_association')),
        )

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(required=['org_id'], org_id=INT('Organization id.'), **PAGING()),
        description='List persons that belong to an organization.',
    )
    def organization_persons_list(self, args):
        args = args_of(args)
        org_id = require_id(args, 'org_id', 'organization_persons_list')
        return self._list(f'/organizations/{org_id}/persons', args, clean_person)

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(
            required=['org_id'],
            org_id=INT('Organization id.'),
            done=INT('0 for pending activities, 1 for completed. Omit for both.'),
            exclude=STR('Comma-separated activity ids to leave out.'),
            **PAGING(),
        ),
        description='List activities associated with an organization.',
    )
    def organization_activities_list(self, args):
        args = args_of(args)
        org_id = require_id(args, 'org_id', 'organization_activities_list')
        return self._list(
            f'/organizations/{org_id}/activities', args, clean_activity, extra=params_from(args, ('done', 'exclude'))
        )

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(required=['org_id'], org_id=INT('Organization id.'), sort=STR('Sort clause.'), **PAGING()),
        description='List files attached to an organization.',
    )
    def organization_files_list(self, args):
        args = args_of(args)
        org_id = require_id(args, 'org_id', 'organization_files_list')
        return self._list(f'/organizations/{org_id}/files', args, clean_file, extra=params_from(args, ('sort',)))

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(
            required=['org_id'],
            org_id=INT('Organization id.'),
            all_changes=STR('Set to "1" to include changes from automations and integrations.'),
            items=STR('Comma-separated update types to include.'),
            **PAGING(),
        ),
        description='Get the update history (flow) of an organization.',
    )
    def organization_updates_list(self, args):
        args = args_of(args)
        org_id = require_id(args, 'org_id', 'organization_updates_list')
        params = paging_params(args)
        params.update(params_from(args, ('all_changes', 'items')))
        envelope = self._call_envelope('GET', f'/organizations/{org_id}/flow', params=params)
        data = envelope.get('data') if isinstance(envelope, dict) else None
        return paginated(envelope, list(data or []))

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(required=['org_id'], org_id=INT('Organization id.'), **PAGING()),
        description='List email messages associated with an organization.',
    )
    def organization_mail_messages_list(self, args):
        args = args_of(args)
        org_id = require_id(args, 'org_id', 'organization_mail_messages_list')
        return self._list(f'/organizations/{org_id}/mailMessages', args, clean_mail_message)

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(required=['org_id'], org_id=INT('Organization id.')),
        description='List users who have permission to see or edit an organization.',
    )
    def organization_permitted_users_list(self, args):
        args = args_of(args)
        org_id = require_id(args, 'org_id', 'organization_permitted_users_list')
        return {'user_ids': self._call('GET', f'/organizations/{org_id}/permittedUsers')}

    # -- followers --------------------------------------------------------

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(required=['org_id'], org_id=INT('Organization id.'), **PAGING()),
        description='List followers of an organization.',
    )
    def organization_followers_list(self, args):
        args = args_of(args)
        org_id = require_id(args, 'org_id', 'organization_followers_list')
        return self._list(f'/organizations/{org_id}/followers', args, passthrough)

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(
            required=['org_id', 'user_id'],
            org_id=INT('Organization id.'),
            user_id=INT('User id to add as a follower.'),
        ),
        description='Add a follower to an organization.',
    )
    def organization_follower_add(self, args):
        args = args_of(args)
        org_id = require_id(args, 'org_id', 'organization_follower_add')
        user_id = require_id(args, 'user_id', 'organization_follower_add')
        return self._write('POST', f'/organizations/{org_id}/followers', passthrough, body={'user_id': user_id})

    @pipedrive_tool(
        group='organizations',
        input_schema=schema(
            required=['org_id', 'follower_id'],
            org_id=INT('Organization id.'),
            follower_id=INT('Follower id (from organization_followers_list, not the user id).'),
        ),
        description='Remove a follower from an organization.',
    )
    def organization_follower_delete(self, args):
        args = args_of(args)
        org_id = require_id(args, 'org_id', 'organization_follower_delete')
        follower_id = require_id(args, 'follower_id', 'organization_follower_delete')
        return self._delete(f'/organizations/{org_id}/followers/{follower_id}')

    # -- relationships (org_relationships group) --------------------------

    @pipedrive_tool(
        group='org_relationships',
        input_schema=schema(required=['org_id'], org_id=INT('Organization id whose relationships to list.')),
        description='List parent/child relationships of an organization.',
    )
    def org_relationship_list(self, args):
        args = args_of(args)
        org_id = require_id(args, 'org_id', 'org_relationship_list')
        data = self._call('GET', '/organizationRelationships', params={'org_id': org_id})
        return {'items': list(data or [])}

    @pipedrive_tool(
        group='org_relationships',
        input_schema=schema(
            required=['relationship_id'],
            relationship_id=INT('Relationship id.'),
            org_id=INT('Organization id used to decide which side is "linked".'),
        ),
        description='Get a single organization relationship.',
    )
    def org_relationship_get(self, args):
        args = args_of(args)
        rel_id = require_id(args, 'relationship_id', 'org_relationship_get')
        return self._call('GET', f'/organizationRelationships/{rel_id}', params=params_from(args, ('org_id',)))

    @pipedrive_tool(
        group='org_relationships',
        input_schema=schema(
            required=['type', 'rel_owner_org_id', 'rel_linked_org_id'],
            type=ENUM('Relationship type.', ['parent', 'related']),
            rel_owner_org_id=INT('Organization id that owns the relationship (the parent, for type "parent").'),
            rel_linked_org_id=INT('Organization id being linked (the daughter, for type "parent").'),
            org_id=INT('Organization id used to decide which side is "linked" in the response.'),
        ),
        description='Create a relationship between two organizations.',
    )
    def org_relationship_create(self, args):
        args = args_of(args)
        require_text(args, 'type', 'org_relationship_create')
        require_id(args, 'rel_owner_org_id', 'org_relationship_create')
        require_id(args, 'rel_linked_org_id', 'org_relationship_create')
        body = body_from(args, ('type', 'rel_owner_org_id', 'rel_linked_org_id', 'org_id'))
        return self._write('POST', '/organizationRelationships', passthrough, body=body)

    @pipedrive_tool(
        group='org_relationships',
        input_schema=schema(
            required=['relationship_id'],
            relationship_id=INT('Relationship id to update.'),
            type=ENUM('Relationship type.', ['parent', 'related']),
            rel_owner_org_id=INT('New owner organization id.'),
            rel_linked_org_id=INT('New linked organization id.'),
            org_id=INT('Organization id used to decide which side is "linked" in the response.'),
        ),
        description='Update an organization relationship.',
    )
    def org_relationship_update(self, args):
        args = args_of(args)
        rel_id = require_id(args, 'relationship_id', 'org_relationship_update')
        body = body_from(args, ('type', 'rel_owner_org_id', 'rel_linked_org_id', 'org_id'))
        return self._write('PUT', f'/organizationRelationships/{rel_id}', passthrough, body=body)

    @pipedrive_tool(
        group='org_relationships',
        input_schema=schema(required=['relationship_id'], relationship_id=INT('Relationship id to delete.')),
        description='Delete an organization relationship.',
    )
    def org_relationship_delete(self, args):
        args = args_of(args)
        rel_id = require_id(args, 'relationship_id', 'org_relationship_delete')
        return self._delete(f'/organizationRelationships/{rel_id}')
