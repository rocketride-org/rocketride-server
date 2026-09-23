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

"""Goal tools: sales targets and their progress."""

from __future__ import annotations

from ..pipedrive_client import clean_goal
from ..tool_groups import pipedrive_tool
from ._base import (
    BOOL,
    ENUM,
    INT,
    OBJ,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    params_from,
    path_segment,
    require_text,
    schema,
)

_GOAL_WRITE_KEYS = ('title', 'assignee', 'type', 'expected_outcome', 'duration', 'interval')

_GOAL_WRITE_PROPS = {
    'title': STR('Goal title.'),
    'assignee': OBJ('Who the goal is for, e.g. {"id": 1, "type": "person"}. Type is person, company or team.'),
    'type': OBJ(
        'Goal type, e.g. {"name": "deals_won", "params": {"pipeline_id": [1]}}. Names: deals_won, deals_progressed, '
        'activities_completed, activities_added, deals_started.'
    ),
    'expected_outcome': OBJ(
        'Target, e.g. {"target": 50, "tracking_metric": "quantity"} or {"target": 100000, "tracking_metric": "sum", "currency_id": 1}.'
    ),
    'duration': OBJ('Goal period, e.g. {"start": "2026-01-01", "end": "2026-03-31"}.'),
    'interval': ENUM('How often the goal repeats.', ['weekly', 'monthly', 'quarterly', 'yearly']),
}


class GoalsMixin(PipedriveToolsBase):
    """Tools for the ``goals`` group."""

    @pipedrive_tool(
        group='goals',
        input_schema=schema(
            title=STR('Only goals whose title contains this text.'),
            is_active=BOOL('Only active (true) or only finished (false) goals. Defaults to active.'),
            assignee_id=INT('Only goals assigned to this id (paired with assignee_type).'),
            assignee_type=ENUM('What assignee_id refers to.', ['person', 'company', 'team']),
            type_name=ENUM(
                'Only goals of this type.',
                ['deals_won', 'deals_progressed', 'activities_completed', 'activities_added', 'deals_started'],
            ),
            expected_outcome_target=INT('Only goals with this target value.'),
            expected_outcome_tracking_metric=ENUM('Only goals tracked this way.', ['quantity', 'sum']),
            period_start=STR('Only goals whose period starts on or after this date, YYYY-MM-DD.'),
            period_end=STR('Only goals whose period ends on or before this date, YYYY-MM-DD.'),
        ),
        description='Find goals by title, assignee, type or period.',
    )
    def goal_find(self, args):
        args = args_of(args)
        params = params_from(args, ('title', 'is_active', 'assignee_id'))
        # Pipedrive expects these as dotted query keys.
        dotted = {
            'assignee.id': args.get('assignee_id'),
            'assignee.type': args.get('assignee_type'),
            'type.name': args.get('type_name'),
            'expected_outcome.target': args.get('expected_outcome_target'),
            'expected_outcome.tracking_metric': args.get('expected_outcome_tracking_metric'),
            'period.start': args.get('period_start'),
            'period.end': args.get('period_end'),
        }
        params.pop('assignee_id', None)
        params.update({k: v for k, v in dotted.items() if v is not None})
        data = self._call('GET', '/goals/find', params=params)
        goals = (data or {}).get('goals') if isinstance(data, dict) else data
        return {'items': [clean_goal(g) for g in (goals or [])]}

    @pipedrive_tool(
        group='goals',
        input_schema=schema(required=['assignee', 'type', 'expected_outcome', 'duration'], **_GOAL_WRITE_PROPS),
        description='Create a goal.',
    )
    def goal_create(self, args):
        args = args_of(args)
        for key in ('assignee', 'type', 'expected_outcome', 'duration'):
            if not isinstance(args.get(key), dict):
                raise ValueError(f'goal_create: "{key}" is required and must be an object')
        return self._write('POST', '/goals', clean_goal, body=body_from(args, _GOAL_WRITE_KEYS))

    @pipedrive_tool(
        group='goals',
        input_schema=schema(required=['goal_id'], goal_id=STR('Goal id.'), **_GOAL_WRITE_PROPS),
        description='Update a goal.',
    )
    def goal_update(self, args):
        args = args_of(args)
        goal_id = require_text(args, 'goal_id', 'goal_update')
        return self._write('PUT', f'/goals/{path_segment(goal_id)}', clean_goal, body=body_from(args, _GOAL_WRITE_KEYS))

    @pipedrive_tool(
        group='goals',
        input_schema=schema(required=['goal_id'], goal_id=STR('Goal id to delete.')),
        description='Delete a goal.',
    )
    def goal_delete(self, args):
        args = args_of(args)
        return self._delete(f'/goals/{path_segment(require_text(args, "goal_id", "goal_delete"))}')

    @pipedrive_tool(
        group='goals',
        input_schema=schema(
            required=['goal_id', 'period_start', 'period_end'],
            goal_id=STR('Goal id.'),
            period_start=STR('Period start, YYYY-MM-DD. Must match the goal duration interval.'),
            period_end=STR('Period end, YYYY-MM-DD.'),
        ),
        description='Get the progress of a goal over a period: how much of the target has been reached.',
    )
    def goal_results_get(self, args):
        args = args_of(args)
        goal_id = require_text(args, 'goal_id', 'goal_results_get')
        params = {
            'period.start': require_text(args, 'period_start', 'goal_results_get'),
            'period.end': require_text(args, 'period_end', 'goal_results_get'),
        }
        return self._call('GET', f'/goals/{path_segment(goal_id)}/results', params=params)
