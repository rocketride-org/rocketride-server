"""Agent-host tool catalog: re-query the owning node on a miss (issue #1402).

``AgentHostServices.Tools`` discovers every connected tool node once, at
construction, and is cached on the IInstance for its whole life. Before this
change a tool the model asked for that was not in that snapshot raised a bare
``ValueError('Tool X not found in tool catalog')`` — even when the owning node
(for example ``tool_mcp_client`` after its server grew a tool) could serve it —
and a weak planner narrates around that error instead of failing.

Now a miss re-queries the owning node once (the ``<node_id>.`` prefix of the
namespaced name), swaps that node's entries into the catalog atomically, and
only then raises ``ToolNotFoundError`` (a ``ValueError`` subclass, so existing
handlers still match) if the tool is still unknown.

``host.py`` is loaded from its file so the tests also run without a built
engine (the same approach as ``nodes/test/tool_mcp_client/test_mcp_agent_catalog.py``);
inside the engine the real ``rocketlib`` is used untouched.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from typing import Any, Dict, List

import pytest

_HOST_PY = Path(__file__).resolve().parents[4] / 'src' / 'ai' / 'common' / 'agent' / '_internal' / 'host.py'


def _ensure_rocketlib_stubs() -> None:
    """Provide the two rocketlib imports host.py needs when the engine is absent."""
    try:
        import rocketlib.types  # noqa: F401

        return
    except Exception:
        pass

    class IInvokeOp:
        pass

    class IInvokeTool(IInvokeOp):
        class Query(IInvokeOp):
            def __init__(self) -> None:
                self.tools: List[Any] = []

        class Invoke(IInvokeOp):
            def __init__(self, *, tool_name: str, input: Any) -> None:
                self.tool_name = tool_name
                self.input = input
                self.output = None

        class Validate(IInvokeOp):
            def __init__(self, *, tool_name: str, input: Any) -> None:
                self.tool_name = tool_name
                self.input = input

    class IInvokeMemory(IInvokeTool):
        pass

    rocketlib = sys.modules.get('rocketlib') or types.ModuleType('rocketlib')
    if not hasattr(rocketlib, 'ToolDescriptor'):
        rocketlib.ToolDescriptor = dict
    rl_types = types.ModuleType('rocketlib.types')
    rl_types.IInvokeOp = IInvokeOp
    rl_types.IInvokeTool = IInvokeTool
    rl_types.IInvokeMemory = IInvokeMemory
    rocketlib.types = rl_types
    sys.modules['rocketlib'] = rocketlib
    sys.modules['rocketlib.types'] = rl_types


_ensure_rocketlib_stubs()

_spec = importlib.util.spec_from_file_location('_rr_agent_host_under_test', _HOST_PY)
host = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = host
_spec.loader.exec_module(host)

Tools = host.AgentHostServices.Tools
ToolNotFoundError = host.ToolNotFoundError
IInvokeTool = host.IInvokeTool


class _FakeInstance:
    """Engine instance seam: one tool node whose catalog can change under the host."""

    def __init__(self, tools_by_node: Dict[str, List[Dict[str, Any]]]) -> None:
        self.tools_by_node = tools_by_node
        self.queries: List[str] = []
        self.invocations: List[tuple] = []
        self.validations: List[tuple] = []

    def getControllerNodeIds(self, kind: str) -> List[str]:
        return list(self.tools_by_node) if kind == 'tool' else []

    def invoke(self, param, component_id: str):
        if isinstance(param, IInvokeTool.Query):
            self.queries.append(component_id)
            param.tools.extend(dict(t) for t in self.tools_by_node.get(component_id, []))
            # Real tool nodes append their descriptors and raise PreventDefault;
            # the host swallows this and reads param.tools.
            raise RuntimeError('no node returned success')
        if isinstance(param, IInvokeTool.Invoke):
            self.invocations.append((component_id, param.tool_name, param.input))
            param.output = {'called': param.tool_name}
            return None
        if isinstance(param, IInvokeTool.Validate):
            self.validations.append((component_id, param.tool_name, param.input))
            return None
        raise AssertionError(f'unexpected op {param!r}')


class _FakeInvoker:
    def __init__(self, instance: _FakeInstance) -> None:
        self.instance = instance


def _descriptor(name: str) -> Dict[str, Any]:
    return {'name': name, 'description': f'{name} description', 'inputSchema': {'type': 'object', 'properties': {}}}


@pytest.fixture
def instance() -> _FakeInstance:
    return _FakeInstance({'n1': [_descriptor('srv.a')]})


@pytest.fixture
def tools(instance) -> Tools:
    return Tools(_FakeInvoker(instance))


class TestDiscovery:
    def test_construction_discovers_each_node_once_and_namespaces_by_node(self, instance, tools):
        assert instance.queries == ['n1']
        assert [d['name'] for d in tools.list] == ['n1.srv.a']
        assert tools.query() == tools.list

    def test_known_tool_invokes_without_re_query(self, instance, tools):
        assert tools.invoke('n1.srv.a', {'q': 1}) == {'called': 'srv.a'}
        assert instance.invocations == [('n1', 'srv.a', {'q': 1})]
        assert instance.queries == ['n1']


class TestMiss:
    def test_tool_added_on_the_node_after_discovery_is_found_and_invoked(self, instance, tools):
        instance.tools_by_node['n1'].append(_descriptor('srv.late'))

        assert tools.invoke('n1.srv.late', {'x': 2}) == {'called': 'srv.late'}

        assert instance.queries == ['n1', 'n1']
        assert instance.invocations == [('n1', 'srv.late', {'x': 2})]
        assert {d['name'] for d in tools.list} == {'n1.srv.a', 'n1.srv.late'}

    def test_get_and_validate_also_recover_after_a_miss(self, instance, tools):
        instance.tools_by_node['n1'].append(_descriptor('srv.late'))

        assert tools.get('n1.srv.late')['name'] == 'n1.srv.late'
        tools.validate('n1.srv.late', {'x': 1})

        assert instance.validations == [('n1', 'srv.late', {'x': 1})]
        # One re-query served both: get() refreshed, validate() hit the cache.
        assert instance.queries == ['n1', 'n1']

    def test_still_unknown_after_re_query_raises_tool_not_found(self, instance, tools):
        with pytest.raises(ToolNotFoundError) as exc:
            tools.invoke('n1.srv.ghost', {})

        assert isinstance(exc.value, ValueError)
        assert 'n1.srv.ghost' in str(exc.value)
        assert instance.queries == ['n1', 'n1']
        assert instance.invocations == []

    def test_unknown_node_prefix_does_not_query_anything(self, instance, tools):
        with pytest.raises(ToolNotFoundError):
            tools.invoke('nope.srv.a', {})

        assert instance.queries == ['n1']

    def test_a_miss_refresh_replaces_the_whole_node_entry_set(self, instance, tools):
        # The node swapped srv.a for srv.b: the miss on srv.b re-queries n1 and
        # the stale srv.a entry goes away with it. (A known name is still
        # served from the cache until then; the node itself is the authority at
        # call time — tool_mcp_client refuses a vanished tool loudly.)
        instance.tools_by_node['n1'] = [_descriptor('srv.b')]

        assert tools.invoke('n1.srv.b', {}) == {'called': 'srv.b'}

        assert [d['name'] for d in tools.list] == ['n1.srv.b']
        assert 'n1.srv.a' not in tools._tool_list

    def test_refresh_swaps_the_catalog_instead_of_mutating_it(self, instance, tools):
        old_catalog = tools._tool_list
        old_list = tools.list
        instance.tools_by_node['n1'].append(_descriptor('srv.late'))

        tools.get('n1.srv.late')

        assert set(old_catalog) == {'n1.srv.a'} and [d['name'] for d in old_list] == ['n1.srv.a']
        assert tools._tool_list is not old_catalog and tools.list is not old_list

    def test_refresh_only_touches_the_owning_node(self):
        instance = _FakeInstance({'n1': [_descriptor('srv.a')], 'n2': [_descriptor('other.z')]})
        tools = Tools(_FakeInvoker(instance))
        instance.tools_by_node['n2'].append(_descriptor('other.late'))

        tools.invoke('n2.other.late', {})

        assert instance.queries == ['n1', 'n2', 'n2']
        assert {d['name'] for d in tools.list} == {'n1.srv.a', 'n2.other.z', 'n2.other.late'}
