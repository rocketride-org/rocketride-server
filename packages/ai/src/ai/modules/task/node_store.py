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

A published node (ai.account.node_deploy) is served the same way, but only to a
caller it is published to: its definitions travel with that caller's calls, and
the version resolved for a run is unpacked before it starts, and deleted when
no live run uses it. One a crash left behind goes when EaaS reads the index.
"""

import base64
import copy
import json
import os
import shutil
import tempfile
import threading
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from rocketlib import getServiceDefinition, getServiceDefinitions, warning

from ai.account import account
from ai.common import node_packages, node_release
from ai.constants import CONST_NODES_CONTRACT

# name -> index entry, provider (logical type) -> name, and provider -> definition with its icon inline;
# providers are keyed in lower case, as the engine ignores case when it looks one up
_nodes: Dict[str, Dict[str, Any]] = {}
_providers: Dict[str, str] = {}
_definitions: Dict[str, Dict[str, Any]] = {}

# Two runs naming the same node must not unpack it at once
_unpacking = threading.Lock()

# Published module -> {run: digest}: the versions live runs use, so one is never replaced under another
_in_use: Dict[str, Dict[str, str]] = {}


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
        # The engine parses them now: a definition it refuses would fail every catalogue call
        getServiceDefinitions(list(definitions.values()))
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
        if name in index['nodes'] or node_packages.digest_of(folder) is None:
            continue
        if node_packages.is_published(name):
            # A cache of an earlier run's published node: the next one unpacks it again
            shutil.rmtree(folder, ignore_errors=True)
        else:
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


def _published_definitions(published: Optional[Dict[str, Dict[str, Any]]]) -> Dict[str, Dict[str, Any]]:
    """Provider -> definition of the published nodes a caller reaches ({node id: publish row})."""
    definitions: Dict[str, Dict[str, Any]] = {}
    for row in (published or {}).values():
        snapshot = row['snapshot']
        for service in snapshot['services'].values():
            definitions[service['protocol'].split(':')[0].lower()] = _inline_icon(service, snapshot['icons'])
    return definitions


def custom(published: Optional[Dict[str, Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    """The definitions of the nodes EaaS serves, for the engine's `custom` argument, with the caller's published ones."""
    return list(_definitions.values()) + list(_published_definitions(published).values())


def served(provider: str, published: Optional[Dict[str, Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    """The definition of a node EaaS serves, or of one published to the caller, for a lookup the engine cannot answer."""
    return _definitions.get(provider.lower()) or _published_definitions(published).get(provider.lower())


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


def place(
    pipeline: Dict[str, Any], published: Optional[Dict[str, Tuple[str, bytes]]] = None, run: str = ''
) -> List[str]:
    """Unpack into nodes/ each node the pipeline names that the server does not carry; the nodes placed.

    Args:
        pipeline: The pipeline the run starts.
        published: Published module -> (digest, package) of the versions resolved for the run
            (see published_packages).
        run: The run they are placed for, which holds them until release(run).

    Raises:
        NodeNotEntitled: The pipeline names a published node (one autopipe inserts, say) not resolved for the run.
        NodeVersionInUse: Another live run uses another version of one of the published nodes.
    """
    providers = node_packages.providers_of(pipeline.get('components', []))
    names = _with_requires({_providers[p] for p in providers if p in _providers})
    published = published or {}
    # A release node's name has no dot: another run's copy of a published node must not load in this one
    unresolved = {p for p in providers if '.' in p} - {node_packages.node_of(m).lower() for m in published}
    if unresolved:
        raise node_packages.NodeNotEntitled(f'{", ".join(sorted(unresolved))} is not resolved for this run')
    nodes_dir = node_release.nodes_dir()
    with _unpacking:
        for module, (digest, _) in sorted(published.items()):
            others = {d for r, d in _in_use.get(module, {}).items() if r != run}
            if others - {digest}:
                raise node_packages.NodeVersionInUse(
                    f'Another run on this server uses another version of {node_packages.node_of(module)}; '
                    'start this one when it ends'
                )
        # A restart keeps what it still names; held before unpacking, so release(run) removes a partial placement
        _release(run, keep=published)
        for module, (digest, _) in published.items():
            _in_use.setdefault(module, {})[run] = digest
        for name in names + sorted(published):
            sha256, data = published.get(name) or (_nodes[name]['sha256'], None)
            # Already unpacked: the package is not read, so a launch does not open the node archive
            if node_packages.digest_of(os.path.join(nodes_dir, name)) != sha256:
                node_packages.unpack(name, data or account.node_package(name, sha256), sha256, nodes_dir)
    return names + sorted(published)


def _release(run: str, keep: Iterable[str] = ()) -> None:
    """Forget the published versions a run holds, deleting one no live run uses but keep; the caller holds _unpacking."""
    for module in list(_in_use):
        _in_use[module].pop(run, None)
        if not _in_use[module]:
            del _in_use[module]
            if module not in keep:
                # The next EaaS start-up scan must not find it: it would list it to every caller
                shutil.rmtree(os.path.join(node_release.nodes_dir(), module), ignore_errors=True)


def release(run: str) -> None:
    """The run has ended: a published node no other run uses is deleted, and another version may be unpacked."""
    with _unpacking:
        _release(run)


async def published_packages(
    org_id: str, user_id: str, published: Dict[str, Dict[str, Any]]
) -> Dict[str, Tuple[str, bytes]]:
    """Module -> (digest, package) of the versions resolved for a run ({node id: publish row}), for place()."""
    from ai.account import node_deploy

    return {
        row['snapshot']['module']: (row['snapshot']['sha256'], await node_deploy.read_package(org_id, user_id, row))
        for row in published.values()
    }
