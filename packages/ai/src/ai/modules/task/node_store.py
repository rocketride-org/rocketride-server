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
The node packages EaaS serves: the nodes the server's index lists and its
nodes/ folder does not hold. Their definitions travel with each catalogue,
validation and stack call as the engine's custom services; before a run starts,
the ones its pipeline names are unpacked into nodes/, so the run's start-up
scan loads them.
"""

import base64
import copy
import json
import os
import tempfile
import threading
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from rocketlib import IJson, getServiceDefinition, getServiceDefinitions, warning

from ai.account import account
from ai.common import node_packages, node_release
from ai.constants import CONST_NODES_CONTRACT

# name -> index entry, provider (logical type) -> name, provider -> definition with its icon inline, and
# provider -> the schema the engine resolved from that definition; providers are keyed in lower case, as
# the engine ignores case when it looks one up
_nodes: Dict[str, Dict[str, Any]] = {}
_providers: Dict[str, str] = {}
_definitions: Dict[str, Dict[str, Any]] = {}
_schemas: Dict[str, Dict[str, Any]] = {}

# What `rocketlib.resolveConfig` consumes of a service the engine lists
_SCHEMA_KEYS = ('properties', 'params', 'capabilities')

# Two runs naming the same node must not unpack it at once
_unpacking = threading.Lock()


def start() -> None:
    """Keep what the index lists and nodes/ does not hold; an index it cannot use serves nothing."""
    try:
        index = account.node_index()
        if index.get('contract') != CONST_NODES_CONTRACT:
            warning(
                f'NODE_VERSION_MISMATCH: node index contract {index.get("contract")}, engine reads {CONST_NODES_CONTRACT}'
            )
            return
        nodes, providers, definitions = _served(index)
        # The engine parses them now: a definition it refuses would fail every catalogue call. A
        # definition in the old node format is refused here, like one on disk. What it lists for
        # each is the resolved schema a server-side lookup needs before the node is unpacked. The
        # internal ones are asked for too: a pipeline names them like any other (`response`), and
        # the listing a UI gets leaves them out
        schemas = _schemas_of(getServiceDefinitions(list(definitions.values()), True), definitions)
        _replace_stale(index)
    except Exception as e:
        warning(
            f'NODE_REGISTRY_UNAVAILABLE: the node index could not be used ({e}); only the nodes the server carries are available'
        )
        return
    problem = _unwritable(node_release.nodes_dir()) if nodes else None
    if problem:
        # A read-only install: say so once, rather than refuse every run that names one
        warning(f'NODE_REGISTRY_UNAVAILABLE: {problem}; not available: {", ".join(sorted(nodes))}')
        return
    _nodes.update(nodes)
    _providers.update(providers)
    _definitions.update(definitions)
    _schemas.update(schemas)


def _schemas_of(listed: Any, providers: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    """The resolved schema the engine made of each served definition: provider -> what `resolveConfig` consumes.

    Args:
        listed: What `getServiceDefinitions(custom, True)` returned: every service the engine knows and the
            custom ones, the internal ones included.
        providers: The providers served, in lower case.

    Returns:
        The schema of each provider the listing holds.
    """
    services = (IJson.toDict(listed) if listed is not None else {}).get('services') or {}
    by_name = {str(name).lower(): entry for name, entry in services.items()}
    schemas: Dict[str, Dict[str, Any]] = {}
    for provider in providers:
        entry = by_name.get(provider)
        if isinstance(entry, dict):
            schemas[provider] = {key: entry[key] for key in _SCHEMA_KEYS if key in entry}
    return schemas


def _served(index: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, str], Dict[str, Any]]:
    """The index's nodes the engine does not find on disk: name -> entry, provider -> name, provider -> definition."""
    nodes: Dict[str, Any] = {}
    providers: Dict[str, str] = {}
    definitions: Dict[str, Any] = {}
    for name, entry in index['nodes'].items():
        services = {file: json.loads(text) for file, text in entry['services'].items()}
        protocols = [service['protocol'].split(':')[0] for service in services.values() if 'protocol' in service]
        # A node found on disk (a development tree, or the server still carries it) is the engine's own;
        # one with no service, a library others import, is placed only through their `requires`
        if protocols and all(getServiceDefinition(provider) is not None for provider in protocols):
            continue
        for provider in protocols:
            if providers.setdefault(provider.lower(), name) != name:
                warning(
                    f'Node index: {provider} is in both {providers[provider.lower()]} and {name}; {name} is not served for it'
                )
        nodes[name] = entry
        for service in services.values():
            provider = service.get('protocol', '').split(':')[0].lower()
            if providers.get(provider) == name:
                definitions[provider] = _inline_icon(service, entry['icons'])
    return nodes, providers, definitions


def _replace_stale(index: Dict[str, Any]) -> None:
    """Replace the copies an earlier release unpacked into nodes/ with this index's, so the next run loads them.

    The start-up scan loads such a folder like any other node, so it is never served and never placed again;
    a copy of a node this index no longer lists is named, so it can be deleted.
    """
    for name, entry in index['nodes'].items():
        folder = os.path.join(node_release.nodes_dir(), name)
        # None: the server's own folder, or nothing there
        old = node_packages.digest_of(folder)
        if old is None or old == entry['sha256']:
            continue
        try:
            with _unpacking:
                # The new copy may import a node not on disk, which no pipeline naming this one would place
                for other in _with_requires([name], index['nodes']):
                    sha256 = index['nodes'][other]['sha256']
                    path = os.path.join(node_release.nodes_dir(), other)
                    on_disk = node_packages.digest_of(path)
                    # A folder with no digest is the server's own
                    if other == name or (on_disk != sha256 and (on_disk is not None or not os.path.isdir(path))):
                        node_packages.unpack(
                            other, account.node_package(other, sha256), sha256, node_release.nodes_dir()
                        )
        except Exception as e:
            warning(f"Node {name}: {folder} holds an earlier release's copy and could not be replaced ({e}); delete it")
            continue
        warning(
            f"Node {name}: replaced the copy an earlier release unpacked; EaaS lists this release's definition after a restart"
        )
    # A folder with a digest is EaaS's own copy: one this release does not list is still loaded by every scan
    nodes_dir = node_release.nodes_dir()
    for name in sorted(os.listdir(nodes_dir)) if os.path.isdir(nodes_dir) else []:
        folder = os.path.join(nodes_dir, name)
        if name not in index['nodes'] and node_packages.digest_of(folder) is not None:
            warning(
                f'Node {name}: {folder} holds a node an earlier release unpacked and this release does not list; delete it'
            )


def _unwritable(nodes_dir: str) -> Optional[str]:
    """Why a node cannot be unpacked into nodes_dir, or None: it is staged in nodes/ and moved in place."""
    try:
        # A real write: os.access does not see read-only mounts
        with tempfile.NamedTemporaryFile(dir=nodes_dir):
            pass
    except OSError as e:
        return f'{nodes_dir} is not writable ({e})'
    return None


def _inline_icon(service: Dict[str, Any], icons: Dict[str, str]) -> Dict[str, Any]:
    """A definition passed as JSON has no folder, so its icon travels as a data: URL."""
    service = copy.deepcopy(service)
    svg = icons.get(service.get('icon', ''))
    if svg is None:
        service.pop('icon', None)
    else:
        service['icon'] = 'data:image/svg+xml;base64,' + base64.b64encode(svg.encode('utf-8')).decode('ascii')
    return service


def custom() -> List[Dict[str, Any]]:
    """The definitions of the nodes EaaS serves, for the engine's `custom` argument."""
    return list(_definitions.values())


def served(provider: str) -> Optional[Dict[str, Any]]:
    """The definition of a node EaaS serves, for a lookup the engine cannot answer."""
    return _definitions.get(provider.lower())


def schema(provider: str) -> Optional[Dict[str, Any]]:
    """The resolved schema of a node EaaS serves (`properties`, `params`, `capabilities`): what the engine's
    `getServiceSchema` answers for a node it carries. `ai.common.node_config.node_schema` falls back to it.
    """
    return _schemas.get(provider.lower())


def _providers_of(components: Iterable[Dict[str, Any]]) -> Set[str]:
    """Every provider a pipeline names, in lower case. A run loads nothing else: no node inserts another."""
    return {str(component.get('provider', '')).lower() for component in components if isinstance(component, dict)}


def _with_requires(names: Iterable[str], nodes: Optional[Dict[str, Any]] = None) -> List[str]:
    """The names with the nodes they import (the `requires` of nodes, by default the served ones), each after them.

    A node is unpacked only once what it imports is, so a failed unpack never leaves one on disk without them:
    after a restart the engine loads it as its own and nothing would place them.
    """
    nodes = _nodes if nodes is None else nodes
    order: List[str] = []
    seen: Set[str] = set()

    def visit(name: str) -> None:
        if name in seen:
            return
        seen.add(name)
        for other in sorted(nodes[name].get('requires', [])):
            if other in nodes:
                visit(other)
        order.append(name)

    for name in sorted(names):
        visit(name)
    return order


def place(pipeline: Dict[str, Any]) -> List[str]:
    """Unpack into nodes/ each node the pipeline names that the server does not carry; the nodes placed."""
    names = _with_requires({_providers[p] for p in _providers_of(pipeline.get('components', [])) if p in _providers})
    with _unpacking:
        for name in names:
            sha256 = _nodes[name]['sha256']
            # Already unpacked: the package is not read, so a launch does not open the node archive
            if node_packages.digest_of(os.path.join(node_release.nodes_dir(), name)) != sha256:
                node_packages.unpack(name, account.node_package(name, sha256), sha256, node_release.nodes_dir())
    return names
