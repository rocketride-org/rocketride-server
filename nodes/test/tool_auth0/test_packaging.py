# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Offline checks of the Auth0 example and generated credential catalog."""

import importlib.util
import json
import shutil
import subprocess
import sys
import types
import uuid
import xml.etree.ElementTree as etree
from pathlib import Path
from unittest.mock import Mock

import pytest
import test_configuration

node = test_configuration.node
pipeline = test_configuration.pipeline


ROOT = Path(__file__).resolve().parents[3]
NODE = ROOT / 'nodes' / 'src' / 'nodes' / 'tool_auth0'


def test_example_pipeline_wires_auth0_to_agent_without_writes():
    """Verify the shipped pipeline wiring and read-only agent instructions."""
    pipeline = json.loads((NODE / 'example.pipe').read_text(encoding='utf-8'))
    assert next(iter(pipeline)) == 'components'
    uuid.UUID(pipeline['project_id'])
    assert pipeline['version'] == 1
    components = {item['id']: item for item in pipeline['components']}
    assert len(components) == len(pipeline['components'])
    assert {item['provider'] for item in components.values()} == {
        'chat',
        'agent_rocketride',
        'llm_ollama',
        'memory_internal',
        'tool_auth0',
        'response_answers',
    }
    agent = components['agent_rocketride_1']
    assert agent['config']['require_tool_call'] is False
    instructions = ' '.join(agent['config']['instructions'])
    assert 'Use only synthetic test accounts' in instructions
    assert all(name in instructions for name in ('search_users', 'get_user', 'get_user_blocks', 'get_user_logs'))
    assert agent['input'] == [{'lane': 'questions', 'from': 'chat_1'}]
    assert components['response_answers_1']['input'] == [{'lane': 'answers', 'from': 'agent_rocketride_1'}]
    for name, kind in (('llm_ollama_1', 'llm'), ('memory_internal_1', 'memory'), ('tool_auth0_1', 'tool')):
        assert components[name]['control'] == [{'classType': kind, 'from': 'agent_rocketride_1'}]
    config = components['tool_auth0_1']['config']
    assert config['domain'] == '${ROCKETRIDE_AUTH0_DEMO_DOMAIN}'
    assert config['clientId'] == '${ROCKETRIDE_AUTH0_DEMO_CLIENT_ID}'
    assert config['clientSecret'] == '${ROCKETRIDE_AUTH0_DEMO_CLIENT_SECRET}'
    llm_config = components['llm_ollama_1']['config']
    assert llm_config['profile'] == 'custom'
    llm = llm_config['custom']
    assert llm['serverbase'] == '' and llm['model'] == ''
    assert 'Never make account changes' in ' '.join(agent['config']['instructions'])


def test_example_config_with_synthetic_tenant_data(node, pipeline, monkeypatch):
    """Exercise the example's configured tools against a synthetic HTTP transport."""
    package, get_config, _, _ = node
    example = json.loads((NODE / 'example.pipe').read_text(encoding='utf-8'))
    env = {
        'ROCKETRIDE_AUTH0_DEMO_DOMAIN': 'demo.auth0.com',
        'ROCKETRIDE_AUTH0_DEMO_CLIENT_ID': 'demo-client',
        'ROCKETRIDE_AUTH0_DEMO_CLIENT_SECRET': 'demo-secret',
    }
    resolved = pipeline.resolve_pipeline_env(example, env)
    get_config.return_value = next(c['config'] for c in resolved['components'] if c['provider'] == 'tool_auth0')
    calls = []
    user_id = 'auth0|synthetic'
    event = {'log_id': 'synthetic-log', 'type': 'limit_wc', 'ip': '192.0.2.1'}

    def response(data):
        """Return a successful JSON response from the synthetic tenant."""
        return types.SimpleNamespace(status_code=200, headers={}, content=b'json', json=lambda: data)

    def request(method, url, **kwargs):
        """Serve only the five reads used by the example."""
        calls.append((method, url, kwargs))
        path = url.removeprefix('https://demo.auth0.com/api/v2')
        data = {
            '/users-by-email': [{'user_id': user_id, 'email': 'demo@example.com'}],
            '/users/auth0%7Csynthetic': {'user_id': user_id},
            '/users/auth0%7Csynthetic/logs': [event],
            '/logs/synthetic-log': event,
            '/user-blocks/auth0%7Csynthetic': {'blocked_for': []},
        }
        assert method == 'GET' and path in data
        return response(data[path])

    requests = types.ModuleType('requests')
    requests.exceptions = types.SimpleNamespace(RequestException=Exception)
    requests.post = Mock(return_value=response({'access_token': 'demo-token', 'expires_in': 3600}))
    requests.request = request
    monkeypatch.setitem(sys.modules, 'requests', requests)
    global_node = package.IGlobal()
    global_node.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='run'))
    global_node.glb = types.SimpleNamespace(logicalType='tool_auth0', connConfig={})
    global_node.beginGlobal()
    tool = package.IInstance()
    tool.IGlobal = global_node
    search = tool.search_users({'email': 'demo@example.com'})
    profile = tool.get_user({'user_id': user_id})
    logs = tool.get_user_logs({'user_id': user_id})
    detail = tool.get_log_event({'log_id': 'synthetic-log'})
    blocks = tool.get_user_blocks({'user_id': user_id})
    assert search['users'][0]['user_id'] == user_id
    assert profile['blocked'] is False and logs['events'][0]['log_id'] == 'synthetic-log'
    assert detail['diagnostics'] and blocks['has_blocks'] is False
    assert len(calls) == 5 and requests.post.call_count == 1
    assert all(call[2]['headers']['Authorization'] == 'Bearer demo-token' for call in calls)
    assert all(call[2]['allow_redirects'] is False for call in calls)
    assert '192.0.2.1' not in str([search, profile, logs, detail, blocks])
    global_node.endGlobal()


def test_example_edges_match_actual_service_definitions():
    """Check example ports against the current service metadata."""
    if not shutil.which('node'):
        pytest.skip('Node.js is not installed')
    dependency_check = subprocess.run(
        [
            'node',
            '-e',
            "try { require.resolve('jsonc-parser', {paths: ['./scripts/lib']}); } "
            "catch (err) { if (err.code === 'MODULE_NOT_FOUND') process.exit(3); throw err; }",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if dependency_check.returncode == 3:
        pytest.skip('jsonc-parser is not installed')
    assert dependency_check.returncode == 0, dependency_check.stderr
    paths = [
        'nodes/src/nodes/webhook/services.chat.json',
        'nodes/src/nodes/agent_rocketride/services.json',
        'nodes/src/nodes/llm_ollama/services.json',
        'nodes/src/nodes/memory_internal/services.json',
        'nodes/src/nodes/tool_auth0/services.json',
        'nodes/src/nodes/response/services.answers.json',
    ]
    script = "const {readJsonSync}=require('./scripts/lib/fs'); process.stdout.write(JSON.stringify(process.argv.slice(1).map(readJsonSync)));"
    output = subprocess.check_output(['node', '-e', script, *paths], cwd=ROOT, text=True)
    definitions = {item['protocol'].removesuffix('://'): item for item in json.loads(output)}
    assert definitions['chat']['lanes']['_source'] == ['questions']
    assert 'answers' in definitions['agent_rocketride']['lanes']['questions']
    assert 'answers' in definitions['response_answers']['lanes']
    for kind, provider in (('llm', 'llm_ollama'), ('memory', 'memory_internal'), ('tool', 'tool_auth0')):
        assert kind in definitions[provider]['classType']
        assert kind in definitions['agent_rocketride']['invoke']


def test_registration_exports_and_icon(node):
    """Verify the node exports its lifecycle classes and ships a valid icon."""
    package, _, _, _ = node
    service = json.loads((NODE / 'services.json').read_text(encoding='utf-8'))
    assert service['protocol'] == 'tool_auth0://' and service['path'] == 'nodes.tool_auth0'
    assert service['register'] == 'filter' and service['classType'] == ['tool']
    assert package.__all__ == ['IGlobal', 'IInstance']
    assert etree.parse(NODE / service['icon']).getroot().tag == '{http://www.w3.org/2000/svg}svg'


def test_read_only_credentials_are_sufficient_for_catalog_readiness(monkeypatch):
    """Mark the node configured with exactly the three read-only credentials."""
    module_path = ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'modules' / 'mcp' / 'credentials.py'
    spec = importlib.util.spec_from_file_location('auth0_packaging_credentials', module_path)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    entry = module.load_catalog(ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'modules' / 'mcp' / 'credentials.json')[
        'tool_auth0'
    ]
    read_vars = ['ROCKETRIDE_AUTH0_DOMAIN', 'ROCKETRIDE_AUTH0_CLIENT_ID', 'ROCKETRIDE_AUTH0_CLIENT_SECRET']
    state = module.evaluate(entry, read_vars)
    assert state['status'] == 'configured' and not state['missing']
    assert set(state['wiring']) == {'auth0.domain', 'auth0.clientId', 'auth0.clientSecret'}
    assert sorted(module.setup_block(entry)['variables']) == sorted(read_vars)
