# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Verify real tool discovery/dispatch under engine -m pytest, without a server.

The node is loaded from this checkout, not the engine's installed node copy.
Only HTTP is mocked. Under the engine it runs with the rest of the directory; under
plain python, without ``engLib``, it is skipped.
"""

import base64
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

pytest.importorskip('engLib', reason='Run with engine -m pytest for native tool dispatch')
from rocketlib import APERR, Ec


def json_response(payload, status=200):
    resp = requests.Response()
    resp.status_code = status
    resp._content = json.dumps(payload).encode()
    return resp


@pytest.fixture
def instance(monkeypatch):
    package = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_github'
    name = '_github_reads_engine_test'
    spec = importlib.util.spec_from_file_location(
        name, package / '__init__.py', submodule_search_locations=[str(package)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
        inst = module.IInstance()
        inst.IGlobal = SimpleNamespace(
            auth_type='pat',
            token='test-token',
            private_key_pem='',
            get_token=lambda: 'test-token',
            default_repo='owner/repo',
            read_only=True,
        )
        request = Mock()
        monkeypatch.setattr(requests, 'request', request)
        yield inst, request
    finally:
        for key in list(sys.modules):
            if key == name or key.startswith(name + '.'):
                del sys.modules[key]


def test_all_new_tools_are_discovered_with_real_schemas(instance):
    inst, request = instance
    param = {'op': 'tool.query', 'tools': []}
    with pytest.raises(APERR) as error:
        inst.invoke(param)
    assert error.value.ec == Ec.PreventDefault
    tools = {tool['name']: tool for tool in param['tools']}
    for name in (
        'repo_tree',
        'repo_contributors',
        'repo_languages',
        'label_list',
        'user_get',
        'file_get',
        'repo_get',
        'pr_list',
    ):
        assert name in tools
        assert tools[name]['inputSchema']['type'] == 'object'
        assert 'token' not in tools[name]['inputSchema']['properties']
    assert set(tools['repo_tree']['inputSchema']['properties']) == {
        'repo',
        'ref',
        'walk',
        'max_requests',
        'max_entries',
    }
    request.assert_not_called()


@pytest.mark.parametrize(
    ('tool', 'args', 'payload', 'url', 'data'),
    [
        (
            'repo_contributors',
            {},
            [{'login': 'reader', 'type': 'User', 'contributions': 1, 'email': 'private@example.test'}],
            'https://api.github.com/repos/owner/repo/contributors',
            [{'login': 'reader', 'contributions': 1, 'type': 'User'}],
        ),
        (
            'repo_languages',
            {'repo': 'other/project'},
            {'Python': 10},
            'https://api.github.com/repos/other/project/languages',
            {'Python': 10},
        ),
        (
            'label_list',
            {},
            [{'id': 7, 'name': 'bug', 'color': 'ff0000', 'description': None}],
            'https://api.github.com/repos/owner/repo/labels',
            [{'name': 'bug', 'color': 'ff0000', 'description': None}],
        ),
        (
            'user_get',
            {},
            {'login': 'reader', 'type': 'User', 'email': 'private@example.test'},
            'https://api.github.com/user',
            {'login': 'reader', 'type': 'User'},
        ),
    ],
)
def test_dispatch_new_read_tools_with_json_input(instance, tool, args, payload, url, data):
    inst, request = instance
    resp = requests.Response()
    resp.status_code = 200
    resp._content = json.dumps(payload).encode()
    request.return_value = resp
    param = {'op': 'tool.invoke', 'tool_name': tool, 'input': json.dumps(args)}
    inst.invoke(param)
    assert param['output']['status'] == 200
    assert param['output']['data'] == data
    assert 'rate_limit' in param['output']
    assert request.call_args.args == ('GET', url)


def test_dispatch_repo_tree_with_json_input(instance):
    inst, request = instance
    request.return_value = json_response({'sha': 'root', 'tree': [], 'truncated': False})
    param = {'op': 'tool.invoke', 'tool_name': 'repo_tree', 'input': json.dumps({'ref': 'main'})}
    inst.invoke(param)
    assert param['output']['status'] == 200
    assert param['output']['data'] == {'sha': 'root', 'tree': [], 'truncated': False, 'complete': True, 'walked': False}
    assert 'rate_limit' in param['output']
    assert request.call_args.args == ('GET', 'https://api.github.com/repos/owner/repo/git/trees/main')


def test_dispatch_file_get_reads_a_large_file_through_the_blob_api(instance):
    inst, request = instance
    text = 'x' * 1_048_577
    request.side_effect = [
        json_response(
            {
                'type': 'file',
                'name': 'big.txt',
                'path': 'big.txt',
                'sha': 'blob-sha',
                'size': len(text),
                'encoding': 'none',
                'content': '',
            }
        ),
        json_response(
            {
                'sha': 'blob-sha',
                'size': len(text),
                'encoding': 'base64',
                'content': base64.encodebytes(text.encode()).decode(),
            }
        ),
    ]
    param = {'op': 'tool.invoke', 'tool_name': 'file_get', 'input': json.dumps({'path': 'big.txt'})}
    inst.invoke(param)
    assert param['output']['found'] is True
    assert param['output']['content'] == text
    assert 'message' not in param['output']
    assert request.call_args.args == ('GET', 'https://api.github.com/repos/owner/repo/git/blobs/blob-sha')


def test_legacy_write_still_blocked_in_read_only_mode(instance):
    inst, request = instance
    with pytest.raises(ValueError, match='read-only'):
        inst.invoke({'op': 'tool.invoke', 'tool_name': 'issue_create', 'input': {'title': 'must not be posted'}})
    request.assert_not_called()
