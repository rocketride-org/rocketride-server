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
Where node packages come from when nothing else serves them: the release's
node archive in dist/nodes beside the server. The archive holds every node
under <name>/, and a node's .rrnode is packed from it on request.
"""

import json
import os
import sys
import zipfile

from ai.common import node_packages


def _beside(*parts: str) -> str:
    """A path next to the folder the engine runs from."""
    return os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(sys.executable)), os.pardir, *parts))


def _local(file: str) -> str:
    """The file in dist/nodes, next to the server the engine runs from."""
    return _beside('nodes', file)


def _read(path: str) -> bytes:
    with open(path, 'rb') as file:
        return file.read()


def nodes_dir() -> str:
    """The server's nodes/ folder: what the engine scans at start-up, and where its index sits."""
    return os.path.join(os.path.dirname(os.path.abspath(sys.executable)), 'nodes')


def read_index() -> bytes:
    """The server's nodes/index.json: written by the build that made this engine, so it lists its nodes."""
    return _read(os.path.join(nodes_dir(), 'index.json'))


def read_package(name: str, sha256: str) -> bytes:
    """<name>.rrnode, packed from the node archive the index names; its files must match the index's digest."""
    archive = json.loads(read_index()).get('archive')
    if not archive:
        raise FileNotFoundError('The node index names no node archive')
    with zipfile.ZipFile(_local(archive)) as nodes:
        files = node_packages.node_files(nodes, name)
    if not files:
        raise FileNotFoundError(f'{name} is not in {archive}')
    if node_packages.content_digest(files) != sha256:
        raise ValueError(f'{name} in {archive} does not match the index')
    return node_packages.pack(name, files)
