# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The fail-closed write gate of the vector store tools.

The write tools (``upsert``, ``delete``, ``soft_delete``, ``restore``) run ``vx_write_gate.check_write``
first. It reads only the call context the engine attached to the call
(``ai.common.tool_context.current_tool_call()``), never anything in the tool
input, and refuses in a fixed order:

    schema id -> no context -> agent (allowed) -> DAP with allow_writes off
    -> source other than tools -> caller other than account/task
    -> call not naming the node -> caller-supplied embedding on upsert

An agent's write is decided by the outer gate alone: ``allow_write`` (#2631)
hides the write tools from agents and DAP callers alike, and there is no
separate switch for agents, as on develop.

The engine binds the context: the dispatcher (``IInstanceBase._dispatch_tool``)
runs each tool inside the context stamped on its invoke param. Without a
context every write is refused, which these tests also pin, and the last
section sends write tools through the real dispatcher with and without a stamp.
"""

from __future__ import annotations

import importlib.util
import inspect
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, Optional

import pytest
from rocketlib import IInstanceBase, OPEN_MODE
from rocketlib.types import IInvokeTool

from ai.common import tool_context
from ai.common.store import StoreGlobalBase, StoreInstanceBase, vx_defaults, vx_write_gate
from ai.common.store import store_global_base as sgb
from ai.common.store.document_store import VectorStoreToolMixin, deletedFilter
from ai.common.store.errors import ToolRefusal
from ai.common.store.vx_defaults import VECTOR_ALLOW_WRITES_DEFAULT
from ai.common.store.vx_types import TOOL_CODES
from ai.common.tool_context import ToolCallContext

from .test_vector_hooks import CountingStore, MemoryStore, corpus, make_doc

_ROOT = Path(__file__).resolve().parents[2]
_COMMON_VECTOR_JSON = _ROOT / 'nodes' / 'src' / 'nodes' / 'core' / 'services.common.vector.json'


# ---------------------------------------------------------------------------
# Contexts
# ---------------------------------------------------------------------------


def dap(
    *,
    source_type: Optional[str] = 'tools',
    auth: str = 'account',
    targeted: bool = True,
    user_id: str = 'u-0001',
    team_id: str = 't-0001',
) -> ToolCallContext:
    """A DAP tool call as the engine would describe it."""
    return ToolCallContext(
        origin='dap',
        source_type=source_type,
        targeted=targeted,
        caller={'auth': auth, 'userId': user_id, 'teamId': team_id, 'orgId': 'o-0001'},
    )


def agent() -> ToolCallContext:
    """A tool call made by an agent inside the pipeline."""
    return ToolCallContext(origin='agent', source_type=None, targeted=True, caller={'auth': 'agent'})


def _check(ctx, *, tool='delete', ids=('doc-1',), allow=True, embedding=False):
    return vx_write_gate.check_write(
        tool,
        object_ids=list(ids),
        allow_writes=allow,
        supplies_embedding=embedding,
        context=ctx,
    )


def _code(ctx, **kw) -> str:
    try:
        _check(ctx, **kw)
    except ToolRefusal as refusal:
        return refusal.code
    return 'ALLOWED'


# ---------------------------------------------------------------------------
# The truth table, row by row
# ---------------------------------------------------------------------------

_WRITE_TOOLS = ['upsert', 'delete', 'soft_delete', 'restore']


@pytest.mark.parametrize('tool', _WRITE_TOOLS)
def test_schema_id_is_refused_before_anything_else(tool):
    assert _code(None, tool=tool, ids=['a', 'schema']) == 'RESERVED_ID'
    assert _code(agent(), tool=tool, ids=['schema']) == 'RESERVED_ID'
    assert _code(dap(), tool=tool, ids=['schema']) == 'RESERVED_ID'


@pytest.mark.parametrize('tool', _WRITE_TOOLS)
def test_no_context_is_an_unknown_caller(tool):
    assert _code(None, tool=tool) == 'WRITES_UNKNOWN_CALLER'


@pytest.mark.parametrize('tool', _WRITE_TOOLS)
@pytest.mark.parametrize('allow', [False, True])
def test_an_agent_write_passes_the_inner_gate_whatever_allow_writes_says(tool, allow):
    # allow_writes governs DAP calls only; whether an agent may write is allow_write's (the outer gate).
    assert _code(agent(), tool=tool, allow=allow) == 'ALLOWED'


def test_the_gate_has_no_agent_switch():
    assert 'agent_writes' not in inspect.signature(vx_write_gate.check_write).parameters
    assert 'WRITES_AGENT' not in TOOL_CODES
    assert not hasattr(vx_defaults, 'VECTOR_AGENT_WRITES_DEFAULT')


@pytest.mark.parametrize('tool', _WRITE_TOOLS)
def test_dap_with_allow_writes_off_is_refused(tool):
    assert _code(dap(), tool=tool, allow=False) == 'WRITES_DISABLED'


@pytest.mark.parametrize('tool', _WRITE_TOOLS)
@pytest.mark.parametrize('source', ['chat', 'dropper', 'webhook', None])
def test_dap_from_a_source_other_than_tools_is_refused(tool, source):
    assert _code(dap(source_type=source), tool=tool) == 'WRITES_SOURCE'


@pytest.mark.parametrize('tool', _WRITE_TOOLS)
@pytest.mark.parametrize('auth', ['public', 'agent', 'unknown', ''])
def test_dap_from_a_caller_that_is_not_an_account_or_task_is_refused(tool, auth):
    assert _code(dap(auth=auth), tool=tool) == 'WRITES_PUBLIC'


@pytest.mark.parametrize('tool', _WRITE_TOOLS)
def test_dap_call_that_does_not_name_the_node_is_refused(tool):
    assert _code(dap(targeted=False), tool=tool) == 'WRITES_BROADCAST'


def test_dap_upsert_with_a_caller_embedding_is_invalid_input():
    assert _code(dap(), tool='upsert', embedding=True) == 'INVALID_INPUT'


def test_agent_upsert_with_its_own_embedding_is_still_allowed():
    assert _code(agent(), tool='upsert', embedding=True) == 'ALLOWED'


@pytest.mark.parametrize('tool', _WRITE_TOOLS)
@pytest.mark.parametrize('auth', ['account', 'task'])
def test_dap_from_tools_by_an_account_or_task_naming_the_node_is_allowed(tool, auth):
    assert _code(dap(auth=auth), tool=tool) == 'ALLOWED'


def test_rows_are_checked_in_order():
    # allow_writes off outranks the source, the caller kind and broadcast
    assert _code(dap(source_type='chat', auth='public', targeted=False), allow=False) == 'WRITES_DISABLED'
    # the source outranks the caller kind and broadcast
    assert _code(dap(source_type='chat', auth='public', targeted=False)) == 'WRITES_SOURCE'
    # the caller kind outranks broadcast
    assert _code(dap(auth='public', targeted=False)) == 'WRITES_PUBLIC'
    # broadcast outranks the embedding check
    assert _code(dap(targeted=False), tool='upsert', embedding=True) == 'WRITES_BROADCAST'


def test_default_switches_decide_a_dap_call_from_the_console():
    """The expectation the templates and the live tool-path table share."""
    expected = 'ALLOWED' if VECTOR_ALLOW_WRITES_DEFAULT else 'WRITES_DISABLED'
    assert _code(dap(), allow=VECTOR_ALLOW_WRITES_DEFAULT) == expected
    assert _code(agent(), allow=VECTOR_ALLOW_WRITES_DEFAULT) == 'ALLOWED'


def test_the_shipped_default_is_writes_off():
    assert VECTOR_ALLOW_WRITES_DEFAULT is False


# ---------------------------------------------------------------------------
# Context handling
# ---------------------------------------------------------------------------


def test_a_dict_context_is_read_like_the_dataclass():
    ctx = {'origin': 'dap', 'source_type': 'tools', 'targeted': True, 'caller': {'auth': 'task'}}
    assert _code(ctx) == 'ALLOWED'


@pytest.mark.parametrize(
    'ctx',
    [
        {'origin': 'somewhere', 'source_type': 'tools', 'targeted': True, 'caller': {'auth': 'account'}},
        {'source_type': 'tools', 'targeted': True, 'caller': {'auth': 'account'}},
        'dap',
        42,
        {'origin': 'dap', 'source_type': 'tools', 'targeted': True, 'caller': 'account'},
    ],
)
def test_a_context_the_gate_cannot_read_is_an_unknown_caller(ctx):
    assert _code(ctx) == 'WRITES_UNKNOWN_CALLER'


def test_the_gate_reads_the_engine_context_when_none_is_passed(monkeypatch):
    monkeypatch.setattr(vx_write_gate, '_current_tool_call', lambda: dap())
    decision = vx_write_gate.check_write('delete', object_ids=['a'], allow_writes=True)
    assert decision.origin == 'dap'


def test_without_engine_wiring_every_write_is_refused():
    """A call that reaches the gate with no context is refused whatever the switches say."""
    with pytest.raises(ToolRefusal) as refusal:
        vx_write_gate.check_write('delete', object_ids=['a'], allow_writes=True, context=None)
    assert refusal.value.code == 'WRITES_UNKNOWN_CALLER'


def test_the_gate_reads_the_engine_reader_at_call_time(monkeypatch):
    monkeypatch.setattr(tool_context, 'current_tool_call', lambda: agent())
    decision = vx_write_gate.check_write('delete', object_ids=['a'], allow_writes=False)
    assert decision.origin == 'agent'


def test_a_reader_that_raises_is_an_unknown_caller(monkeypatch):
    def broken():
        raise RuntimeError('context unavailable')

    monkeypatch.setattr(vx_write_gate, '_current_tool_call', broken)
    assert vx_write_gate.current_context() is None


def test_an_engine_without_tool_context_refuses_every_write(monkeypatch):
    """Load a fresh copy of the gate with ``ai.common.tool_context`` unimportable."""
    name = 'ai.common.store._vx_write_gate_without_context'
    spec = importlib.util.spec_from_file_location(name, vx_write_gate.__file__)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, 'ai.common.tool_context', None)
    monkeypatch.setitem(sys.modules, name, module)
    spec.loader.exec_module(module)
    assert module._current_tool_call is None
    with pytest.raises(ToolRefusal) as refusal:
        module.check_write('delete', object_ids=['a'], allow_writes=True)
    assert refusal.value.code == 'WRITES_UNKNOWN_CALLER'


def test_the_decision_carries_an_audit_caller_without_the_org():
    decision = _check(dap(auth='task'))
    assert decision.caller == {'auth': 'task', 'userId': 'u-0001', 'teamId': 't-0001'}
    assert decision.origin == 'dap'


def test_an_agent_decision_names_the_agent():
    assert _check(agent()).caller == {'auth': 'agent', 'userId': None, 'teamId': None}


def test_refusal_messages_name_no_internal_detail():
    for ctx, kw in [
        (None, {}),
        (dap(), {'allow': False}),
        (dap(source_type='chat'), {}),
        (dap(auth='public'), {}),
        (dap(targeted=False), {}),
    ]:
        with pytest.raises(ToolRefusal) as refusal:
            _check(ctx, **kw)
        text = refusal.value.message.lower()
        assert text and 'pk_' not in text and 'token' not in text


def test_refusal_messages_match_the_console_wording():
    with pytest.raises(ToolRefusal) as refusal:
        _check(dap(), allow=False)
    assert refusal.value.message == 'Removing documents is turned off on this store node (allow_writes).'
    with pytest.raises(ToolRefusal) as refusal:
        _check(dap(source_type='chat'))
    assert refusal.value.message == 'Only a Tools source may remove documents.'
    with pytest.raises(ToolRefusal) as refusal:
        _check(dap(), ids=['schema'])
    assert refusal.value.message == "'schema' is the collection's control record and cannot be removed."


# ---------------------------------------------------------------------------
# Node switches: allow_writes (DAP calls); agents have none of their own
# ---------------------------------------------------------------------------


class _Global(StoreGlobalBase):
    def __init__(self, store):
        self._store = store

    def getConnConfig(self):
        return {}

    def _open_store(self, logical_type, conn_config, bag):
        return self._store

    def _sub_key(self) -> str:
        return 'host/1/coll'

    def _probe_connection(self, config) -> None:
        return None


def _begin(monkeypatch, node_config: Dict[str, Any]) -> _Global:
    monkeypatch.setattr(sgb.Config, 'getNodeConfig', staticmethod(lambda lt, cc: node_config))
    monkeypatch.setattr(sgb.Config, 'getMultiProviderConfig', staticmethod(lambda kind, cc: (None, None)))
    glb = _Global(MemoryStore())
    glb.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=OPEN_MODE.SOURCE, bag={}))
    glb.glb = SimpleNamespace(logicalType='teststore', connConfig={})
    glb.beginGlobal()
    return glb


def test_switches_default_to_the_shared_constants(monkeypatch):
    glb = _begin(monkeypatch, {})
    assert glb.allow_writes is VECTOR_ALLOW_WRITES_DEFAULT
    assert not hasattr(glb, 'agent_writes')


@pytest.mark.parametrize(
    'raw,expected', [(True, True), ('yes', True), ('on', True), ('1', True), (False, False), ('off', False)]
)
def test_allow_writes_is_read_loosely_from_the_node_config(monkeypatch, raw, expected):
    assert _begin(monkeypatch, {'allow_writes': raw}).allow_writes is expected


def test_an_agent_writes_key_in_the_node_config_is_not_read(monkeypatch):
    glb = _begin(monkeypatch, {'agent_writes': 'false'})
    assert not hasattr(glb, 'agent_writes')
    assert (glb.allow_write, glb.allow_writes) == (True, VECTOR_ALLOW_WRITES_DEFAULT)


def test_unreadable_switch_values_fall_back_to_the_defaults(monkeypatch):
    glb = _begin(monkeypatch, {'allow_writes': 'maybe'})
    assert glb.allow_writes is VECTOR_ALLOW_WRITES_DEFAULT


def test_switch_class_defaults_are_the_constants():
    assert StoreGlobalBase.allow_writes is VECTOR_ALLOW_WRITES_DEFAULT
    assert not hasattr(StoreGlobalBase, 'agent_writes')


def _load_jsonc(path: Path) -> dict:
    lines = [line for line in path.read_text(encoding='utf-8').splitlines() if not line.strip().startswith('//')]
    return json.loads('\n'.join(lines))


def test_the_form_fields_default_to_the_same_constants():
    fields = _load_jsonc(_COMMON_VECTOR_JSON)['fields']
    assert fields['vector.allow_writes']['type'] == 'boolean'
    assert fields['vector.allow_writes']['default'] is VECTOR_ALLOW_WRITES_DEFAULT
    assert fields['vector.allow_writes']['title'] == 'Allow document management from tool calls'
    assert not [name for name in fields if 'agent_writes' in name]


_NODES_DIR = _ROOT / 'nodes' / 'src' / 'nodes'

#: The vector store nodes whose tools run the gate on ``vector.allow_writes``
#: (rocketride_vector has its own ``rrvector.*`` pair; Elasticsearch and OpenSearch have no explorer tools).
_VECTOR_STORE_NODES = (
    'store_postgres',
    'store_qdrant',
    'store_chroma',
    'store_milvus',
    'store_weaviate',
    'store_pinecone',
    'store_astra',
    'store_atlas',
)


def _load_services(path: Path) -> dict:
    """Read a services.json: JSON with // comments (outside strings) and trailing commas."""
    text = path.read_text(encoding='utf-8')
    out, i, in_string = [], 0, False
    while i < len(text):
        ch = text[i]
        if in_string:
            if ch == '\\':
                out.append(text[i : i + 2])
                i += 2
                continue
            if ch == '"':
                in_string = False
            out.append(ch)
            i += 1
            continue
        if ch == '"':
            in_string = True
        elif text.startswith('//', i):
            i = text.find('\n', i)
            i = len(text) if i < 0 else i
            continue
        out.append(ch)
        i += 1
    return json.loads(re.sub(r',(\s*[}\]])', r'\1', ''.join(out)))


def _settings_lists(services: dict) -> list:
    """Every property list of a node's form that holds the store's own settings (the lists naming its collection)."""
    lists = [
        field['properties']
        for field in services.get('fields', {}).values()
        if isinstance(field, dict) and isinstance(field.get('properties'), list)
    ]
    lists += [
        section['properties']
        for section in services.get('shape', [])
        if isinstance(section, dict) and isinstance(section.get('properties'), list)
    ]
    return [props for props in lists if any(isinstance(p, str) and p.endswith('.collection') for p in props)]


def test_the_listed_store_nodes_are_every_vector_store_with_tools():
    with_tools = {
        path.parent.name
        for path in _NODES_DIR.glob('*/services*.json')
        if {'store', 'tool'} <= set(_load_services(path).get('classType') or [])
    }
    assert with_tools - {'rocketride_vector'} == set(_VECTOR_STORE_NODES)


@pytest.mark.parametrize('node', _VECTOR_STORE_NODES)
def test_every_vector_store_form_shows_the_write_switch(node):
    services = _load_services(_NODES_DIR / node / 'services.json')
    lists = _settings_lists(services)
    assert lists, f'{node}: no form list names the collection'
    for props in lists:
        assert 'vector.allow_writes' in props, (node, props)
    # The defaults live in vx_defaults only: no profile pins them.
    for name, profile in services.get('preconfig', {}).get('profiles', {}).items():
        assert 'allow_writes' not in profile and 'agent_writes' not in profile, (node, name)


@pytest.mark.parametrize('node', _VECTOR_STORE_NODES + ('rocketride_vector', 'core'))
def test_no_store_node_has_an_agent_write_switch(node):
    # allow_write (the outer gate) alone decides agent writes, as on develop.
    for path in sorted((_NODES_DIR / node).glob('services*.json')):
        assert 'agent_writes' not in path.read_text(encoding='utf-8'), path.name


# ---------------------------------------------------------------------------
# The data lane: the reserved id never reaches addChunks
# ---------------------------------------------------------------------------


class _Instance(StoreInstanceBase, IInstanceBase):
    pass


def _instance(store) -> _Instance:
    inst = object.__new__(_Instance)
    inst.IGlobal = SimpleNamespace(store=store)
    inst._objectIdsWritten = set()  # what the engine's open() sets before any lane writes (#2962)
    return inst


def test_write_documents_with_the_reserved_id_fails_before_add_chunks():
    store = MemoryStore()
    with pytest.raises(Exception) as err:
        _instance(store).writeDocuments([make_doc('a', 0), make_doc('schema', 0)])
    assert 'reserved objectId' in str(err.value)
    assert not any(call[0] == 'addChunks' for call in store.calls)
    assert store.rows == {}


def test_write_documents_without_the_reserved_id_still_writes():
    store = MemoryStore()
    _instance(store).writeDocuments([make_doc('a', 0), make_doc('a', 1)])
    assert ('a', 1) in store.rows


def test_create_collection_still_writes_the_control_record_on_an_empty_driver():
    store = CountingStore()
    store.createCollection(corpus({'a': [0]}))
    assert ('schema', 0) in store.rows
    assert store.countChunks(deletedFilter('all')) == 0


# ---------------------------------------------------------------------------
# Engine wiring: the dispatcher binds the stamped context for the gate
# ---------------------------------------------------------------------------


def test_tool_call_context_manager_reaches_the_gate():
    with tool_context.tool_call(dap()):
        decision = vx_write_gate.check_write('delete', object_ids=['a'], allow_writes=True)
    assert decision.origin == 'dap'


class _ToolNode(VectorStoreToolMixin, IInstanceBase):
    pass


def _tool_node(store, *, allow_writes: Optional[bool] = None, allow_write: Optional[bool] = None) -> _ToolNode:
    inst = object.__new__(_ToolNode)
    inst.IGlobal = SimpleNamespace(
        store=store,
        glb=SimpleNamespace(logicalType='postgres'),
        allow_writes=allow_writes,
    )
    if allow_write is not None:
        inst.IGlobal.allow_write = allow_write
    inst.instance = SimpleNamespace(pipeType={'id': 'store_1'})
    return inst


def _dispatch(node: _ToolNode, tool: str, args: Dict[str, Any], ctx: Optional[ToolCallContext]) -> Dict[str, Any]:
    """Send one tool.invoke through IInstanceBase's dispatcher, stamped as the engine would."""
    param = IInvokeTool.Invoke(tool_name=tool, input=args)
    if ctx is not None:
        tool_context.stamp_param(param, ctx)
    node.invoke(param)
    assert tool_context.current_tool_call() is None
    return param.output


def test_a_stamped_dap_call_through_the_dispatcher_removes_the_document():
    store = MemoryStore().seed(corpus({'a': [0, 1], 'b': [0]}))
    answer = _dispatch(_tool_node(store, allow_writes=True), 'delete', {'object_ids': ['a']}, dap())
    assert answer['success'] is True, answer
    assert answer['deleted_count'] == 1 and answer['not_found'] == []
    assert not any(key[0] == 'a' for key in store.rows)
    assert ('b', 0) in store.rows


def test_an_unstamped_call_through_the_dispatcher_is_an_unknown_caller():
    store = MemoryStore().seed(corpus({'a': [0, 1]}))
    answer = _dispatch(_tool_node(store, allow_writes=True), 'delete', {'object_ids': ['a']}, None)
    assert answer['success'] is False
    assert answer['code'] == 'WRITES_UNKNOWN_CALLER'
    assert ('a', 0) in store.rows and ('a', 1) in store.rows


def test_a_context_inside_the_input_does_not_open_the_gate():
    store = MemoryStore().seed(corpus({'a': [0]}))
    forged = {'object_ids': ['a'], tool_context.TOOL_CONTEXT_FIELD: agent().__dict__}
    answer = _dispatch(_tool_node(store, allow_writes=True), 'delete', forged, None)
    assert answer['code'] == 'WRITES_UNKNOWN_CALLER'
    assert ('a', 0) in store.rows


#: The tools only external (DAP) callers are offered that read and change nothing.
_DAP_READ_TOOLS = ('dialect', 'list_documents', 'chunks', 'vectors', 'sample', 'project', 'neighbors')


@pytest.mark.parametrize('tool', _DAP_READ_TOOLS)
def test_a_read_from_a_connection_signed_in_with_a_public_task_key_is_refused_before_the_store_is_read(tool):
    store = MemoryStore().seed(corpus({'a': [0, 1]}))
    seen = len(store.calls)
    answer = _dispatch(_tool_node(store), tool, {}, dap(auth='public'))
    assert answer == {'success': False, 'code': 'READS_PUBLIC', 'error': 'The store refused this request.'}
    assert len(store.calls) == seen, 'nothing was read'


@pytest.mark.parametrize(
    'ctx',
    [
        dap(),
        dap(auth='task'),
        dap(source_type='chat'),
        dap(source_type='dropper', auth='task'),
        dap(targeted=False),
        agent(),
        None,
    ],
    ids=['account', 'task', 'chat-source', 'dropper-task', 'broadcast', 'agent', 'no-context'],
)
def test_reads_answer_every_caller_but_a_public_task_key(ctx):
    # Read-only cards read through the Chat (or Ingest) source, so reads are not limited to Tools sources.
    store = MemoryStore().seed(corpus({'a': [0, 1]}))
    answer = _dispatch(_tool_node(store), 'list_documents', {}, ctx)
    assert answer['success'] is True, answer
    assert [row['objectId'] for row in answer['items']] == ['a']


def test_the_read_check_is_the_gate_module_s_and_reads_the_engine_context():
    with tool_context.tool_call(dap(auth='public')):
        with pytest.raises(ToolRefusal) as refused:
            vx_write_gate.check_read()
    assert refused.value.code == 'READS_PUBLIC'
    with tool_context.tool_call(dap()):
        vx_write_gate.check_read()
    vx_write_gate.check_read()


def test_the_default_switches_refuse_a_dap_write_and_let_an_agent_write():
    store = MemoryStore().seed(corpus({'a': [0], 'b': [0]}))
    node = _tool_node(store)
    refused = _dispatch(node, 'delete', {'object_ids': ['a']}, dap())
    assert refused['success'] is False and refused['code'] == 'WRITES_DISABLED'
    assert ('a', 0) in store.rows
    allowed = _dispatch(node, 'delete', {'object_ids': ['b']}, agent())
    assert allowed['success'] is True, allowed
    assert not any(key[0] == 'b' for key in store.rows)


def test_an_agent_writes_whenever_allow_write_is_on():
    """allow_write alone decides an agent's write: allow_writes is off, and a stray agent_writes is not read."""
    store = MemoryStore().seed(corpus({'a': [0], 'b': [0]}))
    node = _tool_node(store, allow_writes=False, allow_write=True)
    node.IGlobal.agent_writes = False
    answer = _dispatch(node, 'delete', {'object_ids': ['a']}, agent())
    assert answer['success'] is True, answer
    assert not any(key[0] == 'a' for key in store.rows)
    assert ('b', 0) in store.rows


@pytest.mark.parametrize('tool', _WRITE_TOOLS)
def test_with_allow_write_off_an_agent_has_no_write_tool(tool):
    store = MemoryStore().seed(corpus({'a': [0]}))
    node = _tool_node(store, allow_writes=True, allow_write=False)
    assert tool not in node._collect_tool_methods()
    with tool_context.tool_call(agent()):
        answer = getattr(node, tool)({'object_ids': ['a'], 'documents': [{'content': 'x', 'object_id': 'a'}]})
    assert answer['success'] is False and 'allow_write=true' in answer['error'], answer
    assert ('a', 0) in store.rows
