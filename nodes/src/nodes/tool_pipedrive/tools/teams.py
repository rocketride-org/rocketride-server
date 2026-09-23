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

"""Team tools (legacy v1 teams surface)."""

from __future__ import annotations

from ..pipedrive_client import clean_team
from ..tool_groups import pipedrive_tool
from ._base import (
    ARR,
    INT,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    params_from,
    passthrough,
    require_id,
    require_text,
    schema,
)


class TeamsMixin(PipedriveToolsBase):
    """Tools for the ``teams`` group."""

    @pipedrive_tool(
        group='teams',
        input_schema=schema(
            order_by=STR('Field to order by: id, name, manager_id or active_flag.'),
            skip_users=INT('Set to 1 to leave the user id list out of the response.'),
        ),
        description='List all teams.',
    )
    def team_list(self, args):
        args = args_of(args)
        data = self._call('GET', '/teams', params=params_from(args, ('order_by', 'skip_users')))
        return {'items': [clean_team(t) for t in (data or [])]}

    @pipedrive_tool(
        group='teams',
        input_schema=schema(
            required=['team_id'],
            team_id=INT('Team id.'),
            skip_users=INT('Set to 1 to leave the user id list out of the response.'),
        ),
        description='Get a single team.',
    )
    def team_get(self, args):
        args = args_of(args)
        team_id = require_id(args, 'team_id', 'team_get')
        return self._get(f'/teams/{team_id}', clean_team, params=params_from(args, ('skip_users',)))

    @pipedrive_tool(
        group='teams',
        input_schema=schema(
            required=['name', 'manager_id'],
            name=STR('Team name.'),
            manager_id=INT('User id of the team manager.'),
            description=STR('Team description.'),
            users=ARR('User ids that belong to the team.', 'integer'),
        ),
        description='Create a team.',
    )
    def team_create(self, args):
        args = args_of(args)
        require_text(args, 'name', 'team_create')
        require_id(args, 'manager_id', 'team_create')
        return self._write(
            'POST', '/teams', clean_team, body=body_from(args, ('name', 'manager_id', 'description', 'users'))
        )

    @pipedrive_tool(
        group='teams',
        input_schema=schema(
            required=['team_id'],
            team_id=INT('Team id to update.'),
            name=STR('New team name.'),
            manager_id=INT('New manager user id.'),
            description=STR('New description.'),
            users=ARR('Replacement list of user ids.', 'integer'),
            active_flag=INT('1 to activate the team, 0 to deactivate it.'),
            deleted_flag=INT('1 to mark the team deleted.'),
        ),
        description='Update a team.',
    )
    def team_update(self, args):
        args = args_of(args)
        team_id = require_id(args, 'team_id', 'team_update')
        body = body_from(args, ('name', 'manager_id', 'description', 'users', 'active_flag', 'deleted_flag'))
        return self._write('PUT', f'/teams/{team_id}', clean_team, body=body)

    @pipedrive_tool(
        group='teams',
        input_schema=schema(required=['team_id'], team_id=INT('Team id.')),
        description='List the user ids that belong to a team.',
    )
    def team_users_list(self, args):
        args = args_of(args)
        team_id = require_id(args, 'team_id', 'team_users_list')
        return {'user_ids': self._call('GET', f'/teams/{team_id}/users')}

    @pipedrive_tool(
        group='teams',
        input_schema=schema(
            required=['team_id', 'users'], team_id=INT('Team id.'), users=ARR('User ids to add.', 'integer')
        ),
        description='Add users to a team.',
    )
    def team_user_add(self, args):
        args = args_of(args)
        team_id = require_id(args, 'team_id', 'team_user_add')
        users = args.get('users')
        if not isinstance(users, list) or not users:
            raise ValueError('team_user_add: "users" must be a non-empty array of user ids')
        return self._write('POST', f'/teams/{team_id}/users', passthrough, body={'users': users})

    @pipedrive_tool(
        group='teams',
        input_schema=schema(
            required=['team_id', 'users'], team_id=INT('Team id.'), users=ARR('User ids to remove.', 'integer')
        ),
        description='Remove users from a team.',
    )
    def team_user_delete(self, args):
        args = args_of(args)
        team_id = require_id(args, 'team_id', 'team_user_delete')
        users = args.get('users')
        if not isinstance(users, list) or not users:
            raise ValueError('team_user_delete: "users" must be a non-empty array of user ids')
        self._require_write()
        # Pipedrive reads the payload of this DELETE as form data, not JSON.
        data = self._call('DELETE', f'/teams/{team_id}/users', form={'users': users})
        return {'deleted': True, 'data': data}

    @pipedrive_tool(
        group='teams',
        input_schema=schema(
            required=['user_id'],
            user_id=INT('User id.'),
            order_by=STR('Field to order by: id, name, manager_id or active_flag.'),
            skip_users=INT('Set to 1 to leave the user id lists out of the response.'),
        ),
        description='List the teams a user belongs to.',
    )
    def team_list_for_user(self, args):
        args = args_of(args)
        user_id = require_id(args, 'user_id', 'team_list_for_user')
        data = self._call('GET', f'/teams/user/{user_id}', params=params_from(args, ('order_by', 'skip_users')))
        return {'items': [clean_team(t) for t in (data or [])]}
