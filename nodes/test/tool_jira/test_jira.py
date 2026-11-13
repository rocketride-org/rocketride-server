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

"""Unit tests for the tool_jira node (no network, no engine runtime).

Bootstrap mirrors test_notion.py: stub the engine-only modules (rocketlib,
ai.common.*), load the node's submodules standalone via a synthetic package,
then restore sys.modules so the stubs never leak into a shared pytest session.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import Mock

import pytest
import requests

_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_jira'


def _load_modules():
    _core = ('rocketlib', 'ai', 'ai.common', 'ai.common.config', 'ai.common.utils')
    _saved = {name: sys.modules.get(name) for name in _core}

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    rocketlib.IInstanceBase = type('IInstanceBase', (), {})
    rocketlib.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config'})

    def _tool_function(*args, **kwargs):
        def decorator(fn):
            fn.__tool_meta__ = kwargs
            return fn

        return decorator

    rocketlib.tool_function = _tool_function
    rocketlib.warning = Mock()
    rocketlib.error = Mock()
    sys.modules['rocketlib'] = rocketlib
    sys.modules['ai'] = types.ModuleType('ai')
    sys.modules['ai'].__path__ = []
    sys.modules['ai.common'] = types.ModuleType('ai.common')
    sys.modules['ai.common'].__path__ = []
    ai_cfg = types.ModuleType('ai.common.config')
    ai_cfg.Config = type('Config', (), {'getNodeConfig': staticmethod(lambda *a, **k: {})})
    sys.modules['ai.common.config'] = ai_cfg
    ai_utils = types.ModuleType('ai.common.utils')
    ai_utils.normalize_tool_input = lambda value, **kwargs: value if isinstance(value, dict) else {}
    sys.modules['ai.common.utils'] = ai_utils

    submodule_names = ('tool_jira.jira_client', 'tool_jira.IGlobal', 'tool_jira.IInstance')
    pkg = types.ModuleType('tool_jira')
    pkg.__path__ = [str(_DIR)]
    sys.modules['tool_jira'] = pkg
    try:
        for name in ('jira_client', 'IGlobal', 'IInstance'):
            spec = importlib.util.spec_from_file_location(f'tool_jira.{name}', _DIR / f'{name}.py')
            module = importlib.util.module_from_spec(spec)
            sys.modules[f'tool_jira.{name}'] = module
            spec.loader.exec_module(module)
        return (
            sys.modules['tool_jira.jira_client'],
            sys.modules['tool_jira.IGlobal'],
            sys.modules['tool_jira.IInstance'],
        )
    finally:
        sys.modules.pop('tool_jira', None)
        for name in submodule_names:
            sys.modules.pop(name, None)
        for name, mod in _saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


jc, ig, ii = _load_modules()


def _resp(status=200, json_data=None):
    resp = Mock(spec=requests.Response)
    resp.status_code = status
    resp.ok = 200 <= status < 300
    resp.content = b'x' if json_data is not None else b''
    resp.text = ''
    resp.reason = 'error'
    resp.headers = {}
    if json_data is None:
        resp.json.side_effect = ValueError('no json')
    else:
        resp.json.return_value = json_data
    return resp


@pytest.fixture
def api(monkeypatch):
    """A fake `requests` whose responses the test queues; ``api.calls`` lists (method, path, kwargs)."""
    fake = Mock()
    fake.exceptions = requests.exceptions
    fake.queue = []
    fake.calls = []

    def request(method, url, **kwargs):
        fake.calls.append((method, url.split('/rest/api/3', 1)[1], kwargs))
        return fake.queue.pop(0)

    fake.request.side_effect = request
    monkeypatch.setitem(sys.modules, 'requests', fake)
    monkeypatch.setattr(jc.time, 'sleep', Mock())
    return fake


def _node(read_only=True, projects=(), max_results=25, created_label=''):
    inst = ii.IInstance.__new__(ii.IInstance)
    glob = Mock()
    glob.auth = jc.Auth('https://acme.atlassian.net', 'me@example.com', 'tok')
    glob.read_only = read_only
    glob.projects = list(projects)
    glob.max_results = max_results
    glob.created_label = created_label
    inst.IGlobal = glob
    return inst


def _issue(key='RRT-1', project='RRT', **fields):
    return {'key': key, 'fields': {'project': {'key': project}, **fields}}


# ---------------------------------------------------------------------------
# config (IGlobal)
# ---------------------------------------------------------------------------


def _global(monkeypatch, cfg, env=None):
    for name in (ig.SITE_URL_ENV, ig.EMAIL_ENV, ig.API_TOKEN_ENV):
        monkeypatch.delenv(name, raising=False)
    for name, value in (env or {}).items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(ig.Config, 'getNodeConfig', staticmethod(lambda *a, **k: cfg))
    g = ig.IGlobal.__new__(ig.IGlobal)
    g.glb = Mock()
    return g


def test_config_reads_settings_and_defaults_to_read_only(monkeypatch):
    g = _global(
        monkeypatch,
        {'siteUrl': 'https://acme.atlassian.net/', 'email': 'a@b.c', 'apiToken': 't', 'projects': 'rrt, ops'},
    )
    g._read()
    assert g.auth == jc.Auth('https://acme.atlassian.net', 'a@b.c', 't')
    assert g.read_only is True and g.projects == ['RRT', 'OPS'] and g.max_results == 25 and g.created_label == ''


def test_env_fills_what_the_config_leaves_out_and_config_wins(monkeypatch):
    env = {ig.SITE_URL_ENV: 'https://env.atlassian.net', ig.EMAIL_ENV: 'env@b.c', ig.API_TOKEN_ENV: 'envtok'}
    g = _global(monkeypatch, {'email': 'cfg@b.c'}, env)
    g._read()
    assert g.auth == jc.Auth('https://env.atlassian.net', 'cfg@b.c', 'envtok')


@pytest.mark.parametrize('raw,expected', [(0, 1), (500, 100), ('40', 40), ('x', 25), (None, 25)])
def test_max_results_is_clamped(monkeypatch, raw, expected):
    g = _global(
        monkeypatch, {'siteUrl': 'https://acme.atlassian.net', 'email': 'a', 'apiToken': 't', 'maxResults': raw}
    )
    g._read()
    assert g.max_results == expected


@pytest.mark.parametrize('raw,expected', [(False, False), ('false', False), ('true', True), ('', True), ('ture', True)])
def test_read_only_accepts_string_forms(monkeypatch, raw, expected):
    g = _global(monkeypatch, {'siteUrl': 'https://acme.atlassian.net', 'email': 'a', 'apiToken': 't', 'readOnly': raw})
    g._read()
    assert g.read_only is expected


@pytest.mark.parametrize(
    'cfg,match',
    [
        ({'email': 'a', 'apiToken': 't'}, 'siteUrl'),
        ({'siteUrl': 'https://acme.atlassian.net', 'apiToken': 't'}, 'email'),
        ({'siteUrl': 'http://acme.atlassian.net', 'email': 'a', 'apiToken': 't'}, 'siteUrl must'),
        (
            {'siteUrl': 'https://acme.atlassian.net', 'email': 'a', 'apiToken': 't', 'projects': 'A B'},
            'invalid project key',
        ),
    ],
)
def test_missing_or_invalid_config_is_refused(monkeypatch, cfg, match):
    g = _global(monkeypatch, cfg)
    with pytest.raises(ValueError, match=match):
        g._read()


# ---------------------------------------------------------------------------
# reads
# ---------------------------------------------------------------------------


def test_check_connection(api):
    api.queue = [_resp(200, {'accountId': 'acc-1', 'displayName': 'Maya'})]
    out = _node().jira_check_connection({})
    assert out == {
        'success': True,
        'ok': True,
        'account_id': 'acc-1',
        'display_name': 'Maya',
        'site': 'https://acme.atlassian.net',
    }


def test_search_always_sends_fields_wraps_the_allowlist_and_pages(api):
    api.queue = [
        _resp(
            200,
            {
                'issues': [
                    {
                        'key': 'RRT-7',
                        'fields': {
                            'summary': 'Fix it',
                            'status': {'name': 'To Do'},
                            'issuetype': {'name': 'Bug'},
                            'assignee': {'displayName': 'Maya'},
                            'priority': {'name': 'High'},
                            'updated': '2026-11-13T00:00:00.000+0000',
                            'project': {'key': 'RRT'},
                        },
                    }
                ],
                'nextPageToken': 'tok2',
                'isLast': False,
            },
        )
    ]
    out = _node(projects=['RRT'], max_results=10).jira_search({'jql': 'status = "To Do" ORDER BY updated DESC'})
    method, path, kwargs = api.calls[0]
    assert (method, path) == ('POST', '/search/jql')
    assert kwargs['json'] == {
        'jql': 'project in ("RRT") AND (status = "To Do") ORDER BY updated DESC',
        'fields': ii.SEARCH_FIELDS,
        'maxResults': 10,
    }
    assert out['next_page_token'] == 'tok2'
    assert out['issues'] == [
        {
            'key': 'RRT-7',
            'summary': 'Fix it',
            'status': 'To Do',
            'type': 'Bug',
            'assignee': 'Maya',
            'priority': 'High',
            'updated': '2026-11-13T00:00:00.000+0000',
            'url': 'https://acme.atlassian.net/browse/RRT-7',
        }
    ]


def test_search_passes_the_page_token_and_ends_on_the_last_page(api):
    api.queue = [_resp(200, {'issues': [], 'isLast': True, 'nextPageToken': 'stale'})]
    out = _node().jira_search({'jql': 'project = RRT', 'next_page_token': 'tok2', 'max_results': 500})
    assert api.calls[0][2]['json']['nextPageToken'] == 'tok2'
    assert api.calls[0][2]['json']['maxResults'] == 100
    assert out == {'success': True, 'issues': [], 'next_page_token': None}


def test_search_refuses_results_from_outside_the_allowlist(api):
    # a JQL quirk the wrapper missed must not leak another project's issues
    api.queue = [_resp(200, {'issues': [_issue('RRT-1'), _issue('SEC-9', project='SECRET')], 'isLast': True})]
    out = _node(projects=['RRT']).jira_search({'jql': 'summary ~ "x"'})
    assert out['success'] is False and 'outside the project allowlist' in out['error']


def test_search_needs_jql_and_refuses_an_escape_from_the_allowlist(api):
    assert _node().jira_search({})['success'] is False
    out = _node(projects=['RRT']).jira_search({'jql': 'x = 1) OR (project = SECRET'})
    assert out['success'] is False and 'JQL has' in out['error']
    assert api.calls == []


def test_bad_jql_comes_back_as_jiras_message(api):
    api.queue = [_resp(400, {'errorMessages': ["Error in JQL Query: Expecting a value but got '='."]})]
    out = _node().jira_search({'jql': 'status = = Done'})
    assert out['success'] is False and "got '='" in out['error']


def test_issue_get_flattens_description_and_comments(api):
    description = {
        'type': 'doc',
        'version': 1,
        'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': 'Steps'}]}],
    }
    api.queue = [
        _resp(
            200,
            _issue(
                summary='S',
                status={'name': 'Done'},
                issuetype={'name': 'Task'},
                reporter={'displayName': 'Ana'},
                labels=['x'],
                fixVersions=[{'name': '1.0'}],
                description=description,
            ),
        ),
        _resp(200, {'comments': [{'author': {'displayName': 'Ana'}, 'created': 'c1', 'body': description}]}),
    ]
    out = _node(projects=['RRT']).jira_issue_get({'key': 'rrt-1', 'include_comments': True, 'max_comments': 5})
    assert api.calls[0][1] == '/issue/RRT-1' and 'project' in api.calls[0][2]['params']['fields']
    assert api.calls[1][2]['params'] == {'maxResults': 5, 'orderBy': '-created'}
    assert out['description_text'] == 'Steps' and out['fix_versions'] == ['1.0'] and out['reporter'] == 'Ana'
    assert out['comments'] == [{'author': 'Ana', 'created': 'c1', 'body_text': 'Steps'}]


def test_issue_moved_out_of_the_allowlist_is_refused_whatever_its_key_says(api):
    api.queue = [_resp(200, _issue('RRT-1', project='SECRET', summary='moved'))]
    out = _node(projects=['RRT']).jira_issue_get({'key': 'RRT-1'})
    assert out['success'] is False and 'allowlist' in out['error'] and 'moved' not in str(out)


@pytest.mark.parametrize('key', ['RRT-0', 'RRT', '../myself', 'RRT-1/comment', ''])
def test_malformed_keys_never_reach_the_api(api, key):
    out = _node().jira_issue_get({'key': key})
    assert out['success'] is False and 'not an issue key' in out['error']
    assert api.calls == []


def test_unknown_key_is_a_404_result(api):
    api.queue = [_resp(404, {'errorMessages': ['Issue does not exist or you do not have permission to see it.']})]
    out = _node().jira_issue_get({'key': 'RRT-99'})
    assert out['success'] is False and 'not visible to this account' in out['error']


def test_projects_list_pages_and_filters_by_allowlist(api):
    api.queue = [
        _resp(
            200,
            {
                'values': [{'key': 'RRT', 'name': 'Test', 'projectTypeKey': 'software'}, {'key': 'OPS', 'name': 'Ops'}],
                'isLast': False,
            },
        ),
        _resp(200, {'values': [{'key': 'KAN', 'name': 'Board', 'projectTypeKey': 'software'}], 'isLast': True}),
    ]
    out = _node(projects=['RRT', 'KAN']).jira_projects_list({})
    assert [c[2]['params']['startAt'] for c in api.calls] == [0, 2]
    assert out['projects'] == [
        {'key': 'RRT', 'name': 'Test', 'type': 'software'},
        {'key': 'KAN', 'name': 'Board', 'type': 'software'},
    ]


# ---------------------------------------------------------------------------
# writes
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'tool,args',
    [
        ('jira_issue_create', {'project': 'RRT', 'issue_type': 'Task', 'summary': 's'}),
        ('jira_comment_add', {'key': 'RRT-1', 'body': 'hi'}),
    ],
)
def test_writes_are_refused_in_read_only_mode_naming_the_setting(api, tool, args):
    out = getattr(_node(read_only=True), tool)(args)
    assert out['success'] is False and 'tool_jira.readOnly' in out['error']
    assert api.calls == []


def test_create_sends_adf_labels_and_the_created_label(api):
    api.queue = [_resp(201, {'id': '10', 'key': 'RRT-2'})]
    node = _node(read_only=False, projects=['RRT'], created_label='from-rocketride')
    out = node.jira_issue_create(
        {
            'project': 'rrt',
            'issue_type': 'Bug',
            'summary': ' Crash ',
            'description': 'Steps:\n- open\n- click',
            'labels': ['ui'],
            'priority': 'High',
            'assignee_account_id': 'acc-9',
        }
    )
    assert out == {'success': True, 'key': 'RRT-2', 'url': 'https://acme.atlassian.net/browse/RRT-2'}
    fields = api.calls[0][2]['json']['fields']
    assert (
        fields['project'] == {'key': 'RRT'} and fields['issuetype'] == {'name': 'Bug'} and fields['summary'] == 'Crash'
    )
    assert fields['labels'] == ['ui', 'from-rocketride']
    assert fields['priority'] == {'name': 'High'} and fields['assignee'] == {'accountId': 'acc-9'}
    assert [n['type'] for n in fields['description']['content']] == ['paragraph', 'bulletList']


def test_create_outside_the_allowlist_or_without_required_fields_is_refused(api):
    node = _node(read_only=False, projects=['RRT'])
    assert 'allowlist' in node.jira_issue_create({'project': 'OPS', 'issue_type': 'Task', 'summary': 's'})['error']
    assert 'required' in node.jira_issue_create({'project': 'RRT', 'summary': 's'})['error']
    assert api.calls == []


def test_create_refuses_a_description_over_32_kb(api):
    out = _node(read_only=False).jira_issue_create(
        {'project': 'RRT', 'issue_type': 'Task', 'summary': 's', 'description': 'x' * 40000}
    )
    assert out['success'] is False and '32,767 bytes' in out['error'] and api.calls == []


def test_comment_checks_the_issue_project_first_then_posts_adf(api):
    api.queue = [_resp(200, _issue()), _resp(201, {'id': '500'})]
    out = _node(read_only=False, projects=['RRT']).jira_comment_add({'key': 'RRT-1', 'body': 'Done:\n```\nok\n```'})
    assert [c[:2] for c in api.calls] == [('GET', '/issue/RRT-1'), ('POST', '/issue/RRT-1/comment')]
    assert api.calls[1][2]['json']['body']['content'][1]['type'] == 'codeBlock'
    assert out == {
        'success': True,
        'comment_id': '500',
        'url': 'https://acme.atlassian.net/browse/RRT-1?focusedCommentId=500',
    }


def test_comment_on_an_issue_moved_out_of_the_allowlist_is_not_posted(api):
    api.queue = [_resp(200, _issue(project='SECRET'))]
    out = _node(read_only=False, projects=['RRT']).jira_comment_add({'key': 'RRT-1', 'body': 'hi'})
    assert out['success'] is False and len(api.calls) == 1


def test_a_failed_write_is_not_retried(api):
    api.queue = [_resp(200, _issue()), _resp(503)]
    out = _node(read_only=False).jira_comment_add({'key': 'RRT-1', 'body': 'hi'})
    assert out['success'] is False and len(api.calls) == 2


def test_every_tool_has_a_description_and_schemas():
    names = [n for n in dir(ii.IInstance) if n.startswith('jira_')]
    assert sorted(names) == sorted(
        [
            'jira_check_connection',
            'jira_search',
            'jira_issue_get',
            'jira_projects_list',
            'jira_issue_create',
            'jira_comment_add',
        ]
    )
    for name in names:
        meta = getattr(ii.IInstance, name).__tool_meta__
        assert (
            meta['description']
            and meta['input_schema']['type'] == 'object'
            and 'success' in meta['output_schema']['properties']
        )
