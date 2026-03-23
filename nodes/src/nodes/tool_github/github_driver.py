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
GitHub tool-provider driver.

Exposes one tool: ``github.get_pr_reviews``

Fetches all pull requests for a given repo and counts reviews per reviewer,
returning both the aggregate counts and raw PR-level detail.
"""

from __future__ import annotations

import time
from typing import Any

import requests

from ai.common.tools import ToolsBase

BASE_URL = 'https://api.github.com'
MAX_PRS = 500
PER_PAGE = 100
MAX_RETRIES = 3

INPUT_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'required': ['repo'],
    'properties': {
        'repo': {
            'type': 'string',
            'description': 'Repository in owner/repo format, e.g. "octocat/Hello-World"',
        },
        'since': {
            'type': 'string',
            'description': ('ISO 8601 date string to filter PRs updated after this date, e.g. "2024-01-01T00:00:00Z". Optional.'),
        },
    },
}


class GithubDriver(ToolsBase):
    def __init__(self, *, server_name: str, token: str):
        """Initialize the GitHub driver with a server name and API token."""
        self._server_name = (server_name or '').strip() or 'github'
        self._tool_name = 'get_pr_reviews'
        self._namespaced = f'{self._server_name}.{self._tool_name}'
        self._token = token
        self._session = requests.Session()
        self._session.headers.update(
            {
                'Authorization': f'Bearer {self._token}',
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            }
        )

    def close(self) -> None:
        """Close the underlying HTTP session."""
        self._session.close()

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> list[dict[str, Any]]:
        return [
            {
                'name': self._namespaced,
                'description': ('Fetch pull request review data for a GitHub repository. Returns review counts per reviewer and a list of pull requests with their reviewers. Provide "repo" as "owner/repo". Optionally filter by "since" (ISO 8601 date) to only include PRs updated after that date. Capped at 500 PRs.'),
                'inputSchema': INPUT_SCHEMA,
            }
        ]

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:
        if not isinstance(input_obj, dict):
            raise ValueError('Tool input must be a JSON object')
        repo = input_obj.get('repo')
        if not repo or not isinstance(repo, str) or '/' not in repo:
            raise ValueError(f'"repo" must be a non-empty string in "owner/repo" format, got {repo!r}')

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:
        if not isinstance(input_obj, dict):
            raise ValueError('Tool input must be a JSON object')
        self._tool_validate(tool_name=tool_name, input_obj=input_obj)

        repo = input_obj['repo'].strip()
        since = input_obj.get('since')

        pull_requests = self._fetch_pull_requests(repo, since)
        truncated = len(pull_requests) >= MAX_PRS

        reviews_by_user: dict[str, int] = {}
        pr_details: list[dict[str, Any]] = []

        for pr in pull_requests:
            pr_number = pr['number']
            reviews = self._fetch_reviews(repo, pr_number)

            reviewers: list[str] = []
            seen: set = set()
            for review in reviews:
                login = review.get('user', {}).get('login', '')
                if login and login != pr.get('user', {}).get('login', ''):
                    reviews_by_user[login] = reviews_by_user.get(login, 0) + 1
                    if login not in seen:
                        reviewers.append(login)
                        seen.add(login)

            pr_details.append(
                {
                    'number': pr_number,
                    'title': pr.get('title', ''),
                    'author': pr.get('user', {}).get('login', ''),
                    'state': pr.get('state', ''),
                    'reviewers': reviewers,
                    'review_count': len(reviews),
                    'url': pr.get('html_url', ''),
                }
            )

        # Sort leaderboard descending by review count
        leaderboard = sorted(
            [{'user': u, 'reviews': c} for u, c in reviews_by_user.items()],
            key=lambda x: x['reviews'],
            reverse=True,
        )

        return {
            'repo': repo,
            'total_prs_fetched': len(pull_requests),
            'truncated': truncated,
            'leaderboard': leaderboard,
            'pull_requests': pr_details,
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _get_with_retry(self, url: str, params: dict[str, Any]) -> requests.Response:
        """GET with retry/backoff. Respects Retry-After on 429."""
        for attempt in range(MAX_RETRIES):
            try:
                resp = self._session.get(url, params=params, timeout=30)
                if resp.status_code == 429:
                    wait = int(resp.headers.get('Retry-After', 2**attempt))
                    time.sleep(wait)
                    continue
                resp.raise_for_status()
                return resp
            except requests.exceptions.HTTPError as e:
                if attempt < MAX_RETRIES - 1:
                    time.sleep(2**attempt)
                    continue
                raise RuntimeError(f'GitHub API error for {url} params={params}: {e}') from e
            except requests.exceptions.RequestException as e:
                if attempt < MAX_RETRIES - 1:
                    time.sleep(2**attempt)
                    continue
                raise RuntimeError(f'GitHub request failed for {url} params={params}: {e}') from e
        raise RuntimeError(f'GitHub API exceeded {MAX_RETRIES} retries for {url}')

    def _fetch_pull_requests(self, repo: str, since: str | None) -> list[dict[str, Any]]:
        """Paginate through all PRs (open + closed), up to MAX_PRS."""
        results: list[dict[str, Any]] = []
        params: dict[str, Any] = {'state': 'all', 'per_page': PER_PAGE, 'page': 1}

        while len(results) < MAX_PRS:
            resp = self._get_with_retry(f'{BASE_URL}/repos/{repo}/pulls', params)
            page = resp.json()
            if not page:
                break
            results.extend(page)
            params['page'] += 1
            if len(page) < PER_PAGE:
                break

        # Apply date filtering post-fetch — the Pulls API ignores 'since'
        if since:
            results = [pr for pr in results if (pr.get('updated_at') or '') >= since]

        return results[:MAX_PRS]

    def _fetch_reviews(self, repo: str, pr_number: int) -> list[dict[str, Any]]:
        """Fetch all reviews for a single PR."""
        results: list[dict[str, Any]] = []
        params: dict[str, Any] = {'per_page': PER_PAGE, 'page': 1}

        while True:
            resp = self._get_with_retry(
                f'{BASE_URL}/repos/{repo}/pulls/{pr_number}/reviews',
                params,
            )
            page = resp.json()
            if not page:
                break
            results.extend(page)
            params['page'] += 1
            if len(page) < PER_PAGE:
                break

        return results
