# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for tool_linear (no network, no engine runtime).

Engine-only modules (rocketlib, ai.common.*) are stubbed while the node's
submodules load standalone; the stubs are removed afterwards. HTTP is faked
either by standing a fake ``requests`` module in ``sys.modules`` (client
tests) or by replacing ``linear_client.post`` (tool tests).
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import Mock

import pytest
import requests

_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_linear'


def _load_modules():
    """Import tool_linear's submodules standalone, stubbing engine-only deps.

    Stubs are scoped to this import and removed afterward so they never leak
    into sibling tests running under the full engine (where rocketlib/ai.common
    are real and shared across the pytest session).
    """
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

    def normalize_tool_input(value, **kwargs):
        return value if isinstance(value, dict) else {}

    ai_utils.normalize_tool_input = normalize_tool_input
    sys.modules['ai.common.utils'] = ai_utils

    # The `from . import ...` / `from .X import Y` statements inside IGlobal.py
    # and IInstance.py resolve their references at exec time, so the returned
    # module objects stay fully usable for the rest of this file even after
    # sys.modules is cleaned up below -- nothing here re-resolves through the
    # cache later.
    submodule_names = ('tool_linear.linear_client', 'tool_linear.IGlobal', 'tool_linear.IInstance')
    pkg = types.ModuleType('tool_linear')
    pkg.__path__ = [str(_DIR)]
    sys.modules['tool_linear'] = pkg
    try:
        for name in ('linear_client', 'IGlobal', 'IInstance'):
            spec = importlib.util.spec_from_file_location(f'tool_linear.{name}', _DIR / f'{name}.py')
            module = importlib.util.module_from_spec(spec)
            sys.modules[f'tool_linear.{name}'] = module
            spec.loader.exec_module(module)
        return (
            sys.modules['tool_linear.linear_client'],
            sys.modules['tool_linear.IGlobal'],
            sys.modules['tool_linear.IInstance'],
        )
    finally:
        sys.modules.pop('tool_linear', None)
        for name in submodule_names:
            sys.modules.pop(name, None)
        for name, mod in _saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


_lc, _ig, _ii = _load_modules()


def _resp(status=200, *, json_data=None, headers=None):
    resp = Mock(spec=requests.Response)
    resp.status_code = status
    resp.ok = 200 <= status < 300
    resp.headers = headers or {}
    if json_data is None:
        resp.json.side_effect = ValueError('no json')
    else:
        resp.json.return_value = json_data
    return resp


@pytest.fixture
def mock_requests(monkeypatch):
    fake = Mock()
    fake.exceptions = requests.exceptions
    monkeypatch.setitem(sys.modules, 'requests', fake)
    monkeypatch.setattr(_lc.time, 'sleep', lambda s: None)
    return fake


# ---------------------------------------------------------------------------
# linear_client.post
# ---------------------------------------------------------------------------


class TestPost:
    def test_sends_raw_key_without_bearer(self, mock_requests):
        mock_requests.post.return_value = _resp(200, json_data={'data': {'viewer': {'id': '1'}}})
        out = _lc.post('query { viewer { id } }', api_key='lin_api_x')
        assert out == {'viewer': {'id': '1'}}
        call = mock_requests.post.call_args
        assert call.args[0] == 'https://api.linear.app/graphql'
        assert call.kwargs['headers']['Authorization'] == 'lin_api_x'

    def test_401_names_the_api_key(self, mock_requests):
        mock_requests.post.return_value = _resp(401, json_data={'errors': [{'message': 'nope'}]})
        with pytest.raises(_lc.LinearAPIError, match='apiKey'):
            _lc.post('q', api_key='k')

    def test_graphql_errors_use_first_message(self, mock_requests):
        mock_requests.post.return_value = _resp(200, json_data={'errors': [{'message': 'bad field'}, {'message': 'x'}]})
        with pytest.raises(_lc.LinearAPIError, match='bad field'):
            _lc.post('q', api_key='k')

    def test_ratelimited_http_400_reports_reset_time(self, mock_requests):
        body = {'errors': [{'message': 'Rate limit exceeded', 'extensions': {'code': 'RATELIMITED'}}]}
        mock_requests.post.return_value = _resp(
            400, json_data=body, headers={'X-RateLimit-Requests-Reset': '1700000000000'}
        )
        with pytest.raises(_lc.LinearAPIError) as ei:
            _lc.post('q', api_key='k')
        assert ei.value.code == 'RATELIMITED'
        assert ei.value.reset_at == '2023-11-14T22:13:20Z'
        assert '2023-11-14T22:13:20Z' in str(ei.value)

    def test_ratelimited_without_reset_header_still_errors(self, mock_requests):
        body = {'errors': [{'message': 'slow down', 'extensions': {'code': 'RATELIMITED'}}]}
        mock_requests.post.return_value = _resp(400, json_data=body)
        with pytest.raises(_lc.LinearAPIError) as ei:
            _lc.post('q', api_key='k')
        assert ei.value.reset_at is None

    def test_reads_retry_on_5xx_then_succeed(self, mock_requests):
        mock_requests.post.side_effect = [_resp(502, json_data={}), _resp(200, json_data={'data': {'a': 1}})]
        assert _lc.post('q', api_key='k') == {'a': 1}
        assert mock_requests.post.call_count == 2

    def test_reads_retry_on_connection_error(self, mock_requests):
        mock_requests.post.side_effect = [
            requests.exceptions.ConnectionError('x'),
            _resp(200, json_data={'data': {'a': 1}}),
        ]
        assert _lc.post('q', api_key='k') == {'a': 1}

    def test_connection_error_exhausts_retries(self, mock_requests):
        mock_requests.post.side_effect = requests.exceptions.ConnectionError('down')
        with pytest.raises(_lc.LinearAPIError, match='connection error'):
            _lc.post('q', api_key='k')
        assert mock_requests.post.call_count == 3

    def test_writes_never_retry(self, mock_requests):
        mock_requests.post.return_value = _resp(502, json_data={})
        with pytest.raises(_lc.LinearAPIError):
            _lc.post('mutation', api_key='k', retry=False)
        assert mock_requests.post.call_count == 1

    def test_write_connection_error_not_retried(self, mock_requests):
        mock_requests.post.side_effect = requests.exceptions.Timeout('t')
        with pytest.raises(_lc.LinearAPIError):
            _lc.post('mutation', api_key='k', retry=False)
        assert mock_requests.post.call_count == 1

    def test_non_json_success_is_an_error(self, mock_requests):
        mock_requests.post.return_value = _resp(200)
        with pytest.raises(_lc.LinearAPIError, match='JSON'):
            _lc.post('q', api_key='k')

    def test_non_json_failure_reports_status(self, mock_requests):
        mock_requests.post.return_value = _resp(403)
        with pytest.raises(_lc.LinearAPIError, match='403'):
            _lc.post('q', api_key='k')

    def test_missing_data_is_an_error(self, mock_requests):
        mock_requests.post.return_value = _resp(200, json_data={})
        with pytest.raises(_lc.LinearAPIError, match='no data'):
            _lc.post('q', api_key='k')

    def test_low_remaining_sleeps_until_reset_bounded(self, mock_requests, monkeypatch):
        slept = []
        monkeypatch.setattr(_lc.time, 'sleep', slept.append)
        monkeypatch.setattr(_lc.time, 'time', lambda: 1000.0)
        headers = {'X-RateLimit-Requests-Remaining': '10', 'X-RateLimit-Requests-Reset': str(1_000_000 * 1000)}
        mock_requests.post.return_value = _resp(200, json_data={'data': {'a': 1}}, headers=headers)
        _lc.post('q', api_key='k')
        assert slept == [_lc.MAX_BACKOFF_SECONDS]

    def test_healthy_remaining_does_not_sleep(self, mock_requests, monkeypatch):
        slept = []
        monkeypatch.setattr(_lc.time, 'sleep', slept.append)
        headers = {'X-RateLimit-Requests-Remaining': '2000', 'X-RateLimit-Requests-Reset': '1'}
        mock_requests.post.return_value = _resp(200, json_data={'data': {'a': 1}}, headers=headers)
        _lc.post('q', api_key='k')
        assert slept == []


# ---------------------------------------------------------------------------
# linear_client helpers
# ---------------------------------------------------------------------------


class TestHelpers:
    @pytest.mark.parametrize(
        'raw,expected', [('ENG-123', ('ENG', 123)), ('eng-7', ('ENG', 7)), ('MY-TEAM-9', ('MY-TEAM', 9))]
    )
    def test_parse_identifier(self, raw, expected):
        assert _lc.parse_identifier(raw) == expected

    @pytest.mark.parametrize('raw', ['', 'ENG', 'ENG-', '-12', 'ENG-x', None, 5])
    def test_parse_identifier_rejects(self, raw):
        assert _lc.parse_identifier(raw) is None

    @pytest.mark.parametrize(
        'value,default,expected',
        [(5, 25, 5), (0, 25, 1), (500, 25, 100), (None, 25, 25), ('9', 25, 25), (True, 25, 25), (None, 500, 100)],
    )
    def test_clamp_first(self, value, default, expected):
        assert _lc.clamp_first(value, default) == expected

    def test_team_allowed(self):
        assert _lc.team_allowed('ENG', [])
        assert _lc.team_allowed('eng', ['ENG'])
        assert not _lc.team_allowed('OPS', ['ENG'])
        assert not _lc.team_allowed(None, ['ENG'])

    def test_filter_without_allowlist_is_empty(self):
        assert _lc.build_issue_filter(allowed_teams=[]) == {}

    def test_filter_with_allowlist_uses_in(self):
        flt = _lc.build_issue_filter(allowed_teams=['ENG', 'OPS'])
        assert flt == {'team': {'key': {'in': ['ENG', 'OPS']}}}

    def test_filter_team_key_overrides_in_but_stays_inside_allowlist(self):
        flt = _lc.build_issue_filter(allowed_teams=['ENG', 'OPS'], team_key='ops')
        assert flt['team'] == {'key': {'eq': 'OPS'}}

    def test_filter_team_outside_allowlist_raises(self):
        with pytest.raises(_lc.LinearAPIError, match='allowlist'):
            _lc.build_issue_filter(allowed_teams=['ENG'], team_key='SEC')

    def test_filter_all_fields(self):
        flt = _lc.build_issue_filter(allowed_teams=[], team_key='ENG', state='Todo', assignee='Ana', text='crash')
        assert flt == {
            'team': {'key': {'eq': 'ENG'}},
            'state': {'name': {'eqIgnoreCase': 'Todo'}},
            'assignee': {'name': {'containsIgnoreCase': 'Ana'}},
            'title': {'containsIgnoreCase': 'crash'},
        }

    def test_filter_assignee_me(self):
        assert _lc.build_issue_filter(allowed_teams=[], assignee='Me')['assignee'] == {'isMe': {'eq': True}}

    def test_shape_issue_handles_nulls(self):
        out = _lc.shape_issue({'identifier': 'ENG-1', 'state': None, 'assignee': None})
        assert out['identifier'] == 'ENG-1' and out['state'] is None and out['assignee'] is None

    def test_check_text_rejects_over_32kb(self):
        with pytest.raises(_lc.LinearAPIError, match='32 KB'):
            _lc.check_text('body', 'x' * (32 * 1024 + 1))
        assert _lc.check_text('body', 'x' * 100) == 'x' * 100

    @pytest.mark.parametrize('payload', [None, {}, {'success': False}])
    def test_ensure_success_rejects(self, payload):
        with pytest.raises(_lc.LinearAPIError):
            _lc.ensure_success(payload, 'thing')

    def test_ensure_success_passes_through(self):
        assert _lc.ensure_success({'success': True, 'x': 1}, 'thing')['x'] == 1


# ---------------------------------------------------------------------------
# IGlobal config parsing
# ---------------------------------------------------------------------------


class TestConfigParsing:
    def test_parse_teams(self):
        assert _ig.parse_teams(' eng, ops ,, ') == ['ENG', 'OPS']
        assert _ig.parse_teams('') == []
        assert _ig.parse_teams(None) == []

    @pytest.mark.parametrize('value,expected', [(25, 25), (0, 1), (999, 100), ('7', 7), ('x', 25), (None, 25)])
    def test_clamp_max_results(self, value, expected):
        assert _ig.clamp_max_results(value) == expected

    @pytest.mark.parametrize(
        'value,expected',
        [
            (None, True),
            ('', True),
            (True, True),
            (False, False),
            ('false', False),
            ('False', False),
            ('true', True),
            ('0', False),
        ],
    )
    def test_to_bool(self, value, expected):
        assert _ig.to_bool(value, True) is expected


# ---------------------------------------------------------------------------
# IInstance tools
# ---------------------------------------------------------------------------


class FakeLinear:
    """Scripted ``post``: routes by document, records calls."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, query, variables=None, *, api_key, retry=True, **kw):
        self.calls.append((query, variables, retry))
        handler = self.routes.get(query)
        if handler is None:
            raise AssertionError(f'unexpected query: {query[:60]}')
        out = handler(variables) if callable(handler) else handler
        if isinstance(out, Exception):
            raise out
        return out

    def writes(self):
        return [c for c in self.calls if c[0].startswith('mutation')]


def _instance(monkeypatch, routes, *, read_only=True, teams=(), max_results=25):
    inst = _ii.IInstance.__new__(_ii.IInstance)
    glob = Mock()
    glob.apikey = 'k'
    glob.read_only = read_only
    glob.teams = list(teams)
    glob.max_results = max_results
    inst.IGlobal = glob
    fake = FakeLinear(routes)
    monkeypatch.setattr(_ii.lc, 'post', fake)
    return inst, fake


def _issue(identifier='ENG-1', team='ENG', **extra):
    return {
        'id': 'uuid-' + identifier,
        'identifier': identifier,
        'title': 'T',
        'state': {'name': 'Todo', 'type': 'unstarted'},
        'assignee': {'name': 'Ana'},
        'priorityLabel': 'High',
        'updatedAt': '2026-01-01T00:00:00Z',
        'url': 'https://linear.app/x/issue/' + identifier,
        'team': {'key': team},
        **extra,
    }


TEAM_ENG = {'teams': {'nodes': [{'id': 'team-eng', 'key': 'ENG', 'name': 'Engineering'}]}}
STATE_DONE = {'workflowStates': {'nodes': [{'id': 'st-done', 'name': 'Done', 'type': 'completed'}]}}


class TestChecks:
    def test_check_connection(self, monkeypatch):
        inst, _ = _instance(monkeypatch, {_lc.Q_VIEWER: {'viewer': {'id': 'u', 'name': 'Ana'}}})
        assert inst.linear_check_connection({}) == {'success': True, 'ok': True, 'user': {'id': 'u', 'name': 'Ana'}}

    def test_check_connection_error_is_enveloped(self, monkeypatch):
        inst, _ = _instance(monkeypatch, {_lc.Q_VIEWER: _lc.LinearAPIError('bad key')})
        assert inst.linear_check_connection({}) == {'success': False, 'error': 'bad key'}

    def test_teams_list_filters_by_allowlist(self, monkeypatch):
        teams = {'teams': {'nodes': [{'id': '1', 'key': 'ENG', 'name': 'E'}, {'id': '2', 'key': 'OPS', 'name': 'O'}]}}
        inst, _ = _instance(monkeypatch, {_lc.Q_TEAMS: teams}, teams=['OPS'])
        out = inst.linear_teams_list({})
        assert [t['key'] for t in out['teams']] == ['OPS']

    def test_teams_list_all_without_allowlist(self, monkeypatch):
        teams = {'teams': {'nodes': [{'id': '1', 'key': 'ENG', 'name': 'E'}, {'id': '2', 'key': 'OPS', 'name': 'O'}]}}
        inst, _ = _instance(monkeypatch, {_lc.Q_TEAMS: teams})
        assert len(inst.linear_teams_list({})['teams']) == 2


class TestSearch:
    def _conn(self, nodes, has_next=False, cursor=None):
        return {'issues': {'nodes': nodes, 'pageInfo': {'hasNextPage': has_next, 'endCursor': cursor}}}

    def test_search_shapes_results_and_paging(self, monkeypatch):
        inst, fake = _instance(monkeypatch, {_lc.Q_ISSUES: self._conn([_issue()], True, 'cur1')})
        out = inst.linear_issues_search({'text': 'x'})
        assert out['success'] and out['has_next_page'] is True and out['end_cursor'] == 'cur1'
        assert out['issues'][0]['identifier'] == 'ENG-1' and out['issues'][0]['priority_label'] == 'High'
        assert fake.calls[0][1]['first'] == 25

    def test_search_pages_past_50_with_after(self, monkeypatch):
        pages = {
            None: self._conn([_issue(f'ENG-{i}') for i in range(100)], True, 'c100'),
            'c100': self._conn([_issue('ENG-101')], False, None),
        }
        inst, fake = _instance(monkeypatch, {_lc.Q_ISSUES: lambda v: pages[v['after']]})
        first = inst.linear_issues_search({'first': 100})
        second = inst.linear_issues_search({'first': 100, 'after': first['end_cursor']})
        assert len(first['issues']) == 100 and first['has_next_page']
        assert second['issues'][0]['identifier'] == 'ENG-101' and not second['has_next_page']

    def test_first_is_capped_at_100(self, monkeypatch):
        inst, fake = _instance(monkeypatch, {_lc.Q_ISSUES: self._conn([])})
        inst.linear_issues_search({'first': 5000})
        assert fake.calls[0][1]['first'] == 100

    def test_default_page_size_comes_from_config(self, monkeypatch):
        inst, fake = _instance(monkeypatch, {_lc.Q_ISSUES: self._conn([])}, max_results=7)
        inst.linear_issues_search({})
        assert fake.calls[0][1]['first'] == 7

    def test_allowlist_is_in_every_filter(self, monkeypatch):
        inst, fake = _instance(monkeypatch, {_lc.Q_ISSUES: self._conn([])}, teams=['ENG'])
        inst.linear_issues_search({})
        assert fake.calls[0][1]['filter']['team'] == {'key': {'in': ['ENG']}}

    def test_search_other_team_is_refused_before_any_request(self, monkeypatch):
        inst, fake = _instance(monkeypatch, {}, teams=['ENG'])
        out = inst.linear_issues_search({'team_key': 'SEC'})
        assert out['success'] is False and 'allowlist' in out['error']
        assert fake.calls == []

    def test_search_ratelimited_returns_envelope_not_exception(self, monkeypatch):
        err = _lc.LinearAPIError('Linear rate limit reached (resets at 2026-01-01T00:00:00Z)', code='RATELIMITED')
        inst, _ = _instance(monkeypatch, {_lc.Q_ISSUES: err})
        out = inst.linear_issues_search({})
        assert out['success'] is False and '2026-01-01T00:00:00Z' in out['error']


class TestIssueGet:
    def test_get_by_identifier_resolves_through_filter(self, monkeypatch):
        issue = _issue(
            description='body',
            comments={'nodes': [{'id': 'c1', 'body': 'hi', 'createdAt': 't', 'user': {'name': 'Bo'}}]},
        )
        inst, fake = _instance(monkeypatch, {_lc.Q_ISSUE_BY_IDENTIFIER: {'issues': {'nodes': [issue]}}})
        out = inst.linear_issue_get({'identifier': 'eng-1'})
        assert out['issue']['description'] == 'body'
        assert out['issue']['comments'] == [{'id': 'c1', 'body': 'hi', 'author': 'Bo', 'created_at': 't'}]
        assert fake.calls[0][1]['filter'] == {'team': {'key': {'eq': 'ENG'}}, 'number': {'eq': 1}}

    def test_get_by_id(self, monkeypatch):
        inst, _ = _instance(monkeypatch, {_lc.Q_ISSUE_BY_ID: {'issue': _issue()}})
        assert inst.linear_issue_get({'id': 'abc'})['issue']['identifier'] == 'ENG-1'

    def test_max_comments_is_clamped(self, monkeypatch):
        inst, fake = _instance(monkeypatch, {_lc.Q_ISSUE_BY_ID: {'issue': _issue()}})
        inst.linear_issue_get({'id': 'a', 'max_comments': 999})
        assert fake.calls[0][1]['comments'] == 50

    def test_get_requires_identifier_or_id(self, monkeypatch):
        inst, _ = _instance(monkeypatch, {})
        assert inst.linear_issue_get({})['success'] is False

    def test_get_rejects_malformed_identifier(self, monkeypatch):
        inst, _ = _instance(monkeypatch, {})
        assert 'ENG-123' in inst.linear_issue_get({'identifier': 'nonsense'})['error']

    def test_get_not_found(self, monkeypatch):
        inst, _ = _instance(monkeypatch, {_lc.Q_ISSUE_BY_IDENTIFIER: {'issues': {'nodes': []}}})
        assert inst.linear_issue_get({'identifier': 'ENG-9'})['error'] == 'Issue not found'

    def test_other_team_identifier_is_refused_without_a_request(self, monkeypatch):
        inst, fake = _instance(monkeypatch, {}, teams=['ENG'])
        out = inst.linear_issue_get({'identifier': 'SEC-1'})
        assert out['success'] is False and fake.calls == []

    def test_other_team_by_id_is_refused_after_fetch(self, monkeypatch):
        inst, _ = _instance(monkeypatch, {_lc.Q_ISSUE_BY_ID: {'issue': _issue('SEC-1', 'SEC')}}, teams=['ENG'])
        out = inst.linear_issue_get({'id': 'x'})
        assert out['success'] is False and 'outside' in out['error']


class TestStates:
    def test_states_list_resolves_team_then_states(self, monkeypatch):
        states = {'workflowStates': {'nodes': [{'id': 's1', 'name': 'Todo', 'type': 'unstarted'}]}}
        inst, fake = _instance(monkeypatch, {_lc.Q_TEAM_BY_KEY: TEAM_ENG, _lc.Q_STATES: states})
        out = inst.linear_states_list({'team_key': 'eng'})
        assert out['states'] == [{'id': 's1', 'name': 'Todo', 'type': 'unstarted'}]
        assert fake.calls[1][1]['filter'] == {'team': {'id': {'eq': 'team-eng'}}}

    def test_states_unknown_team(self, monkeypatch):
        inst, _ = _instance(monkeypatch, {_lc.Q_TEAM_BY_KEY: {'teams': {'nodes': []}}})
        assert 'not found' in inst.linear_states_list({'team_key': 'ZZZ'})['error']

    def test_states_requires_team_key(self, monkeypatch):
        inst, _ = _instance(monkeypatch, {})
        assert inst.linear_states_list({})['success'] is False

    def test_states_team_outside_allowlist(self, monkeypatch):
        inst, fake = _instance(monkeypatch, {}, teams=['OPS'])
        assert inst.linear_states_list({'team_key': 'ENG'})['success'] is False and fake.calls == []


class TestReadOnly:
    @pytest.mark.parametrize(
        'tool,args',
        [
            ('linear_issue_create', {'team_key': 'ENG', 'title': 't'}),
            ('linear_comment_add', {'identifier': 'ENG-1', 'body': 'hi'}),
            ('linear_issue_update', {'identifier': 'ENG-1', 'title': 'n'}),
        ],
    )
    def test_writes_refuse_by_default_and_name_the_field(self, monkeypatch, tool, args):
        inst, fake = _instance(monkeypatch, {}, read_only=True)
        out = getattr(inst, tool)(args)
        assert out['success'] is False and 'readOnly' in out['error']
        assert fake.calls == []


class TestCreate:
    def _routes(self, created=None):
        payload = created or {'issueCreate': {'success': True, 'issue': {'id': 'i', 'identifier': 'ENG-5', 'url': 'u'}}}
        return {_lc.Q_TEAM_BY_KEY: TEAM_ENG, _lc.Q_STATES: STATE_DONE, _lc.M_ISSUE_CREATE: payload}

    def test_create_full_input(self, monkeypatch):
        inst, fake = _instance(monkeypatch, self._routes(), read_only=False)
        out = inst.linear_issue_create(
            {
                'team_key': 'eng',
                'title': ' Bug ',
                'description': 'md',
                'priority': 1,
                'state': 'Done',
                'assignee_id': 'a',
                'label_ids': ['l1'],
            }
        )
        assert out == {'success': True, 'identifier': 'ENG-5', 'url': 'u'}
        inp = fake.writes()[0][1]['input']
        assert inp == {
            'teamId': 'team-eng',
            'title': 'Bug',
            'description': 'md',
            'priority': 1,
            'stateId': 'st-done',
            'assigneeId': 'a',
            'labelIds': ['l1'],
        }

    def test_create_write_is_not_retried(self, monkeypatch):
        inst, fake = _instance(monkeypatch, self._routes(), read_only=False)
        inst.linear_issue_create({'team_key': 'ENG', 'title': 't'})
        assert fake.writes()[0][2] is False

    def test_create_requires_title(self, monkeypatch):
        inst, _ = _instance(monkeypatch, self._routes(), read_only=False)
        assert inst.linear_issue_create({'team_key': 'ENG', 'title': '  '})['success'] is False

    @pytest.mark.parametrize('bad', [5, -1, 'high', True, 2.5])
    def test_create_rejects_bad_priority(self, monkeypatch, bad):
        inst, fake = _instance(monkeypatch, self._routes(), read_only=False)
        assert inst.linear_issue_create({'team_key': 'ENG', 'title': 't', 'priority': bad})['success'] is False
        assert fake.writes() == []

    def test_create_priority_zero_is_sent(self, monkeypatch):
        inst, fake = _instance(monkeypatch, self._routes(), read_only=False)
        inst.linear_issue_create({'team_key': 'ENG', 'title': 't', 'priority': 0})
        assert fake.writes()[0][1]['input']['priority'] == 0

    def test_create_unknown_state(self, monkeypatch):
        routes = self._routes()
        routes[_lc.Q_STATES] = {'workflowStates': {'nodes': []}}
        inst, fake = _instance(monkeypatch, routes, read_only=False)
        out = inst.linear_issue_create({'team_key': 'ENG', 'title': 't', 'state': 'Nope'})
        assert 'Nope' in out['error'] and fake.writes() == []

    def test_create_team_outside_allowlist(self, monkeypatch):
        inst, fake = _instance(monkeypatch, self._routes(), read_only=False, teams=['OPS'])
        assert inst.linear_issue_create({'team_key': 'ENG', 'title': 't'})['success'] is False
        assert fake.calls == []

    def test_create_success_false_payload_is_an_error(self, monkeypatch):
        inst, _ = _instance(monkeypatch, self._routes({'issueCreate': {'success': False}}), read_only=False)
        assert inst.linear_issue_create({'team_key': 'ENG', 'title': 't'})['success'] is False

    def test_create_oversized_description_refused(self, monkeypatch):
        inst, fake = _instance(monkeypatch, self._routes(), read_only=False)
        out = inst.linear_issue_create({'team_key': 'ENG', 'title': 't', 'description': 'x' * 40000})
        assert '32 KB' in out['error'] and fake.writes() == []


class TestComment:
    def _routes(self, issue=None, result=None):
        return {
            _lc.Q_ISSUE_BY_IDENTIFIER: {'issues': {'nodes': [issue or _issue()]}},
            _lc.M_COMMENT_CREATE: result or {'commentCreate': {'success': True, 'comment': {'id': 'c', 'url': 'cu'}}},
        }

    def test_comment_add(self, monkeypatch):
        inst, fake = _instance(monkeypatch, self._routes(), read_only=False)
        out = inst.linear_comment_add({'identifier': 'ENG-1', 'body': ' hi '})
        assert out == {'success': True, 'comment_id': 'c', 'url': 'cu'}
        assert fake.writes()[0][1]['input'] == {'issueId': 'uuid-ENG-1', 'body': 'hi'}
        assert fake.writes()[0][2] is False

    def test_comment_requires_body(self, monkeypatch):
        inst, _ = _instance(monkeypatch, self._routes(), read_only=False)
        assert inst.linear_comment_add({'identifier': 'ENG-1', 'body': ''})['success'] is False

    def test_comment_on_other_team_refused(self, monkeypatch):
        inst, fake = _instance(monkeypatch, self._routes(), read_only=False, teams=['OPS'])
        assert inst.linear_comment_add({'identifier': 'ENG-1', 'body': 'hi'})['success'] is False
        assert fake.writes() == []

    def test_comment_success_false(self, monkeypatch):
        inst, _ = _instance(monkeypatch, self._routes(result={'commentCreate': {'success': False}}), read_only=False)
        assert inst.linear_comment_add({'identifier': 'ENG-1', 'body': 'hi'})['success'] is False


class TestUpdate:
    def _routes(self):
        return {
            _lc.Q_ISSUE_BY_IDENTIFIER: {'issues': {'nodes': [_issue()]}},
            _lc.Q_TEAM_BY_KEY: TEAM_ENG,
            _lc.Q_STATES: STATE_DONE,
            _lc.M_ISSUE_UPDATE: {
                'issueUpdate': {'success': True, 'issue': {'id': 'i', 'identifier': 'ENG-1', 'url': 'u'}}
            },
        }

    def test_update_fields_and_state_resolution(self, monkeypatch):
        inst, fake = _instance(monkeypatch, self._routes(), read_only=False)
        out = inst.linear_issue_update({'identifier': 'ENG-1', 'title': 'n', 'state': 'Done', 'priority': 2})
        assert out['success'] and out['identifier'] == 'ENG-1'
        assert out['updated_fields'] == ['priority', 'state', 'title']
        write = fake.writes()[0]
        assert write[1]['id'] == 'uuid-ENG-1'
        assert write[1]['input'] == {'title': 'n', 'priority': 2, 'stateId': 'st-done'}

    def test_update_needs_a_field(self, monkeypatch):
        inst, fake = _instance(monkeypatch, self._routes(), read_only=False)
        assert 'at least one' in inst.linear_issue_update({'identifier': 'ENG-1'})['error']
        assert fake.writes() == []

    def test_update_other_team_refused(self, monkeypatch):
        inst, fake = _instance(monkeypatch, self._routes(), read_only=False, teams=['OPS'])
        assert inst.linear_issue_update({'identifier': 'ENG-1', 'title': 'n'})['success'] is False
        assert fake.writes() == []

    def test_update_failure_payload(self, monkeypatch):
        routes = self._routes()
        routes[_lc.M_ISSUE_UPDATE] = {'issueUpdate': {'success': False}}
        inst, _ = _instance(monkeypatch, routes, read_only=False)
        assert inst.linear_issue_update({'identifier': 'ENG-1', 'title': 'n'})['success'] is False


# ---------------------------------------------------------------------------
# Metadata
# ---------------------------------------------------------------------------


def test_every_tool_is_registered_with_a_schema():
    names = [n for n in dir(_ii.IInstance) if n.startswith('linear_')]
    assert sorted(names) == [
        'linear_check_connection',
        'linear_comment_add',
        'linear_issue_create',
        'linear_issue_get',
        'linear_issue_update',
        'linear_issues_search',
        'linear_states_list',
        'linear_teams_list',
    ]
    for n in names:
        meta = getattr(_ii.IInstance, n).__tool_meta__
        assert meta['input_schema']['type'] == 'object' and meta['description']
