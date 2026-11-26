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
<name>/. A package is unpacked into a nodes/ folder the engine scans at
start-up, so a run started afterwards loads it like any other node.
"""

import contextlib
import glob
import hashlib
import io
import os
import shutil
import tempfile
import time
import zipfile
from typing import Any, Dict, Iterable, Iterator, Optional, Set


class NodePackageInvalid(RuntimeError):
    """A package whose digest is not the one it was announced with, or one the rail refuses."""

    code = 'NODE_PACKAGE_INVALID'


# Prefix of the folders a package is unpacked into before it takes its node's name
_STAGING = '.rrnode-staging-'

# Written into an unpacked node: the digest of the package it came from
DIGEST_FILE = '.rrnode.sha256'

# Filters autopipe inserts while it runs (nodes/src/nodes/autopipe/IGlobal.py, getFilter), besides the
# providers its own config names; a test keeps the two in step
AUTOPIPE_FILTERS = ('parse', 'ocr', 'indexer')


def _sweep(nodes_dir: str) -> None:
    """Drop the staging folders an unpack that was killed left behind an hour ago or more."""
    for path in glob.glob(os.path.join(nodes_dir, f'{_STAGING}*')):
        with contextlib.suppress(OSError):
            if time.time() - os.path.getmtime(path) > 3600:
                shutil.rmtree(path, ignore_errors=True)


def digest_of(node_dir: str) -> Optional[str]:
    """The digest of the package a node folder was unpacked from; None for a node that came with the server."""
    try:
        with open(os.path.join(node_dir, DIGEST_FILE), encoding='utf-8') as file:
            return file.read().strip()
    except OSError:
        return None


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


class NodeVersionInUse(RuntimeError):
    """Another live run on this server uses another version of the same published node."""

    code = 'NODE_VERSION_IN_USE'


def module_of(node_id: str) -> str:
    """The Python module name of a node: acme.my_node imports as nodes.acme__my_node."""
    return node_id.replace('.', '__')


def node_of(module: str) -> str:
    """The node id a module name stands for; the inverse of module_of."""
    return module.replace('__', '.', 1)


def is_published(module: str) -> bool:
    """A published node's module (<developerId>__<name>); a release node's name holds no '__'."""
    return '__' in module.strip('_')


def content_digest(files: dict) -> str:
    """The digest of a node's files ({path inside the node: bytes}), the same whichever zip carries them.

    The sha256 of '<path>\\0<sha256 hex of the file>\\n' for each file in path order, paths
    with '/'; the build that writes the index computes it the same way.
    """
    digest = hashlib.sha256()
    for path in sorted(files):
        digest.update(f'{path}\0{hashlib.sha256(files[path]).hexdigest()}\n'.encode('utf-8'))
    return digest.hexdigest()


def _zip_digest(package: zipfile.ZipFile, name: str) -> str:
    """content_digest of <name>/ in a zip: the same files read_package packs."""
    return content_digest(node_files(package, name))


def node_files(archive: zipfile.ZipFile, name: str) -> dict:
    """The files of <name>/ in a zip, keyed by their path inside the node."""
    prefix = f'{name}/'
    return {
        entry.filename[len(prefix) :]: archive.read(entry)
        for entry in archive.infolist()
        if entry.filename.startswith(prefix) and not entry.is_dir()
    }


def pack(name: str, files: dict) -> bytes:
    """The <name>.rrnode of a node's files: a zip rooted at <name>/."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as package:
        for path in sorted(files):
            package.writestr(f'{name}/{path}', files[path])
    return buffer.getvalue()


def unpack(name: str, data: bytes, sha256: str, nodes_dir: str) -> str:
    """Unpack a package into nodes_dir/<name>, replacing another digest's copy, and return the node's folder."""
    node_dir = os.path.join(nodes_dir, name)
    if digest_of(node_dir) == sha256:
        return node_dir
    if os.path.isdir(node_dir) and digest_of(node_dir) is None:
        # A node the server carries is never replaced by a package
        return node_dir
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            if any(not entry.startswith(f'{name}/') for entry in package.namelist()):
                raise NodePackageInvalid(f'The package of {name} holds files outside {name}/')
            # The digest names the node's files, so a package rebuilt from the release archive still matches
            matches = _zip_digest(package, name) == sha256
    except zipfile.BadZipFile:
        matches = False
    if not matches:
        raise NodePackageInvalid(f'The package of {name} does not match its digest')

    # Staged inside nodes/, so the move stays on one volume (nodes/ may be its own mount). The
    # start-up scan reads only nodes/*/services*.json, never a node a staging folder holds.
    os.makedirs(nodes_dir, exist_ok=True)
    _sweep(nodes_dir)
    staging = tempfile.mkdtemp(prefix=_STAGING, dir=nodes_dir)
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            package.extractall(staging)
        with open(os.path.join(staging, name, DIGEST_FILE), 'w', encoding='utf-8') as file:
            file.write(sha256)
        if os.path.isdir(node_dir):
            # Another digest's copy: move it out of nodes/ first, a folder cannot be replaced in one step
            os.replace(node_dir, os.path.join(staging, 'replaced'))
        os.replace(os.path.join(staging, name), node_dir)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return node_dir


def nested_providers(value: Any) -> Iterator[str]:
    """Every provider named inside a config value, in lower case."""
    if isinstance(value, dict):
        if isinstance(value.get('provider'), str):
            yield value['provider'].lower()
        for item in value.values():
            yield from nested_providers(item)
    elif isinstance(value, list):
        for item in value:
            yield from nested_providers(item)


def providers_of(components: Iterable[Dict[str, Any]]) -> Set[str]:
    """Every provider a pipeline names, with the filters autopipe would insert."""
    found: Set[str] = set()
    for component in components:
        provider = str(component.get('provider', '')).lower()
        found.add(provider)
        if provider == 'autopipe':
            found.update(AUTOPIPE_FILTERS)
            found.update(nested_providers(component.get('config', {})))
    return found
