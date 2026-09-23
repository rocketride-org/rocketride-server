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

"""User tools: the account's users, their settings and their permissions."""

from __future__ import annotations

from ..pipedrive_client import clean_user
from ..tool_groups import pipedrive_tool
from ._base import (
    BOOL,
    INT,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    params_from,
    require_id,
    require_text,
    schema,
)


class UsersMixin(PipedriveToolsBase):
    """Tools for the ``users`` group."""

    @pipedrive_tool(
        group='users',
        input_schema=schema(),
        description='List all users in the Pipedrive account. Use this to resolve a user name to the user_id needed by owner filters.',
    )
    def user_list(self, args):
        args_of(args)
        data = self._call('GET', '/users')
        return {'items': [clean_user(u) for u in (data or [])]}

    @pipedrive_tool(
        group='users',
        input_schema=schema(required=['user_id'], user_id=INT('User id.')),
        description='Get a single user by id.',
    )
    def user_get(self, args):
        args = args_of(args)
        return self._get(f'/users/{require_id(args, "user_id", "user_get")}', clean_user)

    @pipedrive_tool(
        group='users',
        input_schema=schema(),
        description='Get the user the API token belongs to, including the company id, domain and default currency.',
    )
    def user_me(self, args):
        args_of(args)
        return self._call('GET', '/users/me')

    @pipedrive_tool(
        group='users',
        input_schema=schema(
            required=['term'],
            term=STR('Name or email to look for.'),
            search_by_email=INT('Set to 1 to match the term against email addresses instead of names.'),
        ),
        description='Find users by name or email.',
    )
    def user_find(self, args):
        args = args_of(args)
        params = {'term': require_text(args, 'term', 'user_find')}
        params.update(params_from(args, ('search_by_email',)))
        data = self._call('GET', '/users/find', params=params)
        return {'items': [clean_user(u) for u in (data or [])]}

    @pipedrive_tool(
        group='users',
        input_schema=schema(
            required=['email', 'access'],
            email=STR('Email address to invite.'),
            access={
                'type': 'array',
                'items': {'type': 'object'},
                'description': 'Access permissions, e.g. [{"app": "sales", "admin": false}]. Apps: sales, projects, campaigns, global.',
            },
            active_flag=BOOL('Whether the new user is active (default true).'),
        ),
        description='Invite a new user to the Pipedrive account.',
    )
    def user_create(self, args):
        args = args_of(args)
        require_text(args, 'email', 'user_create')
        if not isinstance(args.get('access'), list) or not args['access']:
            raise ValueError('user_create: "access" must be a non-empty array of access objects')
        return self._write('POST', '/users', clean_user, body=body_from(args, ('email', 'access', 'active_flag')))

    @pipedrive_tool(
        group='users',
        input_schema=schema(
            required=['user_id', 'active_flag'],
            user_id=INT('User id to update.'),
            active_flag=BOOL('Whether the user is active. Set false to deactivate.'),
        ),
        description='Activate or deactivate a user.',
    )
    def user_update(self, args):
        args = args_of(args)
        user_id = require_id(args, 'user_id', 'user_update')
        if 'active_flag' not in args:
            raise ValueError('user_update: "active_flag" is required')
        return self._write('PUT', f'/users/{user_id}', clean_user, body={'active_flag': bool(args['active_flag'])})

    @pipedrive_tool(
        group='users',
        input_schema=schema(required=['user_id'], user_id=INT('User id.')),
        description='List the followers of a user.',
    )
    def user_followers_list(self, args):
        args = args_of(args)
        user_id = require_id(args, 'user_id', 'user_followers_list')
        return {'user_ids': self._call('GET', f'/users/{user_id}/followers')}

    @pipedrive_tool(
        group='users',
        input_schema=schema(required=['user_id'], user_id=INT('User id.')),
        description='List the effective permissions of a user (what they can see, add, edit and delete).',
    )
    def user_permissions_get(self, args):
        args = args_of(args)
        user_id = require_id(args, 'user_id', 'user_permissions_get')
        return self._call('GET', f'/users/{user_id}/permissions')

    @pipedrive_tool(
        group='users',
        input_schema=schema(required=['user_id'], user_id=INT('User id.')),
        description='List the role assignments of a user.',
    )
    def user_role_assignments_list(self, args):
        args = args_of(args)
        user_id = require_id(args, 'user_id', 'user_role_assignments_list')
        data = self._call('GET', f'/users/{user_id}/roleAssignments')
        return {'items': list(data or [])}

    @pipedrive_tool(
        group='users',
        input_schema=schema(required=['user_id'], user_id=INT('User id.')),
        description='Get the role settings that apply to a user.',
    )
    def user_role_settings_get(self, args):
        args = args_of(args)
        user_id = require_id(args, 'user_id', 'user_role_settings_get')
        return self._call('GET', f'/users/{user_id}/roleSettings')

    @pipedrive_tool(
        group='users',
        input_schema=schema(),
        description='Get the authenticated user settings: timezone, currency, date format and feature flags.',
    )
    def user_settings_get(self, args):
        args_of(args)
        return self._call('GET', '/userSettings')

    @pipedrive_tool(
        group='users',
        input_schema=schema(),
        description='List the third-party accounts (Google, Microsoft, ...) connected to the authenticated user.',
    )
    def user_connections_list(self, args):
        args_of(args)
        return self._call('GET', '/userConnections')
