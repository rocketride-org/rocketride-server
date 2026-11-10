# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Bedrock signs requests with accessKey and secretKey, which ChatBase does not check.

A key left as an unfilled ${ROCKETRIDE_...} must stop both the save-time probe and
the chat before anything is signed with it. The resolver carries such a value
through untouched (it is filled per caller), so the node's own check is what
catches it. Drives the real driver and validator over the engine-resolved schema.
"""

import importlib.util
import os
import sys
import types
from unittest.mock import MagicMock

import pytest
import rocketlib
from rocketlib.config import resolveConfig

import ai.common.config as config_module
from ai.common.config import UnresolvedCredentialError

_NODE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'nodes', 'llm_bedrock')
_LOGICAL_TYPE = 'llm_bedrock'
PLACEHOLDER = '${ROCKETRIDE_AWS_KEY}'
MISSING = 'no variable named ROCKETRIDE_AWS_KEY was found'


def _config(field):
    """A stored custom-model config whose ``field`` is the unfilled placeholder."""
    config = {
        'model': 'custom',
        'custom': {
            'customModel': 'meta.llama3-3-70b-instruct-v1:0',
            'modelTotalTokens': 128000,
            'modelOutputTokens': 1024,
        },
        'accessKey': 'AKIDEXAMPLE',
        'secretKey': 'secret-example',
        'region': 'us-east-1',
    }
    config[field] = PLACEHOLDER
    return config


def _view(field):
    """The config as the node reads it: resolved through the engine's schema."""
    schema = rocketlib.getServiceSchema(_LOGICAL_TYPE)
    assert schema is not None, f'{_LOGICAL_TYPE} is not registered with the engine'
    return resolveConfig(schema, _config(field))


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_NODE_DIR, filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
def _stub_sdks(monkeypatch):
    """The AWS client and the dependency loader never run."""
    langchain_aws = types.ModuleType('langchain_aws')
    langchain_aws.ChatBedrock = MagicMock()
    depends = types.ModuleType('depends')
    depends.depends = lambda *args, **kwargs: None
    monkeypatch.setitem(sys.modules, 'langchain_aws', langchain_aws)
    monkeypatch.setitem(sys.modules, 'depends', depends)
    return langchain_aws


@pytest.mark.parametrize('field', ['accessKey', 'secretKey'])
def test_the_chat_does_not_start_with_an_unfilled_aws_key(monkeypatch, field):
    module = _load('_llm_bedrock_unfilled_key_chat', 'bedrock.py')
    monkeypatch.setattr(module, '_ChatBedrock', MagicMock())
    with pytest.raises(UnresolvedCredentialError, match=MISSING):
        module.Chat(_LOGICAL_TYPE, _view(field), {})
    module._ChatBedrock.assert_not_called()


@pytest.mark.parametrize('field', ['accessKey', 'secretKey'])
def test_the_save_time_probe_is_not_signed_with_an_unfilled_aws_key(monkeypatch, field, _stub_sdks):
    warned = []
    monkeypatch.setattr(config_module, 'warning', warned.append)
    module = _load('_llm_bedrock_unfilled_key_validator', 'IValidator.py')
    validator = module.IValidator()
    validator.glb = types.SimpleNamespace(logicalType=_LOGICAL_TYPE, connConfig=_config(field))
    validator.validateConfig()
    assert any(MISSING in line for line in warned)
    _stub_sdks.ChatBedrock.assert_not_called()
