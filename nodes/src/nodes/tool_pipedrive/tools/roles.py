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

"""Role and permission-set tools (admin surface)."""

from __future__ import annotations

from ..pipedrive_client import clean_role, clean_user
from ..tool_groups import pipedrive_tool
from ._base import (
    ARR,
    INT,
    PAGING,
    STR,
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


class RolesMixin(PipedriveToolsBase):
    """Tools for the ``roles`` and ``permission_sets`` groups."""

    # -- roles ------------------------------------------------------------

    @pipedrive_tool(
        group='roles',
        input_schema=schema(**PAGING()),
        description='List the roles configured in the account.',
    )
    def role_list(self, args):
        args = args_of(args)
        return self._list('/roles', args, clean_role)

    @pipedrive_tool(
        group='roles',
        input_schema=schema(required=['role_id'], role_id=INT('Role id.')),
        description='Get a single role.',
    )
    def role_get(self, args):
        args = args_of(args)
        return self._get(f'/roles/{require_id(args, "role_id", "role_get")}', clean_role)

    @pipedrive_tool(
        group='roles',
        input_schema=schema(
            required=['name'], name=STR('Role name.'), parent_role_id=INT('Parent role id, for nested roles.')
        ),
        description='Create a role.',
    )
    def role_create(self, args):
        args = args_of(args)
        require_text(args, 'name', 'role_create')
        return self._write('POST', '/roles', clean_role, body=body_from(args, ('name', 'parent_role_id')))

    @pipedrive_tool(
        group='roles',
        input_schema=schema(
            required=['role_id'],
            role_id=INT('Role id to update.'),
            name=STR('New role name.'),
            parent_role_id=INT('New parent role id.'),
        ),
        description='Update a role.',
    )
    def role_update(self, args):
        args = args_of(args)
        role_id = require_id(args, 'role_id', 'role_update')
        return self._write('PUT', f'/roles/{role_id}', clean_role, body=body_from(args, ('name', 'parent_role_id')))

    @pipedrive_tool(
        group='roles',
        input_schema=schema(required=['role_id'], role_id=INT('Role id to delete.')),
        description='Delete a role.',
    )
    def role_delete(self, args):
        args = args_of(args)
        return self._delete(f'/roles/{require_id(args, "role_id", "role_delete")}')

    @pipedrive_tool(
        group='roles',
        input_schema=schema(required=['role_id'], role_id=INT('Role id.'), **PAGING()),
        description='List the sub-roles of a role.',
    )
    def role_sub_roles_list(self, args):
        args = args_of(args)
        role_id = require_id(args, 'role_id', 'role_sub_roles_list')
        return self._list(f'/roles/{role_id}/roles', args, clean_role)

    @pipedrive_tool(
        group='roles',
        input_schema=schema(required=['role_id'], role_id=INT('Role id.'), **PAGING()),
        description='List the users assigned to a role.',
    )
    def role_assignments_list(self, args):
        args = args_of(args)
        role_id = require_id(args, 'role_id', 'role_assignments_list')
        return self._list(f'/roles/{role_id}/assignments', args, clean_user)

    @pipedrive_tool(
        group='roles',
        input_schema=schema(
            required=['role_id', 'user_id'], role_id=INT('Role id.'), user_id=INT('User id to assign to the role.')
        ),
        description='Assign a user to a role.',
    )
    def role_assignment_add(self, args):
        args = args_of(args)
        role_id = require_id(args, 'role_id', 'role_assignment_add')
        user_id = require_id(args, 'user_id', 'role_assignment_add')
        return self._write('POST', f'/roles/{role_id}/assignments', passthrough, body={'user_id': user_id})

    @pipedrive_tool(
        group='roles',
        input_schema=schema(
            required=['role_id', 'user_id'], role_id=INT('Role id.'), user_id=INT('User id to remove from the role.')
        ),
        description='Remove a user from a role.',
    )
    def role_assignment_delete(self, args):
        args = args_of(args)
        role_id = require_id(args, 'role_id', 'role_assignment_delete')
        user_id = require_id(args, 'user_id', 'role_assignment_delete')
        self._require_write()
        # Pipedrive reads the payload of this DELETE as form data, not JSON.
        data = self._call('DELETE', f'/roles/{role_id}/assignments', form={'user_id': user_id})
        return {'deleted': True, 'data': data}

    @pipedrive_tool(
        group='roles',
        input_schema=schema(required=['role_id'], role_id=INT('Role id.')),
        description='Get the visibility settings of a role.',
    )
    def role_settings_get(self, args):
        args = args_of(args)
        role_id = require_id(args, 'role_id', 'role_settings_get')
        return self._call('GET', f'/roles/{role_id}/settings')

    @pipedrive_tool(
        group='roles',
        input_schema=schema(
            required=['role_id', 'setting_key', 'value'],
            role_id=INT('Role id.'),
            setting_key=STR(
                'Setting to change, e.g. "deal_default_visibility", "org_default_visibility", '
                '"person_default_visibility", "product_default_visibility", "deal_access_level".'
            ),
            value=INT('New value for the setting.'),
        ),
        description='Change one visibility setting of a role.',
    )
    def role_setting_set(self, args):
        args = args_of(args)
        role_id = require_id(args, 'role_id', 'role_setting_set')
        key = require_text(args, 'setting_key', 'role_setting_set')
        value = require_id(args, 'value', 'role_setting_set')
        return self._write('POST', f'/roles/{role_id}/settings', passthrough, body={'setting_key': key, 'value': value})

    @pipedrive_tool(
        group='roles',
        input_schema=schema(
            required=['role_id'],
            role_id=INT('Role id.'),
            visible=INT('1 for pipelines visible to the role, 0 for hidden ones.'),
        ),
        description='List which pipelines a role can see.',
    )
    def role_pipelines_list(self, args):
        args = args_of(args)
        role_id = require_id(args, 'role_id', 'role_pipelines_list')
        return self._call('GET', f'/roles/{role_id}/pipelines', params=params_from(args, ('visible',)))

    @pipedrive_tool(
        group='roles',
        input_schema=schema(
            required=['role_id', 'visible_pipeline_ids'],
            role_id=INT('Role id.'),
            visible_pipeline_ids=ARR('Pipeline ids the role may see.', 'integer'),
        ),
        description='Set which pipelines a role can see.',
    )
    def role_pipelines_set(self, args):
        args = args_of(args)
        role_id = require_id(args, 'role_id', 'role_pipelines_set')
        ids = args.get('visible_pipeline_ids')
        if not isinstance(ids, list):
            raise ValueError('role_pipelines_set: "visible_pipeline_ids" must be an array of pipeline ids')
        return self._write('PUT', f'/roles/{role_id}/pipelines', passthrough, body={'visible_pipeline_ids': ids})

    # -- permission sets --------------------------------------------------

    @pipedrive_tool(
        group='permission_sets',
        input_schema=schema(app=STR('Only permission sets for this app: sales, projects, campaigns or global.')),
        description='List the permission sets available in the account.',
    )
    def permission_set_list(self, args):
        args = args_of(args)
        data = self._call('GET', '/permissionSets', params=params_from(args, ('app',)))
        return {'items': list(data or [])}

    @pipedrive_tool(
        group='permission_sets',
        input_schema=schema(required=['permission_set_id'], permission_set_id=STR('Permission set id.')),
        description='Get a single permission set.',
    )
    def permission_set_get(self, args):
        args = args_of(args)
        set_id = require_text(args, 'permission_set_id', 'permission_set_get')
        return self._call('GET', f'/permissionSets/{path_segment(set_id)}')

    @pipedrive_tool(
        group='permission_sets',
        input_schema=schema(required=['permission_set_id'], permission_set_id=STR('Permission set id.'), **PAGING()),
        description='List the users assigned to a permission set.',
    )
    def permission_set_assignments_list(self, args):
        args = args_of(args)
        set_id = require_text(args, 'permission_set_id', 'permission_set_assignments_list')
        return self._list(f'/permissionSets/{path_segment(set_id)}/assignments', args, clean_user)
