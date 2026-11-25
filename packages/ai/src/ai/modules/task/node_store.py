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
from typing import Any, Dict, Iterable, Iterator, List, Optional, Set, Tuple

from rocketlib import getServiceDefinition, getServiceDefinitions, warning

from ai.account import account
from ai.common import node_packages, node_release
from ai.constants import CONST_NODES_CONTRACT

# name -> index entry, provider (logical type) -> name, and provider -> definition with its icon inline;
# providers are keyed in lower case, as the engine ignores case when it looks one up
_nodes: Dict[str, Dict[str, Any]] = {}
_providers: Dict[str, str] = {}
_definitions: Dict[str, Dict[str, Any]] = {}

# Every node the index lists, and provider -> name of those the engine found on disk at start: a copy an earlier
# run unpacked is the engine's own from then on, yet a run in a container of its own needs it as much
_index: Dict[str, Dict[str, Any]] = {}
_on_disk: Dict[str, str] = {}

# Filters autopipe inserts while it runs (nodes/src/nodes/autopipe/IGlobal.py, getFilter), besides the
# providers its own config names; a test keeps the two in step
_AUTOPIPE_FILTERS = ('parse', 'ocr', 'indexer')

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
        nodes, providers, definitions, on_disk = _served(index)
        # The engine parses them now: a definition it refuses would fail every catalogue call
        getServiceDefinitions(list(definitions.values()))
        _replace_stale(index)
    except Exception as e:
        warning(
            f'NODE_REGISTRY_UNAVAILABLE: the node index could not be used ({e}); only the nodes the server carries are available'
        )
        return
    # The copies on disk load in every run, whether or not more can be unpacked
    _index.update(index['nodes'])
    _on_disk.update(on_disk)
    problem = _unwritable(node_release.nodes_dir()) if nodes else None
    if problem:
        # A read-only install: say so once, rather than refuse every run that names one
        warning(f'NODE_REGISTRY_UNAVAILABLE: {problem}; not available: {", ".join(sorted(nodes))}')
        return
    _nodes.update(nodes)
    _providers.update(providers)
    _definitions.update(definitions)


def _served(index: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, str], Dict[str, Any], Dict[str, str]]:
    """The index's nodes not on disk (name -> entry, provider -> name, provider -> definition), and those on disk.

    The last map is provider -> name of the nodes the engine finds on disk.
    """
    nodes: Dict[str, Any] = {}
    providers: Dict[str, str] = {}
    definitions: Dict[str, Any] = {}
    on_disk: Dict[str, str] = {}
    for name, entry in index['nodes'].items():
        services = {file: json.loads(text) for file, text in entry['services'].items()}
        protocols = [service['protocol'].split(':')[0] for service in services.values() if 'protocol' in service]
        # A node found on disk (a development tree, or the server still carries it) is the engine's own;
        # one with no service, a library others import, is placed only through their `requires`
        if protocols and all(getServiceDefinition(provider) is not None for provider in protocols):
            for provider in protocols:
                on_disk.setdefault(provider.lower(), name)
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
    return nodes, providers, definitions, on_disk


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


def _nested_providers(value: Any) -> Iterator[str]:
    """Every provider named inside a config value, in lower case."""
    if isinstance(value, dict):
        if isinstance(value.get('provider'), str):
            yield value['provider'].lower()
        for item in value.values():
            yield from _nested_providers(item)
    elif isinstance(value, list):
        for item in value:
            yield from _nested_providers(item)


def _providers_of(components: Iterable[Dict[str, Any]]) -> Set[str]:
    """Every provider a pipeline names, with the filters autopipe would insert."""
    found: Set[str] = set()
    for component in components:
        provider = str(component.get('provider', '')).lower()
        found.add(provider)
        if provider == 'autopipe':
            found.update(_AUTOPIPE_FILTERS)
            found.update(_nested_providers(component.get('config', {})))
    return found


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


def place(pipeline: Dict[str, Any], isolated: bool = False) -> List[str]:
    """Unpack into nodes/ each node the pipeline names that the server does not carry.

    Args:
        pipeline: The resolved pipeline.
        isolated: The run's task sees only nodes/ (a container or a pod): a node the engine loads
            from a source tree (nodes/src/nodes), which nodes/ has no folder of, is unpacked too.

    Returns:
        The index's nodes the run loads from nodes/: the nodes placed, then the copies an earlier run
        unpacked that the pipeline names or a placed node imports. A folder with no digest is the
        server's own and is not named.
    """
    providers = _providers_of(pipeline.get('components', []))
    names = _with_requires({_providers[p] for p in providers if p in _providers})
    loaded = _with_requires(set(names) | {_on_disk[p] for p in providers if p in _on_disk}, _index)
    nodes_dir = node_release.nodes_dir()
    with _unpacking:
        for name in names:
            sha256 = _nodes[name]['sha256']
            # Already unpacked: the package is not read, so a launch does not open the node archive
            if node_packages.digest_of(os.path.join(nodes_dir, name)) != sha256:
                node_packages.unpack(name, account.node_package(name, sha256), sha256, nodes_dir)
        # The image of an isolated task holds only the server's own nodes
        for name in loaded if isolated else []:
            if name not in names and not os.path.isdir(os.path.join(nodes_dir, name)):
                sha256 = _index[name]['sha256']
                node_packages.unpack(name, account.node_package(name, sha256), sha256, nodes_dir)
        return names + [
            name
            for name in loaded
            if name not in names and node_packages.digest_of(os.path.join(nodes_dir, name)) is not None
        ]
