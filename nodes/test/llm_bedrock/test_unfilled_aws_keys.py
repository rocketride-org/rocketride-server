# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Bedrock signs requests with accessKey and secretKey, which ChatBase does not check.

A key left as an unfilled ${ROCKETRIDE_...} must stop both the save-time probe and
the chat before anything is signed with it.
"""

import importlib.util
import os
import sys
import types
from unittest.mock import MagicMock

import pytest

import ai.common.config as config_module
from ai.common.config import Config, UnresolvedCredentialError

_NODE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'nodes', 'llm_bedrock')
PLACEHOLDER = '${ROCKETRIDE_AWS_KEY}'
MISSING = 'no variable named ROCKETRIDE_AWS_KEY was found'


def _config(field):
    config = {
        'model': 'meta.llama3-3-70b-instruct-v1:0',
        'accessKey': 'AKIDEXAMPLE',
        'secretKey': 'secret-example',
        'region': 'us-east-1',
        'modelTotalTokens': 128000,
        'modelOutputTokens': 1024,
    }
    config[field] = PLACEHOLDER
    return config


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_NODE_DIR, filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize('field', ['accessKey', 'secretKey'])
def test_the_chat_does_not_start_with_an_unfilled_aws_key(monkeypatch, field):
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *args, **kwargs: _config(field)))
    module = _load('_llm_bedrock_unfilled_key_chat', 'bedrock.py')
    monkeypatch.setattr(module, '_ChatBedrock', MagicMock())

    with pytest.raises(UnresolvedCredentialError, match=MISSING):
        module.Chat('llm_bedrock', {field: PLACEHOLDER}, {})

    module._ChatBedrock.assert_not_called()


@pytest.mark.parametrize('field', ['accessKey', 'secretKey'])
def test_the_save_time_probe_is_not_signed_with_an_unfilled_aws_key(monkeypatch, field):
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *args, **kwargs: _config(field)))
    warned = []
    monkeypatch.setattr(config_module, 'warning', warned.append)
    depends = types.ModuleType('depends')
    depends.depends = lambda *args, **kwargs: None
    langchain_aws = types.ModuleType('langchain_aws')
    langchain_aws.ChatBedrock = MagicMock()
    monkeypatch.setitem(sys.modules, 'depends', depends)
    monkeypatch.setitem(sys.modules, 'langchain_aws', langchain_aws)
    module = _load('_llm_bedrock_unfilled_key_global', 'IGlobal.py')
    glb = module.IGlobal.__new__(module.IGlobal)
    glb.glb = MagicMock(logicalType='llm_bedrock', connConfig={field: PLACEHOLDER})

    glb.validateConfig()

    assert any(MISSING in line for line in warned)
    langchain_aws.ChatBedrock.assert_not_called()
