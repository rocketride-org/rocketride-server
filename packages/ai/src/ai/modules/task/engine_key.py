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

IN the key: every component's resolved config and type, the connections in a
stable order, and the entry ``source``. OUT of the key: the ``parameters``
map, the trace level, threads, args, env values, per-call params, the owner,
``project_id``/``name``/``description``, layout and ttl. A spec that is not
shareable across users gets the key ``hash:ownerId``: every control of that
owner with the same content shares it, nobody else does.
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

#: What the caller's catalog says about one component: its resolved config
#: and whether it may run on a cross-user engine (``multitenant`` certified
#: and from the catalog). Called as ``facts(provider, stored_config)``.
ComponentFacts = Callable[[str, Dict[str, Any]], Tuple[Dict[str, Any], bool]]


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
    resolved_config: Mapping[str, Dict[str, Any]],
    types: Mapping[str, str],
    connections: Mapping[str, Mapping[str, List[Dict[str, str]]]],
    source: str,
    *,
    avoid_mocks: bool = False,
) -> str:
    """
    sha256 over the sort-keyed JSON of the resolved spec.

    Args:
        resolved_config: Component id -> resolved config (defaults applied,
            ``${ROCKETRIDE_*}`` placeholders UNEXPANDED).
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
                'config': resolved_config.get(component_id) or {},
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


def qualified_key(hash_value: str, *, shareable: bool, owner_id: str) -> str:
    """
    The registry key of an engine: the hash, qualified by its owner when private.

    Args:
        hash_value: The spec's content hash.
        shareable: True for a cross-user engine.
        owner_id: The owning user (or team, for a team-owned run).

    Returns:
        ``hash`` for a cross-user engine, ``hash:ownerId`` otherwise.
    """
    return hash_value if shareable or not owner_id else f'{hash_value}:{owner_id}'


def engine_key(
    resolved_config: Mapping[str, Dict[str, Any]],
    types: Mapping[str, str],
    connections: Mapping[str, Mapping[str, List[Dict[str, str]]]],
    source: str,
    *,
    shareable: bool,
    owner_id: str,
    avoid_mocks: bool = False,
) -> str:
    """
    The engine key of a resolved spec (plan 7.2, ALB seam 1).

    Args:
        resolved_config: Component id -> resolved config.
        types: Component id -> provider.
        connections: Component id -> its stable-order wiring.
        source: The entry component id.
        shareable: True when the engine may be held across users.
        owner_id: The owner the key is qualified with when not shareable.
        avoid_mocks: The spec's ``avoidMocks`` flag (see ``content_hash``).

    Returns:
        The engine key, also the task file's ``taskId``.
    """
    return qualified_key(
        content_hash(resolved_config, types, connections, source, avoid_mocks=avoid_mocks),
        shareable=shareable,
        owner_id=owner_id,
    )


# ==== From a spec ==============================================================


class EngineContent:
    """
    The content identity of a pipeline spec: its resolved parts, hash and shareability.

    Attributes:
        resolved_config: Component id -> resolved config.
        types: Component id -> provider.
        connections: Component id -> stable-order wiring.
        source: The entry component id.
        content_hash: sha256 over the sort-keyed JSON of the resolved spec.
        shareable: True when the engine may be held by controls of different
            users (a request/response source and every component certified
            ``multitenant`` and from the catalog).
        avoid_mocks: The spec's ``avoidMocks`` flag; part of the identity.
    """

    __slots__ = ('resolved_config', 'types', 'connections', 'source', 'content_hash', 'shareable', 'avoid_mocks')

    def __init__(
        self,
        resolved_config: Dict[str, Dict[str, Any]],
        types: Dict[str, str],
        connections: Dict[str, Dict[str, List[Dict[str, str]]]],
        source: str,
        shareable: bool,
        avoid_mocks: bool = False,
    ) -> None:
        """Hold the resolved parts and derive the hash."""
        self.resolved_config = resolved_config
        self.types = types
        self.connections = connections
        self.source = source
        self.shareable = shareable
        self.avoid_mocks = avoid_mocks
        self.content_hash = content_hash(resolved_config, types, connections, source, avoid_mocks=avoid_mocks)

    def key(self, *, shared: bool, owner_id: str) -> str:
        """
        The engine key for this content.

        Args:
            shared: True to key a cross-user engine (only when ``shareable``
                and the caller's engine shape is the policy one).
            owner_id: The owner a private key is qualified with.

        Returns:
            The engine key.
        """
        return qualified_key(self.content_hash, shareable=shared and self.shareable, owner_id=owner_id)


def engine_content(pipeline: Mapping[str, Any], source: str, facts: ComponentFacts) -> EngineContent:
    """
    Compute the content identity of a pipeline spec.

    Shareable across users iff the entry source is a request/response source
    (webhook, chat, dropper) AND ``facts`` says every component may run on a
    cross-user engine (plan section 1, 4.4); anything else is shared per
    owner only. A component ``facts`` cannot resolve enters with its stored
    config verbatim and makes the engine private.

    Args:
        pipeline: The spec as submitted (placeholders unexpanded).
        source: The entry component id.
        facts: The caller's catalog: ``facts(provider, stored) -> (resolved, shareable)``.

    Returns:
        EngineContent: the resolved parts, the hash and the cross-user shareability.
    """
    resolved: Dict[str, Dict[str, Any]] = {}
    types: Dict[str, str] = {}
    wiring: Dict[str, Dict[str, List[Dict[str, str]]]] = {}
    shareable = True
    for component in pipeline.get('components', []) or []:
        component_id = str(component.get('id'))
        provider = str(component.get('provider') or '')
        stored = component.get('config') or {}
        try:
            config, component_shareable = facts(provider, stored)
        except Exception:
            config, component_shareable = stored, False
        resolved[component_id] = config
        types[component_id] = provider
        wiring[component_id] = connections_of(component)
        shareable = shareable and component_shareable
    source_provider: Optional[str] = types.get(str(source))
    shareable = shareable and source_provider in CONST_SHAREABLE_SOURCES
    return EngineContent(resolved, types, wiring, source, shareable, avoid_mocks=bool(pipeline.get('avoidMocks')))
