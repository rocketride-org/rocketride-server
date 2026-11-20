# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Configuration and lifecycle tests without a running engine or Auth0 tenant."""

import importlib.util
import json
import sys
import types
from pathlib import Path
from unittest.mock import Mock

import pytest


NODE = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_auth0'


@pytest.fixture
def pipeline():
    """Load the task pipeline module for configuration tests."""
    path = NODE.parents[3] / 'packages' / 'ai' / 'src' / 'ai' / 'modules' / 'task' / 'pipeline.py'
    spec = importlib.util.spec_from_file_location('auth0_test_pipeline_config', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def node(monkeypatch):
    """Load the real Auth0 node and validation helpers with engine stubs."""
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    rocketlib.IInstanceBase = type('IInstanceBase', (), {})
    rocketlib.OPEN_MODE = types.SimpleNamespace(CONFIG='config')
    rocketlib.warning = Mock()
    rocketlib.getServiceDefinition = Mock()
    rocketlib.IJson = type('IJson', (), {})

    def tool_function(**metadata):
        """Stub tool registration for tests that load the node without the engine."""

        def decorate(fn):
            """Attach tool metadata to the method for validation tests."""
            fn.__tool_meta__ = metadata
            return fn

        return decorate

    rocketlib.tool_function = tool_function
    depends = types.ModuleType('depends')
    depends.depends = Mock()
    for name, module in (
        ('rocketlib', rocketlib),
        ('ai', types.ModuleType('ai')),
        ('ai.common', types.ModuleType('ai.common')),
        ('depends', depends),
    ):
        monkeypatch.setitem(sys.modules, name, module)
    common = NODE.parents[3] / 'packages' / 'ai' / 'src' / 'ai' / 'common'
    config_spec = importlib.util.spec_from_file_location('ai.common.config', common / 'config.py')
    config = importlib.util.module_from_spec(config_spec)
    monkeypatch.setitem(sys.modules, config_spec.name, config)
    # The mocked Config.getNodeConfig does not parse JSON5.
    monkeypatch.setitem(sys.modules, 'json5', types.ModuleType('json5'))
    config_spec.loader.exec_module(config)
    monkeypatch.setattr(config.Config, 'getNodeConfig', Mock())

    utils = types.ModuleType('ai.common.utils')
    helper = common / 'utils' / 'tool_args.py'
    helper_spec = importlib.util.spec_from_file_location('auth0_test_tool_args', helper)
    helper_module = importlib.util.module_from_spec(helper_spec)
    helper_spec.loader.exec_module(helper_module)
    utils.normalize_tool_input = helper_module.normalize_tool_input
    utils.validate_tool_input_schema = helper_module.validate_tool_input_schema
    monkeypatch.setitem(sys.modules, 'ai.common.utils', utils)
    spec = importlib.util.spec_from_file_location(
        'auth0_test_node', NODE / '__init__.py', submodule_search_locations=[str(NODE)]
    )
    package = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, package)
    spec.loader.exec_module(package)
    yield package, config.Config.getNodeConfig, depends.depends, rocketlib.warning
    for name in list(sys.modules):
        if name.startswith('auth0_test_node.'):
            sys.modules.pop(name, None)


def test_service_configuration():
    """Validate read-only service registration and the secure secret widget."""
    service = json.loads((NODE / 'services.json').read_text(encoding='utf-8'))
    assert service['protocol'] == 'tool_auth0://'
    assert service['path'] == 'nodes.tool_auth0'
    assert service['classType'] == ['tool'] and service['lanes'] == {}
    assert 'nosaas' not in service['capabilities']
    assert 'read-only' in ' '.join(service['description'])
    field = service['fields']['auth0.clientSecret']
    assert field['secure'] is True and field['ui']['ui:widget'] == 'ApiKeyWidget'
    assert all(f'auth0.{name}' in service['shape'][0]['properties'] for name in ('domain', 'clientId', 'clientSecret'))


def test_lifecycle_and_safe_validation(node):
    """Exercise client startup, cleanup, and safe configuration warnings."""
    package, get_config, depends, warning = node
    instance = package.IGlobal()
    instance.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='config'))
    instance.glb = types.SimpleNamespace(logicalType='tool_auth0', connConfig={})
    instance.beginGlobal()
    get_config.assert_not_called()
    depends.assert_not_called()
    assert instance.client is None

    instance.IEndpoint.endpoint.openMode = 'run'
    get_config.return_value = {'domain': 'tenant.auth0.com', 'clientId': 'id', 'clientSecret': 'secret'}
    instance.beginGlobal()
    depends.assert_called_once()
    client = instance.client
    assert client._config['clientSecret'] == 'secret'
    instance.endGlobal()
    assert instance.client is None and client._config == {}

    for overrides in (
        {'clientSecret': ''},
        {'clientSecret': '${ROCKETRIDE_AUTH0_CLIENT_SECRET}'},
        {'clientSecret': '<REDACTED>'},
    ):
        cfg = {'domain': 'tenant.auth0.com', 'clientId': 'id', 'clientSecret': 'secret'} | overrides
        get_config.return_value = cfg
        with pytest.raises(ValueError) as exc:
            instance.beginGlobal()
        assert exc.value.code == 'INVALID_INPUT'
        assert 'secret' not in str(exc.value).lower().replace('clientsecret', '')
        warning.reset_mock()
        instance.validateConfig()
        warning.assert_called_once()


@pytest.mark.parametrize('field', ['domain', 'clientId', 'clientSecret'])
def test_each_missing_credential_fails_safely(node, field):
    """Reject each missing credential before loading the HTTP dependency."""
    package, get_config, depends, _ = node
    instance = package.IGlobal()
    instance.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='run'))
    instance.glb = types.SimpleNamespace(logicalType='tool_auth0', connConfig={})
    config = {
        'domain': 'tenant.auth0.com',
        'clientId': 'read-id',
        'clientSecret': 'read-private',
    }
    config.pop(field)
    get_config.return_value = config
    with pytest.raises(ValueError) as error:
        instance.beginGlobal()
    assert error.value.code == 'INVALID_INPUT'
    assert 'read-private' not in str(error.value)
    depends.assert_not_called()


def test_credentials_are_not_taken_from_process_environment(node, monkeypatch):
    """Require effective node credentials even when environment variables exist."""
    package, get_config, depends, _ = node
    for key in ('AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'ROCKETRIDE_AUTH0_CLIENT_SECRET'):
        monkeypatch.setenv(key, 'should-not-be-used')
    instance = package.IGlobal()
    instance.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='run'))
    instance.glb = types.SimpleNamespace(logicalType='tool_auth0', connConfig={})
    get_config.return_value = {'domain': 'tenant.auth0.com', 'clientId': 'id'}
    with pytest.raises(ValueError):
        instance.beginGlobal()
    depends.assert_not_called()


@pytest.mark.parametrize(
    'secret_name', ['ROCKETRIDE_AUTH0_CLIENT_SECRET', 'ROCKETRIDE_NEW_SECRET'], ids=['example', 'replacement']
)
def test_example_plain_environment_references_configure_auth0(node, pipeline, secret_name):
    """Expand both the example and replacement references before client validation."""
    package, get_config, depends, _ = node
    example = json.loads((NODE / 'example.pipe').read_text(encoding='utf-8'))
    if secret_name != 'ROCKETRIDE_AUTH0_CLIENT_SECRET':
        auth0 = next(item['config'] for item in example['components'] if item['provider'] == 'tool_auth0')
        auth0['clientSecret'] = '${' + secret_name + '}'
    env = {
        'ROCKETRIDE_AUTH0_DOMAIN': 'tenant.auth0.com',
        'ROCKETRIDE_AUTH0_CLIENT_ID': 'read-id',
        secret_name: 'read-private',
        'ROCKETRIDE_OPENROUTER_API_KEY': 'llm-private',
    }
    resolved = pipeline.resolve_pipeline_env(example, env)
    config = next(item['config'] for item in resolved['components'] if item['provider'] == 'tool_auth0')
    instance = package.IGlobal()
    instance.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='run'))
    instance.glb = types.SimpleNamespace(logicalType='tool_auth0', connConfig={})
    get_config.return_value = config
    instance.beginGlobal()
    assert instance.client._config['clientSecret'] == 'read-private'
    depends.assert_called_once()
    instance.endGlobal()
    assert instance.client is None


@pytest.mark.parametrize('field', ['clientSecret'])
def test_reference_inside_secure_token_is_not_expanded_by_plain_env_pass(node, pipeline, field):
    """A reference restored after the environment pass is rejected as unresolved."""
    package, _, _, _ = node
    config = {
        'domain': 'tenant.auth0.com',
        'clientId': 'read-id',
        'clientSecret': 'read-private',
    }
    reference = '${ROCKETRIDE_AUTH0_SECRET}'
    token_pipeline = {'components': [{'config': {'parameters': {'secureParameters': {'token': 'opaque'}}}}]}
    expanded = pipeline.resolve_pipeline_env(token_pipeline, {'ROCKETRIDE_AUTH0_SECRET': 'resolved-private'})
    assert expanded == token_pipeline
    # Simulate the token being decoded after the environment pass; no live engine or key is required.
    config[field] = reference
    with pytest.raises(ValueError, match='unresolved credential reference') as error:
        package.auth0_client.validate_config(config)
    assert 'resolved-private' not in str(error.value)
