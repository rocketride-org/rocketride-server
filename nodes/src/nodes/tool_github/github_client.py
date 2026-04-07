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
GitHub REST API v3 client.

Thin wrapper around requests — handles auth, headers, error parsing,
and response normalisation. All tool methods in IInstance call through here.
"""

from __future__ import annotations

from typing import Any

import requests

BASE_URL = 'https://api.github.com'
DEFAULT_TIMEOUT = 30


def call(
    token: str,
    method: str,
    path: str,
    *,
    params: dict | None = None,
    body: dict | None = None,
) -> Any:
    """Make an authenticated GitHub API call and return parsed JSON.

    Raises ``ValueError`` with a human-readable message on HTTP errors.
    Returns an empty dict for 204 No Content responses.
    """
    headers = {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }

    url = BASE_URL + path
    resp = requests.request(
        method.upper(),
        url,
        headers=headers,
        params={k: v for k, v in (params or {}).items() if v is not None},
        json=body,
        timeout=DEFAULT_TIMEOUT,
    )

    if resp.status_code == 204:
        return {}

    if not resp.ok:
        try:
            err = resp.json()
            msg = err.get('message', resp.text)
            errors = err.get('errors')
            if errors:
                msg += ' — ' + '; '.join(e.get('message', str(e)) if isinstance(e, dict) else str(e) for e in errors)
        except Exception:
            msg = resp.text or resp.reason or 'unknown error'
        raise ValueError(f'GitHub API {resp.status_code}: {msg}')

    return resp.json()


# ---------------------------------------------------------------------------
# Response cleaners — strip noisy fields (node_id, _links, gravatar, etc.)
# so agents get compact, useful output.
# ---------------------------------------------------------------------------


def clean_user(u: dict | None) -> dict:
    if not isinstance(u, dict):
        return {}
    return {k: u[k] for k in ('login', 'id', 'avatar_url', 'html_url') if k in u}


def clean_label(lbl: dict | None) -> dict:
    if not isinstance(lbl, dict):
        return {}
    return {k: lbl[k] for k in ('id', 'name', 'color', 'description') if k in lbl}


def clean_issue(issue: dict) -> dict:
    return {
        'number': issue.get('number'),
        'title': issue.get('title'),
        'body': issue.get('body'),
        'state': issue.get('state'),
        'labels': [clean_label(lbl) for lbl in (issue.get('labels') or [])],
        'user': clean_user(issue.get('user')),
        'assignees': [clean_user(a) for a in (issue.get('assignees') or [])],
        'created_at': issue.get('created_at'),
        'updated_at': issue.get('updated_at'),
        'closed_at': issue.get('closed_at'),
        'html_url': issue.get('html_url'),
        'comments': issue.get('comments'),
    }


def clean_pr(pr: dict) -> dict:
    head = pr.get('head') or {}
    base = pr.get('base') or {}
    return {
        'number': pr.get('number'),
        'title': pr.get('title'),
        'body': pr.get('body'),
        'state': pr.get('state'),
        'merged': pr.get('merged', False),
        'draft': pr.get('draft', False),
        'head': {'ref': head.get('ref'), 'sha': head.get('sha')},
        'base': {'ref': base.get('ref'), 'sha': base.get('sha')},
        'user': clean_user(pr.get('user')),
        'created_at': pr.get('created_at'),
        'updated_at': pr.get('updated_at'),
        'merged_at': pr.get('merged_at'),
        'html_url': pr.get('html_url'),
        'commits': pr.get('commits'),
        'additions': pr.get('additions'),
        'deletions': pr.get('deletions'),
        'changed_files': pr.get('changed_files'),
    }


def clean_file_entry(f: dict) -> dict:
    return {k: f[k] for k in ('name', 'path', 'type', 'sha', 'size', 'download_url') if k in f}


def clean_commit(c: dict) -> dict:
    commit = c.get('commit') or {}
    author = commit.get('author') or {}
    return {
        'sha': c.get('sha'),
        'message': commit.get('message'),
        'author': author.get('name'),
        'email': author.get('email'),
        'date': author.get('date'),
        'html_url': c.get('html_url'),
    }


def clean_release(r: dict) -> dict:
    return {
        'id': r.get('id'),
        'tag_name': r.get('tag_name'),
        'name': r.get('name'),
        'body': r.get('body'),
        'draft': r.get('draft'),
        'prerelease': r.get('prerelease'),
        'created_at': r.get('created_at'),
        'published_at': r.get('published_at'),
        'html_url': r.get('html_url'),
        'author': clean_user(r.get('author')),
    }


def clean_workflow(w: dict) -> dict:
    return {k: w[k] for k in ('id', 'name', 'path', 'state', 'created_at', 'updated_at', 'html_url') if k in w}


def clean_repo(r: dict) -> dict:
    return {
        'id': r.get('id'),
        'full_name': r.get('full_name'),
        'description': r.get('description'),
        'private': r.get('private'),
        'fork': r.get('fork'),
        'default_branch': r.get('default_branch'),
        'language': r.get('language'),
        'stargazers_count': r.get('stargazers_count'),
        'forks_count': r.get('forks_count'),
        'open_issues_count': r.get('open_issues_count'),
        'created_at': r.get('created_at'),
        'updated_at': r.get('updated_at'),
        'pushed_at': r.get('pushed_at'),
        'html_url': r.get('html_url'),
        'clone_url': r.get('clone_url'),
    }
