import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch, Mock

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes'))

_STUB_MODULE_NAMES = ('rocketlib', 'ai', 'ai.common', 'ai.common.config', 'ai.common.utils')


def _install_stubs() -> None:
    mod_rl = types.ModuleType('rocketlib')

    def mock_tool_function(*args, **kwargs):
        return lambda f: f

    mod_rl.tool_function = mock_tool_function

    class IInstanceBase:
        pass

    class IGlobalBase:
        pass

    mod_rl.IInstanceBase = IInstanceBase
    mod_rl.IGlobalBase = IGlobalBase
    mod_rl.OPEN_MODE = Mock()
    mod_rl.warning = Mock()
    sys.modules['rocketlib'] = mod_rl

    sys.modules['ai'] = types.ModuleType('ai')
    sys.modules['ai.common'] = types.ModuleType('ai.common')

    mod_ai_common_config = types.ModuleType('ai.common.config')

    class Config:
        pass

    mod_ai_common_config.Config = Config
    sys.modules['ai.common.config'] = mod_ai_common_config

    mod_ai_common_utils = types.ModuleType('ai.common.utils')
    mod_ai_common_utils.normalize_tool_input = lambda x, **kwargs: x
    mod_ai_common_utils.require_str = lambda x, k, **kwargs: x.get(k)
    mod_ai_common_utils.require_int = lambda x, k, **kwargs: x.get(k)
    sys.modules['ai.common.utils'] = mod_ai_common_utils


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    original_modules = {module_name: sys.modules.get(module_name) for module_name in _STUB_MODULE_NAMES}
    _install_stubs()
    try:
        yield
    finally:
        for module_name, module in original_modules.items():
            if module is None:
                sys.modules.pop(module_name, None)
            else:
                sys.modules[module_name] = module


with _scoped_stubs():
    from tool_github.github_client import call
    from tool_github.IInstance import (
        IInstance,
        _MAX_DIFF_CHARS,
        _extract_ticket_ids,
        _match_reasons,
    )


def test_extract_ticket_ids_bare_and_keywords():
    ids = _extract_ticket_ids(
        'feat: wire PR context (#1852)',
        'Fixes #1000\nCloses #1852\nRefs #999\nAlso see #42.',
    )
    assert ids == [1852, 1000, 999, 42]


def test_match_reasons_tickets_and_basenames():
    reasons = _match_reasons(
        'Related to #1852 and touches github_client.py',
        ticket_ids=[1852, 42],
        basenames={'github_client.py', 'missing.py'},
    )
    assert 'ticket:#1852' in reasons
    assert 'ticket:#42' not in reasons
    assert 'file:github_client.py' in reasons
    assert 'file:missing.py' not in reasons


@patch('tool_github.github_client.requests.request')
def test_call_accept_and_raw_text(mock_request):
    resp = Mock(spec=requests.Response)
    resp.ok = True
    resp.status_code = 200
    resp.text = 'diff --git a/foo b/foo\n'
    resp.json.side_effect = AssertionError('json() should not be called when raw=True')

    mock_request.return_value = resp

    result = call(
        'token',
        'GET',
        '/repos/acme/app/pulls/1',
        accept='application/vnd.github.v3.diff',
        raw=True,
    )

    assert result == 'diff --git a/foo b/foo\n'
    headers = mock_request.call_args.kwargs['headers']
    assert headers['Accept'] == 'application/vnd.github.v3.diff'


def test_pr_review_context_assembles_diff_files_and_related():
    inst = Mock()
    inst._token.return_value = 'token'
    inst._repo.return_value = 'acme/app'

    pr_payload = {
        'number': 10,
        'title': 'Add review context (Fixes #1852)',
        'body': 'Closes #1852 and touches tool_github.',
        'state': 'open',
        'merged': False,
        'draft': False,
        'head': {'ref': 'feat/x', 'sha': 'abc'},
        'base': {'ref': 'develop', 'sha': 'def'},
        'user': {'login': 'alice'},
        'created_at': '2026-01-01T00:00:00Z',
        'updated_at': '2026-01-02T00:00:00Z',
        'merged_at': None,
        'html_url': 'https://github.com/acme/app/pull/10',
        'commits': 1,
        'additions': 5,
        'deletions': 1,
        'changed_files': 1,
    }
    files_payload = [
        {
            'filename': 'nodes/src/nodes/tool_github/IInstance.py',
            'status': 'modified',
            'additions': 5,
            'deletions': 1,
            'changes': 6,
        }
    ]
    open_prs = [
        pr_payload,
        {
            'number': 11,
            'title': 'Also mentions IInstance.py',
            'body': 'overlap on basename',
            'state': 'open',
            'html_url': 'https://github.com/acme/app/pull/11',
            'head': {},
            'base': {},
            'user': {},
        },
        {
            'number': 12,
            'title': 'Unrelated PR',
            'body': 'no overlap',
            'state': 'open',
            'html_url': 'https://github.com/acme/app/pull/12',
            'head': {},
            'base': {},
            'user': {},
        },
    ]
    open_issues = [
        {
            'number': 1852,
            'title': 'PR review context preset',
            'body': 'feature request',
            'state': 'open',
            'html_url': 'https://github.com/acme/app/issues/1852',
        },
        {
            'number': 99,
            'title': 'Mentions IInstance.py in passing',
            'body': '',
            'state': 'open',
            'html_url': 'https://github.com/acme/app/issues/99',
        },
        {
            'number': 10,
            'title': 'This is actually a PR in issues list',
            'body': '',
            'state': 'open',
            'html_url': 'https://github.com/acme/app/pull/10',
            'pull_request': {'url': 'https://api.github.com/repos/acme/app/pulls/10'},
        },
    ]
    diff_text = 'diff --git a/IInstance.py b/IInstance.py\n+new line\n'

    def _side_effect(token, method, path, *, params=None, body=None, accept=None, raw=False):
        if path.endswith('/pulls/10') and raw:
            return diff_text
        if path.endswith('/pulls/10/files'):
            return files_payload
        if path.endswith('/pulls/10'):
            return pr_payload
        if path.endswith('/pulls'):
            return open_prs
        if path.endswith('/issues'):
            return open_issues
        raise AssertionError(f'unexpected call: {method} {path} raw={raw} accept={accept}')

    with patch('tool_github.IInstance.call', side_effect=_side_effect) as mocked:
        result = IInstance.pr_review_context(inst, {'pr_number': 10})

    assert result['pr']['number'] == 10
    assert result['pr']['title'].startswith('Add review context')
    assert result['files'] == [
        {
            'filename': 'nodes/src/nodes/tool_github/IInstance.py',
            'status': 'modified',
            'additions': 5,
            'deletions': 1,
            'changes': 6,
        }
    ]
    assert result['diff'] == diff_text
    assert result['diff_truncated'] is False
    assert result['ticket_ids'] == [1852]

    related_pr_nums = {p['number'] for p in result['related']['prs']}
    assert related_pr_nums == {11}
    assert 'file:IInstance.py' in result['related']['prs'][0]['reasons']

    related_issue_nums = {i['number'] for i in result['related']['issues']}
    assert related_issue_nums == {1852, 99}
    assert any(i['number'] == 1852 and 'ticket:#1852' in i['reasons'] for i in result['related']['issues'])

    # Diff request must use Accept override + raw text.
    assert any(
        c.kwargs.get('raw') is True and c.kwargs.get('accept') == 'application/vnd.github.v3.diff'
        for c in mocked.call_args_list
    )


def test_pr_review_context_truncates_large_diff():
    inst = Mock()
    inst._token.return_value = 'token'
    inst._repo.return_value = 'acme/app'

    huge = 'x' * (_MAX_DIFF_CHARS + 50)

    def _side_effect(token, method, path, *, params=None, body=None, accept=None, raw=False):
        if path.endswith('/pulls/1') and raw:
            return huge
        if path.endswith('/pulls/1/files'):
            return []
        if path.endswith('/pulls/1'):
            return {
                'number': 1,
                'title': 'big',
                'body': '',
                'state': 'open',
                'head': {},
                'base': {},
                'user': {},
            }
        if path.endswith('/pulls') or path.endswith('/issues'):
            return []
        raise AssertionError(path)

    with patch('tool_github.IInstance.call', side_effect=_side_effect):
        result = IInstance.pr_review_context(inst, {'pr_number': 1})

    assert result['diff_truncated'] is True
    assert len(result['diff']) < len(huge)
    assert f'truncated at {_MAX_DIFF_CHARS}' in result['diff']
    assert result['diff'].startswith('x' * 100)
