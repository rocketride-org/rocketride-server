# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for guard-node enforcement in ``AgentHostServices`` (host.py).

Covers the control-plane guard attachment from issue #1792: a ``guard`` node
attached via ``control`` to an agent should gate every tool call the agent
makes (args pre-check, result post-check) and every persistent-memory
read/write (``Memory.put``/``get``/``list``), without needing a lane
connection between the guarded channel and the guard.

The real ``rocketlib``/``rocketlib.types`` require the compiled C++ engine
(``engLib``), which isn't available in a plain test environment. This stubs
both modules with lightweight equivalents so ``host.py`` can be exercised in
isolation — the same technique ``nodes/test/guardrails/test_all.py`` uses for
``IInstance.py``.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types

import pytest

_HOST_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    '..',
    '..',
    '..',
    '..',
    '..',
    'src',
    'ai',
    'common',
    'agent',
    '_internal',
    'host.py',
)


class _IInvokeOp:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def _make_rocketlib_stubs():
    """Build minimal `rocketlib` / `rocketlib.types` stand-ins for host.py."""
    rocketlib_stub = types.ModuleType('rocketlib')
    rocketlib_stub.ToolDescriptor = dict

    rocketlib_types_stub = types.ModuleType('rocketlib.types')

    class IInvokeTool:
        class Query(_IInvokeOp):
            def __init__(self, **kwargs):
                super().__init__(tools=[], **kwargs)

        class Invoke(_IInvokeOp):
            def __init__(self, **kwargs):
                super().__init__(output=None, **kwargs)

        class Validate(_IInvokeOp):
            pass

    class IInvokeMemory:
        class Put(_IInvokeOp):
            pass

        class Get(_IInvokeOp):
            pass

        class List(_IInvokeOp):
            pass

        class Clear(_IInvokeOp):
            pass

    class IInvokeGuard:
        class Check(_IInvokeOp):
            def __init__(self, **kwargs):
                super().__init__(result=None, **kwargs)

    rocketlib_types_stub.IInvokeOp = _IInvokeOp
    rocketlib_types_stub.IInvokeTool = IInvokeTool
    rocketlib_types_stub.IInvokeMemory = IInvokeMemory
    rocketlib_types_stub.IInvokeGuard = IInvokeGuard

    return rocketlib_stub, rocketlib_types_stub, IInvokeTool, IInvokeGuard


def _safe_str(value):
    """Mirror ai.common.utils.string_utils.safe_str exactly."""
    if value is None:
        return ''
    try:
        return str(value)
    except Exception:
        return ''


def _make_ai_utils_stub():
    """Build a minimal `ai`/`ai.common`/`ai.common.utils` stand-in exposing `safe_str`.

    Importing the real package pulls in `ai/__init__.py`'s `from depends import
    depends`, which needs the compiled engine's dependency-loader -- not
    available in a plain test environment. `safe_str` itself has no such
    dependency, so this stub reimplements it verbatim rather than pulling in
    the whole package.
    """
    ai_stub = types.ModuleType('ai')
    ai_common_stub = types.ModuleType('ai.common')
    ai_common_utils_stub = types.ModuleType('ai.common.utils')
    ai_common_utils_stub.safe_str = _safe_str
    return ai_stub, ai_common_stub, ai_common_utils_stub


@pytest.fixture
def host_module(monkeypatch):
    """Load host.py directly from disk with rocketlib/ai.common.utils stubbed out.

    Loaded by file path (not `import ai.common.agent._internal.host`) so
    this doesn't have to drag in the rest of the `ai` package's real
    dependencies (`depends`, model-server extras, etc.) — host.py itself
    only imports stdlib plus `rocketlib`/`rocketlib.types`/`ai.common.utils.safe_str`.
    """
    rocketlib_stub, rocketlib_types_stub, _IInvokeTool, _IInvokeGuard = _make_rocketlib_stubs()
    ai_stub, ai_common_stub, ai_common_utils_stub = _make_ai_utils_stub()

    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib_stub)
    monkeypatch.setitem(sys.modules, 'rocketlib.types', rocketlib_types_stub)
    monkeypatch.setitem(sys.modules, 'ai', ai_stub)
    monkeypatch.setitem(sys.modules, 'ai.common', ai_common_stub)
    monkeypatch.setitem(sys.modules, 'ai.common.utils', ai_common_utils_stub)

    spec = importlib.util.spec_from_file_location('_test_host_guard_module', _HOST_PATH)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)

    yield module


class _FakeInstance:
    """Stand-in for the engine `IInstance` (`pSelf`) that Tools talks to."""

    def __init__(self, *, tool_nodes, guard_nodes, tool_descriptor, tool_output, guard_check):
        self._tool_nodes = tool_nodes
        self._guard_nodes = guard_nodes
        self._tool_descriptor = tool_descriptor
        self._tool_output = tool_output
        self._guard_check = guard_check
        self.tool_invoked = False

    def getControllerNodeIds(self, class_type):
        if class_type == 'tool':
            return list(self._tool_nodes)
        if class_type == 'guard':
            return list(self._guard_nodes)
        return []

    def invoke(self, param, component_id=''):
        type_name = type(param).__qualname__
        if type_name.endswith('Query'):
            param.tools.append(self._tool_descriptor)
            return None
        if type_name.endswith('Invoke') and hasattr(param, 'tool_name') and hasattr(param, 'input'):
            self.tool_invoked = True
            param.output = self._tool_output
            return param
        if type_name.endswith('Check'):
            param.result = self._guard_check(param.mode, param.text)
            return param
        raise AssertionError(f'unexpected invoke param: {param!r}')


def _build_tools(host_module, *, guard_nodes, guard_check, tool_output='ok'):
    instance = _FakeInstance(
        tool_nodes=['tool_slack_1'],
        guard_nodes=guard_nodes,
        tool_descriptor={'name': 'send_message', 'description': 'Send a message'},
        tool_output=tool_output,
        guard_check=guard_check,
    )
    invoker = types.SimpleNamespace(instance=instance)
    tools = host_module.AgentHostServices.Tools(invoker, guard_nodes)
    tool_name = next(iter(tools._tool_list))
    return tools, instance, tool_name


def _pass_result():
    return {'action': 'pass', 'violations': []}


def _block_result(rule='pii_leak'):
    return {'action': 'block', 'violations': [{'rule': rule, 'details': 'blocked for test'}]}


def _warn_result(rule='pii_leak'):
    return {'action': 'warn', 'violations': [{'rule': rule, 'details': 'warned for test'}]}


class TestNoGuardAttached:
    def test_invoke_runs_normally_without_guard_nodes(self, host_module):
        tools, instance, tool_name = _build_tools(
            host_module, guard_nodes=[], guard_check=lambda mode, text: pytest.fail('guard should not run')
        )

        output = tools.invoke(tool_name, {'text': 'hello'})

        assert output == 'ok'
        assert instance.tool_invoked is True


class TestGuardBlocksArgs:
    def test_block_on_args_prevents_tool_call(self, host_module):
        calls = []

        def guard_check(mode, text):
            calls.append(mode)
            return _block_result() if mode == 'output' else _pass_result()

        tools, instance, tool_name = _build_tools(host_module, guard_nodes=['guardrails_1'], guard_check=guard_check)

        with pytest.raises(ValueError, match='Guardrails blocked'):
            tools.invoke(tool_name, {'text': 'email me at john.doe@example.com'})

        assert instance.tool_invoked is False, 'tool must never run once the pre-check blocks'
        assert calls == ['output'], 'only the pre-check should run before a block'


class TestGuardBlocksResult:
    def test_block_on_result_still_raises_after_tool_ran(self, host_module):
        calls = []

        def guard_check(mode, text):
            calls.append(mode)
            return _block_result() if mode == 'input' else _pass_result()

        tools, instance, tool_name = _build_tools(host_module, guard_nodes=['guardrails_1'], guard_check=guard_check)

        with pytest.raises(ValueError, match='Guardrails blocked'):
            tools.invoke(tool_name, {'text': 'safe args'})

        # The tool already ran (its side effect can't be undone), but the
        # caller still sees a failure instead of the (unsafe) output.
        assert instance.tool_invoked is True
        assert calls == ['output', 'input']


class TestGuardPassesBothChecks:
    def test_clean_call_runs_both_checks_and_returns_output(self, host_module):
        calls = []

        def guard_check(mode, text):
            calls.append(mode)
            return _pass_result()

        tools, instance, tool_name = _build_tools(
            host_module, guard_nodes=['guardrails_1'], guard_check=guard_check, tool_output='sent'
        )

        output = tools.invoke(tool_name, {'text': 'hello team'})

        assert output == 'sent'
        assert instance.tool_invoked is True
        assert calls == ['output', 'input']

    def test_warn_action_does_not_block(self, host_module):
        tools, instance, tool_name = _build_tools(
            host_module, guard_nodes=['guardrails_1'], guard_check=lambda mode, text: _warn_result(), tool_output='sent'
        )

        output = tools.invoke(tool_name, {'text': 'hello team'})

        assert output == 'sent'
        assert instance.tool_invoked is True


class TestGuardFailsClosedOnMalformedResult:
    """A guard node that doesn't set a recognized `action` must fail closed, not silently disable enforcement."""

    def test_missing_action_blocks(self, host_module):
        tools, instance, tool_name = _build_tools(
            host_module, guard_nodes=['guardrails_1'], guard_check=lambda mode, text: {}
        )

        with pytest.raises(ValueError, match='no recognized action'):
            tools.invoke(tool_name, {'text': 'hello team'})

        assert instance.tool_invoked is False

    def test_unrecognized_action_blocks(self, host_module):
        tools, instance, tool_name = _build_tools(
            host_module,
            guard_nodes=['guardrails_1'],
            guard_check=lambda mode, text: {'action': 'allow', 'violations': []},
        )

        with pytest.raises(ValueError, match='no recognized action'):
            tools.invoke(tool_name, {'text': 'hello team'})

        assert instance.tool_invoked is False

    @pytest.mark.parametrize('malformed_result', [[], ['block'], 'block', None, 42])
    def test_non_mapping_result_blocks_without_crashing(self, host_module, malformed_result):
        """A guard result that isn't a dict must fail closed with ValueError, not AttributeError."""
        tools, instance, tool_name = _build_tools(
            host_module, guard_nodes=['guardrails_1'], guard_check=lambda mode, text: malformed_result
        )

        with pytest.raises(ValueError, match='no recognized action'):
            tools.invoke(tool_name, {'text': 'hello team'})

        assert instance.tool_invoked is False

    def test_block_with_non_list_violations_does_not_crash(self, host_module):
        tools, instance, tool_name = _build_tools(
            host_module,
            guard_nodes=['guardrails_1'],
            guard_check=lambda mode, text: {'action': 'block', 'violations': 'not a list'},
        )

        with pytest.raises(ValueError, match='Guardrails blocked'):
            tools.invoke(tool_name, {'text': 'hello team'})

        assert instance.tool_invoked is False

    def test_block_with_non_dict_violation_items_does_not_crash(self, host_module):
        tools, instance, tool_name = _build_tools(
            host_module,
            guard_nodes=['guardrails_1'],
            guard_check=lambda mode, text: {'action': 'block', 'violations': ['pii_leak', 123]},
        )

        with pytest.raises(ValueError, match='Guardrails blocked.*pii_leak, 123'):
            tools.invoke(tool_name, {'text': 'hello team'})

        assert instance.tool_invoked is False


# ---------------------------------------------------------------------------
# Memory guard coverage
# ---------------------------------------------------------------------------


class _FakeMemoryInstance:
    """Stand-in for the engine `IInstance` that `Memory` talks to."""

    def __init__(self, *, guard_nodes, store, guard_check):
        self._guard_nodes = guard_nodes
        self._store = store
        self._guard_check = guard_check
        self.memory_invoked = []

    def getControllerNodeIds(self, class_type):
        if class_type == 'guard':
            return list(self._guard_nodes)
        return []

    def invoke(self, param, component_id=''):
        type_name = type(param).__qualname__
        if type_name.endswith('Check'):
            param.result = self._guard_check(param.mode, param.text)
            return param
        if type_name.endswith('Put'):
            self.memory_invoked.append('put')
            self._store[param.input['key']] = param.input['value']
            param.output = {'ok': True}
            return param
        if type_name.endswith('Get'):
            self.memory_invoked.append('get')
            param.output = {'value': self._store.get(param.input['key'])}
            return param
        if type_name.endswith('List'):
            self.memory_invoked.append('list')
            param.output = {'keys': list(self._store.keys())}
            return param
        if type_name.endswith('Clear'):
            self.memory_invoked.append('clear')
            param.output = {'ok': True}
            return param
        raise AssertionError(f'unexpected invoke param: {param!r}')


def _build_memory(host_module, *, guard_nodes, guard_check, store=None):
    instance = _FakeMemoryInstance(
        guard_nodes=guard_nodes, store=store if store is not None else {}, guard_check=guard_check
    )
    invoker = types.SimpleNamespace(instance=instance)
    memory = host_module.AgentHostServices.Memory(invoker, 'memory_1', guard_nodes)
    return memory, instance


class TestMemoryNoGuardAttached:
    def test_put_runs_normally_without_guard_nodes(self, host_module):
        memory, instance = _build_memory(
            host_module, guard_nodes=[], guard_check=lambda mode, text: pytest.fail('guard should not run')
        )

        memory.put('k', 'value')

        assert instance.memory_invoked == ['put']
        assert instance._store['k'] == 'value'


class TestMemoryGuardPut:
    def test_block_prevents_write(self, host_module):
        calls = []

        def guard_check(mode, text):
            calls.append(mode)
            return _block_result()

        memory, instance = _build_memory(host_module, guard_nodes=['guardrails_1'], guard_check=guard_check)

        with pytest.raises(ValueError, match='Guardrails blocked'):
            memory.put('secret', 'email me at john.doe@example.com')

        assert instance.memory_invoked == [], 'the write must never happen once the pre-check blocks'
        assert calls == ['output']

    def test_clean_value_writes_through(self, host_module):
        memory, instance = _build_memory(
            host_module, guard_nodes=['guardrails_1'], guard_check=lambda mode, text: _pass_result()
        )

        memory.put('k', 'safe value')

        assert instance.memory_invoked == ['put']
        assert instance._store['k'] == 'safe value'


class TestMemoryGuardGet:
    def test_block_on_stored_value_after_read(self, host_module):
        calls = []

        def guard_check(mode, text):
            calls.append(mode)
            return _block_result()

        memory, instance = _build_memory(
            host_module, guard_nodes=['guardrails_1'], guard_check=guard_check, store={'k': 'poisoned content'}
        )

        with pytest.raises(ValueError, match='Guardrails blocked'):
            memory.get('k')

        # The read already happened (can't un-read from the store), but the
        # caller still sees a failure instead of the poisoned value.
        assert instance.memory_invoked == ['get']
        assert calls == ['input']

    def test_clean_value_returned(self, host_module):
        memory, instance = _build_memory(
            host_module,
            guard_nodes=['guardrails_1'],
            guard_check=lambda mode, text: _pass_result(),
            store={'k': 'safe value'},
        )

        output = memory.get('k')

        assert output == {'value': 'safe value'}


class TestMemoryGuardList:
    def test_block_on_list_result(self, host_module):
        memory, instance = _build_memory(
            host_module,
            guard_nodes=['guardrails_1'],
            guard_check=lambda mode, text: _block_result(),
            store={'a': '1'},
        )

        with pytest.raises(ValueError, match='Guardrails blocked'):
            memory.list()

        assert instance.memory_invoked == ['list']


class TestMemoryClearIsUnguarded:
    """clear() carries no content to check -- deletion, not a content flow."""

    def test_clear_runs_without_a_guard_check(self, host_module):
        memory, instance = _build_memory(
            host_module,
            guard_nodes=['guardrails_1'],
            guard_check=lambda mode, text: pytest.fail('guard should not run for clear()'),
        )

        memory.clear('k')

        assert instance.memory_invoked == ['clear']
