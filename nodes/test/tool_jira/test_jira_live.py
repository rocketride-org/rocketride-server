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

"""Live test of tool_jira against a real Jira Cloud site.

Skipped unless ROCKETRIDE_JIRA_SITE_URL, ROCKETRIDE_JIRA_EMAIL,
ROCKETRIDE_JIRA_API_TOKEN and ROCKETRIDE_JIRA_PROJECT are set. A free site with
one project is enough. It creates two issues in that project (labelled
rocketride-live-test), comments on one, reads them back, pages a search, checks
the read-only and allowlist refusals, then deletes the issues it created when the
account may delete issues (a new company-managed project doesn't grant that).
"""

from __future__ import annotations

import os
import time
import warnings
from unittest.mock import Mock

import pytest

from .test_jira import ii, jc

ENV = ('ROCKETRIDE_JIRA_SITE_URL', 'ROCKETRIDE_JIRA_EMAIL', 'ROCKETRIDE_JIRA_API_TOKEN', 'ROCKETRIDE_JIRA_PROJECT')
pytestmark = pytest.mark.skipif(not all(os.environ.get(n) for n in ENV), reason='ROCKETRIDE_JIRA_* are not set')
LABEL = 'rocketride-live-test'


def _node(*, read_only=False, projects=None):
    inst = ii.IInstance.__new__(ii.IInstance)
    glob = Mock()
    glob.auth = jc.Auth(
        jc.normalize_site_url(os.environ['ROCKETRIDE_JIRA_SITE_URL']),
        os.environ['ROCKETRIDE_JIRA_EMAIL'],
        os.environ['ROCKETRIDE_JIRA_API_TOKEN'],
    )
    glob.read_only = read_only
    glob.projects = [os.environ['ROCKETRIDE_JIRA_PROJECT'].upper()] if projects is None else projects
    glob.max_results = 25
    glob.created_label = LABEL
    inst.IGlobal = glob
    return inst


@pytest.fixture
def created():
    keys = []
    yield keys
    node = _node()
    for key in keys:  # leave the site as it was, when the project lets this account delete issues
        try:
            jc.request('DELETE', f'/issue/{key}', auth=node.IGlobal.auth)
        except jc.JiraAPIError as exc:
            warnings.warn(f'could not delete {key}: {exc}', stacklevel=1)


def test_the_six_tools_against_a_live_site(created):
    project = os.environ['ROCKETRIDE_JIRA_PROJECT'].upper()
    node = _node()

    me = node.jira_check_connection({})
    assert me['success'] and me['ok'] and me['account_id']
    assert project in [p['key'] for p in node.jira_projects_list({})['projects']]

    for summary in ('live test: first', 'live test: second'):
        made = node.jira_issue_create(
            {
                'project': project,
                'issue_type': 'Task',
                'summary': summary,
                'description': 'Steps:\n- one\n- two\n\n```python\nprint("hi")\n```',
            }
        )
        assert made['success'], made
        created.append(made['key'])

    comment = node.jira_comment_add({'key': created[0], 'body': 'A list:\n\n- alpha\n- beta\n\n```\nok\n```'})
    assert comment['success'] and comment['comment_id'], comment

    got = node.jira_issue_get({'key': created[0], 'include_comments': True})
    assert got['success'] and LABEL in got['labels']
    assert got['description_text'] == 'Steps:\n\n- one\n- two\n\n```python\nprint("hi")\n```'
    assert got['comments'][0]['body_text'] == 'A list:\n\n- alpha\n- beta\n\n```\nok\n```'

    jql = f'key in ({", ".join(created)}) ORDER BY created ASC'
    # new issues can take a moment to show up in search: wait for both before paging (reads only)
    deadline = time.monotonic() + 60
    while len(node.jira_search({'jql': jql, 'max_results': 2}).get('issues') or []) < 2 and time.monotonic() < deadline:
        time.sleep(2)
    first = node.jira_search({'jql': jql, 'max_results': 1})
    assert first['success'] and len(first['issues']) == 1 and first['next_page_token'], first
    second = node.jira_search({'jql': jql, 'max_results': 1, 'next_page_token': first['next_page_token']})
    assert second['success'] and second['issues'][0]['key'] != first['issues'][0]['key']
    assert {first['issues'][0]['key'], second['issues'][0]['key']} == set(created)

    refused = _node(read_only=True).jira_issue_create({'project': project, 'issue_type': 'Task', 'summary': 'x'})
    assert not refused['success'] and 'tool_jira.readOnly' in refused['error']
    outside = _node(projects=['ZZQX']).jira_issue_get({'key': created[0]})
    assert not outside['success'] and 'allowlist' in outside['error']

    assert '400' in node.jira_search({'jql': 'status = = Done'})['error']
    assert '404' in node.jira_issue_get({'key': f'{project}-999999'})['error']
    bad = _node()
    bad.IGlobal.auth = bad.IGlobal.auth._replace(api_token='not-a-token')
    assert '401' in bad.jira_check_connection({})['error']


def test_search_pages_past_100_issues():
    """Needs a project holding more than 100 issues; each page carries full issues, never bare ids."""
    node = _node()
    jql = f'project = {os.environ["ROCKETRIDE_JIRA_PROJECT"].upper()} ORDER BY created ASC'
    first = node.jira_search({'jql': jql, 'max_results': 100})
    assert first['success'], first
    if not first['next_page_token']:
        pytest.skip('the project holds 100 issues or fewer')
    assert len(first['issues']) == 100
    second = node.jira_search({'jql': jql, 'max_results': 100, 'next_page_token': first['next_page_token']})
    assert second['success'] and second['issues'], second
    keys = [i['key'] for i in first['issues'] + second['issues']]
    assert len(keys) == len(set(keys)) > 100
    assert all(i['summary'] and i['status'] and i['url'] for i in first['issues'] + second['issues'])
