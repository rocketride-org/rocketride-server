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

"""Unit tests for tool_jira's jira_client (no network, no engine runtime).

jira_client.py has no engine imports, so it loads standalone from its path. Its
request() imports ``requests`` lazily inside the function, so tests stand a fake
module in for it through sys.modules, as test_notion.py does.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest
import requests

_PATH = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_jira' / 'jira_client.py'
_spec = importlib.util.spec_from_file_location('tool_jira_client_under_test', _PATH)
jc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(jc)

AUTH = jc.Auth('https://acme.atlassian.net', 'me@example.com', 'tok')


def _resp(status=200, *, json_data=None, text='', headers=None):
    resp = Mock(spec=requests.Response)
    resp.status_code = status
    resp.ok = 200 <= status < 300
    resp.content = b'x' if json_data is not None else b''
    resp.text = text
    resp.reason = 'error'
    resp.headers = headers or {}
    if json_data is None:
        resp.json.side_effect = ValueError('no json')
    else:
        resp.json.return_value = json_data
    return resp


@pytest.fixture
def fake_requests(monkeypatch):
    fake = Mock()
    fake.exceptions = requests.exceptions
    monkeypatch.setitem(sys.modules, 'requests', fake)
    monkeypatch.setattr(jc.time, 'sleep', Mock())
    return fake


# ---------------------------------------------------------------------------
# site URL and auth
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'url', ['https://acme.atlassian.net', 'https://acme.atlassian.net/', ' https://acme.atlassian.net ']
)
def test_site_url_is_normalized(url):
    assert jc.normalize_site_url(url) == 'https://acme.atlassian.net'


@pytest.mark.parametrize(
    'url',
    [
        'http://acme.atlassian.net',
        'acme.atlassian.net',
        'https://acme.atlassian.net/rest/api/3',
        'https://acme.atlassian.net?x=1',
        'https://user:pw@acme.atlassian.net',
        '',
        # the token goes only to an Atlassian site
        'https://evil.example.com',
        'https://acme.atlassian.net.evil.example.com',
        'https://acme.atlassian.net:8443',
        'https://acme.atlassian.net:abc',
        'https://evil.example.com\\.atlassian.net',
        'https://.atlassian.net',
    ],
)
def test_site_url_other_than_a_bare_https_host_is_refused(url):
    with pytest.raises(jc.JiraAPIError, match='siteUrl'):
        jc.normalize_site_url(url)


def test_request_sends_basic_auth_to_the_v3_api(fake_requests):
    fake_requests.request.return_value = _resp(200, json_data={'ok': True})
    assert jc.request('GET', '/myself', auth=AUTH) == {'ok': True}
    call = fake_requests.request.call_args
    assert call.args == ('GET', 'https://acme.atlassian.net/rest/api/3/myself')
    assert call.kwargs['headers']['Authorization'] == 'Basic bWVAZXhhbXBsZS5jb206dG9r'  # me@example.com:tok
    assert 'Content-Type' not in call.kwargs['headers']


def test_empty_success_body_is_an_empty_dict(fake_requests):
    fake_requests.request.return_value = _resp(204)
    assert jc.request('PUT', '/issue/A-1', auth=AUTH, json_body={'fields': {}}) == {}


# ---------------------------------------------------------------------------
# retries: reads retry, writes never do
# ---------------------------------------------------------------------------


def test_read_waits_out_retry_after_on_429_then_succeeds(fake_requests):
    fake_requests.request.side_effect = [_resp(429, headers={'Retry-After': '3'}), _resp(200, json_data={'a': 1})]
    assert jc.request('GET', '/myself', auth=AUTH) == {'a': 1}
    jc.time.sleep.assert_called_once_with(3.0)


def test_read_retries_a_429_at_most_twice(fake_requests):
    fake_requests.request.return_value = _resp(429, json_data={'errorMessages': ['slow down']})
    with pytest.raises(jc.JiraAPIError) as err:
        jc.request('GET', '/myself', auth=AUTH)
    assert err.value.status_code == 429
    assert fake_requests.request.call_count == 3


def test_a_retry_after_longer_than_the_cap_is_reported_not_waited(fake_requests):
    fake_requests.request.return_value = _resp(429, headers={'Retry-After': '600'})
    with pytest.raises(jc.JiraAPIError, match='429'):
        jc.request('GET', '/myself', auth=AUTH)
    assert fake_requests.request.call_count == 1
    jc.time.sleep.assert_not_called()


def test_a_negative_retry_after_waits_nothing_instead_of_crashing(fake_requests):
    fake_requests.request.side_effect = [_resp(429, headers={'Retry-After': '-1'}), _resp(200, json_data={'a': 1})]
    assert jc.request('GET', '/myself', auth=AUTH) == {'a': 1}
    jc.time.sleep.assert_called_once_with(0.0)


def test_search_post_counts_as_a_read(fake_requests):
    fake_requests.request.side_effect = [_resp(429), _resp(200, json_data={'issues': []})]
    assert jc.request('POST', '/search/jql', auth=AUTH, read=True, json_body={'jql': 'x'}) == {'issues': []}


@pytest.mark.parametrize('status', [429, 500, 503])
def test_writes_never_retry(fake_requests, status):
    fake_requests.request.return_value = _resp(status, headers={'Retry-After': '1'})
    with pytest.raises(jc.JiraAPIError):
        jc.request('POST', '/issue', auth=AUTH, json_body={'fields': {}})
    assert fake_requests.request.call_count == 1


def test_read_retries_a_5xx_once(fake_requests):
    fake_requests.request.side_effect = [_resp(502), _resp(200, json_data={'ok': 1})]
    assert jc.request('GET', '/project/search', auth=AUTH) == {'ok': 1}
    fake_requests.request.side_effect = [_resp(502), _resp(503)]
    with pytest.raises(jc.JiraAPIError) as err:
        jc.request('GET', '/project/search', auth=AUTH)
    assert err.value.status_code == 503


def test_connection_error_retries_a_read_once_and_never_a_write(fake_requests):
    fake_requests.request.side_effect = requests.exceptions.ConnectionError('down')
    with pytest.raises(jc.JiraAPIError, match='connection error'):
        jc.request('GET', '/myself', auth=AUTH)
    assert fake_requests.request.call_count == 2
    fake_requests.request.reset_mock()
    with pytest.raises(jc.JiraAPIError, match='connection error'):
        jc.request('POST', '/issue', auth=AUTH, json_body={})
    assert fake_requests.request.call_count == 1


# ---------------------------------------------------------------------------
# error mapping
# ---------------------------------------------------------------------------


def test_bad_jql_returns_jiras_messages_verbatim(fake_requests):
    body = {'errorMessages': ["Error in JQL Query: Expecting a value but got '='."], 'errors': {}}
    fake_requests.request.return_value = _resp(400, json_data=body)
    with pytest.raises(jc.JiraAPIError) as err:
        jc.request('POST', '/search/jql', auth=AUTH, read=True, json_body={'jql': 'status = = Done'})
    assert err.value.status_code == 400
    assert "Expecting a value but got '='." in str(err.value)


def test_field_errors_are_included(fake_requests):
    fake_requests.request.return_value = _resp(400, json_data={'errorMessages': [], 'errors': {'summary': 'required'}})
    with pytest.raises(jc.JiraAPIError, match='summary: required'):
        jc.request('POST', '/issue', auth=AUTH, json_body={'fields': {}})


@pytest.mark.parametrize(
    'status,phrase', [(401, 'email or API token'), (403, 'permission'), (404, 'not visible to this account')]
)
def test_auth_permission_and_not_found_errors_say_what_to_check(fake_requests, status, phrase):
    fake_requests.request.return_value = _resp(status, text='nope')
    with pytest.raises(jc.JiraAPIError, match=phrase):
        jc.request('GET', '/issue/A-1', auth=AUTH)


def test_non_json_success_is_an_error(fake_requests):
    resp = _resp(200, json_data={})
    resp.json.side_effect = ValueError('bad')
    fake_requests.request.return_value = resp
    with pytest.raises(jc.JiraAPIError, match='expected JSON'):
        jc.request('GET', '/myself', auth=AUTH)


# ---------------------------------------------------------------------------
# project allowlist and JQL wrapping
# ---------------------------------------------------------------------------


def test_parse_projects_upper_cases_dedupes_and_allows_empty():
    assert jc.parse_projects('') == []
    assert jc.parse_projects(' rrt, OPS ,rrt,, ') == ['RRT', 'OPS']


@pytest.mark.parametrize('value', ['RRT) OR (project = X', 'R R', '1AB', 'A"B'])
def test_parse_projects_refuses_anything_but_a_project_key(value):
    with pytest.raises(jc.JiraAPIError, match='invalid project key'):
        jc.parse_projects(value)


def test_wrap_without_projects_returns_the_jql_unchanged():
    assert jc.wrap_jql('status = Done ORDER BY created', []) == 'status = Done ORDER BY created'


def test_wrap_puts_the_jql_inside_the_allowlist_and_keeps_order_by_last():
    out = jc.wrap_jql('status = Done OR assignee = currentUser() ORDER BY updated DESC', ['RRT', 'OPS'])
    assert out == 'project in ("RRT", "OPS") AND (status = Done OR assignee = currentUser()) ORDER BY updated DESC'


def test_wrap_with_only_order_by():
    assert jc.wrap_jql('order by created', ['RRT']) == 'project in ("RRT") order by created'


def test_wrap_of_empty_jql_is_just_the_allowlist():
    assert jc.wrap_jql('  ', ['RRT']) == 'project in ("RRT")'


def test_order_by_inside_quotes_is_part_of_the_filter():
    out = jc.wrap_jql('summary ~ "sort order by date" ORDER BY created', ['RRT'])
    assert out == 'project in ("RRT") AND (summary ~ "sort order by date") ORDER BY created'


def test_a_word_ending_in_order_is_not_an_order_by():
    out = jc.wrap_jql('labels = preorder by_team', ['RRT'])
    assert out == 'project in ("RRT") AND (labels = preorder by_team)'


@pytest.mark.parametrize(
    'jql',
    [
        'status = Done) OR (project = SECRET',
        'status = Done) OR project = SECRET ORDER BY created',
        '(status = Done',
        'summary ~ "unterminated',
    ],
)
def test_unbalanced_jql_cannot_escape_the_allowlist(jql):
    with pytest.raises(jc.JiraAPIError, match='JQL has'):
        jc.wrap_jql(jql, ['RRT'])


def test_escaped_quotes_inside_a_string_are_handled():
    out = jc.wrap_jql(r'summary ~ "a \"quoted) word"', ['RRT'])
    assert out == r'project in ("RRT") AND (summary ~ "a \"quoted) word")'


# ---------------------------------------------------------------------------
# ADF
# ---------------------------------------------------------------------------


def test_plain_text_becomes_paragraphs_with_hard_breaks():
    doc = jc.text_to_adf('first line\nsecond line\n\nnext paragraph')
    assert doc['type'] == 'doc' and doc['version'] == 1
    assert doc['content'] == [
        {
            'type': 'paragraph',
            'content': [
                {'type': 'text', 'text': 'first line'},
                {'type': 'hardBreak'},
                {'type': 'text', 'text': 'second line'},
            ],
        },
        {'type': 'paragraph', 'content': [{'type': 'text', 'text': 'next paragraph'}]},
    ]


def test_bullets_and_a_fenced_code_block():
    doc = jc.text_to_adf('Steps:\n- one\n* two\n\n```python\nprint(1)\n\nprint(2)\n```\nafter')
    kinds = [n['type'] for n in doc['content']]
    assert kinds == ['paragraph', 'bulletList', 'codeBlock', 'paragraph']
    items = doc['content'][1]['content']
    assert [i['content'][0]['content'][0]['text'] for i in items] == ['one', 'two']
    code = doc['content'][2]
    assert code['attrs'] == {'language': 'python'}
    assert code['content'] == [{'type': 'text', 'text': 'print(1)\n\nprint(2)'}]


def test_empty_text_is_an_empty_document_with_no_empty_text_nodes():
    assert jc.text_to_adf('') == {'type': 'doc', 'version': 1, 'content': []}
    doc = jc.text_to_adf('a\n\n\n\nb\n')
    assert all(n.get('text') != '' for p in doc['content'] for n in p['content'])


def test_unclosed_fence_takes_the_rest_as_code():
    doc = jc.text_to_adf('```\nx = 1')
    assert doc['content'] == [{'type': 'codeBlock', 'content': [{'type': 'text', 'text': 'x = 1'}]}]


def test_adf_round_trips_through_text():
    text = 'Intro\nsecond line\n\n- one\n- two\n\n```python\nprint("hi")\n```'
    assert jc.adf_to_text(jc.text_to_adf(text)) == text


def test_adf_to_text_reads_nodes_jira_writes_itself():
    doc = {
        'type': 'doc',
        'version': 1,
        'content': [
            {
                'type': 'paragraph',
                'content': [
                    {'type': 'text', 'text': 'Ping '},
                    {'type': 'mention', 'attrs': {'id': 'x', 'text': '@Maya'}},
                    {'type': 'text', 'text': ' see '},
                    {'type': 'inlineCard', 'attrs': {'url': 'https://example.com'}},
                ],
            },
            {
                'type': 'orderedList',
                'attrs': {'order': 3},
                'content': [
                    {
                        'type': 'listItem',
                        'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': 'c'}]}],
                    },
                    {
                        'type': 'listItem',
                        'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': 'd'}]}],
                    },
                ],
            },
            {'type': 'rule'},
        ],
    }
    assert jc.adf_to_text(doc) == 'Ping @Maya see https://example.com\n\n3. c\n4. d'


@pytest.mark.parametrize('value', [None, 'text', 3, []])
def test_adf_to_text_of_a_non_node_is_empty(value):
    assert jc.adf_to_text(value) == ''


def test_body_size_cap():
    # Jira refuses a text field of 32,768 characters, so the largest accepted body is one byte short of it
    assert jc.check_body_size('x' * 32767) == 'x' * 32767
    with pytest.raises(jc.JiraAPIError, match='32,767 bytes'):
        jc.check_body_size('x' * 32768)
    with pytest.raises(jc.JiraAPIError, match='comment'):
        jc.check_body_size('é' * (32767 // 2 + 1), 'comment')


def test_a_backslash_escapes_outside_quotes_too():
    # JQL reads \" outside a string as an escaped quote; reading it as an opening quote hid the ")" that
    # closes the allowlist wrapper
    with pytest.raises(jc.JiraAPIError, match='unmatched'):
        jc.wrap_jql('labels = \\" ) OR project = SECRET OR (summary ~ "x\\"y"', ['RRT'])


def test_checklists_decisions_and_table_cells_keep_their_breaks():
    doc = {
        'type': 'doc',
        'content': [
            {
                'type': 'taskList',
                'content': [
                    {'type': 'taskItem', 'attrs': {'state': 'TODO'}, 'content': [{'type': 'text', 'text': 'buy milk'}]},
                    {'type': 'taskItem', 'attrs': {'state': 'DONE'}, 'content': [{'type': 'text', 'text': 'call bob'}]},
                ],
            },
            {
                'type': 'decisionList',
                'content': [
                    {'type': 'decisionItem', 'content': [{'type': 'text', 'text': 'ship friday'}]},
                ],
            },
            {
                'type': 'table',
                'content': [
                    {
                        'type': 'tableRow',
                        'content': [
                            {
                                'type': 'tableHeader',
                                'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': 'a'}]}],
                            },
                            {
                                'type': 'tableCell',
                                'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': 'b'}]}],
                            },
                        ],
                    }
                ],
            },
        ],
    }
    assert jc.adf_to_text(doc) == '- [ ] buy milk\n- [x] call bob\n\n- ship friday\n\na\nb'


def test_a_checklist_item_reads_as_one_line_and_a_nested_list_is_indented():
    mention = {'type': 'mention', 'attrs': {'text': '@Bob'}}
    doc = {
        'type': 'taskList',
        'content': [
            {
                'type': 'taskItem',
                'attrs': {'state': 'TODO'},
                'content': [
                    {'type': 'text', 'text': 'Ask '},
                    mention,
                    {'type': 'text', 'text': ' about deploy'},
                ],
            },
            {
                'type': 'taskList',
                'content': [
                    {'type': 'taskItem', 'attrs': {'state': 'DONE'}, 'content': [{'type': 'text', 'text': 'sub'}]},
                ],
            },
        ],
    }
    assert jc.adf_to_text(doc) == '- [ ] Ask @Bob about deploy\n  - [x] sub'
