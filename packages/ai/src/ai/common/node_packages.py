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

import hashlib
import importlib
import importlib.abc
import importlib.machinery
import io
import os
import shutil
import sys
import tempfile
import zipfile
from typing import Any, Callable, Dict, Optional, Tuple

import engLib
from depends import engine_cache_dir
from rocketlib import getServiceDefinition

# name -> (node name, package bytes, sha256, {services file: definition}), or None when there is no such node
Source = Callable[[str], Optional[Tuple[str, bytes, str, Dict[str, Dict[str, Any]]]]]

_source: Optional[Source] = None


class NodePackageInvalid(RuntimeError):
    """A package whose digest is not the one it was announced with."""

    code = 'NODE_PACKAGE_INVALID'


def unpack(name: str, data: bytes, sha256: str) -> str:
    """Unpack a package once, make it importable, and return the node's folder."""
    cache = engine_cache_dir(create=True)
    root = os.path.join(cache, 'node-packages', sha256)
    if not os.path.isdir(root):
        if hashlib.sha256(data).hexdigest() != sha256:
            raise NodePackageInvalid(f'The package of {name} does not match its digest')
        staging = tempfile.mkdtemp(dir=cache)
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            package.extractall(os.path.join(staging, 'nodes'))
        os.makedirs(os.path.dirname(root), exist_ok=True)
        try:
            os.replace(staging, root)
        except OSError:
            # Another process unpacked the same digest first
            shutil.rmtree(staging, ignore_errors=True)
    if root not in sys.path:
        sys.path.insert(0, root)
        importlib.invalidate_caches()
    return os.path.join(root, 'nodes', name)


def fetch(name: str, register: bool) -> bool:
    """Get a node from the source and unpack it; register its definitions when the engine needs them."""
    package = _source(name) if _source else None
    if package is None:
        return False
    node, data, sha256, definitions = package
    node_dir = unpack(node, data, sha256)
    if register:
        engLib.registerServices(
            [(definition, os.path.join(node_dir, file)) for file, definition in definitions.items()]
        )
    return True


def ensure(name: str) -> None:
    """Make sure the engine knows a node or provider before it is used."""
    if getServiceDefinition(name) is None:
        fetch(name, register=True)


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
            found = fetch(name, register=False)
        except Exception as e:
            # Code that catches ImportError for an optional node keeps working
            raise ImportError(f'Could not fetch {fullname}: {e}', name=fullname) from e
        return importlib.machinery.PathFinder.find_spec(fullname, path) if found else None
