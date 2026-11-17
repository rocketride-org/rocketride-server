# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Real engine dispatch of the new tools, with the node's real IGlobal built from config.

The node is loaded from this checkout under the engine's rocketlib; only the node
config and HTTP are stood in. Run with ``engine -m pytest``, separately from the
stub-based unit tests or in the same directory run.
"""

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import requests

pytest.importorskip('engLib', reason='Run with engine -m pytest for native tool dispatch')
from rocketlib import APERR, Ec  # noqa: E402

from ._fake_github import FakeGitHub, response  # noqa: E402

_PACKAGE = '_github_credentials_engine_test'
TOKEN = 'ghp_sentinel_engine_2592pr3'
NEW_TOOLS = ('installation_repos', 'pr_request_reviewers', 'pr_remove_requested_reviewers', 'issue_add_labels')


@pytest.fixture
def node(monkeypatch):
    package = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_github'
    spec = importlib.util.spec_from_file_location(
        _PACKAGE, package / '__init__.py', submodule_search_locations=[str(package)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[_PACKAGE] = module
    github = FakeGitHub()
    monkeypatch.setattr(requests, 'request', github)
    try:
        spec.loader.exec_module(module)
        config = sys.modules[f'{_PACKAGE}.IGlobal'].Config

        def build(cfg):
            monkeypatch.setattr(config, 'getNodeConfig', staticmethod(lambda logical_type, conn_config: cfg))
            glb = module.IGlobal()
            glb.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode='open'))
            glb.glb = SimpleNamespace(logicalType='tool_github', connConfig={})
            glb.beginGlobal()
            inst = module.IInstance()
            inst.IGlobal = glb
            return inst

        yield SimpleNamespace(build=build, github=github)
    finally:
        for key in list(sys.modules):
            if key == _PACKAGE or key.startswith(_PACKAGE + '.'):
                del sys.modules[key]


def _invoke(inst, tool, args):
    param = {'op': 'tool.invoke', 'tool_name': tool, 'input': json.dumps(args)}
    inst.invoke(param)
    return param['output']


def test_the_new_tools_are_discovered_with_object_schemas(node):
    inst = node.build({'token': TOKEN})
    param = {'op': 'tool.query', 'tools': []}
    with pytest.raises(APERR) as error:
        inst.invoke(param)
    assert error.value.ec == Ec.PreventDefault
    tools = {tool['name']: tool for tool in param['tools']}
    for name in NEW_TOOLS:
        assert tools[name]['inputSchema']['type'] == 'object'
        assert 'token' not in tools[name]['inputSchema']['properties']
    for name in ('graphql', 'user_get', 'installation_repos'):
        assert 'repo' in tools[name]['inputSchema']['properties']
    assert {'affiliation', 'visibility', 'sort'} <= set(tools['user_get_repos']['inputSchema']['properties'])
    assert node.github.calls == []


def test_a_write_dispatches_with_json_input_and_the_matching_credential(node):
    node.github.routes[('POST', '/repos/acme/api/pulls/7/requested_reviewers')] = response(
        {'number': 7, 'requested_reviewers': [{'login': 'octocat'}], 'requested_teams': []}, 201
    )
    inst = node.build({'credentialMap': json.dumps({'acme/*': TOKEN, '*': 'ghp_default'})})
    output = _invoke(inst, 'pr_request_reviewers', {'repo': 'acme/api', 'pr_number': 7, 'reviewers': ['octocat']})
    assert output['status'] == 201
    assert output['data'] == {'number': 7, 'requested_reviewers': ['octocat'], 'requested_teams': []}
    assert 'rate_limit' in output
    [call] = node.github.calls
    assert (call.method, call.path, call.bearer) == ('POST', '/repos/acme/api/pulls/7/requested_reviewers', TOKEN)
    assert call.body == {'reviewers': ['octocat'], 'team_reviewers': []}


def test_a_write_is_refused_in_read_only_mode_through_dispatch(node):
    inst = node.build({'token': TOKEN, 'readOnly': True})
    output = _invoke(inst, 'issue_add_labels', {'repo': 'acme/api', 'issue_number': 7, 'labels': ['bug']})
    assert output['status'] is None
    assert output['message'].startswith('issue_add_labels refused by readOnly')
    assert node.github.calls == []


def test_installation_repos_dispatches_with_a_per_repository_installation(node, rsa_private_key_pem):
    node.github.installations = {'beta/web': 22}
    node.github.routes[('GET', '/installation/repositories')] = response(
        {'total_count': 1, 'repositories': [{'name': 'web', 'full_name': 'beta/web', 'private': False}]}
    )
    inst = node.build({'authType': 'app', 'appId': '111', 'privateKey': rsa_private_key_pem})
    output = _invoke(inst, 'installation_repos', {'repo': 'beta/web'})
    assert output['status'] == 200
    assert output['data']['installation_id'] == 22
    assert output['data']['repositories'] == [{'name': 'web', 'full_name': 'beta/web', 'private': False}]
    assert node.github.bearer_for('/installation/repositories') == 'ghs_fake_22_1'


def test_no_match_through_dispatch_is_a_result_naming_the_repository(node):
    inst = node.build({'credentialMap': {'acme/*': TOKEN}})
    output = _invoke(inst, 'label_list', {'repo': 'other/x'})
    assert output['status'] is None
    assert 'other/x' in output['message']
    assert TOKEN not in json.dumps(output)
    assert node.github.calls == []


def test_a_legacy_error_is_redacted_through_dispatch(node):
    node.github.routes[('GET', '/repos/acme/api/issues/1')] = lambda call: response(
        {'message': f'token {call.bearer} is not allowed'}, 403
    )
    inst = node.build({'credentialMap': {'acme/*': TOKEN}})
    with pytest.raises(ValueError) as error:
        inst.invoke({'op': 'tool.invoke', 'tool_name': 'issue_get', 'input': {'repo': 'acme/api', 'issue_number': 1}})
    assert TOKEN not in f'{error.value} {error.value!r}'
    assert '[REDACTED]' in str(error.value)
    assert node.github.bearer_for('/repos/acme/api/issues/1') == TOKEN


def test_an_object_map_through_the_real_get_node_config(node):
    # build() is not used, so getNodeConfig is the engine's own: it reads the profile block
    # through IJson.toDict and merges the service's profile defaults.
    glb = sys.modules[_PACKAGE].IGlobal()
    glb.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode='open'))
    conn = {'profile': 'default', 'default': {'credentialMap': {'acme/*': TOKEN, 'beta/web': 'ghp_beta'}}}
    glb.glb = SimpleNamespace(logicalType='tool_github', connConfig=conn)
    glb.beginGlobal()
    inst = sys.modules[_PACKAGE].IInstance()
    inst.IGlobal = glb
    node.github.routes[('GET', '/repos/acme/api/labels')] = response([])
    node.github.routes[('GET', '/repos/beta/web/labels')] = response([])
    assert _invoke(inst, 'label_list', {'repo': 'acme/api'})['status'] == 200
    assert _invoke(inst, 'label_list', {'repo': 'beta/web'})['status'] == 200
    assert node.github.bearer_for('/repos/acme/api/labels') == TOKEN
    assert node.github.bearer_for('/repos/beta/web/labels') == 'ghp_beta'
    # Unmatched, and the map has no default entry and the node no token: a result naming it.
    output = _invoke(inst, 'label_list', {'repo': 'gamma/x'})
    assert output['status'] is None
    assert 'gamma/x' in output['message']


def test_a_rows_map_through_the_real_get_node_config(node):
    # build() is not used, so getNodeConfig is the engine's own: it reads the profile block
    # through IJson.toDict and merges the service's profile defaults.
    glb = sys.modules[_PACKAGE].IGlobal()
    glb.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode='open'))
    rows = [
        {'credentialRepository': 'acme/*', 'credentialValue': TOKEN},
        {'credentialRepository': 'beta/web', 'credentialValue': 'ghp_beta'},
    ]
    conn = {'profile': 'default', 'default': {'credentialMap': rows}}
    glb.glb = SimpleNamespace(logicalType='tool_github', connConfig=conn)
    glb.beginGlobal()
    inst = sys.modules[_PACKAGE].IInstance()
    inst.IGlobal = glb
    node.github.routes[('GET', '/repos/acme/api/labels')] = response([])
    node.github.routes[('GET', '/repos/beta/web/labels')] = response([])
    assert _invoke(inst, 'label_list', {'repo': 'acme/api'})['status'] == 200
    assert _invoke(inst, 'label_list', {'repo': 'beta/web'})['status'] == 200
    assert node.github.bearer_for('/repos/acme/api/labels') == TOKEN
    assert node.github.bearer_for('/repos/beta/web/labels') == 'ghp_beta'
    # Unmatched, and the map has no default entry and the node no token: a result naming it.
    output = _invoke(inst, 'label_list', {'repo': 'gamma/x'})
    assert output['status'] is None
    assert 'gamma/x' in output['message']


def test_an_encoded_slash_cannot_hide_dot_segments_through_dispatch(node):
    inst = node.build({'credentialMap': {'acme/*': TOKEN}})
    path = 'x%2F..%2F..%2F..%2F..%2Fevil%2Fx%2Fcontents%2Ff'
    with pytest.raises(ValueError, match='"." or ".." segment or an empty one'):
        inst.invoke({'op': 'tool.invoke', 'tool_name': 'file_get', 'input': {'repo': 'acme/app', 'path': path}})
    output = _invoke(inst, 'repo_tree', {'repo': 'acme/app', 'ref': 'x/../../../../evil/x'})
    assert output['status'] is None
    assert '"." or ".." segment or an empty one' in output['message']
    assert node.github.calls == []
