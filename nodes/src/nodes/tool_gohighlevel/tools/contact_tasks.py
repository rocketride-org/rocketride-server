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

"""Contact task tools: the to-dos attached to one contact."""

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

#: Fields kept from a task record, across both routes that return one.
#:
#: ``GET /contacts/{contactId}/tasks`` returns the seven fields the vendor schema declares.
#: ``POST /locations/{locationId}/tasks/search`` returns the same entities with a dozen more,
#: live-confirmed: locationId, businessId, deleted, status, statusGroup, the two timestamps and
#: two embedded detail objects. Both are listed here so the projection serves either route.
#:
#: ``createdAt`` and ``updatedAt`` are deliberately absent. The search route sends them
#: alongside ``dateAdded`` and ``dateUpdated`` carrying byte-identical values, so keeping both
#: pairs would double the timestamps in every record for nothing. ``searchAfter`` is absent for
#: the same reason it is on contacts: it is a pagination cursor riding on the record, and it
#: belongs to the envelope this node builds rather than to the task.
_TASK_READ_KEYS = (
    'id',
    'contactId',
    'locationId',
    'businessId',
    'title',
    'body',
    'dueDate',
    'completed',
    'status',
    'statusGroup',
    'assignedTo',
    'assignedToUserDetails',
    'contactDetails',
    'deleted',
    'dateAdded',
    'dateUpdated',
)

#: Body fields accepted by contact_tasks_create and contact_tasks_update.
#:
#: CreateTaskParams and UpdateTaskBody declare the same five properties, so one tuple serves
#: both. They differ only in what they require: create requires title, dueDate and completed,
#: update requires nothing.
_TASK_WRITE_KEYS = ('title', 'body', 'dueDate', 'completed', 'assignedTo')

#: How this node describes the due date, stated once because three tools mention it.
_DUE_DATE_DESC = (
    'When the task is due, as an ISO 8601 UTC timestamp, for example "2026-08-01T15:00:00Z". Reads return it '
    'with milliseconds ("2026-08-01T15:00:00.000Z"); either form is accepted on a write.'
)

_TASK_WRITE_PROPS = {
    'title': STR('Short title of the task. This is what shows in the GoHighLevel task list.'),
    'body': STR('Longer description of what the task involves.'),
    'dueDate': STR(_DUE_DATE_DESC),
    'completed': BOOL('Whether the task is already done.'),
    'assignedTo': STR(
        'Id of the GoHighLevel user the task is for. Get user ids from user_list_by_location. An unassigned '
        'task is still created, but nobody is notified about it.'
    ),
}

#: What a task read returns for its id, stated once because four tools return a task.
_TASK_ID_NOTE = (
    'id is normalised by this node: the contact-scoped routes return it as id and the location-wide task search '
    'returns the same task as _id, and both arrive here as id.'
)

_TASK_RECORD_OUTPUT = RECORD_OUTPUT(f'The task, trimmed to the fields this node returns. {_TASK_ID_NOTE}')


def _clean_task(task: Any) -> dict:
    """Trim a task record and give it one id field whichever route it came from.

    GoHighLevel returns the same task keyed ``id`` from ``GET /contacts/{contactId}/tasks``
    and keyed ``_id`` from ``POST /locations/{locationId}/tasks/search``, live-confirmed on
    both. An agent that read a task from one route and passed its id to a tool on the other
    would otherwise be handing over a record with no id in it at all, so the underscore form
    is folded into ``id`` here rather than surfaced as a second field to reason about.
    """
    if not isinstance(task, dict):
        return {}
    out = {key: task[key] for key in _TASK_READ_KEYS if key in task}
    if out.get('id') is None:
        underscored = task.get('_id')
        if underscored is not None:
            out['id'] = underscored
    return out


class ContactTasksMixin(GoHighLevelToolsBase):
    """Tools for the ``contact_tasks`` group."""

    @gohighlevel_tool(
        group='contact_tasks',
        input_schema=schema(required=['contactId'], contactId=STR('Id of the contact.')),
        description=(
            'List the tasks on a contact, open and completed alike. There is no filter and no cursor: this '
            'endpoint returns every task on the contact in one response, so read completed on each record to '
            'tell the outstanding ones apart. Returns tasks under items. Two fields the location-wide task '
            'search reports, status and statusGroup, are absent here, so completed is the only progress signal '
            'this route gives.'
        ),
        output_schema=LIST_OUTPUT(
            'Always null: this endpoint returns every task in one response, so there is no next page.',
            items=f'The tasks on the contact, each trimmed to the fields this node returns. {_TASK_ID_NOTE}',
        ),
    )
    def contact_tasks_list(self, args):
        args = self._args(args, 'contact_tasks_list')
        contact_id = require_id(args, 'contactId', 'contact_tasks_list')
        return self._list(f'/contacts/{contact_id}/tasks', key='tasks', cleaner=_clean_task)

    @gohighlevel_tool(
        group='contact_tasks',
        input_schema=schema(
            required=['contactId', 'taskId'],
            contactId=STR('Id of the contact the task belongs to.'),
            taskId=STR('Id of the task. Get task ids from contact_tasks_list.'),
        ),
        description=(
            'Get one task by id. Both ids are needed: a task is addressed through its contact, so a task id on '
            'its own does not identify anything. Use contact_tasks_list when you have the contact but not the '
            'task id.'
        ),
        output_schema=_TASK_RECORD_OUTPUT,
    )
    def contact_tasks_get(self, args):
        args = self._args(args, 'contact_tasks_get')
        contact_id = require_id(args, 'contactId', 'contact_tasks_get')
        task_id = require_id(args, 'taskId', 'contact_tasks_get')
        return self._get(f'/contacts/{contact_id}/tasks/{task_id}', _clean_task, key='task')

    @gohighlevel_tool(
        group='contact_tasks',
        writes=True,
        input_schema=schema(
            required=['contactId', 'title', 'dueDate'],
            contactId=STR('Id of the contact to attach the task to.'),
            **_TASK_WRITE_PROPS,
        ),
        description=(
            'Create a task on a contact: a follow-up call, a document to send, anything a person has to do '
            'next. title and dueDate are both required by GoHighLevel, so there is no way to file an undated '
            'reminder here. completed is required by the API as well and is sent as false when you omit it, '
            'which is what a new task almost always means; pass it as true only to log something already done. '
            'Set assignedTo to make the task somebody in particular.'
        ),
        output_schema=_TASK_RECORD_OUTPUT,
    )
    def contact_tasks_create(self, args):
        args = self._args(args, 'contact_tasks_create')
        contact_id = require_id(args, 'contactId', 'contact_tasks_create')
        require_text(args, 'title', 'contact_tasks_create')
        require_text(args, 'dueDate', 'contact_tasks_create')
        body = body_from(args, _TASK_WRITE_KEYS)
        # CreateTaskParams requires completed, so something has to be sent. False is the only
        # defensible default for a task being created, and defaulting it locally is better than
        # forwarding a vendor 422 that reads as though the whole request was malformed.
        body.setdefault('completed', False)
        return self._write('POST', f'/contacts/{contact_id}/tasks', _clean_task, key='task', body=body)

    @gohighlevel_tool(
        group='contact_tasks',
        writes=True,
        input_schema=schema(
            required=['contactId', 'taskId'],
            contactId=STR('Id of the contact the task belongs to.'),
            taskId=STR('Id of the task to update. Get task ids from contact_tasks_list.'),
            **_TASK_WRITE_PROPS,
        ),
        description=(
            'Update a task. Only the fields you pass are changed, so this is how to reschedule a due date, '
            'reword a title or hand the task to a different user. Every field is optional here, including the '
            'three contact_tasks_create insists on. To do nothing but tick a task off, use '
            'contact_tasks_set_completed, which needs no other field.'
        ),
        output_schema=_TASK_RECORD_OUTPUT,
    )
    def contact_tasks_update(self, args):
        args = self._args(args, 'contact_tasks_update')
        contact_id = require_id(args, 'contactId', 'contact_tasks_update')
        task_id = require_id(args, 'taskId', 'contact_tasks_update')
        body = body_from(args, _TASK_WRITE_KEYS)
        return self._write('PUT', f'/contacts/{contact_id}/tasks/{task_id}', _clean_task, key='task', body=body)

    @gohighlevel_tool(
        group='contact_tasks',
        writes=True,
        input_schema=schema(
            required=['contactId', 'taskId', 'completed'],
            contactId=STR('Id of the contact the task belongs to.'),
            taskId=STR('Id of the task. Get task ids from contact_tasks_list.'),
            completed=BOOL('True to mark the task done, false to reopen it.'),
        ),
        description=(
            'Mark a task done, or reopen one, without touching its title, due date or assignee. This is the '
            'tool for closing out a follow-up: contact_tasks_update can set the same field but takes the whole '
            'task body with it. Returns the task as it now stands.'
        ),
        output_schema=_TASK_RECORD_OUTPUT,
    )
    def contact_tasks_set_completed(self, args):
        args = self._args(args, 'contact_tasks_set_completed')
        contact_id = require_id(args, 'contactId', 'contact_tasks_set_completed')
        task_id = require_id(args, 'taskId', 'contact_tasks_set_completed')
        completed = args.get('completed')
        # The whole point of this tool is the flag, so an absent or string-typed one is caught
        # here. UpdateTaskStatusParams declares it required and typed boolean, and "false" as a
        # string is the shape an agent most often reaches for.
        if not isinstance(completed, bool):
            raise ValueError('contact_tasks_set_completed: "completed" is required and must be true or false.')
        body = {'completed': completed}
        path = f'/contacts/{contact_id}/tasks/{task_id}/completed'
        return self._write('PUT', path, _clean_task, key='task', body=body)

    @gohighlevel_tool(
        group='contact_tasks',
        writes=True,
        input_schema=schema(
            required=['contactId', 'taskId'],
            contactId=STR('Id of the contact the task belongs to.'),
            taskId=STR('Id of the task to delete. Get task ids from contact_tasks_list.'),
        ),
        description=(
            'Delete a task. There is no undo. Prefer contact_tasks_set_completed for work that is finished: '
            'a completed task stays on the contact as a record that it happened, a deleted one does not.'
        ),
        output_schema=RECORD_OUTPUT(
            'Whether the delete succeeded, under deleted, with the raw GoHighLevel response under data.'
        ),
    )
    def contact_tasks_delete(self, args):
        args = self._args(args, 'contact_tasks_delete')
        contact_id = require_id(args, 'contactId', 'contact_tasks_delete')
        task_id = require_id(args, 'taskId', 'contact_tasks_delete')
        return self._delete(f'/contacts/{contact_id}/tasks/{task_id}')
