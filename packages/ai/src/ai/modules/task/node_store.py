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
The node packages EaaS serves. At start it registers the definitions of every
node the server does not carry, so the catalogue and validation see them; code
is unpacked only when something imports it. A task asks for its nodes with
`node.fetch` over the channel EaaS opened to it.
"""

import asyncio
import json
import os
from typing import Any, Dict, List, Optional, Tuple

import engLib
from depends import engine_cache_dir
from rocketlib import getServiceDefinition, warning

from ai.account import account
from ai.common import node_packages, node_release
from ai.constants import CONST_NODES_CONTRACT

from .task_channel import ChannelReply, register_channel_command

# name -> index entry, and provider (logical type) -> name
_nodes: Dict[str, Dict[str, Any]] = {}
_providers: Dict[str, str] = {}


def start() -> None:
    """Register what the index lists, and serve it to tasks; an index it cannot use registers nothing."""
    try:
        index = account.node_index()
        if index.get('contract') != CONST_NODES_CONTRACT:
            warning(
                f'NODE_VERSION_MISMATCH: node index contract {index.get("contract")}, engine reads {CONST_NODES_CONTRACT}'
            )
            return
        nodes = {
            name: {**entry, 'services': {file: json.loads(text) for file, text in entry['services'].items()}}
            for name, entry in index['nodes'].items()
        }
        providers = {}
        definitions = []
        for name, entry in nodes.items():
            protocols = [
                service['protocol'].split(':')[0] for service in entry['services'].values() if 'protocol' in service
            ]
            for provider in protocols:
                if providers.setdefault(provider, name) != name:
                    warning(
                        f'Node index: {provider} is in both {providers[provider]} and {name}; {name} is not served for it'
                    )
            # A node found on disk (a development tree) is already registered
            if not all(getServiceDefinition(provider) is not None for provider in protocols):
                definitions += _definitions(name, entry)
        engLib.registerServices(definitions)
    except Exception as e:
        warning(
            f'NODE_REGISTRY_UNAVAILABLE: the node index could not be used ({e}); only the nodes the server carries are available'
        )
        return
    _nodes.update(nodes)
    _providers.update(providers)
    node_packages.serve(_package)
    register_channel_command('node.fetch', _fetch)


def _definitions(name: str, entry: Dict[str, Any]) -> List[Tuple[Dict[str, Any], str]]:
    """A node's (definition, path) pairs to register, with its icons written beside them; no code is unpacked."""
    icon_dir = os.path.join(engine_cache_dir(create=True), 'node-icons', entry['sha256'], name)
    for icon, svg in entry['icons'].items():
        if not os.path.exists(os.path.join(icon_dir, icon)):
            node_release.save(os.path.join(icon_dir, icon), svg.encode('utf-8'))
    return [(definition, os.path.join(icon_dir, file)) for file, definition in entry['services'].items()]


def _package(name: str) -> Optional[Tuple[str, bytes, str, Dict[str, Dict[str, Any]]]]:
    """The package that holds a node or provider, if this server serves it."""
    name = _providers.get(name, name)
    entry = _nodes.get(name)
    if entry is None:
        return None
    return name, account.node_package(name, entry['sha256']), entry['sha256'], entry['services']


async def _fetch(task, arguments: Dict[str, Any], data: Optional[bytes]) -> ChannelReply:
    """Answer a task's node.fetch {name}: the package, or an empty body when there is none."""
    package = await asyncio.to_thread(_package, arguments.get('name', ''))
    if package is None:
        return ChannelReply(body={})
    name, data, sha256, services = package
    return ChannelReply(body={'name': name, 'sha256': sha256, 'services': services}, data=data)
