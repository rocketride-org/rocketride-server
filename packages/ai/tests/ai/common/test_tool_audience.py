"""Unit tests for tool audiences: what the agent catalog lists versus what a node dispatches.

``@tool_function(audience=...)`` records who a tool is listed for: ``'agent'``
(the catalog ``tool.query`` builds for agents) and/or ``'dap'`` (external tool
calls). ``tool.query`` lists only agent-audience tools; ``tool.invoke``
dispatches every ``@tool_function`` regardless of audience.

The vector store tools are the reason: Vector Explorer adds DAP-only tools to
every store node, and an agent must keep seeing develop's six tools (search,
upsert, delete, objdir, get, stats) with byte-identical descriptors, the same
accepted inputs and the same output keys. The agent catalog also lists the three
tools #2704 adds and the Vector Explorer shares with it, under #2704's names:
``list_documents``, ``soft_delete`` and ``restore`` (their descriptors are the
port's: cursor-paged listing, trash writes with ``matched_chunks``).
``fixtures/vector_store_agent_descriptors.json`` is that catalog of nine: its six
develop entries are what base 3dec66821 (develop 87f530f39) builds, byte for byte,
and its three new entries are this branch's.

These run in the engine's Python (``./engine -m pytest``) because they drive the
real ``rocketlib`` dispatcher and the real store mixin.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional, Tuple

import pytest

from rocketlib import APERR, Ec, IInstanceBase, tool_function
from rocketlib.types import IInvokeTool

from ai.common.schema import Doc, DocFilter, DocMetadata
from ai.common.store import DocumentStoreBase, VectorStoreToolMixin
from ai.common.tool_context import TOOL_CONTEXT_FIELD, agent_context, current_tool_call

GOLDEN = Path(__file__).parent / 'fixtures' / 'vector_store_agent_descriptors.json'
#: The agent catalog in tool.query order: develop's six (delete, get, objdir, search, stats, upsert) plus #2704's three.
AGENT_TOOLS = ['delete', 'get', 'list_documents', 'objdir', 'restore', 'search', 'soft_delete', 'stats', 'upsert']

# ---------------------------------------------------------------------------
# The decorator
# ---------------------------------------------------------------------------


def test_default_audience_is_agent_and_dap():
    """A tool declared without an audience is listed for both, as every tool was before."""

    @tool_function(description='d')
    def tool(self, args):  # pragma: no cover - never called
        return None

    assert tool.__tool_meta__['audience'] == ('agent', 'dap')


@pytest.mark.parametrize(
    'audience, expected',
    [
        (('dap',), ('dap',)),
        (['agent'], ('agent',)),
        ('dap', ('dap',)),
        (('dap', 'agent', 'dap'), ('dap', 'agent')),
    ],
)
def test_audience_is_recorded_as_a_tuple_of_names(audience, expected):
    """Lists, tuples and a single string are all accepted; a string is never split into letters."""

    @tool_function(description='d', audience=audience)
    def tool(self, args):  # pragma: no cover - never called
        return None

    assert tool.__tool_meta__['audience'] == expected


@pytest.mark.parametrize('audience', [(), [], None, ('agents',), ('dap', 'public'), 'everyone'])
def test_unknown_or_empty_audience_is_rejected(audience):
    """A typo in the audience fails at import time rather than silently hiding a tool."""
    with pytest.raises(ValueError):
        tool_function(description='d', audience=audience)


def test_meta_keeps_its_other_keys():
    """The audience is added next to the existing metadata, which keeps its keys."""

    @tool_function(input_schema={'type': 'object'}, description='d', output_schema={'type': 'object'})
    def tool(self, args):  # pragma: no cover - never called
        return None

    assert set(tool.__tool_meta__) == {'input_schema', 'description', 'output_schema', 'audience'}


# ---------------------------------------------------------------------------
# A node with tools for both audiences
# ---------------------------------------------------------------------------


class _Mixed(IInstanceBase):
    """A node with one tool per audience combination, plus a method with legacy metadata."""

    def __init__(self) -> None:
        self.IGlobal = SimpleNamespace(tool_description='')
        self.calls: List[Tuple[str, Any]] = []

    @tool_function(input_schema={'type': 'object'}, description='For everyone.')
    def shared(self, args: Any) -> Dict[str, Any]:
        self.calls.append(('shared', current_tool_call()))
        return {'tool': 'shared'}

    @tool_function(input_schema={'type': 'object'}, description='For agents only.', audience=('agent',))
    def agent_only(self, args: Any) -> Dict[str, Any]:
        self.calls.append(('agent_only', current_tool_call()))
        return {'tool': 'agent_only'}

    @tool_function(input_schema={'type': 'object'}, description='For external callers only.', audience=('dap',))
    def dap_only(self, args: Any) -> Dict[str, Any]:
        self.calls.append(('dap_only', current_tool_call()))
        return {'tool': 'dap_only'}

    def legacy(self, args: Any) -> Dict[str, Any]:
        return {'tool': 'legacy'}

    # A method stamped the way older code (or a test stub) does, without an audience key.
    legacy.__tool_meta__ = {'input_schema': {'type': 'object'}, 'description': 'Legacy meta.', 'output_schema': None}


def _query(node: IInstanceBase) -> List[Dict[str, Any]]:
    """Run tool.query through the real dispatcher and return the catalog it built."""
    param = IInvokeTool.Query()
    with pytest.raises(APERR) as raised:
        node.invoke(param)
    assert raised.value.ec == Ec.PreventDefault
    return param.tools


def _invoke(node: IInstanceBase, tool: str, input_obj: Any = None, *, stamp: Any = None) -> Any:
    """Run tool.invoke through the real dispatcher and return the tool output."""
    param = IInvokeTool.Invoke(tool_name=tool, input=input_obj if input_obj is not None else {})
    if stamp is not None:
        setattr(param, TOOL_CONTEXT_FIELD, stamp)
    node.invoke(param)
    return param.output


def test_tool_query_lists_only_agent_tools():
    """The agent catalog has the shared, agent-only and legacy tools, never the DAP-only one."""
    names = [d['name'] for d in _query(_Mixed())]
    assert sorted(names) == ['agent_only', 'legacy', 'shared']


def test_tool_invoke_dispatches_every_audience():
    """tool.invoke reaches DAP-only and agent-only tools alike."""
    node = _Mixed()
    assert _invoke(node, 'dap_only') == {'tool': 'dap_only'}
    assert _invoke(node, 'agent_only') == {'tool': 'agent_only'}
    assert _invoke(node, 'shared') == {'tool': 'shared'}
    assert _invoke(node, 'legacy') == {'tool': 'legacy'}


def test_unknown_tool_still_falls_through():
    """A tool this node does not own still raises PreventDefault so the next node can try."""
    with pytest.raises(APERR) as raised:
        _invoke(_Mixed(), 'nope')
    assert raised.value.ec == Ec.PreventDefault


def test_build_tool_descriptors_filters_by_audience():
    """The descriptor builder lists the audience it is asked for; None lists everything."""
    node = _Mixed()
    methods = node._collect_tool_methods()
    assert sorted(d['name'] for d in node._build_tool_descriptors(methods)) == ['agent_only', 'legacy', 'shared']
    assert sorted(d['name'] for d in node._build_tool_descriptors(methods, audience='dap')) == [
        'dap_only',
        'legacy',
        'shared',
    ]
    assert sorted(d['name'] for d in node._build_tool_descriptors(methods, audience=None)) == [
        'agent_only',
        'dap_only',
        'legacy',
        'shared',
    ]


def test_agent_host_catalog_has_no_dap_only_tool_and_cannot_call_one():
    """An agent never sees a DAP-only tool, and asking for it by name is 'not found'."""
    from ai.common.agent._internal.host import AgentHostServices, ToolNotFoundError

    node = _Mixed()

    def _route(param: Any, component_id: str = '') -> Any:
        return node.invoke(param)

    invoker = SimpleNamespace(instance=SimpleNamespace(getControllerNodeIds=lambda kind: ['mixed_1'], invoke=_route))
    tools = AgentHostServices.Tools(invoker)
    assert sorted(d['name'] for d in tools.list) == ['mixed_1.agent_only', 'mixed_1.legacy', 'mixed_1.shared']
    with pytest.raises(ToolNotFoundError):
        tools.invoke('mixed_1.dap_only', {})
    assert tools.invoke('mixed_1.shared', {}) == {'tool': 'shared'}
    assert node.calls[-1] == ('shared', agent_context())


# ---------------------------------------------------------------------------
# A vector store node: the agent catalog and the legacy tools do not change
# ---------------------------------------------------------------------------


class _MemoryStore(DocumentStoreBase):
    """An in-memory store driver: a collection of chunks keyed by (objectId, chunkId)."""

    def __init__(self, *, exists: bool = True) -> None:
        super().__init__('memory', {}, {})
        self.exists = exists
        self.chunks: Dict[Tuple[str, int], Doc] = {}
        if exists:
            self.modelName = 'test-model'
            self.vectorSize = 3

    def _doesCollectionExist(self) -> bool:
        return self.exists

    def _createCollection(self) -> None:
        self.exists = True

    def count_documents(self) -> int:
        return len(self.chunks) if self.exists else 0

    def _matching(self, docFilter: DocFilter) -> List[Doc]:
        docs = sorted(self.chunks.values(), key=lambda d: (d.metadata.objectId, d.metadata.chunkId))
        if docFilter.objectIds:
            docs = [d for d in docs if d.metadata.objectId in docFilter.objectIds]
        if docFilter.parent:
            docs = [d for d in docs if d.metadata.parent == docFilter.parent]
        return docs

    def searchKeyword(self, query: Any, docFilter: DocFilter) -> List[Doc]:
        return [d for d in self._matching(docFilter) if str(query.text) in (d.page_content or '')]

    def searchSemantic(self, query: Any, docFilter: DocFilter) -> List[Doc]:
        docs = self._matching(docFilter)[: docFilter.limit or 10]
        return [Doc(page_content=d.page_content, metadata=d.metadata, score=0.9 - i * 0.1) for i, d in enumerate(docs)]

    def get(self, docFilter: DocFilter) -> List[Doc]:
        docs = self._matching(docFilter)
        offset = docFilter.offset or 0
        return docs[offset : offset + (docFilter.limit or len(docs))]

    def getPaths(self, parent: Optional[str] = None, offset: int = 0, limit: int = 1000) -> Dict[str, str]:
        paths: Dict[str, str] = {}
        for (object_id, _chunk), doc in sorted(self.chunks.items()):
            if parent is None or doc.metadata.parent.startswith(parent):
                paths.setdefault(doc.metadata.parent, object_id)
        return dict(list(paths.items())[offset : offset + limit])

    def addChunks(self, chunks: List[Doc]) -> None:
        for doc in chunks:
            self.chunks[(doc.metadata.objectId, doc.metadata.chunkId)] = doc

    def remove(self, objectIds: List[str]) -> None:
        for key in [k for k in self.chunks if k[0] in objectIds]:
            del self.chunks[key]

    def markDeleted(self, objectIds: List[str]) -> None:
        pass

    def markActive(self, objectIds: List[str]) -> None:
        pass

    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        pass


def _seed(store: _MemoryStore) -> None:
    for object_id, parent, texts in (
        ('obj-a', 'C:/demo/a.md', ['alpha one', 'alpha two']),
        ('obj-b', '/srv/docs/b.txt', ['beta one']),
    ):
        store.addChunks(
            [
                Doc(
                    page_content=text,
                    metadata=DocMetadata(
                        objectId=object_id, chunkId=i, nodeId='chunk_1', parent=parent, isDeleted=False
                    ),
                    embedding=[0.1, 0.2, 0.3],
                )
                for i, text in enumerate(texts)
            ]
        )


class _StoreNode(VectorStoreToolMixin, IInstanceBase):
    """A vector store node instance over the in-memory driver."""

    def __init__(self, store: _MemoryStore) -> None:
        self.IGlobal = SimpleNamespace(
            store=store,
            serverName='postgres',
            tool_description='Demo corpus',
            embed_query=lambda text: [0.1, 0.2, 0.3],
            embed_model_name='test-model',
        )


def _store_node(*, exists: bool = True, seeded: bool = True) -> _StoreNode:
    store = _MemoryStore(exists=exists)
    if exists and seeded:
        _seed(store)
    return _StoreNode(store)


def _agent(node: IInstanceBase, tool: str, input_obj: Any) -> Any:
    """Call a tool as the agent host does (agent-stamped param) through the real dispatcher."""
    return _invoke(node, tool, input_obj, stamp=agent_context())


def test_store_agent_catalog_is_byte_identical_to_the_golden():
    """tool.query on a store node lists develop's six tools, byte-identical, and #2704's three."""
    catalog = _query(_store_node())
    assert [d['name'] for d in catalog] == AGENT_TOOLS
    assert json.dumps(catalog, sort_keys=True, indent=1) + '\n' == GOLDEN.read_text(encoding='utf-8')


def test_store_agent_catalog_through_the_agent_host_is_unchanged():
    """The namespaced catalog an agent driver reads carries the same descriptors."""
    from ai.common.agent._internal.host import AgentHostServices

    node = _store_node()
    invoker = SimpleNamespace(
        instance=SimpleNamespace(
            getControllerNodeIds=lambda kind: ['store_1'],
            invoke=lambda param, component_id='': node.invoke(param),
        )
    )
    tools = AgentHostServices.Tools(invoker)
    golden = json.loads(GOLDEN.read_text(encoding='utf-8'))
    assert [d['name'] for d in tools.list] == [f'store_1.{name}' for name in AGENT_TOOLS]
    assert [{**d, 'name': d['name'].split('.', 1)[1]} for d in tools.list] == golden


def test_legacy_search_input_and_output_keys():
    """The search tool takes query/top_k/filter and answers results[{content, score, metadata}] and total."""
    out = _agent(
        _store_node(),
        'search',
        {'query': 'alpha', 'top_k': 2, 'filter': {'objectId': 'obj-a', 'parent': 'C:/demo/a.md'}},
    )
    assert out['total'] == len(out['results']) == 2
    for row in out['results']:
        assert {'content', 'score', 'metadata'} <= set(row)
        assert {'objectId', 'nodeId', 'parent', 'chunkId'} <= set(row['metadata'])
        assert row['metadata']['objectId'] == 'obj-a'


def test_legacy_search_accepts_a_json_string_and_a_wrapped_input():
    """The legacy input normalization (JSON text, nested input wrapper) still applies."""
    node = _store_node()
    as_text = _agent(node, 'search', json.dumps({'query': 'beta'}))
    wrapped = _agent(node, 'search', {'input': {'query': 'beta'}})
    assert as_text['total'] >= 1
    assert wrapped['total'] >= 1


def test_legacy_search_empty_query_is_a_failure_envelope():
    """An empty query answers success false with an error, as before."""
    out = _agent(_store_node(), 'search', {'query': '  '})
    assert out['success'] is False
    assert isinstance(out['error'], str) and out['error']


def test_legacy_upsert_input_and_output_keys():
    """The upsert tool takes documents[{content, object_id, metadata}] and answers success/count/skipped."""
    node = _store_node()
    out = _agent(
        node,
        'upsert',
        {
            'documents': [
                {
                    'content': 'gamma',
                    'object_id': 'obj-c',
                    'metadata': {'nodeId': 'agent', 'parent': '/g', 'chunkId': 0},
                },
                {'content': '', 'object_id': 'obj-d'},
            ]
        },
    )
    assert out['success'] is True
    assert out['count'] == 1
    assert out['skipped'] == 1
    assert ('obj-c', 0) in node.IGlobal.store.chunks


def test_legacy_delete_input_and_output_keys():
    """The delete tool takes object_ids and answers success and deleted_count."""
    node = _store_node()
    out = _agent(node, 'delete', {'object_ids': ['obj-b']})
    assert out['success'] is True
    assert out['deleted_count'] == 1
    assert not [k for k in node.IGlobal.store.chunks if k[0] == 'obj-b']


def test_legacy_get_input_and_output_keys():
    """The get tool takes object_id/offset/limit and answers success, chunks[{content, chunkId, metadata}] and total."""
    out = _agent(_store_node(), 'get', {'object_id': 'obj-a', 'offset': 0, 'limit': 10})
    assert out['success'] is True
    assert out['total'] == len(out['chunks']) == 2
    assert [c['chunkId'] for c in out['chunks']] == [0, 1]
    for chunk in out['chunks']:
        assert {'content', 'chunkId', 'metadata'} <= set(chunk)


def test_legacy_objdir_input_and_output_keys():
    """The objdir tool takes parent/offset/limit and answers success and paths {path: objectId}."""
    out = _agent(_store_node(), 'objdir', {'offset': 0, 'limit': 100})
    assert out['success'] is True
    assert out['paths'] == {'/srv/docs/b.txt': 'obj-b', 'C:/demo/a.md': 'obj-a'}


def test_legacy_stats_output_keys():
    """The stats tool answers success, count, model and vector_size with their legacy meaning."""
    out = _agent(_store_node(), 'stats', {})
    assert out['success'] is True
    assert out['count'] == 3
    assert out['model'] == 'test-model'
    assert out['vector_size'] == 3


def test_legacy_stats_on_a_missing_collection_is_the_legacy_success_envelope():
    """A store whose collection does not exist yet still answers success with zero counts."""
    out = _agent(_store_node(exists=False), 'stats', {})
    assert out['success'] is True
    assert out['count'] == 0
    assert out['model'] == ''
    assert out['vector_size'] == 0
    assert out.get('collection_exists', False) is False
