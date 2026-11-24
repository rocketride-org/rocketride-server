# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Unpack every node of the node archive into the server's nodes/ (the builder's ``nodes:place``).

EaaS unpacks the nodes a pipeline names before it starts that run's engine,
so the engine of a run finds its nodes on disk. A test that loads a node
without EaaS (a pytest process that resolves a node's configuration through
the engine it runs in, the engine's own C++ tests) stands in for such an
engine and needs the same. This unpacks them all, through the code a run
uses (``ai.common.node_packages.unpack``), so each copy carries its digest
and is what EaaS itself would have placed.

Run by the built engine: ``engine place-nodes.py``.
"""

import json
import os

from ai.common import node_packages, node_release


def main() -> None:
    """Unpack each node the server's index lists, and say how many were not there yet."""
    index = json.loads(node_release.read_index())
    nodes_dir = node_release.nodes_dir()
    placed = 0
    for name, entry in sorted(index['nodes'].items()):
        sha256 = entry['sha256']
        if node_packages.digest_of(os.path.join(nodes_dir, name)) == sha256:
            continue
        node_packages.unpack(name, node_release.read_package(name, sha256), sha256, nodes_dir)
        placed += 1
    print(f'{placed} of {len(index["nodes"])} nodes unpacked into {nodes_dir}')


if __name__ == '__main__':
    main()
