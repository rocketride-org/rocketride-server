# =============================================================================
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

"""AST-based per-environment dependency discovery.

Resolves each node ``provider`` to its entry module (via the ``path`` field of
``services*.json``), then statically walks the import graph into the first-party
``nodes`` and ``ai`` packages to collect exactly the ``requirement*.txt`` files that
environment needs, instead of globbing every requirement in the tree.

Two things the walk must get right: it follows nested/in-function imports, not just
module-level ones, and resolves relative imports against the right package
(``__init__`` vs regular module).

The result is a sound over-approximation — within a shared package directory it may
pick up sibling requirement files, but it never under-includes. Dynamic
``importlib``/``__import__`` calls that cannot be resolved statically are flagged so
the caller can fall back to the runtime ``depends()`` backstop.

Stdlib only, with the package roots passed in explicitly, so it is testable in
isolation.
"""

from __future__ import annotations

import ast
import json
import os
from dataclasses import dataclass, field
from glob import glob
from typing import Iterable, Optional

# Class names a node package re-exports; also the modules worth seeding a walk from.
_ENTRY_BASENAMES = ('__init__.py', 'IGlobal.py', 'IInstance.py', 'IEndpoint.py')

# First-party import roots we recurse INTO; anything else is a third-party leaf we
# record (torch, rfdetr, ...) but never follow.
_FIRST_PARTY = ('nodes', 'ai')

# Stdlib / framework tops that are never pip requirements — pruned from third-party.
_NON_REQUIREMENT_TOPS = frozenset(
    {
        'os',
        'sys',
        're',
        'json',
        'typing',
        'asyncio',
        'logging',
        'abc',
        'dataclasses',
        'functools',
        'enum',
        'io',
        'time',
        'math',
        'threading',
        'collections',
        'pathlib',
        'contextlib',
        'warnings',
        'types',
        'base64',
        'hashlib',
        'zlib',
        'subprocess',
        'tempfile',
        'errno',
        'concurrent',
        'itertools',
        'copy',
        'inspect',
        'importlib',
        'traceback',
        'uuid',
        'random',
        'struct',
        'datetime',
        'shutil',
        'glob',
        'string',
        'rocketlib',
        'depends',
        '__future__',
        'engLib',
    }
)


# ---------------------------------------------------------------------------
# JSONC (services*.json) parsing
# ---------------------------------------------------------------------------


def strip_jsonc(text: str) -> str:
    """Strip ``//`` and ``/* */`` comments and trailing commas from JSONC text.

    String-aware: a ``//`` inside a string literal (e.g. ``"webhook://"``) is
    preserved. ``services*.json`` files are JSONC, so plain ``json.loads`` fails.

    Args:
        text: Raw JSONC document text.

    Returns:
        A string that is valid strict JSON.
    """
    out: list[str] = []
    i, n = 0, len(text)
    in_str = False
    while i < n:
        ch = text[i]
        if in_str:
            out.append(ch)
            if ch == '\\' and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True
            out.append(ch)
            i += 1
            continue
        if ch == '/' and i + 1 < n and text[i + 1] == '/':
            while i < n and text[i] != '\n':
                i += 1
            continue
        if ch == '/' and i + 1 < n and text[i + 1] == '*':
            i += 2
            while i + 1 < n and not (text[i] == '*' and text[i + 1] == '/'):
                i += 1
            i += 2
            continue
        out.append(ch)
        i += 1
    return _strip_trailing_commas(''.join(out))


def _strip_trailing_commas(text: str) -> str:
    """Remove commas that immediately precede a ``}`` or ``]`` (string-aware)."""
    out: list[str] = []
    i, n = 0, len(text)
    in_str = False
    while i < n:
        ch = text[i]
        if in_str:
            out.append(ch)
            if ch == '\\' and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True
            out.append(ch)
            i += 1
            continue
        if ch == ',':
            j = i + 1
            while j < n and text[j] in ' \t\r\n':
                j += 1
            if j < n and text[j] in '}]':
                i += 1  # drop the comma
                continue
        out.append(ch)
        i += 1
    return ''.join(out)


# ---------------------------------------------------------------------------
# provider -> entry-module resolution (the services*.json 'path' mapping)
# ---------------------------------------------------------------------------


@dataclass
class NodeEntry:
    """Resolution of one provider to the files that seed its dependency walk."""

    provider: str
    node_path: Optional[str]  # dotted module path from services.json, e.g. 'nodes.webhook'
    entry_files: list[str]  # absolute .py files to seed the AST walk (empty if native)
    native: bool = False  # provider has no 'path' -> no Python module (skip)


class ProviderIndex:
    """Maps a pipeline ``provider`` string to its Python entry module.

    Reproduces the engine loader's mapping (``protocol`` -> logical type, ``path`` ->
    module) rather than guessing ``nodes.<provider>``, which is wrong for roughly a
    third of providers: aliases, sub-package paths, name != directory, and native
    nodes with no ``path``.
    """

    def __init__(self, nodes_src: str):
        """Build the index by scanning every ``services*.json`` under ``nodes_src``.

        Args:
            nodes_src: The ``nodes`` package source root (its child ``nodes/`` holds
                the node packages), e.g. ``.../nodes/src``.
        """
        self._nodes_src = os.path.abspath(nodes_src)
        # logicalType -> node_path ('nodes.webhook') or None for native nodes.
        self._by_provider: dict[str, Optional[str]] = {}
        self._scan()

    def _scan(self) -> None:
        pattern = os.path.join(self._nodes_src, 'nodes', '**', 'services*.json')
        for path in glob(pattern, recursive=True):
            try:
                with open(path, 'r', encoding='utf-8') as fh:
                    data = json.loads(strip_jsonc(fh.read()))
            except (OSError, ValueError):
                continue
            protocol = data.get('protocol')
            if not isinstance(protocol, str):
                continue
            logical = protocol.split('://', 1)[0].rstrip(':')
            if not logical:
                continue
            node_path = data.get('path')
            # First definition wins; multiple services*.json may share one dir.
            self._by_provider.setdefault(logical, node_path if isinstance(node_path, str) else None)

    def known(self) -> list[str]:
        """Return all provider (logical-type) strings the index resolved."""
        return sorted(self._by_provider)

    def resolve(self, provider: str) -> Optional[NodeEntry]:
        """Resolve one provider to its entry module files.

        Args:
            provider: The pipeline component ``provider`` (logical type).

        Returns:
            A ``NodeEntry`` (``native`` when the provider has no Python ``path``),
            or ``None`` if the provider is unknown to the index.
        """
        if provider not in self._by_provider:
            return None
        node_path = self._by_provider[provider]
        if not node_path:
            return NodeEntry(provider=provider, node_path=None, entry_files=[], native=True)
        pkg_dir = os.path.join(self._nodes_src, *node_path.split('.'))
        entry_files = [
            os.path.join(pkg_dir, base) for base in _ENTRY_BASENAMES if os.path.isfile(os.path.join(pkg_dir, base))
        ]
        return NodeEntry(provider=provider, node_path=node_path, entry_files=entry_files)


# ---------------------------------------------------------------------------
# the transitive AST walk
# ---------------------------------------------------------------------------


@dataclass
class DiscoveryResult:
    """Outcome of a dependency walk over one environment's node set."""

    requirement_files: list[str] = field(default_factory=list)  # absolute paths
    reached_modules: list[str] = field(default_factory=list)  # first-party dotted names
    third_party: list[str] = field(default_factory=list)  # top-level pkg names (leaves)
    dynamic_imports: list[str] = field(default_factory=list)  # unresolved importlib/__import__
    unresolved_providers: list[str] = field(default_factory=list)


def _module_to_file(dotted: str, roots: dict[str, str]) -> Optional[str]:
    """Resolve a dotted first-party module to a ``.py`` file (module or package)."""
    top = dotted.split('.', 1)[0]
    base = roots.get(top)
    if base is None:
        return None
    rel = os.path.join(*dotted.split('.'))
    for cand in (os.path.join(base, rel + '.py'), os.path.join(base, rel, '__init__.py')):
        if os.path.isfile(cand):
            return cand
    return None


def _pkg_of(path: str, roots: dict[str, str]) -> str:
    """Return the dotted *package* a file belongs to (``__init__`` vs module aware)."""
    for base in roots.values():
        if path.startswith(base):
            rel = os.path.relpath(path, base).replace(os.sep, '.')
            if rel.endswith('.__init__.py'):
                return rel[: -len('.__init__.py')]  # pkg/__init__.py -> pkg
            if rel.endswith('.py'):
                return '.'.join(rel[:-3].split('.')[:-1])  # a.b.mod -> a.b
    return ''


def _import_targets(node: ast.AST, cur_file: str, roots: dict[str, str]) -> list[str]:
    """Dotted module names an Import/ImportFrom refers to (relative resolved)."""
    if isinstance(node, ast.Import):
        return [alias.name for alias in node.names]
    if isinstance(node, ast.ImportFrom):
        if node.level:
            anchor = _pkg_of(cur_file, roots).split('.')
            for _ in range(node.level - 1):
                anchor = anchor[:-1]
            base = '.'.join(a for a in anchor if a)
            if node.module:
                return [f'{base}.{node.module}' if base else node.module]
            return [base] if base else []
        return [node.module] if node.module else []
    return []


def _string_consts(value: ast.AST) -> list[str]:
    """Flatten str constants from a Constant / List / Tuple expression."""
    if isinstance(value, ast.Constant) and isinstance(value.value, str):
        return [value.value]
    if isinstance(value, (ast.List, ast.Tuple)):
        out: list[str] = []
        for elt in value.elts:
            out.extend(_string_consts(elt))
        return out
    return []


def discover(entry_files: Iterable[str], roots: dict[str, str]) -> DiscoveryResult:
    """Walk the import graph from ``entry_files`` and collect requirement files.

    Args:
        entry_files: Absolute ``.py`` paths to seed the walk (a node's entry
            modules).
        roots: ``{'nodes': <nodes src>, 'ai': <ai src>}`` first-party package roots.

    Returns:
        A ``DiscoveryResult``. ``requirement_files`` is the sound (over-approximating)
        set of ``requirement*.txt`` paths reachable from the seeds.
    """
    seen: set[str] = set()
    queue: list[str] = [os.path.abspath(f) for f in entry_files]
    reqs: set[str] = set()
    reached: set[str] = set()
    third: set[str] = set()
    dynamic: list[str] = []

    def _add_req_dir(directory: str) -> None:
        for rq in glob(os.path.join(directory, 'requirement*.txt')):
            reqs.add(os.path.abspath(rq))

    while queue:
        cur = queue.pop()
        if not cur or cur in seen or not os.path.isfile(cur):
            continue
        seen.add(cur)
        cur_dir = os.path.dirname(cur)
        _add_req_dir(cur_dir)  # a node's / ai module's co-located requirement*.txt
        try:
            tree = ast.parse(open(cur, encoding='utf-8').read())
        except (OSError, SyntaxError, ValueError):
            continue
        for node in ast.walk(tree):
            # calls: depends()/load_depends() string args + dynamic-import detection
            if isinstance(node, ast.Call):
                fn = getattr(node.func, 'attr', None) or getattr(node.func, 'id', None)
                if fn in ('depends', 'load_depends'):
                    for arg in node.args:
                        for s in _string_consts(arg):
                            if s.endswith('.txt'):
                                cand = os.path.join(cur_dir, s)
                                if os.path.isfile(cand):
                                    reqs.add(os.path.abspath(cand))
                if fn == 'import_module' and not (
                    node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)
                ):
                    dynamic.append(f'importlib.import_module(dynamic) @ {cur}')
                if getattr(node.func, 'id', None) == '__import__' and not (
                    node.args and isinstance(node.args[0], ast.Constant)
                ):
                    dynamic.append(f'__import__(dynamic) @ {cur}')
            # *_REQUIREMENTS_FILE = 'requirements_x.txt' (or a list of them)
            if isinstance(node, ast.Assign):
                for tgt in node.targets:
                    if isinstance(tgt, ast.Name) and 'REQUIREMENT' in tgt.id.upper():
                        for s in _string_consts(node.value):
                            if s.endswith('.txt'):
                                cand = os.path.join(cur_dir, s)
                                if os.path.isfile(cand):
                                    reqs.add(os.path.abspath(cand))
            # imports: recurse first-party, record third-party leaves
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                for mod in _import_targets(node, cur, roots):
                    top = mod.split('.', 1)[0]
                    if top in roots:
                        if top == 'ai' and '.models' in ('.' + mod):
                            reached.add(mod)
                        nxt = _module_to_file(mod, roots)
                        if nxt:
                            queue.append(nxt)
                    elif top and top not in _NON_REQUIREMENT_TOPS:
                        third.add(top)

    return DiscoveryResult(
        requirement_files=sorted(reqs),
        reached_modules=sorted(reached),
        third_party=sorted(third),
        dynamic_imports=sorted(set(dynamic)),
    )


def discover_for_providers(providers: Iterable[str], nodes_src: str, ai_src: str) -> DiscoveryResult:
    """High-level: resolve providers and walk their combined dependency graph.

    Args:
        providers: The set of node ``provider`` strings used by one environment.
        nodes_src: ``nodes`` package source root (e.g. ``.../nodes/src``).
        ai_src: ``ai`` package source root (e.g. ``.../packages/ai/src``).

    Returns:
        A merged ``DiscoveryResult`` for the whole environment. Providers unknown
        to the index (or native, no-``path`` nodes with no module) contribute no
        files and, when unknown, are listed in ``unresolved_providers``.

    Duplicate providers (a pipeline may have many nodes of the same type, e.g. two
    OpenAI or several Frame Grabber nodes) are collapsed up front, so each provider
    is resolved and walked exactly once.
    """
    index = ProviderIndex(nodes_src)
    roots = {'nodes': os.path.abspath(nodes_src), 'ai': os.path.abspath(ai_src)}
    seeds: list[str] = []
    unresolved: list[str] = []
    for provider in dict.fromkeys(providers):  # unique, first-seen order
        entry = index.resolve(provider)
        if entry is None:
            unresolved.append(provider)
            continue
        seeds.extend(entry.entry_files)
    result = discover(seeds, roots)
    result.unresolved_providers = sorted(set(unresolved))
    return result
