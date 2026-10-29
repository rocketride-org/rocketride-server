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
from typing import Any, Dict, Iterable, List, Optional, Set

from rocketlib import getServiceDefinition, getServiceDefinitions, warning

from ai.account import account
from ai.common import node_packages, node_release
from ai.constants import CONST_NODES_CONTRACT

# name -> index entry, provider (logical type) -> name, and provider -> definition with its icon inline
_nodes: Dict[str, Dict[str, Any]] = {}
_providers: Dict[str, str] = {}
_definitions: Dict[str, Dict[str, Any]] = {}

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
        nodes = {}
        providers = {}
        definitions = {}
        for name, entry in index['nodes'].items():
            services = {file: json.loads(text) for file, text in entry['services'].items()}
            protocols = [service['protocol'].split(':')[0] for service in services.values() if 'protocol' in service]
            # A node found on disk (a development tree, or the server still carries it) is the engine's own
            if all(getServiceDefinition(provider) is not None for provider in protocols):
                continue
            for provider in protocols:
                if providers.setdefault(provider, name) != name:
                    warning(
                        f'Node index: {provider} is in both {providers[provider]} and {name}; {name} is not served for it'
                    )
            nodes[name] = entry
            for service in services.values():
                provider = service.get('protocol', '').split(':')[0]
                if providers.get(provider) == name:
                    definitions[provider] = _inline_icon(service, entry['icons'])
        # The engine parses them now: a definition it refuses would fail every catalogue call
        getServiceDefinitions(list(definitions.values()))
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


def _unwritable(nodes_dir: str) -> Optional[str]:
    """Why a node cannot be unpacked into nodes_dir, or None: it is staged beside nodes/ and moved in."""
    for path in (os.path.dirname(os.path.abspath(nodes_dir)), nodes_dir):
        try:
            # A real write: os.access does not see read-only mounts
            with tempfile.NamedTemporaryFile(dir=path):
                pass
        except OSError as e:
            return f'{path} is not writable ({e})'
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
    return _definitions.get(provider)


def _providers_of(components: Iterable[Dict[str, Any]]) -> Set[str]:
    """Every provider a pipeline names, with the filters autopipe would insert."""
    found: Set[str] = set()

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            if isinstance(value.get('provider'), str):
                found.add(value['provider'])
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    for component in components:
        found.add(component.get('provider', ''))
        if component.get('provider') == 'autopipe':
            found.update(_AUTOPIPE_FILTERS)
            walk(component.get('config', {}))
    return found


def place(pipeline: Dict[str, Any]) -> List[str]:
    """Unpack into nodes/ each node the pipeline names that the server does not carry; the nodes placed."""
    names = sorted({_providers[p] for p in _providers_of(pipeline.get('components', [])) if p in _providers})
    with _unpacking:
        for name in names:
            sha256 = _nodes[name]['sha256']
            node_packages.unpack(name, account.node_package(name, sha256), sha256, node_release.nodes_dir())
    return names
