# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""The property model: the control's configuration builds the pool, each call reads its own settings.

These read the node through the engine's resolved schema (``test.framework.controls``):
the definition flags the call's leaves as parameters an agent cannot set, the
control's ``config`` refuses them, ``IGlobal`` builds the pool from the
connection leaves alone, each call's store takes its namespace, write gate and
limits from the call's settings, and ``IValidator`` warns at save time about a
value the node would refuse.
"""

import importlib
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from rocketlib.config import ConfigError
from test.framework.controls import assert_config_refuses, assert_params, bind_call, control_config
from test.mocks.redis_fake import FakeRedis
from nodes.tool_redis.IGlobal import IGlobal
from nodes.tool_redis.IInstance import IInstance
from nodes.tool_redis.IValidator import CALL_KEYS, CONNECTION_KEYS, IValidator
from nodes.tool_redis.redis_client import RedisNodeError

global_module = importlib.import_module('nodes.tool_redis.IGlobal')
validator_module = importlib.import_module('nodes.tool_redis.IValidator')
SERVICE = Path(__file__).parents[2] / 'src' / 'nodes' / 'tool_redis' / 'services.json'


def load_definition():
    return json.loads(SERVICE.read_text(encoding='utf-8'))


def control_for(monkeypatch, config, client=None):
    """A control started on ``config`` (the stored, path-addressed tree) over ``client``; returns it and its pool settings."""
    built = []
    client = client if client is not None else MagicMock()
    monkeypatch.setattr(
        global_module, 'create_client', lambda settings: built.append(settings) or (client, MagicMock())
    )
    control = IGlobal()
    control.glb = SimpleNamespace(connConfig=config, logicalType='tool_redis', id='redis_1')
    control.beginGlobal()
    return control, built[-1]


def fake_control(monkeypatch, config):
    """A started control over an in-process FakeRedis."""
    client = FakeRedis()
    client.ping = lambda: True
    control, _ = control_for(monkeypatch, config, client)
    return control, client


# -- the definition ----------------------------------------------------------


def test_definition_uses_the_current_format():
    definition = load_definition()
    assert not {'preconfig', 'fields', 'shape'} & set(definition)
    assert definition['path'] == 'nodes.tool_redis'


def test_the_call_settings_are_parameters_an_agent_cannot_set():
    leaves = load_definition()['propertyDefinitions']
    params = {name.split('.', 1)[1] for name, leaf in leaves.items() if leaf.get('param')}
    assert params == set(CALL_KEYS)
    assert all(leaves[f'tool_redis.{key}']['tool'] is False for key in CALL_KEYS)
    assert {name.split('.', 1)[1] for name in leaves} - params == set(CONNECTION_KEYS)


def test_the_schema_flags_exactly_the_call_settings():
    assert_params('tool_redis', CALL_KEYS, CALL_KEYS)


def test_the_control_config_refuses_every_call_setting():
    assert_config_refuses(control_config('tool_redis'), CALL_KEYS)


# -- IGlobal: the pool from the control's configuration ------------------------


def test_the_pool_is_built_from_the_connection_leaves(monkeypatch):
    stored = {'host': 'redis.internal', 'port': 6390, 'db': 2, 'socket_timeout': 9, 'max_connections': 4}
    _, settings = control_for(monkeypatch, {**stored, 'key_prefix': 'app:'})
    assert (settings.host, settings.port, settings.db, settings.socket_timeout, settings.max_connections) == (
        'redis.internal',
        6390,
        2,
        9,
        4,
    )
    # The pool never reads a call setting: they keep their defaults there
    assert settings.key_prefix == 'rr:'


def test_a_connection_value_the_node_refuses_fails_the_start(monkeypatch):
    with pytest.raises(RedisNodeError, match='not a URL'):
        control_for(monkeypatch, {'host': 'redis://elsewhere'})


# -- IInstance: each call's store from the call's settings ----------------------


def test_a_call_uses_the_stored_values_unless_it_sends_its_own(monkeypatch):
    control, client = fake_control(monkeypatch, {'key_prefix': 'app:', 'allow_writes': True})
    assert bind_call(IInstance(), control).redis_set({'key': 'k', 'value': 'v'})['stored']
    assert client.get('app:k') == b'v'
    tenant = bind_call(IInstance(), control, {'key_prefix': 'tenant:', 'allow_writes': False})
    assert tenant.redis_set({'key': 'k', 'value': 'w'})['error_code'] == 'permission_denied'
    assert tenant.redis_get({'key': 'k'})['found'] is False
    assert client.get('app:k') == b'v'


def test_a_call_sets_its_own_expiry_default_and_value_cap(monkeypatch):
    control, _ = fake_control(monkeypatch, {'allow_writes': True})
    persistent = bind_call(IInstance(), control, {'default_ttl_seconds': 0})
    assert persistent.redis_set({'key': 'k', 'value': 'v'})['requested_ttl_seconds'] == 0
    capped = bind_call(IInstance(), control, {'max_value_bytes': 2})
    assert capped.redis_set({'key': 'k', 'value': 'abc'})['error_code'] == 'value_too_large'


def test_a_call_setting_the_node_refuses_fails_the_call_not_the_control(monkeypatch):
    control, client = fake_control(monkeypatch, {})
    result = bind_call(IInstance(), control, {'key_prefix': 'bad*:'}).redis_get({'key': 'k'})
    assert (result['error_code'], result['outcome']) == ('invalid_input', 'not_applied')
    assert bind_call(IInstance(), control).redis_get({'key': 'k'})['success']


def test_a_call_without_a_started_control_reports_it():
    instance = IInstance.__new__(IInstance)
    instance.IGlobal = IGlobal.__new__(IGlobal)  # beginGlobal never ran
    instance._settings = {}
    assert instance.redis_get({'key': 'k'})['error_code'] == 'not_initialized'


# -- IValidator: the node's own checks at save time ----------------------------


def validator_for(config):
    """The IValidator the engine builds in CONFIG mode for ``config``."""
    validator = IValidator()
    validator.glb = SimpleNamespace(connConfig=config, logicalType='tool_redis')
    return validator


@pytest.mark.parametrize(
    'config,expected',
    [
        # A call setting: its stored value is read through the full view
        ({'key_prefix': 'bad*:'}, 'key_prefix must be'),
        ({'host': 'rediss://user:secret@redis.example'}, 'rediss://host:port'),
    ],
)
def test_validator_warns_about_a_value_the_node_refuses(monkeypatch, config, expected):
    warnings = []
    monkeypatch.setattr(validator_module, 'warning', warnings.append)
    validator_for(config).validateConfig()
    assert len(warnings) == 1 and expected in warnings[0]
    assert 'secret' not in warnings[0]


def test_validator_accepts_the_defaults(monkeypatch):
    warnings = []
    monkeypatch.setattr(validator_module, 'warning', warnings.append)
    monkeypatch.setattr(validator_module, 'is_hosted', lambda: False)
    monkeypatch.setattr(validator_module, 'is_shared_host', lambda: False)
    validator_for({}).validateConfig()
    assert warnings == []


def test_validator_checks_only_the_shape_when_asked(monkeypatch):
    warnings = []
    monkeypatch.setattr(validator_module, 'warning', warnings.append)
    validator_for({'key_prefix': 'bad*:'}).validateConfig(syntaxOnly=True)
    assert warnings == []
    with pytest.raises(ConfigError):
        validator_for({'unknown_key': 1}).validateConfig(syntaxOnly=True)
