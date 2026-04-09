"""
Live integration tests for tool_github.

Calls every GitHub API endpoint used by the 37 tool functions.
Requires a GitHub PAT with repo + issues + pull_requests + workflows scopes.

    export GITHUB_TOKEN=<your token>
    export GITHUB_TEST_REPO=ryan-t-christensen/skyrim   # default
    pytest nodes/test/tool_github/test_tools.py -v
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_github'))
from github_client import call  # noqa: E402

TOKEN = os.getenv('GITHUB_TOKEN', '')
REPO = os.getenv('GITHUB_TEST_REPO', 'ryan-t-christensen/skyrim')

pytestmark = pytest.mark.skipif(not TOKEN, reason='GITHUB_TOKEN not set')

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def c(method, path, *, params=None, body=None):
    return call(TOKEN, method, path, params=params, body=body)


def repo_path(suffix=''):
    return f'/repos/{REPO}{suffix}'


# ---------------------------------------------------------------------------
# Repository
# ---------------------------------------------------------------------------


class TestRepo:
    def test_repo_get(self):
        data = c('GET', repo_path())
        assert data['full_name'] == REPO


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------


class TestFiles:
    def test_file_list_root(self):
        data = c('GET', repo_path('/contents/'))
        assert isinstance(data, list)
        assert len(data) > 0

    def test_file_get(self):
        # Get the first file found in the root
        entries = c('GET', repo_path('/contents/'))
        files = [e for e in entries if e['type'] == 'file']
        assert files, 'no files in repo root'
        path = files[0]['path']
        data = c('GET', repo_path(f'/contents/{path}'))
        assert 'content' in data or data.get('type') == 'file'

    def test_file_create_edit_delete(self):
        uid = uuid.uuid4().hex[:8]
        path = f'test-{uid}.txt'

        # Create
        create = c(
            'PUT',
            repo_path(f'/contents/{path}'),
            body={
                'message': f'test: create {path}',
                'content': __import__('base64').b64encode(b'hello rocketride').decode(),
            },
        )
        sha = create['content']['sha']
        assert sha

        # Edit
        edit = c(
            'PUT',
            repo_path(f'/contents/{path}'),
            body={
                'message': f'test: edit {path}',
                'content': __import__('base64').b64encode(b'hello rocketride updated').decode(),
                'sha': sha,
            },
        )
        new_sha = edit['content']['sha']
        assert new_sha != sha

        # Delete
        c(
            'DELETE',
            repo_path(f'/contents/{path}'),
            body={
                'message': f'test: delete {path}',
                'sha': new_sha,
            },
        )


# ---------------------------------------------------------------------------
# Commits
# ---------------------------------------------------------------------------


class TestCommits:
    def test_commit_list(self):
        data = c('GET', repo_path('/commits'), params={'per_page': 5})
        assert isinstance(data, list)
        assert len(data) > 0
        assert 'sha' in data[0]

    def test_commit_get(self):
        commits = c('GET', repo_path('/commits'), params={'per_page': 1})
        sha = commits[0]['sha']
        data = c('GET', repo_path(f'/commits/{sha}'))
        assert data['sha'] == sha
        assert 'stats' in data


# ---------------------------------------------------------------------------
# Issues
# ---------------------------------------------------------------------------


class TestIssues:
    _issue_number: int = None

    def test_issue_create(self):
        uid = uuid.uuid4().hex[:8]
        data = c(
            'POST',
            repo_path('/issues'),
            body={
                'title': f'[test] {uid}',
                'body': 'Automated test issue — safe to close.',
                'labels': [],
            },
        )
        assert data['number']
        TestIssues._issue_number = data['number']

    def test_issue_get(self):
        assert TestIssues._issue_number, 'depends on test_issue_create'
        data = c('GET', repo_path(f'/issues/{TestIssues._issue_number}'))
        assert data['number'] == TestIssues._issue_number

    def test_issue_list(self):
        data = c('GET', repo_path('/issues'), params={'state': 'open', 'per_page': 10})
        assert isinstance(data, list)

    def test_issue_comment(self):
        assert TestIssues._issue_number, 'depends on test_issue_create'
        data = c(
            'POST',
            repo_path(f'/issues/{TestIssues._issue_number}/comments'),
            body={
                'body': 'Automated test comment.',
            },
        )
        assert data['id']

    def test_issue_edit(self):
        assert TestIssues._issue_number, 'depends on test_issue_create'
        data = c(
            'PATCH',
            repo_path(f'/issues/{TestIssues._issue_number}'),
            body={
                'title': f'[test][edited] {TestIssues._issue_number}',
            },
        )
        assert 'edited' in data['title']

    def test_issue_lock(self):
        assert TestIssues._issue_number, 'depends on test_issue_create'
        c(
            'PUT',
            repo_path(f'/issues/{TestIssues._issue_number}/lock'),
            body={
                'lock_reason': 'resolved',
            },
        )

    def test_issue_close(self):
        assert TestIssues._issue_number, 'depends on test_issue_create'
        data = c(
            'PATCH',
            repo_path(f'/issues/{TestIssues._issue_number}'),
            body={
                'state': 'closed',
            },
        )
        assert data['state'] == 'closed'


# ---------------------------------------------------------------------------
# Pull Requests
# ---------------------------------------------------------------------------


class TestPullRequests:
    def test_pr_list(self):
        data = c('GET', repo_path('/pulls'), params={'state': 'all', 'per_page': 10})
        assert isinstance(data, list)

    def test_pr_get(self):
        prs = c('GET', repo_path('/pulls'), params={'state': 'all', 'per_page': 1})
        if not prs:
            pytest.skip('no PRs in repo')
        data = c('GET', repo_path(f'/pulls/{prs[0]["number"]}'))
        assert data['number'] == prs[0]['number']


# ---------------------------------------------------------------------------
# Reviews
# ---------------------------------------------------------------------------


class TestReviews:
    def test_review_list(self):
        prs = c('GET', repo_path('/pulls'), params={'state': 'all', 'per_page': 1})
        if not prs:
            pytest.skip('no PRs in repo')
        pr_number = prs[0]['number']
        data = c('GET', repo_path(f'/pulls/{pr_number}/reviews'))
        assert isinstance(data, list)


# ---------------------------------------------------------------------------
# Releases
# ---------------------------------------------------------------------------


class TestReleases:
    _release_id: int = None

    def test_release_list(self):
        data = c('GET', repo_path('/releases'), params={'per_page': 10})
        assert isinstance(data, list)

    def test_release_create(self):
        uid = uuid.uuid4().hex[:8]
        # Need a tag — use the latest commit SHA as lightweight ref
        commits = c('GET', repo_path('/commits'), params={'per_page': 1})
        sha = commits[0]['sha']

        # Create a temp tag
        tag = f'test-{uid}'
        c(
            'POST',
            repo_path('/git/refs'),
            body={
                'ref': f'refs/tags/{tag}',
                'sha': sha,
            },
        )

        data = c(
            'POST',
            repo_path('/releases'),
            body={
                'tag_name': tag,
                'name': f'Test Release {uid}',
                'body': 'Automated test release — safe to delete.',
                'draft': True,
            },
        )
        assert data['id']
        TestReleases._release_id = data['id']
        TestReleases._tag = tag

    def test_release_get(self):
        if not TestReleases._release_id:
            pytest.skip('depends on test_release_create')
        data = c('GET', repo_path(f'/releases/{TestReleases._release_id}'))
        assert data['id'] == TestReleases._release_id

    def test_release_update(self):
        if not TestReleases._release_id:
            pytest.skip('depends on test_release_create')
        data = c(
            'PATCH',
            repo_path(f'/releases/{TestReleases._release_id}'),
            body={
                'name': 'Test Release (updated)',
            },
        )
        assert 'updated' in data['name']

    def test_release_delete(self):
        if not TestReleases._release_id:
            pytest.skip('depends on test_release_create')
        c('DELETE', repo_path(f'/releases/{TestReleases._release_id}'))
        # Clean up the tag too
        c('DELETE', repo_path(f'/git/refs/tags/{TestReleases._tag}'))


# ---------------------------------------------------------------------------
# Workflows
# ---------------------------------------------------------------------------


class TestWorkflows:
    def test_workflow_list(self):
        data = c('GET', repo_path('/actions/workflows'))
        assert 'workflows' in data

    def test_workflow_get(self):
        data = c('GET', repo_path('/actions/workflows'))
        workflows = data.get('workflows', [])
        if not workflows:
            pytest.skip('no workflows in repo')
        wf_id = workflows[0]['id']
        wf = c('GET', repo_path(f'/actions/workflows/{wf_id}'))
        assert wf['id'] == wf_id

    def test_workflow_get_usage(self):
        data = c('GET', repo_path('/actions/workflows'))
        workflows = data.get('workflows', [])
        if not workflows:
            pytest.skip('no workflows in repo')
        wf_id = workflows[0]['id']
        usage = c('GET', repo_path(f'/actions/workflows/{wf_id}/timing'))
        assert 'billable' in usage


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------


class TestUsers:
    def test_user_get_repos_authenticated(self):
        data = c('GET', '/user/repos', params={'per_page': 5, 'type': 'owner'})
        assert isinstance(data, list)

    def test_user_get_repos_by_name(self):
        owner = REPO.split('/')[0]
        data = c('GET', f'/users/{owner}/repos', params={'per_page': 5})
        assert isinstance(data, list)


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


class TestSearch:
    def test_search_code(self):
        data = c(
            'GET',
            '/search/code',
            params={
                'q': f'repo:{REPO} README',
                'per_page': 5,
            },
        )
        assert 'items' in data

    def test_search_issues(self):
        data = c(
            'GET',
            '/search/issues',
            params={
                'q': f'repo:{REPO} is:issue',
                'per_page': 5,
            },
        )
        assert 'items' in data


# ---------------------------------------------------------------------------
# Org
# ---------------------------------------------------------------------------


class TestOrg:
    def test_org_list_repos(self):
        data = c('GET', '/orgs/rocketride-org/repos', params={'per_page': 5})
        assert isinstance(data, list)
