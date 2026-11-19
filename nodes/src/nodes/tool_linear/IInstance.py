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
Linear tool node instance.

Exposes Linear issue operations as @tool_function methods over Linear's
GraphQL API using a personal API key. Writes are refused unless ``readOnly``
is turned off; ``teams`` restricts every operation to an allowlist.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input

from . import linear_client as lc
from .IGlobal import IGlobal

_ERROR_SCHEMA = {'error': {'type': 'string'}}
_WRITE_REFUSAL = "tool_linear is read-only; set the node's 'readOnly' config field to false to allow writes"


def _out(properties: Dict[str, Any]) -> Dict[str, Any]:
    return {'type': 'object', 'properties': {'success': {'type': 'boolean'}, **properties, **_ERROR_SCHEMA}}


def _run(op) -> Dict[str, Any]:
    """Adapt a LinearAPIError into the standard {success, error} envelope."""
    try:
        return {'success': True, **op()}
    except lc.LinearAPIError as exc:
        return {'success': False, 'error': str(exc)}


class IInstance(IInstanceBase):
    """Node instance exposing Linear operations as agent tools."""

    IGlobal: IGlobal

    # -- internals ---------------------------------------------------------

    def _post(self, query: str, variables: Optional[Dict[str, Any]] = None, *, write: bool = False):
        return lc.post(query, variables, api_key=self.IGlobal.apikey, retry=not write)

    def _require_write(self) -> None:
        if self.IGlobal.read_only:
            raise lc.LinearAPIError(_WRITE_REFUSAL)

    def _fetch_issue(self, args: Dict[str, Any], comments: int = 0) -> Dict[str, Any]:
        """Fetch an issue by ``identifier`` (ENG-123) or ``id`` and enforce the team allowlist."""
        identifier = (args.get('identifier') or '').strip()
        issue_id = (args.get('id') or '').strip()
        if identifier:
            parsed = lc.parse_identifier(identifier)
            if not parsed:
                raise lc.LinearAPIError(f"'{identifier}' is not an issue identifier like ENG-123")
            key, number = parsed
            if not lc.team_allowed(key, self.IGlobal.teams):
                raise lc.LinearAPIError(f"Team '{key}' is not in the node's teams allowlist")
            data = self._post(
                lc.Q_ISSUE_BY_IDENTIFIER,
                {'filter': {'team': {'key': {'eq': key}}, 'number': {'eq': number}}, 'comments': comments},
            )
            nodes = (data.get('issues') or {}).get('nodes') or []
            issue = nodes[0] if nodes else None
        elif issue_id:
            data = self._post(lc.Q_ISSUE_BY_ID, {'id': issue_id, 'comments': comments})
            issue = data.get('issue')
        else:
            raise lc.LinearAPIError('Provide an issue identifier (e.g. ENG-123) or id')
        if not issue:
            raise lc.LinearAPIError('Issue not found')
        if not lc.team_allowed((issue.get('team') or {}).get('key'), self.IGlobal.teams):
            raise lc.LinearAPIError("Issue belongs to a team outside the node's teams allowlist")
        return issue

    def _team(self, team_key: str) -> Dict[str, Any]:
        key = (team_key or '').strip().upper()
        if not key:
            raise lc.LinearAPIError('team_key is required')
        if not lc.team_allowed(key, self.IGlobal.teams):
            raise lc.LinearAPIError(f"Team '{key}' is not in the node's teams allowlist")
        data = self._post(lc.Q_TEAM_BY_KEY, {'filter': {'key': {'eq': key}}})
        nodes = (data.get('teams') or {}).get('nodes') or []
        if not nodes:
            raise lc.LinearAPIError(f"Team '{key}' not found")
        return nodes[0]

    def _state_id(self, team_id: str, name: str) -> str:
        data = self._post(lc.Q_STATES, {'filter': {'team': {'id': {'eq': team_id}}, 'name': {'eqIgnoreCase': name}}})
        nodes = (data.get('workflowStates') or {}).get('nodes') or []
        if not nodes:
            raise lc.LinearAPIError(f"Workflow state '{name}' not found for this team")
        return nodes[0]['id']

    @staticmethod
    def _priority(value: Any) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value not in lc.PRIORITY_LABELS:
            raise lc.LinearAPIError('priority must be an integer 0-4 (0 none, 1 urgent, 2 high, 3 medium, 4 low)')
        return value

    # -- tools -------------------------------------------------------------

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema=_out({'ok': {'type': 'boolean'}, 'user': {'type': 'object'}}),
        description='Check the Linear API key works and return the authenticated user.',
    )
    def linear_check_connection(self, args):
        """Verify credentials via ``viewer``."""

        def op():
            viewer = self._post(lc.Q_VIEWER).get('viewer') or {}
            return {'ok': True, 'user': {'id': viewer.get('id'), 'name': viewer.get('name')}}

        return _run(op)

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema=_out({'teams': {'type': 'array', 'items': {'type': 'object'}}}),
        description='List Linear teams (id, key, name), limited to the configured team allowlist.',
    )
    def linear_teams_list(self, args):
        """List teams."""

        def op():
            nodes = (self._post(lc.Q_TEAMS).get('teams') or {}).get('nodes') or []
            teams = [
                {'id': t.get('id'), 'key': t.get('key'), 'name': t.get('name')}
                for t in nodes
                if lc.team_allowed(t.get('key'), self.IGlobal.teams)
            ]
            return {'teams': teams}

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'team_key': {'type': 'string', 'description': 'Team key, e.g. ENG.'},
                'state': {'type': 'string', 'description': 'Workflow state name, e.g. "In Progress".'},
                'assignee': {'type': 'string', 'description': 'Assignee name, or "me".'},
                'text': {'type': 'string', 'description': 'Text the issue title contains.'},
                'first': {'type': 'integer', 'description': 'Page size 1-100 (default: node maxResults).'},
                'after': {'type': 'string', 'description': "Cursor from a previous call's end_cursor."},
            },
        },
        output_schema=_out(
            {
                'issues': {'type': 'array', 'items': {'type': 'object'}},
                'end_cursor': {'type': ['string', 'null']},
                'has_next_page': {'type': 'boolean'},
            }
        ),
        description=(
            'Search Linear issues by team, state, assignee and title text, newest-updated first. '
            'Pass end_cursor back as `after` to page.'
        ),
    )
    def linear_issues_search(self, args):
        """Search issues."""
        args = normalize_tool_input(args, tool_name='linear_issues_search')

        def op():
            flt = lc.build_issue_filter(
                allowed_teams=self.IGlobal.teams,
                team_key=args.get('team_key'),
                state=args.get('state'),
                assignee=args.get('assignee'),
                text=args.get('text'),
            )
            variables = {
                'filter': flt,
                'first': lc.clamp_first(args.get('first'), self.IGlobal.max_results),
                'after': args.get('after') or None,
            }
            conn = self._post(lc.Q_ISSUES, variables).get('issues') or {}
            info = conn.get('pageInfo') or {}
            return {
                'issues': [lc.shape_issue(n) for n in conn.get('nodes') or []],
                'end_cursor': info.get('endCursor'),
                'has_next_page': bool(info.get('hasNextPage')),
            }

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'identifier': {'type': 'string', 'description': 'Issue identifier, e.g. ENG-123.'},
                'id': {'type': 'string', 'description': 'Issue UUID (alternative to identifier).'},
                'max_comments': {'type': 'integer', 'description': 'Comments to include, 0-50 (default 10).'},
            },
        },
        output_schema=_out({'issue': {'type': 'object'}}),
        description='Get one Linear issue with its description and recent comments.',
    )
    def linear_issue_get(self, args):
        """Get an issue."""
        args = normalize_tool_input(args, tool_name='linear_issue_get')

        def op():
            mc = args.get('max_comments')
            mc = 10 if isinstance(mc, bool) or not isinstance(mc, int) else max(0, min(50, mc))
            issue = self._fetch_issue(args, comments=mc)
            shaped = lc.shape_issue(issue)
            shaped['description'] = issue.get('description')
            shaped['comments'] = [
                {
                    'id': c.get('id'),
                    'body': c.get('body'),
                    'author': (c.get('user') or {}).get('name'),
                    'created_at': c.get('createdAt'),
                }
                for c in (issue.get('comments') or {}).get('nodes') or []
            ]
            return {'issue': shaped}

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['team_key'],
            'properties': {'team_key': {'type': 'string', 'description': 'Team key, e.g. ENG.'}},
        },
        output_schema=_out({'states': {'type': 'array', 'items': {'type': 'object'}}}),
        description="List a team's workflow states (id, name, type).",
    )
    def linear_states_list(self, args):
        """List workflow states for a team."""
        args = normalize_tool_input(args, tool_name='linear_states_list')

        def op():
            team = self._team(args.get('team_key'))
            data = self._post(lc.Q_STATES, {'filter': {'team': {'id': {'eq': team['id']}}}})
            nodes = (data.get('workflowStates') or {}).get('nodes') or []
            return {'states': [{'id': s.get('id'), 'name': s.get('name'), 'type': s.get('type')} for s in nodes]}

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['team_key', 'title'],
            'properties': {
                'team_key': {'type': 'string'},
                'title': {'type': 'string'},
                'description': {'type': 'string', 'description': 'Markdown body (max 32 KB).'},
                'priority': {'type': 'integer', 'description': '0 none, 1 urgent, 2 high, 3 medium, 4 low.'},
                'state': {'type': 'string', 'description': 'Workflow state name.'},
                'assignee_id': {'type': 'string'},
                'label_ids': {'type': 'array', 'items': {'type': 'string'}},
            },
        },
        output_schema=_out({'identifier': {'type': 'string'}, 'url': {'type': 'string'}}),
        description='Create a Linear issue (write; refused while the node is read-only).',
    )
    def linear_issue_create(self, args):
        """Create an issue."""
        args = normalize_tool_input(args, tool_name='linear_issue_create')

        def op():
            self._require_write()
            title = (args.get('title') or '').strip()
            if not title:
                raise lc.LinearAPIError('title is required')
            team = self._team(args.get('team_key'))
            inp: Dict[str, Any] = {'teamId': team['id'], 'title': lc.check_text('title', title)}
            if args.get('description'):
                inp['description'] = lc.check_text('description', args['description'])
            if args.get('priority') is not None:
                inp['priority'] = self._priority(args['priority'])
            if args.get('state'):
                inp['stateId'] = self._state_id(team['id'], args['state'])
            if args.get('assignee_id'):
                inp['assigneeId'] = args['assignee_id']
            if args.get('label_ids'):
                inp['labelIds'] = list(args['label_ids'])
            payload = lc.ensure_success(
                self._post(lc.M_ISSUE_CREATE, {'input': inp}, write=True).get('issueCreate'), 'issue creation'
            )
            issue = payload.get('issue') or {}
            return {'identifier': issue.get('identifier'), 'url': issue.get('url')}

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['identifier', 'body'],
            'properties': {
                'identifier': {'type': 'string', 'description': 'Issue identifier, e.g. ENG-123.'},
                'body': {'type': 'string', 'description': 'Markdown comment (max 32 KB).'},
            },
        },
        output_schema=_out({'comment_id': {'type': 'string'}, 'url': {'type': 'string'}}),
        description='Add a comment to a Linear issue (write; refused while the node is read-only).',
    )
    def linear_comment_add(self, args):
        """Comment on an issue."""
        args = normalize_tool_input(args, tool_name='linear_comment_add')

        def op():
            self._require_write()
            body = (args.get('body') or '').strip()
            if not body:
                raise lc.LinearAPIError('body is required')
            issue = self._fetch_issue({'identifier': args.get('identifier')})
            inp = {'issueId': issue['id'], 'body': lc.check_text('body', body)}
            payload = lc.ensure_success(
                self._post(lc.M_COMMENT_CREATE, {'input': inp}, write=True).get('commentCreate'), 'comment'
            )
            comment = payload.get('comment') or {}
            return {'comment_id': comment.get('id'), 'url': comment.get('url')}

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['identifier'],
            'properties': {
                'identifier': {'type': 'string'},
                'title': {'type': 'string'},
                'description': {'type': 'string'},
                'priority': {'type': 'integer'},
                'state': {'type': 'string', 'description': 'Workflow state name.'},
                'assignee_id': {'type': 'string'},
            },
        },
        output_schema=_out({'identifier': {'type': 'string'}, 'updated_fields': {'type': 'array'}}),
        description='Update a Linear issue (write; refused while the node is read-only).',
    )
    def linear_issue_update(self, args):
        """Update an issue."""
        args = normalize_tool_input(args, tool_name='linear_issue_update')

        def op():
            self._require_write()
            issue = self._fetch_issue({'identifier': args.get('identifier')})
            inp: Dict[str, Any] = {}
            if args.get('title'):
                inp['title'] = lc.check_text('title', args['title'])
            if args.get('description') is not None and 'description' in args:
                inp['description'] = lc.check_text('description', args['description'])
            if args.get('priority') is not None:
                inp['priority'] = self._priority(args['priority'])
            if args.get('assignee_id'):
                inp['assigneeId'] = args['assignee_id']
            if args.get('state'):
                team = self._team((issue.get('team') or {}).get('key'))
                inp['stateId'] = self._state_id(team['id'], args['state'])
            if not inp:
                raise lc.LinearAPIError('Provide at least one field to update')
            payload = lc.ensure_success(
                self._post(lc.M_ISSUE_UPDATE, {'id': issue['id'], 'input': inp}, write=True).get('issueUpdate'),
                'issue update',
            )
            updated = payload.get('issue') or {}
            fields: List[str] = sorted(k.replace('Id', '') if k.endswith('Id') else k for k in inp)
            return {'identifier': updated.get('identifier') or issue.get('identifier'), 'updated_fields': fields}

        return _run(op)
