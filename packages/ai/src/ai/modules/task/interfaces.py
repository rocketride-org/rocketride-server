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
# =============================================================================
# INTERFACES — what a pipeline offers a front end, by address and node (plan 3.6)
#
# A front end (the chat app, the dropper, the SQL explorer) needs two facts
# to talk to a pipeline: the ADDRESS to start and the NODE to call. This
# module derives both from a pipeline spec and the node catalog, nothing
# else — no engine, no hold, no deploy-time stamp. The map it answers is
#
#     { "<address>": { "<classType>": [ {nodeId, name}, ... ] } }
#
# Every source component sits under its own address (``dev.pipe.source``)
# with its catalog classTypes; every other component sits under the PIPE
# address (``dev.pipe`` — the default source) under each classType it
# carries. Interface names are the catalog's ``classType`` words, so a front
# end filters with plain equality (``database``, ``chat``, ``dropper``).
# ``name`` is always present: the author's display name, else the node id.
#
# Reachability is NOT computed here: the engine is the arbiter. A tool
# borrow of a node the entry source did not load fails at the engine and
# the front end shows that error (decided 2026-11-16).
#
# SOURCES. The classType words cannot tell sources apart: Telegram, Discord
# and the local file system all carry ``source`` alone, yet one is a
# listener and one a scan. ``pipe_sources`` answers what each source IS,
# from its provider's own declaration, under the same address the map uses:
#
#     { "<source address>": { nodeId, name, title, kind, entry, lanes } }
#
# ``kind`` is the service's ``sourceKind`` (``request``, ``listener`` or
# ``scan``; a service that declares none is a scan); ``entry`` is how a
# request reaches it (``tool`` for a source that hosts tools or is one,
# else ``data``); ``lanes`` are the lanes it declares on ``_source``.
#
# PURE MODULE: the catalog lookup is injected so the derivation is testable
# without a server and reusable from any door.
# =============================================================================

from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional

from .address import build_address

# ==== Types ====================================================================

#: One catalog lookup: provider name -> the catalog entry (or None when unknown).
CatalogLookup = Callable[[str], Awaitable[Optional[Mapping[str, Any]]]]

#: The answer: address -> classType -> [{nodeId, name}].
InterfaceMap = Dict[str, Dict[str, List[Dict[str, str]]]]

#: One source, as ``pipe_sources`` describes it.
SourceInfo = Dict[str, Any]

#: The sources answer: source address -> its description.
SourceMap = Dict[str, SourceInfo]

#: The classType word that marks a source component in the catalog.
CONST_SOURCE_CLASS_TYPE = 'source'

#: The classType word of a tool (a node an agent, or a caller, calls).
CONST_TOOL_CLASS_TYPE = 'tool'

#: The ways work reaches a source, as a service declares them.
SOURCE_KINDS = ('request', 'listener', 'scan')

#: The kind of a source whose service declares none (it reads on its own).
CONST_DEFAULT_SOURCE_KIND = 'scan'


# ==== The derivation ===========================================================


def _class_types(entry: Optional[Mapping[str, Any]]) -> List[str]:
    """
    The classType words of one catalog entry, in the catalog's order.

    Args:
        entry: The catalog entry for a provider, or None when unknown.

    Returns:
        The classTypes as strings; empty for an unknown provider or a
        malformed entry.
    """
    if not isinstance(entry, Mapping):
        return []
    raw = entry.get('classType')
    if isinstance(raw, str):
        return [raw]
    if not isinstance(raw, (list, tuple)):
        return []
    return [str(value) for value in raw if isinstance(value, str) and value]


def _is_source(component: Mapping[str, Any], class_types: List[str]) -> bool:
    """
    Whether a component is a source: the catalog says so, or the spec marks it.

    The spec's ``config.mode == 'Source'`` is what the engine reads when it
    infers the entry component; a node the catalog does not know (a custom
    node) still counts as a source when the author marked it one.

    Args:
        component: One entry of the pipeline's ``components``.
        class_types: The component's catalog classTypes.

    Returns:
        True for a source component.
    """
    if CONST_SOURCE_CLASS_TYPE in class_types:
        return True
    config = component.get('config')
    return isinstance(config, Mapping) and config.get('mode') == 'Source'


async def pipe_interfaces(
    pipeline: Mapping[str, Any],
    developer_id: str,
    pipe_id: str,
    lookup: CatalogLookup,
) -> InterfaceMap:
    """
    The interface map of one pipeline spec (plan 3.6).

    Args:
        pipeline: The pipeline spec (the deployed artifact, or a workspace
            spec): its ``components`` list is read, nothing else.
        developer_id: The namespace segment of the pipe's address.
        pipe_id: The pipe's short id.
        lookup: One async catalog lookup, provider -> entry.

    Returns:
        ``{address: {classType: [{nodeId, name}, ...]}}`` in the order the
        components appear in the spec. A component without an id or a
        provider is skipped; a component whose provider the catalog does not
        know contributes nothing unless the spec marks it a source, in which
        case it appears under its address with the ``source`` classType only.
    """
    pipe_address = build_address(developer_id, pipe_id)
    interfaces: InterfaceMap = {}
    components = pipeline.get('components') or []

    for component in components:
        # Step 1: the facts the entry needs, skipping what cannot be addressed
        if not isinstance(component, Mapping):
            continue
        node_id = str(component.get('id') or '')
        provider = str(component.get('provider') or '')
        if not node_id or not provider:
            continue
        class_types = _class_types(await lookup(provider))
        is_source = _is_source(component, class_types)
        if is_source and CONST_SOURCE_CLASS_TYPE not in class_types:
            class_types = [CONST_SOURCE_CLASS_TYPE, *class_types]
        if not class_types:
            continue

        # Step 2: a source under its own address, anything else under the pipe's
        address = build_address(developer_id, pipe_id, node_id) if is_source else pipe_address
        name = str(component.get('name') or node_id)
        entry = {'nodeId': node_id, 'name': name}
        by_class = interfaces.setdefault(address, {})
        for class_type in class_types:
            by_class.setdefault(class_type, []).append(dict(entry))

    return interfaces


def _source_kind(entry: Optional[Mapping[str, Any]]) -> str:
    """
    How work reaches a source, as its service declares it.

    Args:
        entry: The catalog entry for the source's provider, or None.

    Returns:
        The declared ``sourceKind``; ``scan`` for an unknown provider, a
        service that declares none, or a value the engine would refuse.
    """
    if isinstance(entry, Mapping):
        kind = entry.get('sourceKind')
        if kind in SOURCE_KINDS:
            return kind
    return CONST_DEFAULT_SOURCE_KIND


def _source_entry(entry: Optional[Mapping[str, Any]], class_types: List[str]) -> str:
    """
    How a request reaches a source: by tool call, or as data.

    A source that hosts tools (its service declares a ``tool`` invoke
    channel, as the Tools endpoint does) or is itself a tool (``tool`` in
    its classTypes, as the Pipeline Tool is) is entered by tool calls.

    Args:
        entry: The catalog entry for the source's provider, or None.
        class_types: The component's catalog classTypes.

    Returns:
        ``tool`` or ``data``.
    """
    if CONST_TOOL_CLASS_TYPE in class_types:
        return 'tool'
    if isinstance(entry, Mapping):
        invoke = entry.get('invoke')
        if isinstance(invoke, Mapping) and CONST_TOOL_CLASS_TYPE in invoke:
            return 'tool'
    return 'data'


def _source_lanes(entry: Optional[Mapping[str, Any]]) -> List[str]:
    """
    The lanes a source's service declares on ``_source``, in its order.

    Args:
        entry: The catalog entry for the source's provider, or None.

    Returns:
        The lane names; empty for an unknown provider or a service that
        declares none.
    """
    if not isinstance(entry, Mapping):
        return []
    lanes = entry.get('lanes')
    if not isinstance(lanes, Mapping):
        return []
    declared = lanes.get('_source')
    if not isinstance(declared, (list, tuple)):
        return []
    return [lane for lane in declared if isinstance(lane, str) and lane]


async def pipe_sources(
    pipeline: Mapping[str, Any],
    developer_id: str,
    pipe_id: str,
    lookup: CatalogLookup,
) -> SourceMap:
    """
    What each source of one pipeline spec is, from its provider's declaration.

    The same components ``pipe_interfaces`` puts under their own address,
    by the same rule (the catalog's ``source`` classType, or the spec's
    ``mode: Source``), keyed by that same address.

    Args:
        pipeline: The pipeline spec: its ``components`` list is read,
            nothing else.
        developer_id: The namespace segment of the pipe's address.
        pipe_id: The pipe's short id.
        lookup: One async catalog lookup, provider -> entry.

    Returns:
        ``{address: {nodeId, name, title, kind, entry, lanes}}`` in the
        order the components appear in the spec. ``title`` is the service's
        title, else the display name; a source whose provider the catalog
        does not know is a ``scan`` entered by ``data`` with no lanes.
    """
    sources: SourceMap = {}
    components = pipeline.get('components') or []

    for component in components:
        # Step 1: only addressable source components
        if not isinstance(component, Mapping):
            continue
        node_id = str(component.get('id') or '')
        provider = str(component.get('provider') or '')
        if not node_id or not provider:
            continue
        entry = await lookup(provider)
        class_types = _class_types(entry)
        if not _is_source(component, class_types):
            continue

        # Step 2: what its service declares about it
        name = str(component.get('name') or node_id)
        title = entry.get('title') if isinstance(entry, Mapping) else None
        sources[build_address(developer_id, pipe_id, node_id)] = {
            'nodeId': node_id,
            'name': name,
            'title': title if isinstance(title, str) and title else name,
            'kind': _source_kind(entry),
            'entry': _source_entry(entry, class_types),
            'lanes': _source_lanes(entry),
        }

    return sources
