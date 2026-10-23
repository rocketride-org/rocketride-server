# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Exercise catalogue token limits through the Bedrock node startup path."""

import copy
import importlib.util
import json
import sys
import types
from contextvars import ContextVar
from pathlib import Path

import json5
import pytest

_ROOT = Path(__file__).resolve().parents[3]
_LIMITS = [
    ('ai21_jamba-1_5-large', 4096),
    ('ai21_jamba-1_5-mini', 4096),
    ('amazon_titan-text-express', 8000),
    ('amazon_nova-2-lite', 64000),
    ('anthropic_claude-3_7-sonnet', 8192),
    ('anthropic_claude-sonnet-4-5', 64000),
    ('anthropic_claude-3_5-haiku', 8192),
    ('anthropic_claude-haiku-4-5', 64000),
    ('anthropic_claude-opus-4', 32000),
    ('anthropic_claude-opus-4-5', 64000),
    ('cohere_command-r-plus', 4096),
    ('cohere_command-r', 4096),
    ('meta_llama3_1-8b', 2048),
    ('meta_llama3_1-70b', 2048),
    ('meta_llama3_3-70b', 2048),
    ('meta_llama3_2-1b', 2048),
    ('meta_llama3_2-3b', 2048),
    ('meta_llama3_2-11b', 2048),
    ('meta_llama3_2-90b', 2048),
    ('meta_llama4-scout-17b', 2048),
    ('meta_llama4-maverick-17b', 2048),
]


@pytest.fixture
def bedrock_startup(monkeypatch):
    """Use real configuration and node code with engine and transport stubs."""
    service = json5.loads((_ROOT / 'nodes/src/nodes/llm_bedrock/services.json').read_text())

    def stub(name, **attrs):
        module = types.ModuleType(name)
        module.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, module)
        return module

    def load(name, path):
        spec = importlib.util.spec_from_file_location(name, _ROOT / path)
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, name, module)
        spec.loader.exec_module(module)
        return module

    class IJson(dict):
        @staticmethod
        def toDict(value):
            return value

    def noop(*args, **kwargs):
        pass

    stub('rocketlib', debug=noop, warning=noop, IJson=IJson, IGlobalBase=object, getServiceDefinition=lambda _: service)
    stub('ai')
    stub('ai.common')
    load('ai.common.config', 'packages/ai/src/ai/common/config.py')
    load('ai.common.validation', 'packages/ai/src/ai/common/validation.py')
    stub('ai.common.schema', Answer=dict, Question=dict)
    stub('ai.common.util', ThinkTruncatedError=RuntimeError, parseJson=json.loads)
    stub(
        'ai.common.llm_native_stream',
        STOP_SEQUENCES_VAR=ContextVar('stop', default=None),
        dispatch_native_chat_stream=noop,
    )
    stub('ai.common.llm_adapter', LangChainAdapter=object, NativeOpenAIResponsesAdapter=object, drive_adapter=noop)
    load('ai.common.chat', 'packages/ai/src/ai/common/chat.py')

    class ChatBedrock:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    stub('langchain_aws', ChatBedrock=ChatBedrock)
    stub('depends', depends=noop)
    package = stub('_bedrock_catalogue_test')
    package.__path__ = [str(_ROOT / 'nodes/src/nodes/llm_bedrock')]
    load('_bedrock_catalogue_test.bedrock', 'nodes/src/nodes/llm_bedrock/bedrock.py')
    global_type = load('_bedrock_catalogue_test.IGlobal', 'nodes/src/nodes/llm_bedrock/IGlobal.py').IGlobal

    def start(raw):
        original = copy.deepcopy(raw)
        original_service = copy.deepcopy(service)
        node = global_type()
        bag = {}
        node.glb = types.SimpleNamespace(logicalType='llm_bedrock', connConfig=raw)
        node.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(bag=bag))
        node.beginGlobal()
        assert node._chat is bag['chat']
        assert raw == original
        assert service == original_service
        return node._chat

    return start, service


@pytest.mark.parametrize(('profile', 'limit'), _LIMITS)
def test_bedrock_startup_uses_selected_profile_limits(bedrock_startup, profile, limit):
    start, service = bedrock_startup
    selected = service['preconfig']['profiles'][profile]
    chat = start({'profile': profile, profile: {'accessKey': 'access', 'secretKey': 'secret', 'region': 'eu-west-1'}})
    assert chat._modelTotalTokens == selected['modelTotalTokens']
    assert chat._modelOutputTokens == limit
    assert chat._llm.kwargs == {
        'model': 'eu.' + selected['model'],
        'aws_access_key_id': 'access',
        'aws_secret_access_key': 'secret',
        'region': 'eu-west-1',
        'temperature': 0,
        'max_tokens': limit,
    }


def test_bedrock_custom_keeps_missing_output_fallback(bedrock_startup):
    start, _ = bedrock_startup
    chat = start(
        {
            'profile': 'custom',
            'custom': {'model': 'vendor.custom-v1', 'accessKey': 'a', 'secretKey': 's', 'region': 'us-east-1'},
        }
    )
    assert chat._llm.kwargs['model'] == 'us.vendor.custom-v1'
    assert chat._llm.kwargs['max_tokens'] == 4096
    assert chat._modelTotalTokens == 256000


def test_bedrock_default_profile_limit(bedrock_startup):
    start, service = bedrock_startup
    default = service['preconfig']['default']
    chat = start({default: {'accessKey': 'a', 'secretKey': 's', 'region': 'us-east-1'}})
    assert chat._llm.kwargs['model'] == 'us.' + service['preconfig']['profiles'][default]['model']
    assert chat._llm.kwargs['max_tokens'] == 2048


def test_bedrock_custom_top_level_overrides(bedrock_startup):
    start, _ = bedrock_startup
    chat = start(
        {
            'profile': 'custom',
            'custom': {
                'model': 'vendor.custom-v1',
                'modelOutputTokens': 8192,
                'accessKey': 'nested',
                'secretKey': 'nested',
                'region': 'us-east-1',
            },
            'modelOutputTokens': 6144,
            'accessKey': 'top',
            'secretKey': 'top-secret',
            'region': 'ap-south-1',
        }
    )
    assert chat._llm.kwargs['max_tokens'] == 6144
    assert chat._llm.kwargs['aws_access_key_id'] == 'top'
    assert chat._llm.kwargs['aws_secret_access_key'] == 'top-secret'
    assert chat._llm.kwargs['region'] == 'ap-south-1'
    assert chat._llm.kwargs['model'] == 'apac.vendor.custom-v1'


def test_bedrock_manual_limit_is_clamped_to_context(bedrock_startup):
    start, _ = bedrock_startup
    chat = start(
        {
            'profile': 'custom',
            'custom': {
                'model': 'vendor.custom-v1',
                'modelTotalTokens': 4096,
                'modelOutputTokens': 8192,
                'region': 'us-east-1',
            },
        }
    )
    assert chat._llm.kwargs['max_tokens'] == 4096


def test_bedrock_rejects_nonpositive_manual_output(bedrock_startup):
    start, _ = bedrock_startup
    with pytest.raises(ValueError):
        start(
            {
                'profile': 'custom',
                'custom': {'model': 'vendor.custom-v1', 'modelOutputTokens': 0, 'region': 'us-east-1'},
            }
        )
