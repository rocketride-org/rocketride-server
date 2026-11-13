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
Jira tool node instance.

Exposes Jira Cloud reads (connection check, JQL search, issue read, project
list) and writes (create an issue, add a comment) as @tool_function methods.
Writes are refused in read-only mode (the default), and every call stays inside
the node's project allowlist: searches are wrapped in it, and key-based calls
check the issue's own project, since an issue moved between projects still
resolves under its old key. See jira_client.py for the verified API surface.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input

from . import jira_client
from .IGlobal import IGlobal

_ERROR_SCHEMA = {'error': {'type': 'string'}}
_ISSUE_KEY = re.compile(r'^[A-Z][A-Z0-9_]+-[1-9][0-9]*$')
SEARCH_FIELDS = ['summary', 'status', 'issuetype', 'assignee', 'priority', 'updated']
ISSUE_FIELDS = [
    'summary',
    'status',
    'issuetype',
    'assignee',
    'reporter',
    'priority',
    'labels',
    'fixVersions',
    'created',
    'updated',
    'description',
    'project',
]
DEFAULT_MAX_COMMENTS = 20


def _run(op: Callable[[], Dict[str, Any]]) -> Dict[str, Any]:
    """Adapt a JiraAPIError into the standard {success, error} envelope."""
    try:
        return {'success': True, **op()}
    except jira_client.JiraAPIError as exc:
        return {'success': False, 'error': str(exc)}


def _name(value: Any, key: str = 'name') -> Optional[str]:
    return value.get(key) if isinstance(value, dict) else None


def _int_arg(value: Any, default: int, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    return max(low, min(high, value))


def _issue_key(value: Any) -> str:
    key = str(value or '').strip().upper()
    if not _ISSUE_KEY.match(key):
        raise jira_client.JiraAPIError(0, [f'not an issue key: {str(value)!r} (expected e.g. PROJ-123)'])
    return key


def _string_list(value: Any) -> List[str]:
    if isinstance(value, str):
        value = value.split(',')
    return [str(v).strip() for v in value or [] if str(v).strip()]


class IInstance(IInstanceBase):
    """Node instance exposing Jira Cloud operations as agent tools."""

    IGlobal: IGlobal

    # -------------------------------------------------------------------
    # helpers
    # -------------------------------------------------------------------

    def _request(self, method: str, path: str, **kwargs: Any) -> Dict[str, Any]:
        return jira_client.request(method, path, auth=self.IGlobal.auth, **kwargs)

    def _url(self, key: str) -> str:
        return f'{self.IGlobal.auth.site_url}/browse/{key}'

    def _require_write(self, tool: str) -> None:
        if self.IGlobal.read_only:
            raise jira_client.JiraAPIError(
                0,
                [
                    f'{tool} is blocked: the node is read-only. Turn off tool_jira.readOnly in the node config to allow writes.'
                ],
            )

    def _require_project(self, project_key: Optional[str]) -> None:
        allowed = self.IGlobal.projects
        if allowed and (project_key or '').upper() not in allowed:
            raise jira_client.JiraAPIError(
                0, [f"project {project_key!r} is outside this node's allowlist ({', '.join(allowed)})"]
            )

    def _issue(self, key: str, fields: List[str]) -> Dict[str, Any]:
        """GET an issue and refuse it when its current project is outside the allowlist."""
        issue = self._request('GET', f'/issue/{key}', params={'fields': ','.join(fields)})
        self._require_project(_name((issue.get('fields') or {}).get('project'), 'key'))
        return issue

    # -------------------------------------------------------------------
    # reads
    # -------------------------------------------------------------------

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'ok': {'type': 'boolean'},
                'account_id': {'type': 'string'},
                'display_name': {'type': 'string'},
                'site': {'type': 'string'},
                **_ERROR_SCHEMA,
            },
        },
        description='Check that the configured Jira site, email and API token work, and show which account the node acts as.',
    )
    def jira_check_connection(self, args):
        """GET /myself."""

        def op():
            me = self._request('GET', '/myself')
            return {
                'ok': True,
                'account_id': me.get('accountId'),
                'display_name': me.get('displayName'),
                'site': self.IGlobal.auth.site_url,
            }

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['jql'],
            'properties': {
                'jql': {
                    'type': 'string',
                    'description': 'A JQL query, e.g. "status = \\"In Progress\\" ORDER BY updated DESC".',
                },
                'max_results': {
                    'type': 'integer',
                    'description': 'Issues per page (1-100; default from the node config).',
                },
                'next_page_token': {
                    'type': 'string',
                    'description': 'The next_page_token of a previous call, for the next page.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'issues': {'type': 'array', 'items': {'type': 'object'}},
                'next_page_token': {'type': ['string', 'null']},
                **_ERROR_SCHEMA,
            },
        },
        description=(
            'Search Jira issues with JQL. Returns key, summary, status, type, assignee, priority, updated and url per '
            "issue, and next_page_token while more pages remain. Searches stay inside the node's project allowlist."
        ),
    )
    def jira_search(self, args):
        """POST /search/jql, always asking for the fields of the result shape (the endpoint returns ids only otherwise)."""
        args = normalize_tool_input(args, tool_name='jira_search')

        def op():
            jql = str(args.get('jql') or '').strip()
            if not jql:
                raise jira_client.JiraAPIError(0, ['jql is required'])
            body: Dict[str, Any] = {
                'jql': jira_client.wrap_jql(jql, self.IGlobal.projects),
                'fields': SEARCH_FIELDS,
                'maxResults': _int_arg(
                    args.get('max_results'), self.IGlobal.max_results, 1, jira_client.MAX_RESULTS_CAP
                ),
            }
            if args.get('next_page_token'):
                body['nextPageToken'] = str(args['next_page_token'])
            resp = self._request('POST', '/search/jql', json_body=body, read=True)
            issues = []
            for issue in resp.get('issues') or []:
                f = issue.get('fields') or {}
                issues.append(
                    {
                        'key': issue.get('key'),
                        'summary': f.get('summary'),
                        'status': _name(f.get('status')),
                        'type': _name(f.get('issuetype')),
                        'assignee': _name(f.get('assignee'), 'displayName'),
                        'priority': _name(f.get('priority')),
                        'updated': f.get('updated'),
                        'url': self._url(issue.get('key')),
                    }
                )
            return {
                'issues': issues,
                'next_page_token': None if resp.get('isLast', True) else resp.get('nextPageToken'),
            }

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['key'],
            'properties': {
                'key': {'type': 'string', 'description': 'Issue key, e.g. PROJ-123.'},
                'include_comments': {
                    'type': 'boolean',
                    'description': 'Also return the latest comments (default false).',
                },
                'max_comments': {
                    'type': 'integer',
                    'description': 'How many comments, newest first (1-100, default 20).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'key': {'type': 'string'},
                'summary': {'type': 'string'},
                'description_text': {'type': 'string'},
                'comments': {'type': 'array', 'items': {'type': 'object'}},
                'url': {'type': 'string'},
                **_ERROR_SCHEMA,
            },
        },
        description=(
            'Read one Jira issue: summary, status, type, assignee, reporter, priority, labels, fix versions, dates, '
            'the description as plain text and, optionally, its latest comments as plain text.'
        ),
    )
    def jira_issue_get(self, args):
        """GET /issue/{key}, plus GET /issue/{key}/comment when asked."""
        args = normalize_tool_input(args, tool_name='jira_issue_get')

        def op():
            key = _issue_key(args.get('key'))
            issue = self._issue(key, ISSUE_FIELDS)
            f = issue.get('fields') or {}
            out: Dict[str, Any] = {
                'key': issue.get('key', key),
                'summary': f.get('summary'),
                'status': _name(f.get('status')),
                'type': _name(f.get('issuetype')),
                'assignee': _name(f.get('assignee'), 'displayName'),
                'reporter': _name(f.get('reporter'), 'displayName'),
                'priority': _name(f.get('priority')),
                'labels': f.get('labels') or [],
                'fix_versions': [v.get('name') for v in f.get('fixVersions') or [] if isinstance(v, dict)],
                'created': f.get('created'),
                'updated': f.get('updated'),
                'description_text': jira_client.adf_to_text(f.get('description')),
                'comments': [],
                'url': self._url(issue.get('key', key)),
            }
            if args.get('include_comments') is True:
                count = _int_arg(args.get('max_comments'), DEFAULT_MAX_COMMENTS, 1, jira_client.MAX_RESULTS_CAP)
                page = self._request(
                    'GET', f'/issue/{key}/comment', params={'maxResults': count, 'orderBy': '-created'}
                )
                out['comments'] = [
                    {
                        'author': _name(c.get('author'), 'displayName'),
                        'created': c.get('created'),
                        'body_text': jira_client.adf_to_text(c.get('body')),
                    }
                    for c in page.get('comments') or []
                ]
            return out

        return _run(op)

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'projects': {'type': 'array', 'items': {'type': 'object'}},
                **_ERROR_SCHEMA,
            },
        },
        description='List the Jira projects this node can use (key, name, type), limited to its project allowlist.',
    )
    def jira_projects_list(self, args):
        """GET /project/search, every page."""

        def op():
            projects, start = [], 0
            while True:
                page = self._request('GET', '/project/search', params={'startAt': start, 'maxResults': 50})
                values = page.get('values') or []
                for p in values:
                    if not self.IGlobal.projects or p.get('key') in self.IGlobal.projects:
                        projects.append({'key': p.get('key'), 'name': p.get('name'), 'type': p.get('projectTypeKey')})
                start += len(values)
                if page.get('isLast', True) or not values:
                    return {'projects': projects}

        return _run(op)

    # -------------------------------------------------------------------
    # writes
    # -------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['project', 'issue_type', 'summary'],
            'properties': {
                'project': {'type': 'string', 'description': 'Project key, e.g. PROJ.'},
                'issue_type': {'type': 'string', 'description': 'Issue type name, e.g. Task or Bug.'},
                'summary': {'type': 'string', 'description': 'One-line title.'},
                'description': {
                    'type': 'string',
                    'description': 'Plain text; "- " lines become bullets and ``` fences code blocks.',
                },
                'labels': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Labels (no spaces).'},
                'priority': {'type': 'string', 'description': 'Priority name, e.g. High.'},
                'assignee_account_id': {'type': 'string', 'description': 'Atlassian account id of the assignee.'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'key': {'type': 'string'},
                'url': {'type': 'string'},
                **_ERROR_SCHEMA,
            },
        },
        description='Create a Jira issue. Blocked in read-only mode (the default) and outside the project allowlist.',
    )
    def jira_issue_create(self, args):
        """POST /issue."""
        args = normalize_tool_input(args, tool_name='jira_issue_create')

        def op():
            self._require_write('jira_issue_create')
            project = str(args.get('project') or '').strip().upper()
            issue_type = str(args.get('issue_type') or '').strip()
            summary = str(args.get('summary') or '').strip()
            if not (project and issue_type and summary):
                raise jira_client.JiraAPIError(0, ['project, issue_type and summary are required'])
            self._require_project(project)
            fields: Dict[str, Any] = {
                'project': {'key': project},
                'issuetype': {'name': issue_type},
                'summary': summary,
            }
            if args.get('description'):
                fields['description'] = jira_client.text_to_adf(
                    jira_client.check_body_size(str(args['description']), 'description')
                )
            labels = _string_list(args.get('labels'))
            if self.IGlobal.created_label and self.IGlobal.created_label not in labels:
                labels.append(self.IGlobal.created_label)
            if labels:
                fields['labels'] = labels
            if args.get('priority'):
                fields['priority'] = {'name': str(args['priority']).strip()}
            if args.get('assignee_account_id'):
                fields['assignee'] = {'accountId': str(args['assignee_account_id']).strip()}
            created = self._request('POST', '/issue', json_body={'fields': fields})
            return {'key': created.get('key'), 'url': self._url(created.get('key'))}

        return _run(op)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['key', 'body'],
            'properties': {
                'key': {'type': 'string', 'description': 'Issue key, e.g. PROJ-123.'},
                'body': {
                    'type': 'string',
                    'description': 'Comment text; "- " lines become bullets and ``` fences code blocks.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'comment_id': {'type': 'string'},
                'url': {'type': 'string'},
                **_ERROR_SCHEMA,
            },
        },
        description='Add a comment to a Jira issue. Blocked in read-only mode (the default) and outside the project allowlist.',
    )
    def jira_comment_add(self, args):
        """POST /issue/{key}/comment, after checking the issue's project."""
        args = normalize_tool_input(args, tool_name='jira_comment_add')

        def op():
            self._require_write('jira_comment_add')
            key = _issue_key(args.get('key'))
            body = str(args.get('body') or '')
            if not body.strip():
                raise jira_client.JiraAPIError(0, ['body is required'])
            self._issue(key, ['project'])
            comment = self._request(
                'POST',
                f'/issue/{key}/comment',
                json_body={'body': jira_client.text_to_adf(jira_client.check_body_size(body, 'comment'))},
            )
            cid = str(comment.get('id') or '')
            return {'comment_id': cid, 'url': f'{self._url(key)}?focusedCommentId={cid}'}

        return _run(op)
