"""Unit tests for the tool call context (``ai.common.tool_context``) and its engine wiring.

The engine attaches a call context to every tool invoke so a node tool that
changes data can tell where the call came from:

- the DAP tool path (``DataConn._tool``) stamps origin ``'dap'``, the calling
  task's source type, whether a node was named, and the caller as the server
  sees it (``DataCommands.on_rrext_process`` overwrites any caller the client
  sent);
- the agent host stamps origin ``'agent'``;
- ``IInstanceBase._dispatch_tool`` reads the stamp from the invoke param and
  runs the tool method inside it, so the method reads it with
  ``current_tool_call()``. Nothing inside the tool ``input`` is ever read as
  context, and a call without a stamp never inherits an outer call's context.

These run in the engine's Python (``./engine -m pytest``) because they drive the
real ``rocketlib`` dispatcher.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

from rocketlib import IInstanceBase, tool_function
from rocketlib.types import IInvokeTool

from ai.common import tool_context
from ai.common.tool_context import (
    CALLER_AUTH_KINDS,
    TOOL_CONTEXT_FIELD,
    ToolCallContext,
    agent_context,
    caller_from_auth,
    context_from_stamp,
    current_tool_call,
    dap_context,
    no_tool_call,
    normalize_caller,
    read_stamp,
    stamp_param,
    tool_call,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

DAP_CALLER = {'auth': 'account', 'userId': 'user-1', 'teamId': 'team-1', 'orgId': 'org-1'}


def _dap(**overrides: Any) -> ToolCallContext:
    values: Dict[str, Any] = {'origin': 'dap', 'source_type': 'tools', 'targeted': True, 'caller': dict(DAP_CALLER)}
    values.update(overrides)
    return ToolCallContext(**values)


class _Probe(IInstanceBase):
    """A node with tools that report the context they ran under."""

    def __init__(self) -> None:
        self.IGlobal = SimpleNamespace(tool_description='')
        self.seen: List[Optional[ToolCallContext]] = []

    @tool_function(input_schema={'type': 'object', 'properties': {}}, description='Report the call context.')
    def whoami(self, args: Any) -> Dict[str, Any]:
        ctx = current_tool_call()
        self.seen.append(ctx)
        return {'context': None if ctx is None else ctx.origin}

    @tool_function(input_schema={'type': 'object', 'properties': {}}, description='Fail after reading the context.')
    def explode(self, args: Any) -> None:
        self.seen.append(current_tool_call())
        raise RuntimeError('boom')


class _DynamicProbe(IInstanceBase):
    """A node whose only tool is dynamic (the MCP client shape)."""

    def __init__(self) -> None:
        self.IGlobal = SimpleNamespace(tool_description='')
        self.seen: List[Optional[ToolCallContext]] = []

    def _tool_query_dynamic(self) -> list:
        return [{'name': 'remote_tool', 'description': 'd', 'inputSchema': {'type': 'object'}}]

    def _tool_invoke_dynamic(self, *, tool_name: str, input_obj: Any) -> Any:
        self.seen.append(current_tool_call())
        return {'ok': True}


def _invoke(node: IInstanceBase, tool: str, *, stamp: Any = None, input_obj: Any = None, as_dict: bool = False) -> Any:
    """Send a tool.invoke through the real dispatcher, optionally stamped."""
    if as_dict:
        param: Any = {'op': 'tool.invoke', 'tool_name': tool, 'input': input_obj if input_obj is not None else {}}
        if stamp is not None:
            param[TOOL_CONTEXT_FIELD] = stamp
    else:
        param = IInvokeTool.Invoke(tool_name=tool, input=input_obj if input_obj is not None else {})
        if stamp is not None:
            setattr(param, TOOL_CONTEXT_FIELD, stamp)
    node.invoke(param)
    return param


# ---------------------------------------------------------------------------
# The context variable
# ---------------------------------------------------------------------------


def test_no_context_outside_a_tool_call():
    """Outside any call there is no context."""
    assert current_tool_call() is None


def test_tool_call_sets_and_clears_the_context():
    """Inside tool_call() the context is visible; after it, it is gone."""
    ctx = _dap()
    with tool_call(ctx) as entered:
        assert entered is ctx
        assert current_tool_call() is ctx
    assert current_tool_call() is None


def test_tool_call_clears_the_context_when_the_body_raises():
    """An exception in the body still restores the previous (empty) context."""
    with pytest.raises(ValueError):
        with tool_call(_dap()):
            raise ValueError('body failed')
    assert current_tool_call() is None


def test_nested_tool_calls_restore_the_outer_context():
    """A nested call sees its own context; the outer one comes back afterwards."""
    outer = _dap()
    inner = agent_context()
    with tool_call(outer):
        with tool_call(inner):
            assert current_tool_call() is inner
        assert current_tool_call() is outer


def test_tool_call_rejects_anything_but_a_context():
    """tool_call() takes a ToolCallContext only; a dict is not accepted."""
    with pytest.raises(TypeError):
        with tool_call({'origin': 'dap'}):  # type: ignore[arg-type]
            pass


def test_no_tool_call_hides_an_outer_context():
    """no_tool_call() runs its body with no context and restores the outer one."""
    outer = _dap()
    with tool_call(outer):
        with no_tool_call():
            assert current_tool_call() is None
        assert current_tool_call() is outer


def test_context_does_not_leak_into_a_plain_thread():
    """A thread started inside a call does not see the caller's context."""
    seen: List[Optional[ToolCallContext]] = []
    with tool_call(_dap()):
        worker = threading.Thread(target=lambda: seen.append(current_tool_call()))
        worker.start()
        worker.join()
    assert seen == [None]


# ---------------------------------------------------------------------------
# Building and reading contexts
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'auth, expected',
    [
        ('pk_0123456789abcdef', 'public'),
        ('tk_0123456789abcdef', 'task'),
        ('local-acceptance-key', 'account'),
        ('rr_user_token', 'account'),
        ('', 'unknown'),
        (None, 'unknown'),
    ],
)
def test_caller_from_auth_maps_the_key_kind(auth, expected):
    """The caller kind follows the key the connection signed in with."""
    caller = caller_from_auth(auth, user_id='u', team_id='t', org_id='o')
    assert caller == {'auth': expected, 'userId': 'u', 'teamId': 't', 'orgId': 'o'}


def test_caller_from_auth_never_carries_the_key():
    """The caller block names the kind of key only, never the key itself."""
    caller = caller_from_auth('tk_secretvalue', user_id=None, team_id=None, org_id=None)
    assert 'tk_secretvalue' not in repr(caller)
    assert caller == {'auth': 'task', 'userId': None, 'teamId': None, 'orgId': None}


@pytest.mark.parametrize(
    'raw',
    [
        None,
        'account',
        ['account'],
        {},
        {'auth': 'root'},
        {'auth': 7},
        {'userId': 'u'},
    ],
)
def test_normalize_caller_turns_anything_unexpected_into_unknown(raw):
    """A missing or malformed caller is 'unknown', which no write path accepts."""
    assert normalize_caller(raw)['auth'] == 'unknown'


def test_normalize_caller_keeps_known_keys_only_and_stringifies_ids():
    """Only auth/userId/teamId/orgId survive; ids become strings or None."""
    caller = normalize_caller({'auth': 'account', 'userId': 42, 'teamId': None, 'orgId': 'o', 'apikey': 'nope'})
    assert caller == {'auth': 'account', 'userId': '42', 'teamId': None, 'orgId': 'o'}


def test_every_caller_kind_is_known():
    """The kinds produced by the helpers are all listed in CALLER_AUTH_KINDS."""
    produced = {caller_from_auth(a)['auth'] for a in ('pk_x', 'tk_x', 'key', '')}
    produced.add(agent_context().caller['auth'])
    assert produced <= set(CALLER_AUTH_KINDS)


def test_dap_context_records_source_target_and_caller():
    """The DAP context names its source type, whether a node was named, and the caller."""
    ctx = dap_context(source_type='tools', node_id='store_1', caller=dict(DAP_CALLER))
    assert ctx == ToolCallContext(origin='dap', source_type='tools', targeted=True, caller=DAP_CALLER)
    broadcast = dap_context(source_type='chat', node_id='', caller=None)
    assert broadcast.targeted is False
    assert broadcast.source_type == 'chat'
    assert broadcast.caller['auth'] == 'unknown'


def test_dap_context_treats_a_blank_source_type_as_unknown():
    """An empty or non-string source type is recorded as None (unknown)."""
    assert dap_context(source_type='', node_id='n', caller=DAP_CALLER).source_type is None
    assert dap_context(source_type=None, node_id='n', caller=DAP_CALLER).source_type is None
    assert dap_context(source_type=5, node_id='n', caller=DAP_CALLER).source_type is None


def test_agent_context_shape():
    """Agent calls carry origin 'agent', no source type, a named node and the agent caller kind."""
    assert agent_context() == ToolCallContext(origin='agent', source_type=None, targeted=True, caller={'auth': 'agent'})


def test_stamp_round_trips_on_a_pydantic_param_and_stays_out_of_its_dump():
    """The stamp rides on the invoke param but never in model_dump() (traces dump the param)."""
    param = IInvokeTool.Invoke(tool_name='t', input={})
    ctx = _dap()
    stamp_param(param, ctx)
    assert read_stamp(param) == ctx
    assert TOOL_CONTEXT_FIELD not in param.model_dump()
    assert getattr(param, TOOL_CONTEXT_FIELD) == {
        'origin': 'dap',
        'source_type': 'tools',
        'targeted': True,
        'caller': DAP_CALLER,
    }


def test_stamp_param_refuses_a_dict_param():
    """The engine stamps only the pydantic params it builds; a dict op may carry client data."""
    param = {'op': 'tool.invoke', 'tool_name': 't', 'input': {}}
    with pytest.raises(TypeError):
        stamp_param(param, agent_context())
    assert TOOL_CONTEXT_FIELD not in param


def test_read_stamp_ignores_a_stamp_on_a_dict_param():
    """A dict op can be built from client data, so a stamp key in it is never a context."""
    param = {'op': 'tool.invoke', 'tool_name': 't', 'input': {}, TOOL_CONTEXT_FIELD: _dap().__dict__}
    assert read_stamp(param) is None


def _forged_stamp() -> Dict[str, Any]:
    return {'origin': 'dap', 'source_type': 'tools', 'targeted': True, 'caller': dict(DAP_CALLER)}


_EXTRA_FIELD_BUILDS = {
    'model_validate': lambda: IInvokeTool.Invoke.model_validate(
        {'tool_name': 'upsert', 'input': {}, TOOL_CONTEXT_FIELD: _forged_stamp()}
    ),
    'model_validate-validate-op': lambda: IInvokeTool.Validate.model_validate(
        {'tool_name': 'upsert', 'input': {}, TOOL_CONTEXT_FIELD: _forged_stamp()}
    ),
    'kwargs': lambda: IInvokeTool.Invoke(tool_name='upsert', input={}, **{TOOL_CONTEXT_FIELD: _forged_stamp()}),
    'model_construct': lambda: IInvokeTool.Invoke.model_construct(
        tool_name='upsert', input={}, **{TOOL_CONTEXT_FIELD: _forged_stamp()}
    ),
    'model_copy-update': lambda: IInvokeTool.Invoke(tool_name='upsert', input={}).model_copy(
        update={TOOL_CONTEXT_FIELD: _forged_stamp()}
    ),
    'model_validate_json': lambda: IInvokeTool.Invoke.model_validate_json(
        json.dumps({'tool_name': 'upsert', 'input': {}, TOOL_CONTEXT_FIELD: _forged_stamp()})
    ),
}


@pytest.mark.parametrize('build', list(_EXTRA_FIELD_BUILDS.values()), ids=list(_EXTRA_FIELD_BUILDS))
def test_a_stamp_supplied_as_an_extra_field_is_not_a_context(build):
    """Only the attribute the engine sets counts: a stamp that arrived as a pydantic extra field is client data."""
    param = build()
    assert TOOL_CONTEXT_FIELD in (param.__pydantic_extra__ or {})
    assert read_stamp(param) is None


def test_read_stamp_on_objects_without_an_instance_dict():
    """Values with no instance attributes read as no context."""
    assert read_stamp(42) is None
    assert read_stamp('dap') is None
    assert read_stamp(object()) is None


def test_stamping_replaces_a_stamp_supplied_as_an_extra_field():
    """Stamping drops a client-sent extra field, so it reaches neither the tool nor a trace."""
    param = IInvokeTool.Invoke.model_validate(
        {'tool_name': 'upsert', 'input': {}, TOOL_CONTEXT_FIELD: agent_context().__dict__}
    )
    stamp_param(param, _dap())
    assert read_stamp(param) == _dap()
    assert TOOL_CONTEXT_FIELD not in (param.__pydantic_extra__ or {})
    assert TOOL_CONTEXT_FIELD not in param.model_dump()


def test_stamp_is_a_copy():
    """Changing the context's caller after stamping does not change the stamp."""
    ctx = _dap()
    param = IInvokeTool.Invoke(tool_name='t', input={})
    stamp_param(param, ctx)
    ctx.caller['auth'] = 'public'
    assert read_stamp(param).caller['auth'] == 'account'


def test_read_stamp_ignores_the_tool_input():
    """A context placed inside the tool input is not a stamp."""
    param = IInvokeTool.Invoke(tool_name='t', input={TOOL_CONTEXT_FIELD: _dap().__dict__})
    assert read_stamp(param) is None
    assert read_stamp({'op': 'tool.invoke', 'input': {TOOL_CONTEXT_FIELD: _dap().__dict__}}) is None
    assert read_stamp(None) is None


@pytest.mark.parametrize(
    'value',
    [
        None,
        'dap',
        [],
        {},
        {'origin': 'dap'},
        {'origin': 'root', 'source_type': 'tools', 'targeted': True, 'caller': DAP_CALLER},
        {'origin': 'dap', 'source_type': 'tools', 'targeted': 'yes', 'caller': DAP_CALLER},
        {'origin': 'dap', 'source_type': 7, 'targeted': True, 'caller': DAP_CALLER},
        {'origin': 'dap', 'source_type': 'tools', 'targeted': True, 'caller': 'account'},
        {'origin': 'dap', 'source_type': 'tools', 'targeted': True, 'caller': {'auth': 'root'}},
    ],
)
def test_malformed_stamps_read_as_no_context(value):
    """Anything that is not a well-formed context is no context at all (fail closed)."""
    assert context_from_stamp(value) is None


def test_well_formed_stamps_parse():
    """A dict or a ToolCallContext parses; the caller is normalized and copied."""
    ctx = _dap()
    assert context_from_stamp(ctx) == ctx
    parsed = context_from_stamp({**ctx.__dict__, 'caller': {**DAP_CALLER, 'extra': 'dropped'}})
    assert parsed == ctx
    assert parsed.caller is not ctx.caller


# ---------------------------------------------------------------------------
# The dispatcher (IInstanceBase._dispatch_tool)
# ---------------------------------------------------------------------------


def test_dispatcher_runs_the_tool_inside_the_stamped_context():
    """The tool method reads exactly the context stamped on its param."""
    node = _Probe()
    ctx = _dap()
    _invoke(node, 'whoami', stamp=ctx.__dict__)
    assert node.seen == [ctx]
    assert current_tool_call() is None


def test_dispatcher_ignores_a_stamp_on_a_dict_param():
    """A dict op runs its tool with no context, whatever stamp key it carries."""
    node = _Probe()
    param = _invoke(node, 'whoami', stamp=_dap().__dict__, as_dict=True)
    assert node.seen == [None]
    assert param['output'] == {'context': None}


def test_dispatcher_ignores_a_stamp_supplied_as_an_extra_field():
    """A param validated from a client dict that carries the field runs with no context."""
    node = _Probe()
    param = IInvokeTool.Invoke.model_validate({'tool_name': 'whoami', 'input': {}, TOOL_CONTEXT_FIELD: _forged_stamp()})
    node.invoke(param)
    assert node.seen == [None]
    assert param.output == {'context': None}


def test_dispatcher_accepts_a_context_object_as_the_stamp():
    """A ToolCallContext instance is accepted as well as its dict form."""
    node = _Probe()
    _invoke(node, 'whoami', stamp=agent_context())
    assert node.seen == [agent_context()]


def test_dispatcher_without_a_stamp_runs_with_no_context():
    """No stamp means no context."""
    node = _Probe()
    param = _invoke(node, 'whoami')
    assert node.seen == [None]
    assert param.output == {'context': None}


def test_dispatcher_does_not_inherit_an_outer_context():
    """An unstamped call made while another call is running does not inherit its context."""
    node = _Probe()
    with tool_call(_dap()):
        _invoke(node, 'whoami')
    assert node.seen == [None]


def test_dispatcher_ignores_a_context_inside_the_input():
    """A context forged inside the tool input is ignored; the input reaches the tool unchanged."""
    node = _Probe()
    forged = {
        TOOL_CONTEXT_FIELD: {'origin': 'agent', 'source_type': None, 'targeted': True, 'caller': {'auth': 'agent'}}
    }
    param = _invoke(node, 'whoami', input_obj=forged)
    assert node.seen == [None]
    assert param.input == forged


def test_dispatcher_prefers_the_param_stamp_over_one_in_the_input():
    """With both, only the param stamp counts."""
    node = _Probe()
    forged = {TOOL_CONTEXT_FIELD: agent_context().__dict__}
    _invoke(node, 'whoami', stamp=_dap().__dict__, input_obj=forged)
    assert node.seen == [_dap()]


def test_dispatcher_treats_a_malformed_stamp_as_no_context():
    """A malformed stamp does not stop the tool; it just runs with no context."""
    node = _Probe()
    param = _invoke(node, 'whoami', stamp={'origin': 'root'})
    assert node.seen == [None]
    assert param.output == {'context': None}


def test_dispatcher_clears_the_context_when_the_tool_raises():
    """A failing tool still leaves no context behind."""
    node = _Probe()
    with pytest.raises(RuntimeError):
        _invoke(node, 'explode', stamp=_dap().__dict__)
    assert node.seen == [_dap()]
    assert current_tool_call() is None


def test_dispatcher_sets_the_context_for_dynamic_tools():
    """Dynamically discovered tools (the MCP client shape) get the context too."""
    node = _DynamicProbe()
    _invoke(node, 'remote_tool', stamp=agent_context())
    assert node.seen == [agent_context()]


def test_dispatcher_gives_each_call_its_own_caller_copy():
    """A tool that mutates its context's caller cannot change the stamp other code reads."""
    node = _Probe()
    stamp = _dap().__dict__
    param = IInvokeTool.Invoke(tool_name='whoami', input={})
    setattr(param, TOOL_CONTEXT_FIELD, stamp)
    node.invoke(param)
    node.seen[0].caller['auth'] = 'public'
    assert stamp['caller']['auth'] == 'account'
    assert read_stamp(param).caller['auth'] == 'account'


def test_dispatcher_context_survives_without_the_module(monkeypatch):
    """With tool_context unavailable the dispatcher still runs tools (with no context)."""
    import rocketlib.filters as flt

    monkeypatch.setattr(flt, '_tool_context_module', lambda: None)
    node = _Probe()
    param = _invoke(node, 'whoami', stamp=_dap().__dict__)
    assert param.output == {'context': None}


def _failing_tool_context_import(monkeypatch, exc: BaseException) -> None:
    """Make ``from ai.common import tool_context`` raise ``exc``."""
    import builtins

    real_import = builtins.__import__

    def _import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == 'ai.common' and fromlist and 'tool_context' in fromlist:
            raise exc
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, '__import__', _import)


def test_a_broken_tool_context_module_is_reported_once(monkeypatch, caplog):
    """A tool_context that fails for any reason but being absent is logged once; tools run with no context."""
    import rocketlib.filters as flt

    monkeypatch.setattr(flt, '_tool_context_failure_reported', False)
    _failing_tool_context_import(monkeypatch, SyntaxError('invalid syntax'))
    caplog.set_level(logging.WARNING, logger='rocketlib.filters')
    node = _Probe()
    first = _invoke(node, 'whoami', stamp=_dap().__dict__)
    second = _invoke(node, 'whoami', stamp=_dap().__dict__)
    assert first.output == second.output == {'context': None}
    reports = [r for r in caplog.records if 'tool_context' in r.getMessage()]
    assert len(reports) == 1
    assert reports[0].levelno == logging.WARNING
    assert 'SyntaxError' in reports[0].getMessage()


@pytest.mark.parametrize('missing', ['ai', 'ai.common', 'ai.common.tool_context'])
def test_an_absent_ai_package_is_not_reported(monkeypatch, caplog, missing):
    """Running rocketlib without the ai package is supported: no context, and nothing logged."""
    import rocketlib.filters as flt

    monkeypatch.setattr(flt, '_tool_context_failure_reported', False)
    _failing_tool_context_import(monkeypatch, ModuleNotFoundError(f'No module named {missing!r}', name=missing))
    caplog.set_level(logging.WARNING, logger='rocketlib.filters')
    assert flt._tool_context_module() is None
    assert not [r for r in caplog.records if 'tool_context' in r.getMessage()]


def test_a_missing_dependency_of_tool_context_is_reported(monkeypatch, caplog):
    """A module tool_context needs that is missing is a broken install, not an absent ai package."""
    import rocketlib.filters as flt

    monkeypatch.setattr(flt, '_tool_context_failure_reported', False)
    _failing_tool_context_import(monkeypatch, ModuleNotFoundError("No module named 'gone'", name='gone'))
    caplog.set_level(logging.WARNING, logger='rocketlib.filters')
    assert flt._tool_context_module() is None
    assert len([r for r in caplog.records if 'tool_context' in r.getMessage()]) == 1


# ---------------------------------------------------------------------------
# DAP stamping (DataConn._tool)
# ---------------------------------------------------------------------------


class _RecordingInstance:
    """A python instance that records the param it was invoked with."""

    def __init__(self, owns: bool = True) -> None:
        self.params: List[Any] = []
        self.owns = owns

    def invoke(self, param: Any) -> Any:
        from rocketlib import APERR, Ec

        self.params.append(param)
        if not self.owns:
            raise APERR(Ec.PreventDefault, 'not owned')
        param.output = {'ok': True, 'seen': read_stamp(param)}
        return param


def _chain(*nodes: Any) -> Any:
    """Link fake pipe nodes (id, python instance) into the chain DataConn walks."""
    head = None
    for node_id, instance in reversed(nodes):
        head = SimpleNamespace(pipeId=1, pipeType=SimpleNamespace(id=node_id), pyInstance=instance, next=head)
    return head


def _data_conn(target: Any) -> Any:
    from ai.modules.data.data_conn import DataConn

    conn = DataConn.__new__(DataConn)
    conn._server = SimpleNamespace(_target=target)
    conn._pipe_map = {}
    conn._pipe_sem = None
    conn._thread_count = None
    conn._pipe_sem_init_lock = asyncio.Lock()
    conn.debug_message = MagicMock()
    conn._emit_tool_trace = MagicMock()
    return conn


class _IJsonLike:
    """Stand-in for the engine's IJson task config: dict-like, converts with toDict()."""

    def __init__(self, value: Dict[str, Any]) -> None:
        self._value = value

    def get(self, key: str, default: Any = None) -> Any:
        return self._value.get(key, default)

    def toDict(self) -> Dict[str, Any]:
        return self._value


def _pipeline(source_provider: Any, *, source: str = 'src_1') -> Dict[str, Any]:
    """A task pipeline config whose source component has the given provider."""
    components = [{'id': 'store_1', 'provider': 'postgres'}]
    if source_provider is not None:
        components.insert(0, {'id': source, 'provider': source_provider})
    return {'source': source, 'components': components}


def _target(source_provider: Any, chain: Any, *, pipeline: Any = None) -> Any:
    """The pipeline's target endpoint as DataConn sees it: the Null endpoint, whose own type says nothing."""
    target = MagicMock()
    target.logicalType = 'null'
    target.taskConfig = {'threadCount': 2, 'pipeline': pipeline if pipeline is not None else _pipeline(source_provider)}
    target.getPipe = MagicMock(return_value=chain)
    target.putPipe = MagicMock()
    return target


def _run_tool(conn: Any, args: Dict[str, Any]) -> Any:
    request = {'seq': 1, 'type': 'request', 'command': 'rrext_process', 'arguments': args}
    return asyncio.run(conn._tool(request, args))


def test_dap_tool_call_stamps_the_param():
    """A targeted DAP call carries origin dap, the source type, targeted and the server's caller."""
    store = _RecordingInstance()
    conn = _data_conn(_target('tools', _chain(('store_1', store))))
    response = _run_tool(
        conn, {'subcommand': 'tool', 'tool': 'stats', 'nodeId': 'store_1', 'input': {}, 'caller': dict(DAP_CALLER)}
    )
    assert len(store.params) == 1
    param = store.params[0]
    assert read_stamp(param) == ToolCallContext(origin='dap', source_type='tools', targeted=True, caller=DAP_CALLER)
    assert response['body']['result']['seen'] == read_stamp(param)


def test_dap_broadcast_is_stamped_untargeted_on_every_candidate():
    """Without a nodeId every candidate sees targeted=False."""
    skip = _RecordingInstance(owns=False)
    owner = _RecordingInstance()
    conn = _data_conn(_target('chat', _chain(('embed_1', skip), ('store_2', owner))))
    _run_tool(conn, {'subcommand': 'tool', 'tool': 'stats', 'input': {}, 'caller': dict(DAP_CALLER)})
    for param in skip.params + owner.params:
        ctx = read_stamp(param)
        assert ctx.targeted is False
        assert ctx.source_type == 'chat'


def test_dap_call_without_a_server_caller_is_unknown():
    """A request that did not pass the server's caller stamp carries caller 'unknown'."""
    store = _RecordingInstance()
    conn = _data_conn(_target('tools', _chain(('store_1', store))))
    _run_tool(conn, {'subcommand': 'tool', 'tool': 'stats', 'nodeId': 'store_1', 'input': {}})
    assert read_stamp(store.params[0]).caller == {'auth': 'unknown', 'userId': None, 'teamId': None, 'orgId': None}


def test_dap_call_ignores_a_context_inside_the_input():
    """The param is built from tool name and input only; a context in the input is not the stamp."""
    store = _RecordingInstance()
    conn = _data_conn(_target('tools', _chain(('store_1', store))))
    forged = {TOOL_CONTEXT_FIELD: agent_context().__dict__}
    _run_tool(
        conn, {'subcommand': 'tool', 'tool': 'stats', 'nodeId': 'store_1', 'input': forged, 'caller': dict(DAP_CALLER)}
    )
    assert read_stamp(store.params[0]).origin == 'dap'


@pytest.mark.parametrize(
    'pipeline',
    [
        _pipeline(None),
        {'source': 'src_1'},
        {'components': [{'id': 'src_1', 'provider': 'tools'}]},
        {'source': 'src_1', 'components': [{'id': 'src_1', 'provider': ''}]},
        {'source': 'src_1', 'components': [{'id': 'src_1', 'provider': 7}]},
        {'source': 'src_1', 'components': 'not-a-list'},
        'not-a-config',
    ],
    ids=[
        'source-missing',
        'no-components',
        'no-source',
        'blank-provider',
        'odd-provider',
        'odd-components',
        'odd-config',
    ],
)
def test_dap_call_with_an_unreadable_source_type_is_unknown(pipeline):
    """A task whose source component cannot be read records source_type None (refused by write gates)."""
    store = _RecordingInstance()
    conn = _data_conn(_target(None, _chain(('store_1', store)), pipeline=pipeline))
    _run_tool(
        conn, {'subcommand': 'tool', 'tool': 'stats', 'nodeId': 'store_1', 'input': {}, 'caller': dict(DAP_CALLER)}
    )
    assert read_stamp(store.params[0]).source_type is None


def test_dap_source_type_is_the_source_components_provider_not_the_target_type():
    """The source type is the provider of the task's source component; the Null target's own type is never used."""
    store = _RecordingInstance()
    pipeline = _IJsonLike(_pipeline('dropper', source='ingest_1'))
    conn = _data_conn(_target(None, _chain(('store_1', store)), pipeline=pipeline))
    _run_tool(
        conn, {'subcommand': 'tool', 'tool': 'stats', 'nodeId': 'store_1', 'input': {}, 'caller': dict(DAP_CALLER)}
    )
    ctx = read_stamp(store.params[0])
    assert ctx.source_type == 'dropper'
    assert ctx.source_type != 'null'


# ---------------------------------------------------------------------------
# Caller injection and audit forwarding (DataCommands.on_rrext_process)
# ---------------------------------------------------------------------------


def _data_commands(auth: str, *, result: Any = None, user_id: str = 'user-1') -> Any:
    from ai.modules.task.commands.cmd_data import DataCommands

    cmd = DataCommands.__new__(DataCommands)
    task = SimpleNamespace(
        wait_for_running=AsyncMock(),
        _send_data=AsyncMock(return_value={'body': {'result': result}}),
    )
    control = SimpleNamespace(userId='owner-1', teamId='team-1', orgId='org-1', project_id='proj-1', source='tools_1')
    cmd.get_task = MagicMock(return_value=task)
    cmd.get_task_token = MagicMock(return_value='tk_task')
    cmd._server = SimpleNamespace(get_task_control=MagicMock(return_value=control))
    cmd._account_info = SimpleNamespace(auth=auth, userId=user_id)
    cmd.debug_message = MagicMock()
    cmd.build_response = lambda request, body=None: {'request_seq': request.get('seq'), 'body': body}
    return cmd, task


def _process(cmd: Any, arguments: Dict[str, Any]) -> Any:
    request = {'seq': 7, 'command': 'rrext_process', 'arguments': arguments}
    return asyncio.run(cmd.on_rrext_process(request)), request


@pytest.mark.parametrize(
    'auth, kind',
    [('pk_public', 'public'), ('tk_task', 'task'), ('local-acceptance-key', 'account')],
)
def test_server_overwrites_the_caller_on_tool_calls(auth, kind):
    """The caller forwarded to the task is the server's view; a client-sent one is discarded."""
    cmd, task = _data_commands(auth)
    forged = {'auth': 'account', 'userId': 'someone-else', 'teamId': 'x', 'orgId': 'y'}
    _process(cmd, {'subcommand': 'tool', 'tool': 'stats', 'nodeId': 'store_1', 'input': {}, 'caller': forged})
    sent = task._send_data.await_args.args[0]
    assert sent['arguments']['caller'] == {'auth': kind, 'userId': 'user-1', 'teamId': 'team-1', 'orgId': 'org-1'}
    assert auth not in repr(sent['arguments']['caller'])


def test_server_leaves_other_subcommands_alone():
    """Only tool calls get a caller; open/write/close are forwarded unchanged."""
    cmd, task = _data_commands('local-acceptance-key')
    _process(cmd, {'subcommand': 'open', 'mimetype': 'text/plain'})
    sent = task._send_data.await_args.args[0]
    assert 'caller' not in sent['arguments']


def test_audit_block_is_forwarded_to_the_account_audit(monkeypatch):
    """A tool result carrying an audit block becomes one account.audit() call with ids and counts only."""
    from ai.account import account

    audit = AsyncMock()
    monkeypatch.setattr(account, 'audit', audit)
    result = {
        'success': True,
        'matched_chunks': 2,
        'audit': {
            'action': 'vector.soft_delete',
            'node': 'store_1',
            'provider': 'postgres',
            'collection': 'vx_demo_docs',
            'object_ids': ['a', 'b'],
            'rows': 2,
            'caller': {'auth': 'account', 'userId': 'user-1', 'teamId': 'team-1'},
            'content': 'must not be forwarded',
            'vectors': [[0.1, 0.2]],
        },
    }
    cmd, _task = _data_commands('local-acceptance-key', result=result)
    response, _request = _process(cmd, {'subcommand': 'tool', 'tool': 'soft_delete', 'nodeId': 'store_1', 'input': {}})
    assert response['body']['result'] == result
    audit.assert_awaited_once()
    kwargs = audit.await_args.kwargs
    args = audit.await_args.args
    assert args == ('user-1',)
    assert kwargs['source'] == 'vector'
    assert kwargs['reason'] == 'vector.soft_delete'
    assert kwargs['org_id'] == 'org-1'
    assert kwargs['request_data'] == {
        'node': 'store_1',
        'provider': 'postgres',
        'collection': 'vx_demo_docs',
        'object_ids': ['a', 'b'],
        'caller_auth': 'account',
        'teamId': 'team-1',
        'source': 'tools_1',
    }
    assert kwargs['response_data'] == {'rows': 2, 'success': True, 'code': None}
    flat = repr(kwargs)
    assert 'must not be forwarded' not in flat
    assert '0.1' not in flat


def test_audit_object_ids_are_capped(monkeypatch):
    """At most 100 object ids reach the audit record."""
    from ai.account import account

    audit = AsyncMock()
    monkeypatch.setattr(account, 'audit', audit)
    result = {
        'success': True,
        'audit': {'action': 'vector.delete', 'object_ids': [str(i) for i in range(250)], 'rows': 250},
    }
    cmd, _task = _data_commands('tk_task', result=result)
    _process(cmd, {'subcommand': 'tool', 'tool': 'delete', 'nodeId': 'store_1', 'input': {}})
    assert len(audit.await_args.kwargs['request_data']['object_ids']) == 100


def test_refusal_with_an_audit_block_is_audited_with_its_code(monkeypatch):
    """A refused write that reports an audit block is recorded with success false and its code."""
    from ai.account import account

    audit = AsyncMock()
    monkeypatch.setattr(account, 'audit', audit)
    result = {
        'success': False,
        'code': 'WRITES_DISABLED',
        'error': 'off',
        'audit': {'action': 'vector.delete', 'object_ids': ['a']},
    }
    cmd, _task = _data_commands('local-acceptance-key', result=result)
    _process(cmd, {'subcommand': 'tool', 'tool': 'delete', 'nodeId': 'store_1', 'input': {}})
    assert audit.await_args.kwargs['response_data'] == {'rows': None, 'success': False, 'code': 'WRITES_DISABLED'}


@pytest.mark.parametrize(
    'result',
    [None, 'text', ['a'], {'success': True}, {'success': True, 'audit': 'not-a-dict'}, {'success': True, 'audit': {}}],
)
def test_results_without_an_audit_block_are_not_audited(monkeypatch, result):
    """Only a dict result with a non-empty audit block (with an action) is audited."""
    from ai.account import account

    audit = AsyncMock()
    monkeypatch.setattr(account, 'audit', audit)
    cmd, _task = _data_commands('local-acceptance-key', result=result)
    _process(cmd, {'subcommand': 'tool', 'tool': 'stats', 'nodeId': 'store_1', 'input': {}})
    audit.assert_not_awaited()


@pytest.mark.parametrize(
    'action',
    [
        'delete',
        'shell.exec',
        'account.delete',
        'vector.',
        'vector.Delete',
        'vector.delete everything',
        'vector.delete\nforged line',
        'vector..delete',
        'vector.' + 'x' * 80,
        ' vector.delete',
    ],
)
def test_audit_actions_outside_the_vector_namespace_are_not_recorded(monkeypatch, action):
    """Only a `vector.<snake_case name>` action is recorded, so another node's result cannot pick audit labels."""
    from ai.account import account

    audit = AsyncMock()
    monkeypatch.setattr(account, 'audit', audit)
    result = {'success': True, 'audit': {'action': action, 'object_ids': ['a'], 'rows': 1}}
    cmd, _task = _data_commands('local-acceptance-key', result=result)
    response, _request = _process(cmd, {'subcommand': 'tool', 'tool': 'stats', 'nodeId': 'store_1', 'input': {}})
    assert response['body']['result'] == result
    audit.assert_not_awaited()


@pytest.mark.parametrize(
    'action', ['vector.upsert', 'vector.delete', 'vector.soft_delete', 'vector.restore', 'vector.v2_write']
)
def test_vector_audit_actions_are_recorded(monkeypatch, action):
    """The write tools' actions are recorded under their own label."""
    from ai.account import account

    audit = AsyncMock()
    monkeypatch.setattr(account, 'audit', audit)
    result = {'success': True, 'audit': {'action': action, 'object_ids': ['a'], 'rows': 1}}
    cmd, _task = _data_commands('local-acceptance-key', result=result)
    _process(cmd, {'subcommand': 'tool', 'tool': 'upsert', 'nodeId': 'store_1', 'input': {}})
    audit.assert_awaited_once()
    assert audit.await_args.kwargs['reason'] == action


def test_audit_failure_does_not_fail_the_call(monkeypatch):
    """An audit backend error is logged, and the tool answer still reaches the client."""
    from ai.account import account

    monkeypatch.setattr(account, 'audit', AsyncMock(side_effect=RuntimeError('audit store down')))
    result = {'success': True, 'audit': {'action': 'vector.delete', 'object_ids': ['a'], 'rows': 1}}
    cmd, _task = _data_commands('local-acceptance-key', result=result)
    response, _request = _process(cmd, {'subcommand': 'tool', 'tool': 'delete', 'nodeId': 'store_1', 'input': {}})
    assert response['body']['result'] == result


def test_open_results_are_never_audited(monkeypatch):
    """Data-lane subcommands are not inspected for audit blocks."""
    from ai.account import account

    audit = AsyncMock()
    monkeypatch.setattr(account, 'audit', audit)
    cmd, _task = _data_commands('local-acceptance-key', result={'audit': {'action': 'x'}})
    _process(cmd, {'subcommand': 'close', 'pipe_id': 1})
    audit.assert_not_awaited()


# ---------------------------------------------------------------------------
# Agent host stamping (host.py)
# ---------------------------------------------------------------------------


class _Invoker:
    """An agent invoker whose engine instance routes invokes to real node objects."""

    def __init__(self, nodes: Dict[str, IInstanceBase]) -> None:
        self.nodes = nodes
        self.params: List[Any] = []
        self.instance = SimpleNamespace(getControllerNodeIds=self._controllers, invoke=self._invoke)

    def _controllers(self, kind: str) -> List[str]:
        return list(self.nodes) if kind == 'tool' else []

    def _invoke(self, param: Any, component_id: str = '') -> Any:
        self.params.append(param)
        return self.nodes[component_id].invoke(param)


def test_agent_host_invoke_stamps_agent_origin():
    """A tool call made by an agent reaches the node with origin 'agent'."""
    from ai.common.agent._internal.host import AgentHostServices

    node = _Probe()
    invoker = _Invoker({'probe_1': node})
    tools = AgentHostServices.Tools(invoker)
    out = tools.invoke('probe_1.whoami', {})
    assert out == {'context': 'agent'}
    assert node.seen == [agent_context()]
    assert read_stamp(invoker.params[-1]) == agent_context()


def test_agent_host_validate_stamps_agent_origin():
    """Validate params built by the agent host carry the agent stamp too."""
    from ai.common.agent._internal.host import AgentHostServices

    recorded: List[Any] = []

    def _invoke(param: Any, component_id: str = '') -> None:
        recorded.append(param)
        if param.op == 'tool.query':
            param.tools.append({'name': 'whoami', 'description': '', 'inputSchema': {}})

    invoker = SimpleNamespace(instance=SimpleNamespace(getControllerNodeIds=lambda kind: ['probe_1'], invoke=_invoke))
    tools = AgentHostServices.Tools(invoker)
    tools.validate('probe_1.whoami', {})
    assert read_stamp(recorded[-1]) == agent_context()


def test_agent_host_discovery_is_not_stamped():
    """tool.query is a catalog read; it carries no call context."""
    from ai.common.agent._internal.host import AgentHostServices

    node = _Probe()
    invoker = _Invoker({'probe_1': node})
    AgentHostServices.Tools(invoker)
    assert invoker.params and all(read_stamp(p) is None for p in invoker.params)


def test_module_exports():
    """The public names of the module are stable."""
    assert set(tool_context.__all__) >= {
        'CALLER_AUTH_KINDS',
        'ORIGINS',
        'TOOL_CONTEXT_FIELD',
        'ToolCallContext',
        'agent_context',
        'caller_from_auth',
        'context_from_stamp',
        'current_tool_call',
        'dap_context',
        'no_tool_call',
        'normalize_caller',
        'read_stamp',
        'stamp_param',
        'tool_call',
    }
