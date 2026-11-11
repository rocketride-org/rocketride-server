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
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    rocketlib.IInstanceBase = type('IInstanceBase', (), {})
    rocketlib.OPEN_MODE = types.SimpleNamespace(CONFIG='config')
    rocketlib.warning = Mock()

    def tool_function(**metadata):
        def decorate(fn):
            fn.__tool_meta__ = metadata
            return fn

        return decorate

    rocketlib.tool_function = tool_function
    config = types.ModuleType('ai.common.config')
    config.Config = types.SimpleNamespace(getNodeConfig=Mock())
    depends = types.ModuleType('depends')
    depends.depends = Mock()
    for name, module in (
        ('rocketlib', rocketlib),
        ('ai', types.ModuleType('ai')),
        ('ai.common', types.ModuleType('ai.common')),
        ('ai.common.config', config),
        ('depends', depends),
    ):
        monkeypatch.setitem(sys.modules, name, module)
    utils = types.ModuleType('ai.common.utils')
    helper = NODE.parents[3] / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils' / 'tool_args.py'
    helper_spec = importlib.util.spec_from_file_location('auth0_test_tool_args', helper)
    helper_module = importlib.util.module_from_spec(helper_spec)
    helper_spec.loader.exec_module(helper_module)
    utils.normalize_tool_input = helper_module.normalize_tool_input
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
    service = json.loads((NODE / 'services.json').read_text(encoding='utf-8'))
    assert service['protocol'] == 'tool_auth0://'
    assert service['path'] == 'nodes.tool_auth0'
    assert service['classType'] == ['tool'] and service['lanes'] == {}
    assert 'nosaas' not in service['capabilities']
    assert service['preconfig']['profiles']['default']['allowWrite'] is False
    assert 'unavailable' in service['fields']['auth0.allowWrite']['description']
    for name in ('clientSecret', 'writeClientSecret'):
        field = service['fields'][f'auth0.{name}']
        assert field['secure'] is True and field['ui']['ui:widget'] == 'ApiKeyWidget'
    assert service['fields']['auth0.writeClientId']['optional'] is True
    assert service['fields']['auth0.writeClientSecret']['optional'] is True
    assert all(
        f'auth0.{name}' in service['shape'][0]['properties']
        for name in ('domain', 'clientId', 'clientSecret', 'allowWrite', 'writeClientId', 'writeClientSecret')
    )


def test_lifecycle_and_safe_validation(node):
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
        {'allowWrite': True},
        {'allowWrite': 'true'},
        {'clientSecret': '${ROCKETRIDE_AUTH0_CLIENT_SECRET}'},
        {'clientSecret': '<REDACTED>'},
    ):
        cfg = {'domain': 'tenant.auth0.com', 'clientId': 'id', 'clientSecret': 'secret'} | overrides
        get_config.return_value = cfg
        with pytest.raises(ValueError) as exc:
            instance.beginGlobal()
        assert 'secret' not in str(exc.value).lower().replace('clientsecret', '')
        instance.validateConfig()
        assert warning.called


def test_separate_write_credentials(node):
    package, get_config, _, _ = node
    instance = package.IGlobal()
    instance.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='run'))
    instance.glb = types.SimpleNamespace(logicalType='tool_auth0', connConfig={})
    get_config.return_value = {
        'domain': 'tenant.auth0.com',
        'clientId': 'read',
        'clientSecret': 'read-secret',
        'allowWrite': True,
        'writeClientId': 'write',
        'writeClientSecret': 'write-secret',
    }
    instance.beginGlobal()
    assert instance.client._config['clientId'] == 'read'
    assert instance.client._config['writeClientId'] == 'write'
    instance.endGlobal()


def test_write_application_must_differ_from_read_application(node):
    package, _, _, _ = node
    cfg = {
        'domain': 'tenant.auth0.com',
        'clientId': 'read-client',
        'clientSecret': 'read-secret',
        'allowWrite': True,
        'writeClientId': 'read-client',
        'writeClientSecret': 'write-secret',
    }
    with pytest.raises(ValueError, match='separate applications'):
        package.auth0_client.validate_config(cfg)


@pytest.mark.parametrize('field', ['domain', 'clientId', 'clientSecret', 'writeClientId', 'writeClientSecret'])
def test_each_missing_credential_fails_safely(node, field):
    package, get_config, depends, _ = node
    instance = package.IGlobal()
    instance.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='run'))
    instance.glb = types.SimpleNamespace(logicalType='tool_auth0', connConfig={})
    config = {
        'domain': 'tenant.auth0.com',
        'clientId': 'read-id',
        'clientSecret': 'read-private',
        'allowWrite': True,
        'writeClientId': 'write-id',
        'writeClientSecret': 'write-private',
    }
    config.pop(field)
    get_config.return_value = config
    with pytest.raises(ValueError) as error:
        instance.beginGlobal()
    assert 'read-private' not in str(error.value) and 'write-private' not in str(error.value)
    depends.assert_not_called()


def test_credentials_are_not_taken_from_process_environment(node, monkeypatch):
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


@pytest.mark.parametrize('secret', ['${ROCKETRIDE_AUTH0_WRITE_SECRET}', 'literal-write-secret'])
def test_encrypted_write_credential_is_decoded_before_env_substitution(node, monkeypatch, secret, pipeline):
    package, _, _, _ = node
    encrypted = {
        'components': [
            {'config': {'parameters': {'secureParameters': {'secure': ['writeClientSecret'], 'token': 'opaque'}}}}
        ]
    }
    decoded = {'components': [{'config': {'parameters': {'writeClientSecret': secret}}}]}
    monkeypatch.setattr(sys.modules['rocketlib'], 'resolveSecureParameters', lambda value: decoded, raising=False)
    resolved = pipeline.resolve_pipeline_env(
        pipeline.resolve_parameter_tokens(encrypted), {'ROCKETRIDE_AUTH0_WRITE_SECRET': 'resolved-write-secret'}
    )
    cfg = {
        'domain': 'tenant.auth0.com',
        'clientId': 'read',
        'clientSecret': 'read-secret',
        'allowWrite': True,
        'writeClientId': 'write',
        **resolved['components'][0]['config']['parameters'],
    }
    package.auth0_client.validate_config(cfg)
    assert cfg['writeClientSecret'] == ('resolved-write-secret' if secret.startswith('${') else secret)
    unresolved = pipeline.resolve_pipeline_env(pipeline.resolve_parameter_tokens(encrypted), {})
    if secret.startswith('${'):
        cfg.update(unresolved['components'][0]['config']['parameters'])
        with pytest.raises(ValueError, match='unresolved credential reference'):
            package.auth0_client.validate_config(cfg)


def test_parameter_decode_failure_does_not_expose_values(node, monkeypatch, pipeline):
    def fail(_):
        raise ValueError('credential-value')

    monkeypatch.setattr(sys.modules['rocketlib'], 'resolveSecureParameters', fail, raising=False)
    data = {'components': [{'config': {'parameters': {'secureParameters': {}}}}]}
    with pytest.raises(ValueError) as error:
        pipeline.resolve_parameter_tokens(data)
    assert 'credential-value' not in str(error.value)
    assert error.value.__suppress_context__


def test_active_tokens_are_decoded_once_and_inactive_profiles_are_preserved(node, monkeypatch, pipeline):
    inactive = {'secureParameters': {'secure': ['key'], 'token': 'inactive'}}
    original = {
        'components': [
            {
                'config': {
                    'profile': 'current',
                    'current': {'secureParameters': {'secure': ['key'], 'token': 'active'}},
                    'other': inactive,
                }
            }
        ]
    }
    decoded = {'components': [{'config': {'profile': 'current', 'current': {'key': 'value'}, 'other': inactive}}]}
    calls = []

    def resolve(value):
        calls.append(value)
        return decoded

    monkeypatch.setattr(sys.modules['rocketlib'], 'resolveSecureParameters', resolve, raising=False)
    assert pipeline.resolve_parameter_tokens(pipeline.resolve_parameter_tokens(original)) is decoded
    assert calls == [original]
    assert decoded['components'][0]['config']['other'] == inactive
