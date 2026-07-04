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
GitHub tool node instance.

Exposes GitHub repository operations as agent tools: files, issues, pull
requests, reviews, releases, workflows, orgs, users, and code search.
"""

from __future__ import annotations

import base64
import re

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input, require_int, require_str

from .github_client import (
    call,
    clean_commit,
    clean_file_entry,
    clean_issue,
    clean_pr,
    clean_release,
    clean_repo,
    clean_user,
    clean_workflow,
)
from .IGlobal import IGlobal

# ---------------------------------------------------------------------------
# Shared parameter descriptions
# ---------------------------------------------------------------------------
_REPO_DESC = 'Repository in "owner/repo" format (e.g. "acme/myapp"). Omit to use the configured default.'
_PER_PAGE_DESC = 'Results per page (1–100, default 30).'
_PAGE_DESC = 'Page number for pagination (default 1).'
# Code search and issue search use DIFFERENT GitHub query syntaxes: issue-only qualifiers
# (is:issue, label:bug, in:title) are not valid for code search, so the two tools advertise
# different examples.
_SEARCH_CODE_QUERY_DESC = (
    'Search keywords — use 2–5 distinct terms, NOT a full sentence. GitHub ANDs every word, so '
    'long natural-language queries match nothing. Supports code-search qualifiers like '
    '"language:python", "path:src", "extension:py". Example: "mcp_client transport extension:py".'
)
_SEARCH_ISSUES_QUERY_DESC = (
    'Search keywords — use 2–5 distinct terms, NOT a full sentence. GitHub ANDs every word, so '
    'long natural-language queries match nothing. Supports issue-search qualifiers like '
    '"is:issue", "label:bug", "in:title". Example: "dropper browse button is:open".'
)

# Words stripped from a query before the OR-relax fallback so the relaxed query keeps only
# meaningful terms (and stays under GitHub's 5 AND/OR/NOT operator limit).
_SEARCH_STOPWORDS = frozenset(
    {
        'a',
        'an',
        'the',
        'is',
        'are',
        'was',
        'were',
        'be',
        'been',
        'being',
        'i',
        'im',
        "i'm",
        'it',
        'its',
        "it's",
        'this',
        'that',
        'to',
        'of',
        'in',
        'on',
        'for',
        'with',
        'and',
        'or',
        'but',
        'if',
        'when',
        'my',
        'me',
        'you',
        'having',
        'issue',
        'problem',
        'not',
        'no',
        'works',
        'working',
        'work',
        'click',
        'clicking',
    }
)


# One search token, keeping quoted qualifier values and quoted phrases whole so a space inside
# quotes does not split them: -label:"good first issue" | repo:acme/app | "exact phrase" | word
_QUERY_TOKEN_RE = re.compile(r'-?\w+:"[^"]*"|-?\w+:\S+|"[^"]*"|\S+')


def _relax_query(q: str, *, max_terms: int = 5) -> str | None:
    """Build an OR-relaxed variant of a free-text-heavy query.

    GitHub free-text search ANDs every term, so a verbose natural-language query matches
    nothing. This keeps GitHub qualifiers (``repo:x``, ``is:issue``, negated ``-label:bug``,
    and quoted values like ``label:"good first issue"``) intact and OR-joins the remaining
    keywords. Returns ``None`` when not relaxable (fewer than two usable free-text terms).

    Caps the relaxed query to stay under GitHub's limit of five AND/OR/NOT operators: each
    OR keyword after the first costs one operator and each qualifier costs one implicit AND,
    so the keyword count is trimmed to leave room for the qualifiers (never below two).
    """
    qualifiers: list[str] = []
    terms: list[str] = []
    for tok in _QUERY_TOKEN_RE.findall(q):
        key = tok.split(':', 1)[0].lstrip('-')
        if ':' in tok and key and key.isalnum():  # repo:, is:, label:, in:, -label:, ...
            qualifiers.append(tok)
            continue
        word = tok.strip('\'".,!?')
        if len(word) > 1 and word.lower() not in _SEARCH_STOPWORDS:
            terms.append(f'"{word}"' if ' ' in word else word)  # re-quote multi-word phrases
    # de-dup case-insensitively, preserve order
    seen: set[str] = set()
    uniq = [t for t in terms if not (t.lower() in seen or seen.add(t.lower()))]
    if len(uniq) < 2:
        return None
    budget = max(2, 6 - len(qualifiers))
    or_clause = ' OR '.join(uniq[: min(max_terms, budget)])
    return ' '.join([or_clause, *qualifiers]).strip()


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def _token(self) -> str:
        return self.IGlobal.token

    def _repo(self, args: dict) -> str:
        repo = (args.get('repo') or self.IGlobal.default_repo or '').strip()
        if not repo:
            raise ValueError('repo is required (or configure a default repo in the node settings)')
        return repo

    def _require_write(self) -> None:
        if self.IGlobal.read_only:
            raise ValueError('This operation is not permitted: the node is configured in read-only mode')

    # =======================================================================
    # FILES
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['path'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'path': {
                    'type': 'string',
                    'description': 'File path in the repository, e.g. "src/nodes/llm_openai/services.json"',
                },
                'ref': {
                    'type': 'string',
                    'description': 'Branch, tag, or commit SHA to read from (default: repo default branch)',
                },
            },
        },
        description='Get the decoded content and metadata of a single file from a GitHub repository.',
    )
    def file_get(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        path = require_str(args, 'path', tool_name='file_get')
        params = {'ref': args['ref']} if args.get('ref') else None
        data = call(self._token(), 'GET', f'/repos/{repo}/contents/{path.lstrip("/")}', params=params)
        if isinstance(data, list):
            raise ValueError(f'Path "{path}" is a directory — use file_list instead')
        content_b64 = data.get('content', '')
        content = base64.b64decode(content_b64).decode('utf-8', errors='replace')
        return {
            'path': data.get('path'),
            'name': data.get('name'),
            'sha': data.get('sha'),
            'size': data.get('size'),
            'content': content,
            'html_url': data.get('html_url'),
            'download_url': data.get('download_url'),
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'path': {'type': 'string', 'description': 'Directory path (default: repo root "")'},
                'ref': {'type': 'string', 'description': 'Branch, tag, or commit SHA (default: repo default branch)'},
            },
        },
        description='List files and directories at a path in a GitHub repository.',
    )
    def file_list(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        path = (args.get('path') or '').strip().lstrip('/')
        params = {'ref': args['ref']} if args.get('ref') else None
        data = call(self._token(), 'GET', f'/repos/{repo}/contents/{path}', params=params)
        if not isinstance(data, list):
            raise ValueError(f'Path "{path}" is a file — use file_get instead')
        return [clean_file_entry(f) for f in data]

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['path', 'content', 'message'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'path': {'type': 'string', 'description': 'File path to create, e.g. "docs/nodes/llm_openai.md"'},
                'content': {
                    'type': 'string',
                    'description': 'Plain text file content (will be base64-encoded automatically)',
                },
                'message': {'type': 'string', 'description': 'Commit message'},
                'branch': {'type': 'string', 'description': 'Branch to commit to (default: repo default branch)'},
            },
        },
        description='Create a new file in a GitHub repository.',
    )
    def file_create(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        path = require_str(args, 'path', tool_name='file_create')
        content = args.get('content')
        if content is None:
            raise ValueError('file_create: "content" is required')
        message = require_str(args, 'message', tool_name='file_create')
        body: dict = {
            'message': message,
            'content': base64.b64encode(content.encode('utf-8')).decode('ascii'),
        }
        if args.get('branch'):
            body['branch'] = args['branch']
        data = call(self._token(), 'PUT', f'/repos/{repo}/contents/{path.lstrip("/")}', body=body)
        return {
            'path': path,
            'sha': (data.get('content') or {}).get('sha'),
            'commit_sha': (data.get('commit') or {}).get('sha'),
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['path', 'content', 'message', 'sha'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'path': {'type': 'string', 'description': 'File path to update'},
                'content': {'type': 'string', 'description': 'New plain text file content'},
                'message': {'type': 'string', 'description': 'Commit message'},
                'sha': {'type': 'string', 'description': 'SHA of the file blob being replaced (from file_get)'},
                'branch': {'type': 'string', 'description': 'Branch to commit to (default: repo default branch)'},
            },
        },
        description='Update an existing file in a GitHub repository. Requires the current file SHA (get it from file_get first).',
    )
    def file_edit(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        path = require_str(args, 'path', tool_name='file_edit')
        content = args.get('content')
        if content is None:
            raise ValueError('file_edit: "content" is required')
        message = require_str(args, 'message', tool_name='file_edit')
        sha = require_str(args, 'sha', tool_name='file_edit')
        body: dict = {
            'message': message,
            'content': base64.b64encode(content.encode('utf-8')).decode('ascii'),
            'sha': sha,
        }
        if args.get('branch'):
            body['branch'] = args['branch']
        data = call(self._token(), 'PUT', f'/repos/{repo}/contents/{path.lstrip("/")}', body=body)
        return {
            'path': path,
            'sha': (data.get('content') or {}).get('sha'),
            'commit_sha': (data.get('commit') or {}).get('sha'),
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['path', 'message', 'sha'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'path': {'type': 'string', 'description': 'File path to delete'},
                'message': {'type': 'string', 'description': 'Commit message'},
                'sha': {'type': 'string', 'description': 'SHA of the file blob to delete (from file_get)'},
                'branch': {'type': 'string', 'description': 'Branch to commit to (default: repo default branch)'},
            },
        },
        description='Delete a file from a GitHub repository. Requires the current file SHA (get it from file_get first).',
    )
    def file_delete(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        path = require_str(args, 'path', tool_name='file_delete')
        message = require_str(args, 'message', tool_name='file_delete')
        sha = require_str(args, 'sha', tool_name='file_delete')
        body: dict = {'message': message, 'sha': sha}
        if args.get('branch'):
            body['branch'] = args['branch']
        call(self._token(), 'DELETE', f'/repos/{repo}/contents/{path.lstrip("/")}', body=body)
        return {'deleted': True, 'path': path}

    # =======================================================================
    # ISSUES
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['issue_number'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'issue_number': {'type': 'integer', 'description': 'Issue number'},
            },
        },
        description='Get a single GitHub issue by number.',
    )
    def issue_get(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        num = require_int(args, 'issue_number', tool_name='issue_get')
        data = call(self._token(), 'GET', f'/repos/{repo}/issues/{num}')
        if data.get('pull_request'):
            raise ValueError(f'#{num} is a pull request — use pr_get instead')
        return clean_issue(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'state': {
                    'type': 'string',
                    'enum': ['open', 'closed', 'all'],
                    'description': 'Filter by state (default: open)',
                },
                'labels': {'type': 'string', 'description': 'Comma-separated label names to filter by'},
                'assignee': {'type': 'string', 'description': 'Filter by assignee login'},
                'per_page': {'type': 'integer', 'description': _PER_PAGE_DESC},
                'page': {'type': 'integer', 'description': _PAGE_DESC},
            },
        },
        description='List issues in a repository. Excludes pull requests.',
    )
    def issue_list(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        params = {
            'state': args.get('state', 'open'),
            'labels': args.get('labels'),
            'assignee': args.get('assignee'),
            'per_page': max(1, min(int(args.get('per_page') or 30), 100)),
            'page': max(1, int(args.get('page') or 1)),
        }
        data = call(self._token(), 'GET', f'/repos/{repo}/issues', params=params)
        # GitHub issues endpoint includes PRs — filter them out
        return [clean_issue(i) for i in data if not i.get('pull_request')]

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['title'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'title': {'type': 'string', 'description': 'Issue title'},
                'body': {'type': 'string', 'description': 'Issue body (markdown)'},
                'labels': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Label names to apply'},
                'assignees': {'type': 'array', 'items': {'type': 'string'}, 'description': 'GitHub logins to assign'},
            },
        },
        description='Create a new issue in a GitHub repository.',
    )
    def issue_create(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        body: dict = {'title': require_str(args, 'title', tool_name='issue_create')}
        if args.get('body'):
            body['body'] = args['body']
        if args.get('labels'):
            body['labels'] = args['labels']
        if args.get('assignees'):
            body['assignees'] = args['assignees']
        data = call(self._token(), 'POST', f'/repos/{repo}/issues', body=body)
        return clean_issue(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['issue_number', 'body'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'issue_number': {'type': 'integer', 'description': 'Issue number to comment on'},
                'body': {'type': 'string', 'description': 'Comment body (markdown)'},
            },
        },
        description='Post a comment on a GitHub issue.',
    )
    def issue_comment(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        num = require_int(args, 'issue_number', tool_name='issue_comment')
        body = require_str(args, 'body', tool_name='issue_comment')
        data = call(self._token(), 'POST', f'/repos/{repo}/issues/{num}/comments', body={'body': body})
        return {'id': data.get('id'), 'html_url': data.get('html_url'), 'created_at': data.get('created_at')}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['issue_number'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'issue_number': {'type': 'integer', 'description': 'Issue number to edit'},
                'title': {'type': 'string', 'description': 'New title'},
                'body': {'type': 'string', 'description': 'New body (markdown)'},
                'state': {'type': 'string', 'enum': ['open', 'closed'], 'description': 'New state'},
                'labels': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Replace all labels with this list',
                },
                'assignees': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Replace all assignees with this list',
                },
            },
        },
        description='Edit an existing GitHub issue (title, body, state, labels, assignees).',
    )
    def issue_edit(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        num = require_int(args, 'issue_number', tool_name='issue_edit')
        body = {k: args[k] for k in ('title', 'body', 'state', 'labels', 'assignees') if args.get(k) is not None}
        if not body:
            raise ValueError('issue_edit: provide at least one field to update')
        data = call(self._token(), 'PATCH', f'/repos/{repo}/issues/{num}', body=body)
        return clean_issue(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['issue_number'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'issue_number': {'type': 'integer', 'description': 'Issue number to lock'},
                'lock_reason': {
                    'type': 'string',
                    'enum': ['off-topic', 'too heated', 'resolved', 'spam'],
                    'description': 'Reason for locking',
                },
            },
        },
        description='Lock a GitHub issue to prevent further comments.',
    )
    def issue_lock(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        num = require_int(args, 'issue_number', tool_name='issue_lock')
        body: dict = {}
        if args.get('lock_reason'):
            body['lock_reason'] = args['lock_reason']
        call(self._token(), 'PUT', f'/repos/{repo}/issues/{num}/lock', body=body or None)
        return {'locked': True, 'issue_number': num}

    # =======================================================================
    # PULL REQUESTS
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['pr_number'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'pr_number': {'type': 'integer', 'description': 'Pull request number'},
            },
        },
        description='Get a single pull request by number.',
    )
    def pr_get(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        num = require_int(args, 'pr_number', tool_name='pr_get')
        data = call(self._token(), 'GET', f'/repos/{repo}/pulls/{num}')
        return clean_pr(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'state': {
                    'type': 'string',
                    'enum': ['open', 'closed', 'all'],
                    'description': 'Filter by state (default: open)',
                },
                'base': {'type': 'string', 'description': 'Filter by base branch name'},
                'per_page': {'type': 'integer', 'description': _PER_PAGE_DESC},
                'page': {'type': 'integer', 'description': _PAGE_DESC},
            },
        },
        description='List pull requests in a repository.',
    )
    def pr_list(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        params = {
            'state': args.get('state', 'open'),
            'base': args.get('base'),
            'per_page': max(1, min(int(args.get('per_page') or 30), 100)),
            'page': max(1, int(args.get('page') or 1)),
        }
        data = call(self._token(), 'GET', f'/repos/{repo}/pulls', params=params)
        return [clean_pr(pr) for pr in data]

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['title', 'head', 'base'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'title': {'type': 'string', 'description': 'PR title'},
                'body': {'type': 'string', 'description': 'PR description (markdown)'},
                'head': {'type': 'string', 'description': 'Branch to merge from (e.g. "feat/my-feature")'},
                'base': {'type': 'string', 'description': 'Branch to merge into (e.g. "develop")'},
                'draft': {'type': 'boolean', 'description': 'Open as draft PR (default: false)'},
            },
        },
        description='Create a new pull request.',
    )
    def pr_create(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        body: dict = {
            'title': require_str(args, 'title', tool_name='pr_create'),
            'head': require_str(args, 'head', tool_name='pr_create'),
            'base': require_str(args, 'base', tool_name='pr_create'),
        }
        if args.get('body'):
            body['body'] = args['body']
        if args.get('draft') is not None:
            body['draft'] = bool(args['draft'])
        data = call(self._token(), 'POST', f'/repos/{repo}/pulls', body=body)
        return clean_pr(data)

    # =======================================================================
    # REVIEWS
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['pr_number', 'event'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'pr_number': {'type': 'integer', 'description': 'Pull request number'},
                'body': {'type': 'string', 'description': 'Review summary comment'},
                'event': {
                    'type': 'string',
                    'enum': ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'],
                    'description': 'Review action',
                },
            },
        },
        description='Submit a review on a pull request (approve, request changes, or comment).',
    )
    def review_create(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        num = require_int(args, 'pr_number', tool_name='review_create')
        event = require_str(args, 'event', tool_name='review_create').upper()
        if event not in ('APPROVE', 'REQUEST_CHANGES', 'COMMENT'):
            raise ValueError('review_create: event must be APPROVE, REQUEST_CHANGES, or COMMENT')
        body: dict = {'event': event}
        if args.get('body'):
            body['body'] = args['body']
        data = call(self._token(), 'POST', f'/repos/{repo}/pulls/{num}/reviews', body=body)
        return {
            'id': data.get('id'),
            'state': data.get('state'),
            'submitted_at': data.get('submitted_at'),
            'html_url': data.get('html_url'),
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['pr_number'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'pr_number': {'type': 'integer', 'description': 'Pull request number'},
                'per_page': {'type': 'integer', 'description': _PER_PAGE_DESC},
                'page': {'type': 'integer', 'description': _PAGE_DESC},
            },
        },
        description='List all reviews on a pull request.',
    )
    def review_list(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        num = require_int(args, 'pr_number', tool_name='review_list')
        params = {
            'per_page': max(1, min(int(args.get('per_page') or 30), 100)),
            'page': max(1, int(args.get('page') or 1)),
        }
        data = call(self._token(), 'GET', f'/repos/{repo}/pulls/{num}/reviews', params=params)
        return [
            {
                'id': r.get('id'),
                'state': r.get('state'),
                'body': r.get('body'),
                'user': clean_user(r.get('user')),
                'submitted_at': r.get('submitted_at'),
            }
            for r in data
        ]

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['pr_number', 'review_id'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'pr_number': {'type': 'integer', 'description': 'Pull request number'},
                'review_id': {'type': 'integer', 'description': 'Review ID'},
            },
        },
        description='Get a single review on a pull request.',
    )
    def review_get(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        num = require_int(args, 'pr_number', tool_name='review_get')
        rid = require_int(args, 'review_id', tool_name='review_get')
        data = call(self._token(), 'GET', f'/repos/{repo}/pulls/{num}/reviews/{rid}')
        return {
            'id': data.get('id'),
            'state': data.get('state'),
            'body': data.get('body'),
            'user': clean_user(data.get('user')),
            'submitted_at': data.get('submitted_at'),
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['pr_number', 'review_id', 'body'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'pr_number': {'type': 'integer', 'description': 'Pull request number'},
                'review_id': {'type': 'integer', 'description': 'Review ID to update'},
                'body': {'type': 'string', 'description': 'Updated review body'},
            },
        },
        description='Update the body of a pending review on a pull request.',
    )
    def review_update(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        num = require_int(args, 'pr_number', tool_name='review_update')
        rid = require_int(args, 'review_id', tool_name='review_update')
        body = require_str(args, 'body', tool_name='review_update')
        data = call(self._token(), 'PUT', f'/repos/{repo}/pulls/{num}/reviews/{rid}', body={'body': body})
        return {'id': data.get('id'), 'state': data.get('state'), 'body': data.get('body')}

    # =======================================================================
    # REPOSITORY
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
            },
        },
        description='Get metadata for a GitHub repository (stars, forks, language, default branch, etc.).',
    )
    def repo_get(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        data = call(self._token(), 'GET', f'/repos/{repo}')
        return clean_repo(data)

    # =======================================================================
    # RELEASES
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'per_page': {'type': 'integer', 'description': _PER_PAGE_DESC},
                'page': {'type': 'integer', 'description': _PAGE_DESC},
            },
        },
        description='List releases for a repository.',
    )
    def release_list(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        params = {
            'per_page': max(1, min(int(args.get('per_page') or 30), 100)),
            'page': max(1, int(args.get('page') or 1)),
        }
        data = call(self._token(), 'GET', f'/repos/{repo}/releases', params=params)
        return [clean_release(r) for r in data]

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['release_id'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'release_id': {'type': 'integer', 'description': 'Release ID'},
            },
        },
        description='Get a single release by ID.',
    )
    def release_get(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        rid = require_int(args, 'release_id', tool_name='release_get')
        return clean_release(call(self._token(), 'GET', f'/repos/{repo}/releases/{rid}'))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['tag_name', 'name'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'tag_name': {'type': 'string', 'description': 'Tag name (e.g. "v1.2.0")'},
                'name': {'type': 'string', 'description': 'Release title'},
                'body': {'type': 'string', 'description': 'Release notes (markdown)'},
                'draft': {'type': 'boolean', 'description': 'Create as draft (default: false)'},
                'prerelease': {'type': 'boolean', 'description': 'Mark as pre-release (default: false)'},
            },
        },
        description='Create a new release in a repository.',
    )
    def release_create(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        body: dict = {
            'tag_name': require_str(args, 'tag_name', tool_name='release_create'),
            'name': require_str(args, 'name', tool_name='release_create'),
        }
        for k in ('body', 'draft', 'prerelease'):
            if args.get(k) is not None:
                body[k] = args[k]
        return clean_release(call(self._token(), 'POST', f'/repos/{repo}/releases', body=body))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['release_id'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'release_id': {'type': 'integer', 'description': 'Release ID to update'},
                'tag_name': {'type': 'string', 'description': 'New tag name'},
                'name': {'type': 'string', 'description': 'New title'},
                'body': {'type': 'string', 'description': 'New release notes'},
                'draft': {'type': 'boolean', 'description': 'Draft status'},
                'prerelease': {'type': 'boolean', 'description': 'Pre-release status'},
            },
        },
        description='Update an existing release.',
    )
    def release_update(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        rid = require_int(args, 'release_id', tool_name='release_update')
        body = {k: args[k] for k in ('tag_name', 'name', 'body', 'draft', 'prerelease') if args.get(k) is not None}
        if not body:
            raise ValueError('release_update: provide at least one field to update')
        return clean_release(call(self._token(), 'PATCH', f'/repos/{repo}/releases/{rid}', body=body))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['release_id'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'release_id': {'type': 'integer', 'description': 'Release ID to delete'},
            },
        },
        description='Delete a release from a repository.',
    )
    def release_delete(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        rid = require_int(args, 'release_id', tool_name='release_delete')
        call(self._token(), 'DELETE', f'/repos/{repo}/releases/{rid}')
        return {'deleted': True, 'release_id': rid}

    # =======================================================================
    # WORKFLOWS
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'per_page': {'type': 'integer', 'description': _PER_PAGE_DESC},
                'page': {'type': 'integer', 'description': _PAGE_DESC},
            },
        },
        description='List all workflows in a repository.',
    )
    def workflow_list(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        params = {
            'per_page': max(1, min(int(args.get('per_page') or 30), 100)),
            'page': max(1, int(args.get('page') or 1)),
        }
        data = call(self._token(), 'GET', f'/repos/{repo}/actions/workflows', params=params)
        return [clean_workflow(w) for w in (data.get('workflows') or [])]

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['workflow_id'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'workflow_id': {
                    'type': ['string', 'integer'],
                    'description': 'Workflow ID (integer) or filename (e.g. "ci.yml")',
                },
            },
        },
        description='Get a single workflow by ID or filename.',
    )
    def workflow_get(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        wid = require_str(args, 'workflow_id', tool_name='workflow_get')
        return clean_workflow(call(self._token(), 'GET', f'/repos/{repo}/actions/workflows/{wid}'))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['workflow_id', 'ref'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'workflow_id': {
                    'type': ['string', 'integer'],
                    'description': 'Workflow ID or filename (e.g. "ci.yml")',
                },
                'ref': {'type': 'string', 'description': 'Branch or tag to run the workflow on'},
                'inputs': {
                    'type': 'object',
                    'description': 'Key-value inputs defined by the workflow',
                    'additionalProperties': {'type': 'string'},
                },
            },
        },
        description='Trigger a workflow_dispatch event to manually run a workflow.',
    )
    def workflow_dispatch(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        wid = require_str(args, 'workflow_id', tool_name='workflow_dispatch')
        ref = require_str(args, 'ref', tool_name='workflow_dispatch')
        body: dict = {'ref': ref}
        if args.get('inputs'):
            body['inputs'] = args['inputs']
        call(self._token(), 'POST', f'/repos/{repo}/actions/workflows/{wid}/dispatches', body=body)
        return {'dispatched': True, 'workflow_id': wid, 'ref': ref}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['workflow_id'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'workflow_id': {'type': ['string', 'integer'], 'description': 'Workflow ID or filename'},
            },
        },
        description='Enable a previously disabled workflow.',
    )
    def workflow_enable(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        wid = require_str(args, 'workflow_id', tool_name='workflow_enable')
        call(self._token(), 'PUT', f'/repos/{repo}/actions/workflows/{wid}/enable')
        return {'enabled': True, 'workflow_id': wid}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['workflow_id'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'workflow_id': {'type': ['string', 'integer'], 'description': 'Workflow ID or filename'},
            },
        },
        description='Disable a workflow so it will not run.',
    )
    def workflow_disable(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        repo = self._repo(args)
        wid = require_str(args, 'workflow_id', tool_name='workflow_disable')
        call(self._token(), 'PUT', f'/repos/{repo}/actions/workflows/{wid}/disable')
        return {'disabled': True, 'workflow_id': wid}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['workflow_id'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'workflow_id': {'type': ['string', 'integer'], 'description': 'Workflow ID or filename'},
            },
        },
        description='Get billable minutes and run counts for a workflow.',
    )
    def workflow_get_usage(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        wid = require_str(args, 'workflow_id', tool_name='workflow_get_usage')
        return call(self._token(), 'GET', f'/repos/{repo}/actions/workflows/{wid}/timing')

    # =======================================================================
    # ORGANIZATION
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['org'],
            'properties': {
                'org': {'type': 'string', 'description': 'Organization login (e.g. "acme-corp")'},
                'type': {
                    'type': 'string',
                    'enum': ['all', 'public', 'private', 'forks', 'sources', 'member'],
                    'description': 'Repository type filter (default: all)',
                },
                'per_page': {'type': 'integer', 'description': _PER_PAGE_DESC},
                'page': {'type': 'integer', 'description': _PAGE_DESC},
            },
        },
        description='List repositories belonging to a GitHub organization.',
    )
    def org_list_repos(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        org = require_str(args, 'org', tool_name='org_list_repos')
        params = {
            'type': args.get('type', 'all'),
            'per_page': max(1, min(int(args.get('per_page') or 30), 100)),
            'page': max(1, int(args.get('page') or 1)),
        }
        data = call(self._token(), 'GET', f'/orgs/{org}/repos', params=params)
        return [clean_repo(r) for r in data]

    # =======================================================================
    # USERS
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'username': {
                    'type': 'string',
                    'description': 'GitHub username. Omit to list repos for the authenticated user.',
                },
                'type': {
                    'type': 'string',
                    'enum': ['all', 'owner', 'member'],
                    'description': 'Repository type filter (default: owner)',
                },
                'per_page': {'type': 'integer', 'description': _PER_PAGE_DESC},
                'page': {'type': 'integer', 'description': _PAGE_DESC},
            },
        },
        description="List repositories for a user. Omit username to list the authenticated user's repos.",
    )
    def user_get_repos(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        username = (args.get('username') or '').strip()
        params = {
            'type': args.get('type', 'owner'),
            'per_page': max(1, min(int(args.get('per_page') or 30), 100)),
            'page': max(1, int(args.get('page') or 1)),
        }
        path = f'/users/{username}/repos' if username else '/user/repos'
        data = call(self._token(), 'GET', path, params=params)
        return [clean_repo(r) for r in data]

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['org', 'email'],
            'properties': {
                'org': {'type': 'string', 'description': 'Organization login'},
                'email': {'type': 'string', 'description': 'Email address to invite'},
                'role': {
                    'type': 'string',
                    'enum': ['admin', 'direct_member', 'billing_manager'],
                    'description': 'Role for the new member (default: direct_member)',
                },
            },
        },
        description='Invite a user to a GitHub organization by email.',
    )
    def user_invite(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        self._require_write()
        org = require_str(args, 'org', tool_name='user_invite')
        email = require_str(args, 'email', tool_name='user_invite')
        body: dict = {'email': email, 'role': args.get('role', 'direct_member')}
        data = call(self._token(), 'POST', f'/orgs/{org}/invitations', body=body)
        return {
            'id': data.get('id'),
            'email': data.get('email'),
            'role': data.get('role'),
            'created_at': data.get('created_at'),
        }

    # =======================================================================
    # SEARCH & DISCOVERY
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
            'properties': {
                'query': {
                    'type': 'string',
                    'description': _SEARCH_CODE_QUERY_DESC,
                },
                'repo': {
                    'type': 'string',
                    'description': 'Scope search to a specific repo (owner/repo). Omit to search all accessible repos.',
                },
                'per_page': {'type': 'integer', 'description': _PER_PAGE_DESC},
                'page': {'type': 'integer', 'description': _PAGE_DESC},
            },
        },
        description='Search code across GitHub repositories. Returns matching file paths, repo, and a snippet.',
    )
    def search_code(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        q = require_str(args, 'query', tool_name='search_code')
        repo = (args.get('repo') or self.IGlobal.default_repo or '').strip()
        if repo:
            q = f'{q} repo:{repo}'
        params = {
            'q': q,
            'per_page': max(1, min(int(args.get('per_page') or 30), 100)),
            'page': max(1, int(args.get('page') or 1)),
        }
        data = call(self._token(), 'GET', '/search/code', params=params)
        if not data.get('items'):
            relaxed = _relax_query(q)
            if relaxed and relaxed != q:
                params['q'] = relaxed
                data = call(self._token(), 'GET', '/search/code', params=params)
        return [
            {
                'name': item.get('name'),
                'path': item.get('path'),
                'repository': (item.get('repository') or {}).get('full_name'),
                'html_url': item.get('html_url'),
            }
            for item in (data.get('items') or [])
        ]

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
            'properties': {
                'query': {
                    'type': 'string',
                    'description': _SEARCH_ISSUES_QUERY_DESC,
                },
                'repo': {
                    'type': 'string',
                    'description': 'Scope search to a specific repo. Omit to search all accessible repos.',
                },
                'state': {'type': 'string', 'enum': ['open', 'closed'], 'description': 'Filter by issue state'},
                'per_page': {'type': 'integer', 'description': _PER_PAGE_DESC},
                'page': {'type': 'integer', 'description': _PAGE_DESC},
            },
        },
        description='Search issues and pull requests across GitHub. Useful for finding bug reports and edge cases related to a node.',
    )
    def search_issues(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        q = require_str(args, 'query', tool_name='search_issues')
        repo = (args.get('repo') or self.IGlobal.default_repo or '').strip()
        if repo:
            q = f'{q} repo:{repo}'
        if args.get('state'):
            q = f'{q} is:{args["state"]}'
        params = {
            'q': q,
            'per_page': max(1, min(int(args.get('per_page') or 30), 100)),
            'page': max(1, int(args.get('page') or 1)),
        }
        data = call(self._token(), 'GET', '/search/issues', params=params)
        if not data.get('items'):
            relaxed = _relax_query(q)
            if relaxed and relaxed != q:
                params['q'] = relaxed
                data = call(self._token(), 'GET', '/search/issues', params=params)
        results = []
        for i in data.get('items') or []:
            cleaned = clean_issue(i)
            cleaned['repository'] = i.get('repository_url', '').removeprefix('https://api.github.com/repos/')
            cleaned['is_pull_request'] = 'pull_request' in i
            results.append(cleaned)
        return results

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'path': {
                    'type': 'string',
                    'description': 'Filter commits to those that touched this file or directory',
                },
                'sha': {
                    'type': 'string',
                    'description': 'Branch, tag, or commit SHA to start from (default: repo default branch)',
                },
                'per_page': {'type': 'integer', 'description': _PER_PAGE_DESC},
                'page': {'type': 'integer', 'description': _PAGE_DESC},
            },
        },
        description='List commits in a repository, optionally filtered to a specific file path. Useful for understanding what changed recently.',
    )
    def commit_list(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        params = {
            'path': args.get('path'),
            'sha': args.get('sha'),
            'per_page': max(1, min(int(args.get('per_page') or 30), 100)),
            'page': max(1, int(args.get('page') or 1)),
        }
        data = call(self._token(), 'GET', f'/repos/{repo}/commits', params=params)
        return [clean_commit(c) for c in data]

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['sha'],
            'properties': {
                'repo': {'type': 'string', 'description': _REPO_DESC},
                'sha': {'type': 'string', 'description': 'Full commit SHA'},
            },
        },
        description='Get a single commit including its diff stats and changed files.',
    )
    def commit_get(self, args):
        args = normalize_tool_input(args, tool_name='tool_github')
        repo = self._repo(args)
        sha = require_str(args, 'sha', tool_name='commit_get')
        data = call(self._token(), 'GET', f'/repos/{repo}/commits/{sha}')
        result = clean_commit(data)
        stats = data.get('stats') or {}
        result['stats'] = {
            'additions': stats.get('additions'),
            'deletions': stats.get('deletions'),
            'total': stats.get('total'),
        }
        result['files'] = [
            {
                'filename': f.get('filename'),
                'status': f.get('status'),
                'additions': f.get('additions'),
                'deletions': f.get('deletions'),
                'patch': f.get('patch'),
            }
            for f in (data.get('files') or [])
        ]
        return result
