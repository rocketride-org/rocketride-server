# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Offline checks of the Auth0 example and generated credential catalog."""

import importlib.util
import json
import subprocess
import sys
import uuid
import xml.etree.ElementTree as etree
from pathlib import Path

import test_configuration

node = test_configuration.node


ROOT = Path(__file__).resolve().parents[3]
NODE = ROOT / 'nodes' / 'src' / 'nodes' / 'tool_auth0'


def test_example_pipeline_wires_auth0_to_agent_without_writes():
    pipeline = json.loads((NODE / 'example.pipe').read_text(encoding='utf-8'))
    assert next(iter(pipeline)) == 'components'
    uuid.UUID(pipeline['project_id'])
    assert pipeline['version'] == 1
    components = {item['id']: item for item in pipeline['components']}
    assert len(components) == len(pipeline['components'])
    assert {item['provider'] for item in components.values()} == {
        'chat',
        'agent_rocketride',
        'llm_openai_api',
        'memory_internal',
        'tool_auth0',
        'response_answers',
    }
    agent = components['agent_rocketride_1']
    assert agent['input'] == [{'lane': 'questions', 'from': 'chat_1'}]
    assert components['response_answers_1']['input'] == [{'lane': 'answers', 'from': 'agent_rocketride_1'}]
    for name, kind in (('llm_openai_api_1', 'llm'), ('memory_internal_1', 'memory'), ('tool_auth0_1', 'tool')):
        assert components[name]['control'] == [{'classType': kind, 'from': 'agent_rocketride_1'}]
    config = components['tool_auth0_1']['config']
    assert config['allowWrite'] is False
    assert config['domain'] == '${ROCKETRIDE_AUTH0_DOMAIN}'
    assert config['clientId'] == '${ROCKETRIDE_AUTH0_CLIENT_ID}'
    assert config['clientSecret'] == '${ROCKETRIDE_AUTH0_CLIENT_SECRET}'
    assert not config.get('writeClientSecret') and not config.get('writeClientId')
    llm = components['llm_openai_api_1']['config']['custom']
    assert llm['apikey'] == '${ROCKETRIDE_OPENROUTER_API_KEY}'
    assert llm['base_url'] == 'https://openrouter.ai/api/v1' and llm['model'] == 'openrouter/free'
    assert 'Never call unblock_user' in ' '.join(agent['config']['instructions'])


def test_example_edges_match_actual_service_definitions():
    paths = [
        'nodes/src/nodes/webhook/services.chat.json',
        'nodes/src/nodes/agent_rocketride/services.json',
        'nodes/src/nodes/llm_openai_api/services.json',
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
    for kind, provider in (('llm', 'llm_openai_api'), ('memory', 'memory_internal'), ('tool', 'tool_auth0')):
        assert kind in definitions[provider]['classType']
        assert kind in definitions['agent_rocketride']['invoke']


def test_registration_exports_and_icon(node):
    package, _, _, _ = node
    service = json.loads((NODE / 'services.json').read_text(encoding='utf-8'))
    assert service['protocol'] == 'tool_auth0://' and service['path'] == 'nodes.tool_auth0'
    assert service['register'] == 'filter' and service['classType'] == ['tool']
    assert package.__all__ == ['IGlobal', 'IInstance']
    assert etree.parse(NODE / service['icon']).getroot().tag == '{http://www.w3.org/2000/svg}svg'


def test_read_only_credentials_are_sufficient_for_catalog_readiness(monkeypatch):
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
    assert 'ROCKETRIDE_AUTH0_WRITE_CLIENT_SECRET' not in module.setup_block(entry)['variables']
