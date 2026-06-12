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

"""Static API extractor for RocketRide nodes.

Parses a node's Python files with the standard-library ``ast`` module — a pure
static parse that never imports the node or its dependencies — and emits JSON
describing the node's top-level classes: their base classes, summary docstring,
and public method signatures with summaries. Consumed by
``nodes/scripts/gen-node-tables.mjs`` to populate the Classes sub-section of each
node's generated doc.md block.

Only the node's interface files are scanned, in this order::

    <node>.py  IGlobal.py  IInstance.py  IEndpoint.py

Usage::

    python3 extract_node_api.py <node_dir>   # writes JSON to stdout
"""

from __future__ import annotations

import ast
import json
import os
import sys
from typing import List, Optional

# Interface files scanned for every node, in render order. ``<node>`` is the
# node directory name (e.g. ``index_search.py``); the rest are the standard
# transform interface files. Missing files are simply skipped.
INTERFACE_FILES = ('{node}.py', 'IGlobal.py', 'IInstance.py', 'IEndpoint.py')


def _summary(node: ast.AST) -> str:
    """First paragraph of a node's docstring, whitespace-collapsed."""
    doc = ast.get_docstring(node, clean=True)
    if not doc:
        return ''
    paragraph = doc.strip().split('\n\n', 1)[0]
    return ' '.join(paragraph.split())


def _annotation(node: Optional[ast.AST]) -> str:
    """Render a type annotation node back to source, or '' when absent."""
    if node is None:
        return ''
    return ast.unparse(node)


def _default(node: Optional[ast.AST]) -> str:
    """Render a default-value node back to source, or '' when absent."""
    if node is None:
        return ''
    return ast.unparse(node)


def _format_arg(arg: ast.arg, default: Optional[ast.AST]) -> str:
    """Render a single argument as ``name: Annotation = default``."""
    out = arg.arg
    annotation = _annotation(arg.annotation)
    if annotation:
        out += f': {annotation}'
    default_src = _default(default)
    if default_src:
        out += f' = {default_src}' if annotation else f'={default_src}'
    return out


def _signature(name: str, func) -> str:
    """Reconstruct a readable ``name(args) -> Return`` signature string."""
    a = func.args
    parts: List[str] = []

    posonly = list(getattr(a, 'posonlyargs', []))
    positional = posonly + list(a.args)
    # defaults align with the tail of (posonlyargs + args)
    pad = [None] * (len(positional) - len(a.defaults))
    pos_defaults = pad + list(a.defaults)
    for i, arg in enumerate(positional):
        parts.append(_format_arg(arg, pos_defaults[i]))
        if posonly and i == len(posonly) - 1:
            parts.append('/')

    if a.vararg:
        parts.append('*' + _format_arg(a.vararg, None))
    elif a.kwonlyargs:
        parts.append('*')
    for arg, default in zip(a.kwonlyargs, a.kw_defaults):
        parts.append(_format_arg(arg, default))

    if a.kwarg:
        parts.append('**' + _format_arg(a.kwarg, None))

    sig = f'{name}({", ".join(parts)})'
    returns = _annotation(func.returns)
    if returns:
        sig += f' -> {returns}'
    return sig


def _methods(cls: ast.ClassDef) -> List[dict]:
    """Public methods (skip names starting with '_') with signature + summary."""
    methods = []
    for item in cls.body:
        if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if item.name.startswith('_'):
            continue
        prefix = 'async ' if isinstance(item, ast.AsyncFunctionDef) else ''
        methods.append(
            {
                'name': item.name,
                'signature': prefix + _signature(item.name, item),
                'summary': _summary(item),
            }
        )
    return methods


def _classes(tree: ast.Module) -> List[dict]:
    """Top-level classes in a module with bases, summary, and public methods."""
    classes = []
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        classes.append(
            {
                'name': node.name,
                'bases': [ast.unparse(b) for b in node.bases],
                'summary': _summary(node),
                'methods': _methods(node),
            }
        )
    return classes


def extract_node(node_dir: str) -> dict:
    """Extract class API for a single node directory."""
    node_name = os.path.basename(os.path.normpath(node_dir))
    files = []
    for template in INTERFACE_FILES:
        filename = template.format(node=node_name)
        path = os.path.join(node_dir, filename)
        if not os.path.isfile(path):
            continue
        with open(path, 'r', encoding='utf-8') as handle:
            tree = ast.parse(handle.read(), filename=filename)
        classes = _classes(tree)
        if classes:
            files.append({'file': filename, 'classes': classes})
    return {'node': node_name, 'files': files}


def main(argv: List[str]) -> int:
    if len(argv) != 1:
        sys.stderr.write('usage: extract_node_api.py <node_dir>\n')
        return 2
    json.dump(extract_node(argv[0]), sys.stdout, indent=2)
    sys.stdout.write('\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
