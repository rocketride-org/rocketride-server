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

"""
Project tools: projects, their plans, tasks, phases, boards and templates.

The projects endpoints use cursor pagination rather than the ``start``/``limit``
offsets the rest of v1 uses, so these tools take a ``cursor`` and return
``next_cursor``.
"""

from __future__ import annotations

from ..pipedrive_client import clean_activity, clean_project, clean_task, paginated_v2
from ..tool_groups import pipedrive_tool
from ._base import (
    ARR,
    BOOL,
    ENUM,
    EXTRA,
    INT,
    PAGING_V2,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    paging_params_v2,
    params_from,
    passthrough,
    require_id,
    require_text,
    schema,
)

_PROJECT_WRITE_KEYS = (
    'title',
    'board_id',
    'phase_id',
    'description',
    'status',
    'owner_id',
    'start_date',
    'end_date',
    'deal_ids',
    'org_id',
    'person_id',
    'labels',
    'template_id',
)

_PROJECT_WRITE_PROPS = {
    'title': STR('Project title.'),
    'board_id': INT('Board the project belongs to.'),
    'phase_id': INT('Phase within the board.'),
    'description': STR('Project description.'),
    'status': ENUM('Project status.', ['open', 'completed', 'canceled', 'deleted']),
    'owner_id': INT('Owner user id.'),
    'start_date': STR('Start date, YYYY-MM-DD.'),
    'end_date': STR('End date, YYYY-MM-DD.'),
    'deal_ids': ARR('Deal ids linked to the project.', 'integer'),
    'org_id': INT('Linked organization id.'),
    'person_id': INT('Linked person id.'),
    'labels': ARR('Project label ids.', 'integer'),
    'template_id': INT('Project template to create from.'),
    'extra': EXTRA(),
}

_TASK_WRITE_KEYS = (
    'title',
    'project_id',
    'description',
    'parent_task_id',
    'assignee_id',
    'done',
    'due_date',
)

_TASK_WRITE_PROPS = {
    'title': STR('Task title.'),
    'project_id': INT('Project the task belongs to.'),
    'description': STR('Task description.'),
    'parent_task_id': INT('Parent task id, for subtasks.'),
    'assignee_id': INT('User assigned to the task.'),
    'done': INT('0 for open, 1 for done.'),
    'due_date': STR('Due date, YYYY-MM-DD.'),
    'extra': EXTRA(),
}


class ProjectsMixin(PipedriveToolsBase):
    """Tools for the ``projects`` group."""

    def _cursor_list(self, path: str, args: dict, cleaner, *, extra: dict | None = None) -> dict:
        """GET a cursor-paged collection. Same contract as the v2 search tools.

        The project endpoints are v1 routes but page by opaque cursor rather than
        offset, so they borrow the v2 paging vocabulary — one implementation of
        the cursor contract, not two that can drift over clamping or cursor
        trimming.
        """
        params = paging_params_v2(args)
        if extra:
            params.update(extra)
        envelope = self._call_envelope('GET', path, params=params)
        data = envelope.get('data') if isinstance(envelope, dict) else None
        return paginated_v2(envelope, [cleaner(item) for item in (data or [])])

    # -- projects ---------------------------------------------------------

    @pipedrive_tool(
        group='projects',
        input_schema=schema(
            **PAGING_V2(),
            filter_id=INT('Apply a saved filter by id.'),
            status=STR('Comma-separated statuses to include: open, completed, canceled, deleted.'),
            phase_id=INT('Only projects in this phase.'),
            include_archived=BOOL('Include archived projects.'),
        ),
        description='List projects.',
    )
    def project_list(self, args):
        args = args_of(args)
        return self._cursor_list(
            '/projects',
            args,
            clean_project,
            extra=params_from(args, ('filter_id', 'status', 'phase_id', 'include_archived')),
        )

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['project_id'], project_id=INT('Project id.')),
        description='Get a single project.',
    )
    def project_get(self, args):
        args = args_of(args)
        return self._get(f'/projects/{require_id(args, "project_id", "project_get")}', clean_project)

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['title', 'board_id', 'phase_id'], **_PROJECT_WRITE_PROPS),
        description='Create a project.',
    )
    def project_create(self, args):
        args = args_of(args)
        require_text(args, 'title', 'project_create')
        require_id(args, 'board_id', 'project_create')
        require_id(args, 'phase_id', 'project_create')
        return self._write('POST', '/projects', clean_project, body=body_from(args, _PROJECT_WRITE_KEYS))

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['project_id'], project_id=INT('Project id to update.'), **_PROJECT_WRITE_PROPS),
        description='Update a project.',
    )
    def project_update(self, args):
        args = args_of(args)
        project_id = require_id(args, 'project_id', 'project_update')
        return self._write('PUT', f'/projects/{project_id}', clean_project, body=body_from(args, _PROJECT_WRITE_KEYS))

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['project_id'], project_id=INT('Project id to delete.')),
        description='Delete a project.',
    )
    def project_delete(self, args):
        args = args_of(args)
        return self._delete(f'/projects/{require_id(args, "project_id", "project_delete")}')

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['project_id'], project_id=INT('Project id to archive.')),
        description='Archive a project.',
    )
    def project_archive(self, args):
        args = args_of(args)
        project_id = require_id(args, 'project_id', 'project_archive')
        return self._write('POST', f'/projects/{project_id}/archive', clean_project)

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['project_id'], project_id=INT('Project id.')),
        description='Get the plan of a project: its tasks and activities with their scheduled dates.',
    )
    def project_plan_get(self, args):
        args = args_of(args)
        project_id = require_id(args, 'project_id', 'project_plan_get')
        data = self._call('GET', f'/projects/{project_id}/plan')
        return {'items': list(data or [])}

    @pipedrive_tool(
        group='projects',
        input_schema=schema(
            required=['project_id', 'activity_id'],
            project_id=INT('Project id.'),
            activity_id=INT('Activity id in the plan.'),
            phase_id=INT('Move the activity to this phase.'),
            group_id=INT('Move the activity to this group.'),
        ),
        description='Move an activity to another phase or group within a project plan.',
    )
    def project_plan_activity_update(self, args):
        args = args_of(args)
        project_id = require_id(args, 'project_id', 'project_plan_activity_update')
        activity_id = require_id(args, 'activity_id', 'project_plan_activity_update')
        return self._write(
            'PUT',
            f'/projects/{project_id}/plan/activities/{activity_id}',
            passthrough,
            body=body_from(args, ('phase_id', 'group_id')),
        )

    @pipedrive_tool(
        group='projects',
        input_schema=schema(
            required=['project_id', 'task_id'],
            project_id=INT('Project id.'),
            task_id=INT('Task id in the plan.'),
            phase_id=INT('Move the task to this phase.'),
            group_id=INT('Move the task to this group.'),
        ),
        description='Move a task to another phase or group within a project plan.',
    )
    def project_plan_task_update(self, args):
        args = args_of(args)
        project_id = require_id(args, 'project_id', 'project_plan_task_update')
        task_id = require_id(args, 'task_id', 'project_plan_task_update')
        return self._write(
            'PUT',
            f'/projects/{project_id}/plan/tasks/{task_id}',
            passthrough,
            body=body_from(args, ('phase_id', 'group_id')),
        )

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['project_id'], project_id=INT('Project id.')),
        description='List the groups of a project.',
    )
    def project_groups_list(self, args):
        args = args_of(args)
        project_id = require_id(args, 'project_id', 'project_groups_list')
        data = self._call('GET', f'/projects/{project_id}/groups')
        return {'items': list(data or [])}

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['project_id'], project_id=INT('Project id.')),
        description='List the activities of a project.',
    )
    def project_activities_list(self, args):
        args = args_of(args)
        project_id = require_id(args, 'project_id', 'project_activities_list')
        data = self._call('GET', f'/projects/{project_id}/activities')
        return {'items': [clean_activity(a) for a in (data or [])]}

    # -- tasks ------------------------------------------------------------

    @pipedrive_tool(
        group='projects',
        input_schema=schema(**PAGING_V2(), project_id=INT('Only tasks of this project.')),
        description='List project tasks.',
    )
    def project_task_list(self, args):
        args = args_of(args)
        return self._cursor_list('/tasks', args, clean_task, extra=params_from(args, ('project_id',)))

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['task_id'], task_id=INT('Task id.')),
        description='Get a single project task.',
    )
    def project_task_get(self, args):
        args = args_of(args)
        return self._get(f'/tasks/{require_id(args, "task_id", "project_task_get")}', clean_task)

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['title', 'project_id'], **_TASK_WRITE_PROPS),
        description='Create a project task.',
    )
    def project_task_create(self, args):
        args = args_of(args)
        require_text(args, 'title', 'project_task_create')
        require_id(args, 'project_id', 'project_task_create')
        return self._write('POST', '/tasks', clean_task, body=body_from(args, _TASK_WRITE_KEYS))

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['task_id'], task_id=INT('Task id to update.'), **_TASK_WRITE_PROPS),
        description='Update a project task. Pass done=1 to complete it.',
    )
    def project_task_update(self, args):
        args = args_of(args)
        task_id = require_id(args, 'task_id', 'project_task_update')
        return self._write('PUT', f'/tasks/{task_id}', clean_task, body=body_from(args, _TASK_WRITE_KEYS))

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['task_id'], task_id=INT('Task id to delete.')),
        description='Delete a project task.',
    )
    def project_task_delete(self, args):
        args = args_of(args)
        return self._delete(f'/tasks/{require_id(args, "task_id", "project_task_delete")}')

    # -- boards, phases and templates -------------------------------------

    @pipedrive_tool(
        group='projects',
        input_schema=schema(),
        description='List project boards. Board ids are needed to create a project.',
    )
    def project_board_list(self, args):
        args_of(args)
        data = self._call('GET', '/projects/boards')
        return {'items': list(data or [])}

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['board_id'], board_id=INT('Board id.')),
        description='Get a single project board.',
    )
    def project_board_get(self, args):
        args = args_of(args)
        board_id = require_id(args, 'board_id', 'project_board_get')
        return self._call('GET', f'/projects/boards/{board_id}')

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['board_id'], board_id=INT('Board id whose phases to list.')),
        description='List the phases of a project board. Phase ids are needed to create a project.',
    )
    def project_phase_list(self, args):
        args = args_of(args)
        board_id = require_id(args, 'board_id', 'project_phase_list')
        data = self._call('GET', '/projects/phases', params={'board_id': board_id})
        return {'items': list(data or [])}

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['phase_id'], phase_id=INT('Phase id.')),
        description='Get a single project phase.',
    )
    def project_phase_get(self, args):
        args = args_of(args)
        phase_id = require_id(args, 'phase_id', 'project_phase_get')
        return self._call('GET', f'/projects/phases/{phase_id}')

    @pipedrive_tool(
        group='projects',
        input_schema=schema(**PAGING_V2()),
        description='List project templates.',
    )
    def project_template_list(self, args):
        args = args_of(args)
        return self._cursor_list('/projectTemplates', args, passthrough)

    @pipedrive_tool(
        group='projects',
        input_schema=schema(required=['template_id'], template_id=INT('Template id.')),
        description='Get a single project template.',
    )
    def project_template_get(self, args):
        args = args_of(args)
        template_id = require_id(args, 'template_id', 'project_template_get')
        return self._call('GET', f'/projectTemplates/{template_id}')
