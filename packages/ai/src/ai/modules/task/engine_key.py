# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
The engine key: the content identity of a pipeline spec (plan section 7.2).

PURE by contract (ALB seam 1): this module imports the standard library
only. No server, no account, no asyncio, no node catalog. Anything that has
to consult the catalog (resolving a stored config, reading a node's
certification) is done by the caller and handed in, either as the resolved
values (``engine_key``) or as a ``facts`` callable (``engine_content``). A
front end that is not the task server computes the same key from the same
inputs; ``test_engine_key_parity`` holds a server process and a bare
``python -c`` import of this file to the same answer.

IN the key: every component's provider, the connections in a stable order,
the entry ``source`` and ``avoidMocks``: the SHAPE of the spec. OUT of the
key: every component's configuration (per control: it rides the control's
first open, plan 5.3), the ``parameters`` map, the trace level, threads,
args, env values, per-call params, the owner, ``project_id``/``name``/
``description``, layout and ttl. The resolved config is still computed here
(``EngineContent.resolved_config`` / ``config_by_index``): it validates the
spec and is the control's configuration identity, never hashed into the
engine key. In this PR every rung qualifies the key by its owner,
``hash:ownerId`` (plan 13 Step 3c PR 1); C.25 leaves the published rungs
bare.

The STACK ORDER (C.23) is the engine's own canonical walk, read through the
engine binding ``engLib.pipelineStack`` when the process has the engine
loaded (the server always does): the order the task file writes, the index
every control's config and every trace speaks, and the SHAPE hash
(``EngineContent.shape_hash``), which ignores component ids. The module never
imports the engine: it looks the binding up in ``sys.modules`` and, in a
bare interpreter or on an engine without the binding, falls back to the
component id order. The engine key itself is still ``content_hash`` until
C.25 switches it to the shape hash.
"""

import hashlib
import json
import sys
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

# ==== Policy constants =========================================================

#: Request/response sources: every unit of work arrives as a request from a
#: caller, so an engine running one of them can serve many callers. Listener
#: sources (discord, telegram, a scan) have no caller per unit of work.
CONST_SHAREABLE_SOURCES = frozenset({'webhook', 'chat', 'dropper'})

#: Catalog nodes ship with the engine and load from the ``nodes`` package;
#: anything else (``local_nodes``, a workspace node) is not a catalog node.
CONST_CATALOG_NODE_PREFIX = 'nodes.'

#: The rungs whose engines are keyed ``hash:ownerId``: every rung in this PR
#: (no cross-owner sharing before C.25, which shrinks this to ``spec``).
OWNER_QUALIFIED_RUNGS = frozenset({'spec', 'me', 'team', 'public'})

#: What the caller's catalog says about one component: its resolved config
#: and whether it may run on a cross-user engine (``multitenant`` certified
#: and from the catalog). Called as ``facts(provider, stored_config)``.
ComponentFacts = Callable[[str, Dict[str, Any]], Tuple[Dict[str, Any], bool]]


# ==== The stack order ============================================================

#: The engine module whose ``pipelineStack`` binding is the canonical walk.
CONST_ENGINE_MODULE = 'engLib'

#: The longest stack index a trace can carry, in decimal digits.
CONST_MAX_INDEX_DIGITS = 9


def _component_id(component: Any) -> str:
    """A component entry's id as a string ('' for a malformed entry)."""
    return str((component or {}).get('id') if isinstance(component, dict) else '')


def pipeline_stack(pipeline: Mapping[str, Any], source: Optional[str]) -> Optional[Dict[str, Any]]:
    """
    The engine's canonical stack of a spec (plan 7.2), or None where the engine binding is absent.

    One walk, the engine's own (``stack.cpp`` ``computePipelineStack``):
    index 0 is the source, then every component the engine builds, in an
    order that depends on the shape alone. The server never reimplements it.
    The binding is looked up in ``sys.modules``, never imported, so this
    module stays importable in a bare interpreter, where the answer is None.

    Args:
        pipeline: The spec (``components``, optional ``avoidMocks``).
        source: The entry component id.

    Returns:
        ``{'components': [{index, id, provider, inputs: [{from, lane}],
        controls: [{from, classType}]}], 'hash': str}`` with ``from`` a stack
        index, or None when the process has no engine with the binding.

    Raises:
        Exception: The engine refused the spec (two components with one id, a
            member without a provider), as the engine itself would at start.
    """
    engine = sys.modules.get(CONST_ENGINE_MODULE)
    binding = getattr(engine, 'pipelineStack', None) if engine is not None else None
    if binding is None:
        return None
    return binding(dict(pipeline), str(source or ''))


def stack_order(components: List[Any], stack: Optional[Mapping[str, Any]] = None) -> List[Any]:
    """
    The components of a spec in STACK ORDER: the one order the task file writes and the open's config follows.

    The engine indexes ``_caller.config`` by a component's position in the
    task file's ``pipeline.components`` and names a component in a trace by
    its canonical stack index; the server writes the task file and builds
    every control's config from this ONE rule, so position and index agree
    and two controls of one shape that list (or name) their components
    differently index them alike. With the engine's canonical stack (C.23)
    the stack members come first in stack order, then the components the
    engine never builds (another source's branch, an orphan) by id; without
    it, the component id order (C.22).

    Args:
        components: The spec's ``components`` entries.
        stack: ``pipeline_stack`` of the spec, or None.

    Returns:
        The same entries, in stack order.
    """
    if not stack:
        return sorted(components, key=_component_id)
    rank = {str(entry.get('id')): int(entry.get('index')) for entry in stack.get('components') or []}
    stacked = sorted((c for c in components if _component_id(c) in rank), key=lambda c: rank[_component_id(c)])
    rest = sorted((c for c in components if _component_id(c) not in rank), key=_component_id)
    return stacked + rest


class IndexMap:
    """
    Author component id <-> stack index for one spec (C.23): the server's translation table.

    The engine speaks stack indexes (traces, the open's config); a control
    shows its user the ids THEY wrote. The position of a component in
    ``stack_order`` is its index, so the table is that order.

    Attributes:
        ids: The component ids in stack order.
        stacked: How many of them the engine builds (the canonical stack's
            length); the rest are never built and never traced.
        engine_indexes: True when the order came from the engine's canonical
            stack, so the engine names components by index; False on an
            engine without the binding, which names them by id.
        shape_hash: The canonical stack's shape hash, or None.
    """

    __slots__ = ('ids', 'stacked', 'engine_indexes', 'shape_hash', '_index')

    def __init__(self, ids: List[str], stacked: int, engine_indexes: bool, shape_hash: Optional[str] = None) -> None:
        """Hold the order and index it."""
        self.ids = list(ids)
        self.stacked = stacked
        self.engine_indexes = engine_indexes
        self.shape_hash = shape_hash
        self._index = {component_id: index for index, component_id in enumerate(self.ids)}

    def to_index(self, component_id: Any) -> Optional[int]:
        """The stack index of an author id, or None for an id the spec does not have."""
        return self._index.get(str(component_id))

    def to_id(self, index: Any) -> Optional[str]:
        """The author id at a stack index, or None for an index outside the spec."""
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(self.ids):
            return None
        return self.ids[index]

    def author(self, component: Any) -> Any:
        """
        The author's id for a component the engine named in a trace.

        The engine writes a stack member's index in ASCII decimal; anything
        else (a filter the pipeline does not name, a tool call's own label, a
        label of non-ASCII digits such as '²') passes through, as does
        every value on an engine that names by id.

        Args:
            component: The trace's component field.

        Returns:
            The author id, or the value unchanged.
        """
        if not self.engine_indexes or not isinstance(component, str):
            return component
        # Only the engine's own spelling is an index: ASCII digits, no longer
        # than any stack could need (str.isdigit alone accepts '²', which
        # int() refuses)
        if not (0 < len(component) <= CONST_MAX_INDEX_DIGITS and component.isascii() and component.isdigit()):
            return component
        index = int(component)
        return self.ids[index] if index < min(self.stacked, len(self.ids)) else component

    def order(self, components: List[Any]) -> List[Any]:
        """The spec's component entries in this stack order (entries this map does not know go last, by id)."""
        known = [c for c in components if _component_id(c) in self._index]
        known.sort(key=lambda c: self._index[_component_id(c)])
        return known + sorted((c for c in components if _component_id(c) not in self._index), key=_component_id)


def index_map_of(
    pipeline: Mapping[str, Any], source: Optional[str], stack: Optional[Mapping[str, Any]] = None
) -> IndexMap:
    """
    The id <-> index table of a spec, from the engine's canonical stack when the process has it.

    Position i of ``ids`` is the engine's stack index i, row for row, never
    compacted: a stack row the spec has no component entry for (a source
    named by ``source`` but missing from ``components``) keeps its slot under
    the id the stack gives it, so every later component keeps the index the
    engine traces it by. The components the engine never builds follow, by id.

    Args:
        pipeline: The spec.
        source: The entry component id.
        stack: ``pipeline_stack`` already computed for this spec, or None to
            compute it here.

    Returns:
        The spec's ``IndexMap``.
    """
    if stack is None:
        stack = pipeline_stack(pipeline, source)
    components = list(pipeline.get('components') or [])
    if stack is None:
        return IndexMap([_component_id(c) for c in stack_order(components)], 0, engine_indexes=False)
    # The stack's rows by index, then everything the engine never builds
    rows = sorted(stack.get('components') or [], key=lambda row: int(row.get('index')))
    ids = [str(row.get('id')) for row in rows]
    stacked = set(ids)
    ids += [_component_id(c) for c in sorted(components, key=_component_id) if _component_id(c) not in stacked]
    return IndexMap(
        ids,
        len(rows),
        engine_indexes=True,
        shape_hash=str(stack.get('hash')),
    )


# ==== The pure key =============================================================


def connections_of(component: Mapping[str, Any]) -> Dict[str, List[Dict[str, str]]]:
    """
    One component's wiring in a stable order.

    The wiring is content; its order in the file is not.

    Args:
        component: One entry of the pipeline's ``components``.

    Returns:
        ``{'input': [{lane, from}...], 'control': [{classType, from}...]}``, sorted.
    """
    inputs = sorted(
        ({'lane': str(c.get('lane') or ''), 'from': str(c.get('from') or '')} for c in component.get('input') or []),
        key=lambda c: (c['from'], c['lane']),
    )
    controls = sorted(
        (
            {'classType': str(c.get('classType') or ''), 'from': str(c.get('from') or '')}
            for c in component.get('control') or []
        ),
        key=lambda c: (c['from'], c['classType']),
    )
    return {'input': inputs, 'control': controls}


def content_hash(
    types: Mapping[str, str],
    connections: Mapping[str, Mapping[str, List[Dict[str, str]]]],
    source: str,
    *,
    avoid_mocks: bool = False,
) -> str:
    """
    sha256 over the sort-keyed JSON of the spec's shape: providers, wiring, source.

    Configuration is not here (plan 7.2): a spec that differs only in a config
    value is another control on the same engine.

    Args:
        types: Component id -> provider.
        connections: Component id -> ``connections_of(component)``.
        source: The entry component id.
        avoid_mocks: The spec's ``avoidMocks`` flag. It changes the engine's
            subprocess environment (``ROCKETRIDE_MOCK`` is stripped), so a
            mocked and a real-model engine are two engines.

    Returns:
        The hex digest.
    """
    components = sorted(
        (
            {
                'id': component_id,
                'provider': str(types.get(component_id) or ''),
                'input': list((connections.get(component_id) or {}).get('input') or []),
                'control': list((connections.get(component_id) or {}).get('control') or []),
            }
            for component_id in types
        ),
        key=lambda c: str(c['id']),
    )
    identity: Dict[str, Any] = {'source': source, 'components': components}
    if avoid_mocks:
        identity['avoidMocks'] = True
    content = json.dumps(identity, sort_keys=True, default=str)
    return hashlib.sha256(content.encode('utf-8')).hexdigest()


def qualified_key(hash_value: str, *, rung: str, owner_id: str) -> str:
    """
    The registry key of an engine: the shape hash, qualified by its owner on an owner-qualified rung.

    Args:
        hash_value: The spec's shape hash.
        rung: The rung the control resolved on (``spec``, ``me``, ``team``, ``public``).
        owner_id: The owning user (or team, for a team-owned run).

    Returns:
        ``hash:ownerId`` on a rung in :data:`OWNER_QUALIFIED_RUNGS` (every
        rung in this PR), the bare ``hash`` otherwise.
    """
    if rung not in OWNER_QUALIFIED_RUNGS or not owner_id:
        return hash_value
    return f'{hash_value}:{owner_id}'


def engine_key(
    types: Mapping[str, str],
    connections: Mapping[str, Mapping[str, List[Dict[str, str]]]],
    source: str,
    *,
    rung: str,
    owner_id: str,
    avoid_mocks: bool = False,
) -> str:
    """
    The engine key of a spec's shape (plan 7.2, ALB seam 1).

    Args:
        types: Component id -> provider.
        connections: Component id -> its stable-order wiring.
        source: The entry component id.
        rung: The rung the control resolved on.
        owner_id: The owner the key is qualified with.
        avoid_mocks: The spec's ``avoidMocks`` flag (see ``content_hash``).

    Returns:
        The engine key, also the task file's ``taskId``.
    """
    return qualified_key(
        content_hash(types, connections, source, avoid_mocks=avoid_mocks),
        rung=rung,
        owner_id=owner_id,
    )


# ==== From a spec ==============================================================


class EngineContent:
    """
    The identity of a pipeline spec: its shape hash (the engine's) and its resolved config (the control's).

    Attributes:
        resolved_config: Component id -> resolved config (defaults applied,
            placeholders unexpanded). Never hashed into the engine key.
        config_by_index: The same RESOLVED configs as a list by STACK INDEX
            (``stack_order``: the engine's canonical walk when the process
            has the binding, the component id order otherwise; the component
            order the task file carries): the control's configuration
            identity (a spelled-out default and an omitted one are one
            control).
        stored_by_index: The configs AS THE SPEC STORES THEM, by the same
            index: what the control's open delivers to the engine, which
            resolves them against the node schemas itself (a resolved,
            flattened view would not round-trip through the resolver).
        types: Component id -> provider.
        connections: Component id -> stable-order wiring.
        source: The entry component id.
        content_hash: sha256 over the sort-keyed JSON of the shape, ids
            included: the engine key until C.25.
        shape_hash: The engine's SHAPE hash (C.23): the canonical stack's
            providers and wiring by stack index plus ``avoidMocks``, ids and
            configuration outside it; None where the process has no engine
            binding. Logged beside the content hash; not yet the key.
        index_map: Author id <-> stack index for this spec.
        shareable: What the catalog certifies (a request/response source and
            every component ``multitenant`` from the catalog). Not consulted
            for the key in this PR (every rung is owner-qualified); C.25
            removes it with the certification.
        avoid_mocks: The spec's ``avoidMocks`` flag; part of the shape.
    """

    __slots__ = (
        'resolved_config',
        'config_by_index',
        'stored_by_index',
        'types',
        'connections',
        'source',
        'content_hash',
        'shape_hash',
        'index_map',
        'shareable',
        'avoid_mocks',
    )

    def __init__(
        self,
        resolved_config: Dict[str, Dict[str, Any]],
        config_by_index: List[Dict[str, Any]],
        stored_by_index: List[Dict[str, Any]],
        types: Dict[str, str],
        connections: Dict[str, Dict[str, List[Dict[str, str]]]],
        source: str,
        shareable: bool,
        avoid_mocks: bool = False,
        index_map: Optional[IndexMap] = None,
    ) -> None:
        """Hold the resolved parts and derive the content hash."""
        self.resolved_config = resolved_config
        self.config_by_index = config_by_index
        self.stored_by_index = stored_by_index
        self.types = types
        self.connections = connections
        self.source = source
        self.shareable = shareable
        self.avoid_mocks = avoid_mocks
        self.index_map = index_map if index_map is not None else IndexMap(sorted(types), 0, engine_indexes=False)
        self.shape_hash = self.index_map.shape_hash
        self.content_hash = content_hash(types, connections, source, avoid_mocks=avoid_mocks)

    def key(self, *, rung: str, owner_id: str) -> str:
        """
        The engine key for this shape.

        Args:
            rung: The rung the control resolved on.
            owner_id: The owner the key is qualified with.

        Returns:
            The engine key.
        """
        return qualified_key(self.content_hash, rung=rung, owner_id=owner_id)


def engine_content(pipeline: Mapping[str, Any], source: str, facts: ComponentFacts) -> EngineContent:
    """
    Compute the identity of a pipeline spec: its shape and its resolved config.

    The config of every component is resolved through ``facts`` (defaults
    applied) in ``stack_order`` (the engine's canonical walk through the
    ``pipelineStack`` binding, or the component id order without it; NOT
    the order the spec lists them), the stack index the task file carries:
    ``config_by_index`` and ``stored_by_index`` follow that order, never the
    submitted component list. A component ``facts`` cannot resolve (an
    unknown node, a config that does not fit its schema) is an ERROR, raised
    as ``facts`` raised it, and so is a spec the engine's walk refuses: a
    spec that cannot be keyed is never run (audit 2026-11-12).
    ``shareable`` records what the catalog certifies (a request/response
    source and every component ``multitenant`` from the catalog); nothing
    reads it for the key in this PR.

    Args:
        pipeline: The spec as submitted (placeholders unexpanded).
        source: The entry component id.
        facts: The caller's catalog: ``facts(provider, stored) -> (resolved, shareable)``.

    Returns:
        EngineContent: the resolved parts, the content and shape hashes and the certification.
    """
    resolved: Dict[str, Dict[str, Any]] = {}
    by_index: List[Dict[str, Any]] = []
    stored_by_index: List[Dict[str, Any]] = []
    types: Dict[str, str] = {}
    wiring: Dict[str, Dict[str, List[Dict[str, str]]]] = {}
    shareable = True
    # The one stack order: the engine's walk when the process has it
    index_map = index_map_of(pipeline, source)
    for component in index_map.order(list(pipeline.get('components', []) or [])):
        component_id = str(component.get('id'))
        provider = str(component.get('provider') or '')
        stored = component.get('config') or {}
        config, component_shareable = facts(provider, stored)
        resolved[component_id] = config
        by_index.append(config)
        stored_by_index.append(dict(stored))
        types[component_id] = provider
        wiring[component_id] = connections_of(component)
        shareable = shareable and component_shareable
    source_provider: Optional[str] = types.get(str(source))
    shareable = shareable and source_provider in CONST_SHAREABLE_SOURCES
    return EngineContent(
        resolved,
        by_index,
        stored_by_index,
        types,
        wiring,
        source,
        shareable,
        avoid_mocks=bool(pipeline.get('avoidMocks')),
        index_map=index_map,
    )
