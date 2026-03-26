"""
Tests for MiniMax LLM provider.

Validates the MiniMax Chat class initialization, temperature clamping,
API key validation, and services.json configuration without requiring
a real API connection.
"""

import importlib
import importlib.util
import json
import json5
import os
import sys
import types
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------

_HERE = os.path.dirname(os.path.abspath(__file__))
_SRC_NODES = os.path.join(_HERE, '..', '..', 'src', 'nodes')
_MINIMAX_DIR = os.path.join(_SRC_NODES, 'llm_minimax')
_MINIMAX_MOD = os.path.join(_MINIMAX_DIR, 'minimax.py')
_SERVICES_JSON = os.path.join(_MINIMAX_DIR, 'services.json')
_IGLOBAL_MOD = os.path.join(_MINIMAX_DIR, 'IGlobal.py')

# Expected base URL for MiniMax API
MINIMAX_BASE_URL = 'https://api.minimax.io/v1'


# ---------------------------------------------------------------------------
# Helpers: load module with stubbed runtime deps
# ---------------------------------------------------------------------------

def _stub_modules():
    """Stub out heavy runtime dependencies so we can import the Chat class."""
    stub_names = [
        'ai', 'ai.common', 'ai.common.chat', 'ai.common.config',
        'langchain_openai', 'rocketlib',
    ]
    saved = {}
    for name in stub_names:
        saved[name] = sys.modules.get(name)
        stub = types.ModuleType(name)
        if name == 'ai.common.chat':
            # Provide a minimal ChatBase for subclassing
            class FakeChatBase:
                def __init__(self, provider, connConfig, bag):
                    self._model = 'MiniMax-M2.7'
                    self._modelTotalTokens = 1000000
                    self._modelOutputTokens = 4096
            stub.ChatBase = FakeChatBase
        if name == 'ai.common.config':
            class FakeConfig:
                @staticmethod
                def getNodeConfig(provider, connConfig):
                    return connConfig
            stub.Config = FakeConfig
        if name == 'langchain_openai':
            class FakeChatOpenAI:
                def __init__(self, **kwargs):
                    self.model = kwargs.get('model')
                    self.base_url = kwargs.get('base_url')
                    self.api_key = kwargs.get('api_key')
                    self.temperature = kwargs.get('temperature')
                    self.max_tokens = kwargs.get('max_tokens')
            stub.ChatOpenAI = FakeChatOpenAI
        if name == 'rocketlib':
            stub.IGlobalBase = type('IGlobalBase', (), {})
            stub.warning = lambda msg: None
        sys.modules[name] = stub
    return saved, stub_names


def _restore_modules(saved, stub_names):
    """Restore original sys.modules state."""
    for name in stub_names:
        if saved[name] is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = saved[name]


def _load_chat_class():
    """Load the Chat class from minimax.py with stubbed deps."""
    saved, stub_names = _stub_modules()
    try:
        spec = importlib.util.spec_from_file_location('_minimax', _MINIMAX_MOD)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.Chat, mod.MINIMAX_BASE_URL
    finally:
        _restore_modules(saved, stub_names)


Chat, LOADED_BASE_URL = _load_chat_class()


# ---- Tests for services.json configuration --------------------------------

class TestServicesJson:
    """Validate that services.json is well-formed and complete."""

    @pytest.fixture(autouse=True)
    def load_services(self):
        with open(_SERVICES_JSON, 'r') as f:
            self.services = json5.load(f)

    def test_title(self):
        assert self.services['title'] == 'MiniMax'

    def test_protocol(self):
        assert self.services['protocol'] == 'llm_minimax://'

    def test_class_type(self):
        assert self.services['classType'] == ['llm']

    def test_capabilities(self):
        assert 'invoke' in self.services['capabilities']

    def test_register(self):
        assert self.services['register'] == 'filter'

    def test_node_type(self):
        assert self.services['node'] == 'python'

    def test_path(self):
        assert self.services['path'] == 'nodes.llm_minimax'

    def test_prefix(self):
        assert self.services['prefix'] == 'llm'

    def test_has_description(self):
        desc = self.services.get('description', [])
        assert len(desc) > 0
        full = ''.join(desc)
        assert 'MiniMax' in full

    def test_has_documentation(self):
        assert 'documentation' in self.services

    def test_has_tile(self):
        tile = self.services.get('tile', [])
        assert len(tile) > 0
        assert 'llm_minimax' in tile[0]

    def test_lanes(self):
        assert self.services['lanes'] == {'questions': ['answers']}

    def test_input_output(self):
        inputs = self.services['input']
        assert len(inputs) == 1
        assert inputs[0]['lane'] == 'questions'
        assert inputs[0]['output'][0]['lane'] == 'answers'


class TestServicesJsonProfiles:
    """Validate that model profiles are correctly defined."""

    @pytest.fixture(autouse=True)
    def load_services(self):
        with open(_SERVICES_JSON, 'r') as f:
            self.services = json5.load(f)
        self.profiles = self.services['preconfig']['profiles']

    def test_default_profile_exists(self):
        default = self.services['preconfig']['default']
        assert default in self.profiles

    def test_m2_7_profile(self):
        p = self.profiles['minimax-m2_7']
        assert p['model'] == 'MiniMax-M2.7'
        assert p['modelTotalTokens'] == 1000000

    def test_m2_7_highspeed_profile(self):
        p = self.profiles['minimax-m2_7-highspeed']
        assert p['model'] == 'MiniMax-M2.7-highspeed'
        assert p['modelTotalTokens'] == 1000000

    def test_m2_5_profile(self):
        p = self.profiles['minimax-m2_5']
        assert p['model'] == 'MiniMax-M2.5'
        assert p['modelTotalTokens'] == 204000

    def test_m2_5_highspeed_profile(self):
        p = self.profiles['minimax-m2_5-highspeed']
        assert p['model'] == 'MiniMax-M2.5-highspeed'
        assert p['modelTotalTokens'] == 204000

    def test_custom_profile(self):
        p = self.profiles['custom']
        assert p['model'] == ''
        assert p['title'] == 'Custom Model'

    def test_all_cloud_profiles_have_apikey(self):
        for name, p in self.profiles.items():
            assert 'apikey' in p, f"Profile {name} missing apikey field"

    def test_profile_count(self):
        assert len(self.profiles) == 5


class TestServicesJsonFields:
    """Validate that UI field definitions are correct."""

    @pytest.fixture(autouse=True)
    def load_services(self):
        with open(_SERVICES_JSON, 'r') as f:
            self.services = json5.load(f)
        self.fields = self.services['fields']

    def test_profile_field_exists(self):
        assert 'minimax.profile' in self.fields

    def test_profile_field_default(self):
        assert self.fields['minimax.profile']['default'] == 'minimax-m2_7'

    def test_profile_field_enum_count(self):
        enum = self.fields['minimax.profile']['enum']
        assert len(enum) == 5  # custom + 4 models

    def test_profile_conditional_count(self):
        conds = self.fields['minimax.profile']['conditional']
        assert len(conds) == 5

    def test_custom_field_has_model_and_tokens(self):
        custom = self.fields['minimax.custom']
        props = custom['properties']
        assert 'model' in props
        assert 'modelTotalTokens' in props
        assert 'llm.cloud.apikey' in props

    def test_non_custom_fields_have_apikey(self):
        for key in ['minimax.minimax-m2_7', 'minimax.minimax-m2_7-highspeed',
                     'minimax.minimax-m2_5', 'minimax.minimax-m2_5-highspeed']:
            assert 'llm.cloud.apikey' in self.fields[key]['properties']


class TestServicesJsonTest:
    """Validate the test configuration in services.json."""

    @pytest.fixture(autouse=True)
    def load_services(self):
        with open(_SERVICES_JSON, 'r') as f:
            self.services = json5.load(f)
        self.test_config = self.services['test']

    def test_has_profiles(self):
        assert len(self.test_config['profiles']) > 0

    def test_has_outputs(self):
        assert 'answers' in self.test_config['outputs']

    def test_has_cases(self):
        assert len(self.test_config['cases']) > 0

    def test_first_case_has_expect(self):
        case = self.test_config['cases'][0]
        assert 'expect' in case
        assert 'answers' in case['expect']


# ---- Tests for Chat class initialization -----------------------------------

class TestChatInit:
    """Validate Chat class initialization and configuration."""

    def test_basic_init(self):
        config = {
            'model': 'MiniMax-M2.7',
            'apikey': 'test-key-123',
            'modelTotalTokens': 1000000,
            'modelOutputTokens': 4096,
        }
        bag = {}
        chat = Chat('llm_minimax', config, bag)
        assert bag['chat'] is chat
        assert chat._llm.api_key == 'test-key-123'
        assert chat._llm.base_url == MINIMAX_BASE_URL

    def test_missing_apikey_raises(self):
        config = {
            'model': 'MiniMax-M2.7',
            'apikey': '',
            'modelTotalTokens': 1000000,
            'modelOutputTokens': 4096,
        }
        with pytest.raises(ValueError, match='API key is required'):
            Chat('llm_minimax', config, {})

    def test_none_apikey_raises(self):
        config = {
            'model': 'MiniMax-M2.7',
            'apikey': None,
            'modelTotalTokens': 1000000,
            'modelOutputTokens': 4096,
        }
        with pytest.raises(ValueError, match='API key is required'):
            Chat('llm_minimax', config, {})


class TestTemperatureClamping:
    """Validate that temperature is properly clamped for MiniMax."""

    def _make_chat(self, temperature=None):
        config = {
            'model': 'MiniMax-M2.7',
            'apikey': 'test-key-123',
            'modelTotalTokens': 1000000,
            'modelOutputTokens': 4096,
        }
        if temperature is not None:
            config['temperature'] = temperature
        return Chat('llm_minimax', config, {})

    def test_zero_temperature_clamped(self):
        chat = self._make_chat(temperature=0)
        assert chat._llm.temperature >= 0.01

    def test_negative_temperature_clamped(self):
        chat = self._make_chat(temperature=-1)
        assert chat._llm.temperature >= 0.01

    def test_normal_temperature_preserved(self):
        chat = self._make_chat(temperature=0.7)
        assert chat._llm.temperature == 0.7

    def test_default_temperature_clamped(self):
        chat = self._make_chat()
        assert chat._llm.temperature >= 0.01

    def test_small_positive_temperature_preserved(self):
        chat = self._make_chat(temperature=0.5)
        assert chat._llm.temperature == 0.5


class TestBaseUrl:
    """Validate that the MiniMax base URL is correctly set."""

    def test_base_url_constant(self):
        assert LOADED_BASE_URL == MINIMAX_BASE_URL

    def test_chat_uses_correct_base_url(self):
        config = {
            'model': 'MiniMax-M2.7',
            'apikey': 'test-key-123',
            'modelTotalTokens': 1000000,
            'modelOutputTokens': 4096,
        }
        chat = Chat('llm_minimax', config, {})
        assert chat._llm.base_url == 'https://api.minimax.io/v1'


# ---- Tests for IGlobal error formatting -----------------------------------

class TestIGlobalErrorFormat:
    """Validate IGlobal._format_error helper."""

    @pytest.fixture(autouse=True)
    def load_iglobal(self):
        saved, stub_names = _stub_modules()
        try:
            spec = importlib.util.spec_from_file_location('_iglobal', _IGLOBAL_MOD)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            self.IGlobal = mod.IGlobal
        finally:
            _restore_modules(saved, stub_names)

    def _format(self, status, etype, emsg, fallback):
        inst = object.__new__(self.IGlobal)
        return inst._format_error(status, etype, emsg, fallback)

    def test_format_with_status_and_message(self):
        result = self._format(401, 'AuthError', 'Invalid API key', 'fallback')
        assert 'Error 401:' in result
        assert 'Invalid API key' in result

    def test_format_fallback_when_no_fields(self):
        result = self._format(None, None, None, 'some raw error')
        assert result == 'some raw error'

    def test_format_normalizes_whitespace(self):
        result = self._format(500, None, 'multi\n  line\t error', 'fallback')
        assert '\n' not in result
        assert '\t' not in result

    def test_format_status_only(self):
        result = self._format(429, None, None, 'fallback')
        assert result == 'Error 429:'


# ---- Tests for module exports ---------------------------------------------

class TestModuleExports:
    """Validate that __init__.py exports the expected symbols."""

    def test_init_exports(self):
        init_path = os.path.join(_MINIMAX_DIR, '__init__.py')
        with open(init_path, 'r') as f:
            content = f.read()
        assert 'IGlobal' in content
        assert 'IInstance' in content
        assert 'getChat' in content

    def test_iinstance_inherits_base(self):
        iinstance_path = os.path.join(_MINIMAX_DIR, 'IInstance.py')
        with open(iinstance_path, 'r') as f:
            content = f.read()
        assert 'IInstanceGenericLLM' in content

    def test_requirements_has_openai(self):
        req_path = os.path.join(_MINIMAX_DIR, 'requirements.txt')
        with open(req_path, 'r') as f:
            content = f.read()
        assert 'openai' in content
        assert 'langchain-openai' in content
