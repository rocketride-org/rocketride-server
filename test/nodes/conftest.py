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

"""Shared pytest fixtures and mock infrastructure for pipeline node tests.

All node tests rely on heavy mocking because the real rocketlib, ai.common,
and provider SDKs are native/C++ or require live credentials.  This conftest
installs the mock modules into ``sys.modules`` before any node code is imported,
ensuring that ``from rocketlib import ...`` and ``from ai.common...`` resolve
to lightweight test doubles.

Mock installation happens at module scope (import time) so that test module
imports can resolve.  A session-scoped autouse fixture restores the original
``sys.modules`` entries on teardown, preventing test bleed between files.
"""

import os as _os
import sys
import types
import enum
from unittest.mock import MagicMock
import pytest


# ---------------------------------------------------------------------------
# Module names that will be mocked in sys.modules
# ---------------------------------------------------------------------------

_MOCKED_MODULE_NAMES = [
    'engLib',
    'rocketlib',
    'rocketlib.types',
    'ai',
    'ai.common',
    'ai.common.schema',
    'ai.common.config',
    'ai.common.chat',
    'ai.common.embedding',
    'ai.common.tools',
    'ai.common.store',
    'ai.common.transform',
    'ai.common.agent',
    'ai.common.agent._internal',
    'ai.common.agent._internal.host',
    'ai.common.agent.types',
    'depends',
]

# Save originals *before* any mutation so teardown can restore them.
_original_modules = {name: sys.modules[name] for name in _MOCKED_MODULE_NAMES if name in sys.modules}


# ---------------------------------------------------------------------------
# 1. Mock: engLib (C++ bridge)
# ---------------------------------------------------------------------------


class MockEntry:
    """Minimal stand-in for engLib.Entry."""

    objectId = 'test-object-id'
    hasVectorBatchId = False
    vectorBatchId = None


class MockFilters:
    """Minimal stand-in for engLib.Filters."""


_mock_englib = types.ModuleType('engLib')
_mock_englib.Entry = MockEntry
_mock_englib.Filters = MockFilters
sys.modules['engLib'] = _mock_englib


# ---------------------------------------------------------------------------
# 2. Mock: rocketlib
# ---------------------------------------------------------------------------


class OPEN_MODE(enum.Enum):
    """Simulates rocketlib.OPEN_MODE."""

    CONFIG = 'config'
    READ = 'read'
    WRITE = 'write'


class IGlobalBase:
    """Minimal base for IGlobal classes."""

    def __init__(self):
        """Initialize."""
        self.glb = MagicMock()
        self.IEndpoint = MagicMock()


class IInstanceBase:
    """Minimal base for IInstance classes."""

    def __init__(self):
        """Initialize."""
        self.instance = MagicMock()
        self.IGlobal = MagicMock()

    def preventDefault(self):
        pass


class IInvokeLLM:
    """Simulates rocketlib.types.IInvokeLLM."""

    def __init__(self, op='ask', question=None):
        """Initialize."""
        self.op = op
        self.question = question


_warned_messages = []


def _mock_warning(msg):
    _warned_messages.append(msg)


def _mock_debug(msg):
    pass


# Build the rocketlib module tree
_mock_rocketlib = types.ModuleType('rocketlib')
_mock_rocketlib.IGlobalBase = IGlobalBase
_mock_rocketlib.IInstanceBase = IInstanceBase
_mock_rocketlib.OPEN_MODE = OPEN_MODE
_mock_rocketlib.Entry = MockEntry
_mock_rocketlib.warning = _mock_warning
_mock_rocketlib.debug = _mock_debug

_mock_rocketlib_types = types.ModuleType('rocketlib.types')
_mock_rocketlib_types.IInvokeLLM = IInvokeLLM

sys.modules['rocketlib'] = _mock_rocketlib
sys.modules['rocketlib.types'] = _mock_rocketlib_types


# ---------------------------------------------------------------------------
# 3. Mock: ai.common tree
# ---------------------------------------------------------------------------


class MockQuestion:
    """Simulates ai.common.schema.Question."""

    def __init__(self, text='test question'):
        """Initialize."""
        self.questions = [MagicMock(text=text, embedding=None, embedding_model=None)]
        self.role = ''
        self.expectJson = False
        self.goals = []

    def addGoal(self, text):
        self.goals.append(text)

    def addInstruction(self, name, body):
        pass

    def addContext(self, ctx):
        pass

    def addQuestion(self, text):
        self.questions.append(MagicMock(text=text, embedding=None, embedding_model=None))

    def model_copy(self, deep=False):
        import copy

        return copy.deepcopy(self) if deep else copy.copy(self)

    def getPrompt(self):
        return 'mock prompt'


class MockAnswer:
    """Simulates ai.common.schema.Answer."""

    def __init__(self, text='mock answer'):
        """Initialize."""
        self.text = text

    def getJson(self):
        return {}


class MockDoc:
    """Simulates ai.common.schema.Doc."""

    def __init__(self, page_content='test content', metadata=None):
        """Initialize."""
        self.page_content = page_content
        self.metadata = metadata or {}
        self.embedding = None
        self.embedding_model = None


class MockConfig:
    """Simulates ai.common.config.Config."""

    _configs = {}

    @classmethod
    def getNodeConfig(cls, logical_type, conn_config):
        return cls._configs.get(logical_type, conn_config or {})

    @classmethod
    def set_config(cls, logical_type, config):
        cls._configs[logical_type] = config

    @classmethod
    def reset(cls):
        cls._configs = {}


class MockChatBase:
    """Simulates ai.common.chat.ChatBase."""

    def __init__(self, provider=None, connConfig=None, bag=None):
        """Initialize."""
        self._model = 'test-model'
        self._modelOutputTokens = 1024
        self._modelTotalTokens = 4096

    def chat(self, question):
        return MockAnswer()

    def getTotalTokens(self):
        return self._modelTotalTokens

    def getOutputTokens(self):
        return self._modelOutputTokens

    def getTokens(self, text):
        return len(text.split())


class MockEmbeddingBase:
    """Simulates ai.common.embedding.EmbeddingBase."""

    def __init__(self, provider=None, connConfig=None, bag=None):
        """Initialize."""
        pass

    def encodeChunks(self, documents):
        pass

    def encodeQuestion(self, question):
        pass


class MockToolsBase:
    """Simulates ai.common.tools.ToolsBase."""

    def handle_invoke(self, param):
        op = param.get('op') if isinstance(param, dict) else getattr(param, 'op', None)
        if op == 'tool.query':
            return self._tool_query()
        elif op == 'tool.validate':
            return self._tool_validate(tool_name=param.get('tool'), input_obj=param.get('input'))
        elif op == 'tool.invoke':
            return self._tool_invoke(tool_name=param.get('tool'), input_obj=param.get('input'))
        return None


class MockIGlobalTransform(IGlobalBase):
    """Simulates ai.common.transform.IGlobalTransform."""

    def beginGlobal(self, subKey=None):
        pass

    def getConnConfig(self):
        return getattr(self.glb, 'connConfig', {})


class MockIInstanceTransform(IInstanceBase):
    """Simulates ai.common.transform.IInstanceTransform."""


class MockIEndpointTransform:
    """Simulates ai.common.transform.IEndpointTransform."""


class MockAgentHostServices:
    """Simulates ai.common.agent._internal.host.AgentHostServices."""

    def __init__(self, instance=None):
        """Initialize."""
        self.llm = MagicMock()
        self.tools = MagicMock()
        self.memory = MagicMock()


# Build the ai.common module tree
_ai = types.ModuleType('ai')
_ai_common = types.ModuleType('ai.common')
_ai_common_schema = types.ModuleType('ai.common.schema')
_ai_common_schema.Question = MockQuestion
_ai_common_schema.Answer = MockAnswer
_ai_common_schema.Doc = MockDoc
_ai_common_schema.DocFilter = MagicMock()
_ai_common_schema.DocMetadata = MagicMock()
_ai_common_schema.QuestionText = MagicMock()

_ai_common_config = types.ModuleType('ai.common.config')
_ai_common_config.Config = MockConfig

_ai_common_chat = types.ModuleType('ai.common.chat')
_ai_common_chat.ChatBase = MockChatBase

_ai_common_embedding = types.ModuleType('ai.common.embedding')
_ai_common_embedding.EmbeddingBase = MockEmbeddingBase

_ai_common_tools = types.ModuleType('ai.common.tools')
_ai_common_tools.ToolsBase = MockToolsBase

_ai_common_store = types.ModuleType('ai.common.store')
_ai_common_store.DocumentStoreBase = MagicMock()

_ai_common_transform = types.ModuleType('ai.common.transform')
_ai_common_transform.IGlobalTransform = MockIGlobalTransform
_ai_common_transform.IInstanceTransform = MockIInstanceTransform
_ai_common_transform.IEndpointTransform = MockIEndpointTransform

_ai_common_agent = types.ModuleType('ai.common.agent')
_ai_common_agent.safe_str = lambda x: str(x) if x is not None else ''

_ai_common_agent_internal = types.ModuleType('ai.common.agent._internal')
_ai_common_agent_internal_host = types.ModuleType('ai.common.agent._internal.host')
_ai_common_agent_internal_host.AgentHostServices = MockAgentHostServices

_ai_common_agent_types = types.ModuleType('ai.common.agent.types')


class MockAgentInput:
    def __init__(self, question=None):
        """Initialize."""
        self.question = question or MockQuestion()


class MockAgentHost:
    def __init__(self):
        """Initialize."""
        self.llm = MagicMock()
        self.tools = MagicMock()
        self.memory = MagicMock()


_ai_common_agent_types.AgentInput = MockAgentInput
_ai_common_agent_types.AgentHost = MockAgentHost

sys.modules['ai'] = _ai
sys.modules['ai.common'] = _ai_common
sys.modules['ai.common.schema'] = _ai_common_schema
sys.modules['ai.common.config'] = _ai_common_config
sys.modules['ai.common.chat'] = _ai_common_chat
sys.modules['ai.common.embedding'] = _ai_common_embedding
sys.modules['ai.common.tools'] = _ai_common_tools
sys.modules['ai.common.store'] = _ai_common_store
sys.modules['ai.common.transform'] = _ai_common_transform
sys.modules['ai.common.agent'] = _ai_common_agent
sys.modules['ai.common.agent._internal'] = _ai_common_agent_internal
sys.modules['ai.common.agent._internal.host'] = _ai_common_agent_internal_host
sys.modules['ai.common.agent.types'] = _ai_common_agent_types

# ---------------------------------------------------------------------------
# 4. Mock: depends module
# ---------------------------------------------------------------------------

_mock_depends = types.ModuleType('depends')
_mock_depends.depends = lambda *a, **kw: None
sys.modules['depends'] = _mock_depends

# ---------------------------------------------------------------------------
# 5. Add nodes/src to sys.path so `from nodes.<node> import ...` resolves
#    to the real package on disk.  The `depends` mock above ensures the
#    `nodes/__init__.py` (which calls `depends(requirements)`) executes
#    without side-effects.
# ---------------------------------------------------------------------------

_nodes_src = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), '..', '..', 'nodes', 'src'))
if _nodes_src not in sys.path:
    sys.path.insert(0, _nodes_src)


# ---------------------------------------------------------------------------
# Session-scoped fixture: restore sys.modules on teardown
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True, scope='session')
def _restore_mock_modules():
    """Restore original sys.modules entries after the test session ends.

    The mocks are installed at module scope (above) so that test module
    imports resolve.  This fixture only handles cleanup, preventing the
    mocked entries from leaking into other test sessions or conftest
    scopes.
    """
    yield

    for mod_name in _MOCKED_MODULE_NAMES:
        if mod_name in _original_modules:
            sys.modules[mod_name] = _original_modules[mod_name]
        elif mod_name in sys.modules:
            del sys.modules[mod_name]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_warnings():
    """Clear captured warnings before each test."""
    _warned_messages.clear()
    yield
    _warned_messages.clear()


@pytest.fixture
def warned_messages():
    """Provide access to warning messages captured during the test."""
    return _warned_messages


@pytest.fixture
def mock_config():
    """Provide and reset the MockConfig singleton."""
    MockConfig.reset()
    yield MockConfig
    MockConfig.reset()


@pytest.fixture
def mock_glb():
    """Create a mock ``glb`` object with common attributes."""
    glb = MagicMock()
    glb.logicalType = 'test-node'
    glb.connConfig = {}
    return glb


@pytest.fixture
def mock_endpoint():
    """Create a mock IEndpoint with bag and openMode."""
    endpoint = MagicMock()
    endpoint.endpoint.openMode = OPEN_MODE.WRITE
    endpoint.endpoint.bag = {}
    return endpoint


@pytest.fixture
def mock_endpoint_config():
    """Create a mock IEndpoint in CONFIG mode."""
    endpoint = MagicMock()
    endpoint.endpoint.openMode = OPEN_MODE.CONFIG
    endpoint.endpoint.bag = {}
    return endpoint


@pytest.fixture
def mock_chat_response():
    """Provide a factory for creating mock chat responses."""

    def _factory(text='mock response'):
        return MockAnswer(text=text)

    return _factory


@pytest.fixture
def make_question():
    """Provide a factory for creating MockQuestion instances."""

    def _factory(text='test question'):
        return MockQuestion(text=text)

    return _factory


@pytest.fixture
def make_doc():
    """Provide a factory for creating MockDoc instances."""

    def _factory(page_content='test content', metadata=None):
        return MockDoc(page_content=page_content, metadata=metadata)

    return _factory
