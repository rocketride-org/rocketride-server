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
Node packages: a node shipped on its own as <name>.rrnode, a zip rooted at
<name>/. A package is unpacked once under the engine cache, in a folder named by
its digest, and that folder joins the `nodes` package; a process that serves
packages (EaaS) or fetches them (a task) installs a source with serve().
"""

import contextlib
import glob
import hashlib
import importlib
import importlib.abc
import importlib.machinery
import io
import os
import shutil
import sys
import tempfile
import time
import zipfile
from typing import Any, Callable, Dict, List, Optional, Tuple

import engLib
from depends import engine_cache_dir
from rocketlib import getServiceDefinition

# name -> (node name, package bytes, sha256, {services file: definition}), or None when there is no such node
Source = Callable[[str], Optional[Tuple[str, bytes, str, Dict[str, Dict[str, Any]]]]]

_source: Optional[Source] = None


class NodePackageInvalid(RuntimeError):
    """A package whose digest is not the one it was announced with, or one the rail refuses."""

    code = 'NODE_PACKAGE_INVALID'


# Prefix of the folders a package is unpacked into before it takes its digest's name
_STAGING = 'staging-'


def _sweep(cache: str) -> None:
    """Drop the staging folders an unpack that was killed left behind an hour ago or more."""
    for path in glob.glob(os.path.join(cache, f'{_STAGING}*')):
        with contextlib.suppress(OSError):
            if time.time() - os.path.getmtime(path) > 3600:
                shutil.rmtree(path, ignore_errors=True)


class NodeNotFound(RuntimeError):
    """No node by that name is published anywhere the caller can see."""

    code = 'NODE_NOT_FOUND'


class NodeNotEntitled(RuntimeError):
    """The node exists, but not on any rung the caller is on."""

    code = 'NODE_NOT_ENTITLED'


class NodeRegistryUnavailable(RuntimeError):
    """The rail could not be read, so a published node cannot be resolved."""

    code = 'NODE_REGISTRY_UNAVAILABLE'


class NodeVersionMismatch(RuntimeError):
    """A package or index built for a node contract this engine does not speak."""

    code = 'NODE_VERSION_MISMATCH'


def module_of(node_id: str) -> str:
    """The Python module name of a node: acme.my_node imports as nodes.acme__my_node."""
    return node_id.replace('.', '__')


def node_of(module: str) -> str:
    """The node id a module name stands for; the inverse of module_of."""
    return module.replace('__', '.', 1)


def unpack(name: str, data: bytes, sha256: str) -> str:
    """Unpack a package once, make it importable, and return the node's folder."""
    cache = engine_cache_dir(create=True)
    root = os.path.join(cache, 'node-packages', sha256)
    if not os.path.isdir(root):
        if hashlib.sha256(data).hexdigest() != sha256:
            raise NodePackageInvalid(f'The package of {name} does not match its digest')
        _sweep(cache)
        staging = tempfile.mkdtemp(prefix=_STAGING, dir=cache)
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            # Its root goes first on sys.path: a stray folder would shadow another node
            if any(not entry.startswith(f'{name}/') for entry in package.namelist()):
                shutil.rmtree(staging, ignore_errors=True)
                raise NodePackageInvalid(f'The package of {name} holds files outside {name}/')
            package.extractall(os.path.join(staging, 'nodes'))
        os.makedirs(os.path.dirname(root), exist_ok=True)
        try:
            os.replace(staging, root)
        except OSError:
            shutil.rmtree(staging, ignore_errors=True)
            # Only another process unpacking the same digest first is not a failure
            if not os.path.isdir(root):
                raise
    if root not in sys.path:
        sys.path.insert(0, root)
        importlib.invalidate_caches()
    return os.path.join(root, 'nodes', name)


def fetch(name: str) -> Optional[List[Tuple[Dict[str, Any], str]]]:
    """Get a node from the source and unpack it; its (definition, path) pairs, or None when there is no such node."""
    package = _source(name) if _source else None
    if package is None:
        return None
    node, data, sha256, definitions = package
    node_dir = unpack(node, data, sha256)
    return [(definition, os.path.join(node_dir, file)) for file, definition in definitions.items()]


def ensure(*names: str) -> None:
    """Make sure the engine knows these nodes or providers, registering the missing ones in one batch."""
    batch = []
    for name in names:
        if getServiceDefinition(name) is None:
            batch += fetch(name) or []
    if batch:
        # Together, so a definition that lists other services sees all of them
        engLib.registerServices(batch)


def serve(source: Source) -> None:
    """Fetch missing nodes from source, and their code whenever something imports one."""
    global _source
    _source = source
    sys.meta_path.append(NodeFinder())


class NodeFinder(importlib.abc.MetaPathFinder):
    """Unpack `nodes.<name>` when it is imported and not on disk yet."""

    def find_spec(self, fullname, path, target=None):
        """Unpack the missing node, then let the path finder import it."""
        parent, _, name = fullname.partition('.')
        if parent != 'nodes' or '.' in name:
            return None
        try:
            found = fetch(name) is not None
        except Exception as e:
            # Code that catches ImportError for an optional node keeps working
            raise ImportError(f'Could not fetch {fullname}: {e}', name=fullname) from e
        return importlib.machinery.PathFinder.find_spec(fullname, path) if found else None
