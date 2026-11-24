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
from typing import Optional


class NodePackageInvalid(RuntimeError):
    """A package whose digest is not the one it was announced with."""

    code = 'NODE_PACKAGE_INVALID'


# Prefix of the folders a package is unpacked into before it takes its node's name
_STAGING = '.rrnode-staging-'

# Written into an unpacked node: the digest of the package it came from
DIGEST_FILE = '.rrnode.sha256'

# How often a rename is tried, and the pause between tries. On Windows a virus scanner or the
# indexer can still hold a file that was just written, and renaming its folder is refused
# (WinError 5) until it lets go, which takes a moment. Elsewhere a rename is tried once.
_MOVE_TRIES = 10 if os.name == 'nt' else 1
_MOVE_PAUSE_SECS = 0.1


def _move(src: str, dst: str) -> None:
    """os.replace, tried again while the system refuses it with a permission error (see _MOVE_TRIES)."""
    for remaining in range(_MOVE_TRIES - 1, -1, -1):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if not remaining:
                raise
            time.sleep(_MOVE_PAUSE_SECS)


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
    """Unpack a package into nodes_dir/<name>, replacing another digest's copy, and return the node's folder.

    The copy being replaced is moved aside first. When the new copy then cannot be moved in, the previous
    one is put back; when even that fails, it is left in the staging folder the raised error names (which
    a later unpack sweeps once it is an hour old, like any staging folder left behind).
    """
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
    replaced = None
    keep = False
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            package.extractall(staging)
        with open(os.path.join(staging, name, DIGEST_FILE), 'w', encoding='utf-8') as file:
            file.write(sha256)
        if os.path.isdir(node_dir):
            # Another digest's copy: move it out of nodes/ first, a folder cannot be replaced in one step
            replaced = os.path.join(staging, 'replaced')
            _move(node_dir, replaced)
        try:
            _move(os.path.join(staging, name), node_dir)
        except OSError as e:
            if replaced is not None:
                # Put the previous copy back; one that cannot go back is not deleted here
                try:
                    _move(replaced, node_dir)
                except OSError as restore_error:
                    keep = True
                    raise OSError(
                        f'{name} could not be moved into place ({e}) and its previous copy could not be put back '
                        f'({restore_error}); the previous copy is kept in {replaced}'
                    ) from e
            raise
    finally:
        if not keep:
            shutil.rmtree(staging, ignore_errors=True)
    return node_dir
