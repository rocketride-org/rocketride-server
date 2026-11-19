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
"""

import hashlib
import json
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


def stack_order(components: List[Any]) -> List[Any]:
    """
    The components of a spec in STACK ORDER: the one order the task file writes and the open's config follows (C.22).

    The engine indexes ``_caller.config`` by a component's position in the
    task file's ``pipeline.components``; the server must therefore write the
    task file and build every control's config from ONE rule that does not
    depend on how a spec happens to list its components (two controls of one
    shape may list them differently). Until C.23 brings the canonical walk,
    the rule is the component id order.

    Args:
        components: The spec's ``components`` entries.

    Returns:
        The same entries, ordered by component id.
    """
    return sorted(
        components, key=lambda component: str((component or {}).get('id') if isinstance(component, dict) else '')
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
            (``stack_order``, the component order the task file carries,
            plan C.22; C.23 replaces it with the canonical walk): the
            control's configuration identity (a spelled-out default and an
            omitted one are one control).
        stored_by_index: The configs AS THE SPEC STORES THEM, by the same
            index: what the control's open delivers to the engine, which
            resolves them against the node schemas itself (a resolved,
            flattened view would not round-trip through the resolver).
        types: Component id -> provider.
        connections: Component id -> stable-order wiring.
        source: The entry component id.
        content_hash: sha256 over the sort-keyed JSON of the shape.
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
    ) -> None:
        """Hold the resolved parts and derive the shape hash."""
        self.resolved_config = resolved_config
        self.config_by_index = config_by_index
        self.stored_by_index = stored_by_index
        self.types = types
        self.connections = connections
        self.source = source
        self.shareable = shareable
        self.avoid_mocks = avoid_mocks
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
    applied) in the spec's component order, which is the stack index the
    task file carries (C.22). A component ``facts`` cannot resolve (an
    unknown node, a config that does not fit its schema) is an ERROR, raised
    as ``facts`` raised it: a spec that cannot be keyed is never run
    (audit 2026-11-12). ``shareable`` records what the catalog certifies
    (a request/response source and every component ``multitenant`` from the
    catalog); nothing reads it for the key in this PR.

    Args:
        pipeline: The spec as submitted (placeholders unexpanded).
        source: The entry component id.
        facts: The caller's catalog: ``facts(provider, stored) -> (resolved, shareable)``.

    Returns:
        EngineContent: the resolved parts, the shape hash and the certification.
    """
    resolved: Dict[str, Dict[str, Any]] = {}
    by_index: List[Dict[str, Any]] = []
    stored_by_index: List[Dict[str, Any]] = []
    types: Dict[str, str] = {}
    wiring: Dict[str, Dict[str, List[Dict[str, str]]]] = {}
    shareable = True
    for component in stack_order(pipeline.get('components', []) or []):
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
    )
