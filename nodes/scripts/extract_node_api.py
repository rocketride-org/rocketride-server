# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Static extractor for node Python public API, consumed by gen-node-tables.mjs.

Parses each node's top-level ``.py`` files with the standard-library ``ast``
module — purely static, no node modules are imported or executed (the node
packages pull heavy optional dependencies that are not installed at docs-build
time). For every top-level class it emits the class name, its base classes, and
the public method signatures plus the first line of each docstring.

Usage:
    python extract_node_api.py [NODES_DIR]   # defaults to ../src/nodes

Output (stdout): JSON mapping node directory name -> list of classes, e.g.
    {
      "llm_anthropic": [
        {
          "file": "IGlobal.py",
          "name": "IGlobal",
          "bases": ["IGlobalBase"],
          "methods": [
            {"signature": "validateConfig(self)", "summary": "Save-time validation ..."}
          ]
        }
      ]
    }
"""

import ast
import json
import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
DEFAULT_NODES_DIR = os.path.join(HERE, '..', 'src', 'nodes')

# Top-level files that never carry node API surface.
_SKIP_FILES = {'__init__.py'}


def _format_arg(arg: ast.arg) -> str:
    """Render a single argument as ``name`` or ``name: annotation``."""
    if arg.annotation is not None:
        try:
            return f'{arg.arg}: {ast.unparse(arg.annotation)}'
        except Exception:
            return arg.arg
    return arg.arg


def _format_signature(name: str, func: ast.AST) -> str:
    """Build a concise ``method(args) -> ret`` string (defaults omitted)."""
    args = func.args
    parts = []
    parts.extend(_format_arg(a) for a in getattr(args, 'posonlyargs', []))
    if getattr(args, 'posonlyargs', []):
        parts.append('/')
    parts.extend(_format_arg(a) for a in args.args)
    if args.vararg is not None:
        parts.append('*' + _format_arg(args.vararg))
    elif args.kwonlyargs:
        parts.append('*')
    parts.extend(_format_arg(a) for a in args.kwonlyargs)
    if args.kwarg is not None:
        parts.append('**' + _format_arg(args.kwarg))

    ret = ''
    if func.returns is not None:
        try:
            ret = f' -> {ast.unparse(func.returns)}'
        except Exception:
            ret = ''
    return f'{name}({", ".join(parts)}){ret}'


def _summary(node: ast.AST) -> str:
    """First non-empty line of the docstring, or empty string."""
    doc = ast.get_docstring(node)
    if not doc:
        return ''
    for line in doc.splitlines():
        line = line.strip()
        if line:
            return line
    return ''


def _is_public_method(node: ast.AST) -> bool:
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return False
    return node.name == '__init__' or not node.name.startswith('_')


def _extract_class(node: ast.ClassDef) -> dict:
    bases = []
    for base in node.bases:
        try:
            bases.append(ast.unparse(base))
        except Exception:
            pass
    methods = [
        {'signature': _format_signature(child.name, child), 'summary': _summary(child)}
        for child in node.body
        if _is_public_method(child)
    ]
    return {'name': node.name, 'bases': bases, 'methods': methods}


def _extract_file(path: str) -> list:
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            tree = ast.parse(handle.read())
    except (SyntaxError, OSError):
        return []
    return [_extract_class(node) for node in tree.body if isinstance(node, ast.ClassDef)]


def extract_node(node_dir: str) -> list:
    """Return the list of classes for a single node directory."""
    classes = []
    for filename in sorted(os.listdir(node_dir)):
        if not filename.endswith('.py') or filename in _SKIP_FILES:
            continue
        for cls in _extract_file(os.path.join(node_dir, filename)):
            cls['file'] = filename
            classes.append(cls)
    return classes


def main() -> None:
    nodes_dir = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_NODES_DIR
    result = {}
    for name in sorted(os.listdir(nodes_dir)):
        node_dir = os.path.join(nodes_dir, name)
        if not os.path.isdir(node_dir):
            continue
        classes = extract_node(node_dir)
        if classes:
            result[name] = classes
    json.dump(result, sys.stdout, indent='\t', sort_keys=False)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
