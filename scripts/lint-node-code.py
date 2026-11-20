#!/usr/bin/env python3
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
"""Lint a node package's Python against the node contract (plan 4.1, 4.3).

Static, deterministic, stdlib only: it parses every ``.py`` under a node
directory and never imports it. One check per rule of the contract:

  module-cache     a module-level mutable container written from function code,
                   a module global rebound from config, or an ``lru_cache`` /
                   ``cache`` function called with config-derived arguments.
                   Module scope holds constants, fixed tables and singletons
                   shared by every control; nothing per control lives there.
  bag-write        a write into the endpoint ``bag`` (item store or delete, or
                   a mutating method). A control's objects live on its IGlobal.
  class-mutable    a mutable container assigned in the class body of an
                   ``IGlobal`` / ``IInstance``: it is shared by every control
                   and every binding. Initialise it in ``__init__`` / ``begin*``.
  print-logging    ``print`` or the ``logging`` module in node code. Output goes
                   through rocketlib's ``debug`` / ``warning`` / ``error``.
  global-unclosed  ``beginGlobal`` stores a built object on ``self`` that
                   ``endGlobal`` never touches (best-effort pairing by attribute
                   name, following ``self.<method>()`` calls inside the class).
  param-in-global  ``beginGlobal`` reads a ``param``-flagged key through
                   ``self.config``: a parameter is per call (``self.settings``).
  caller-write     a class-level ``caller`` / ``_caller`` or any assignment to
                   ``.caller`` / ``._caller``: the engine binds the caller once.
  introspection    ``gc``, ``inspect.stack`` or ``sys.modules`` of another
                   package: a node never reaches past its own objects.
  glb-pipetype     any ``.glb`` or ``.pipeType`` read: the node's identity is
                   ``self.config.node`` (plan 5.6.4).

The checks are best-effort static analysis: they refuse the patterns, they do
not prove their absence. The runtime half is the two-replica test (plan 4.3).

Usage: lint-node-code.py <node-dir> [<node-dir> ...]
       lint-node-code.py --all nodes/src/nodes
"""

import ast
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Set

# =============================================================================
# Vocabulary
# =============================================================================

#: Call names that build a mutable container.
MUTABLE_FACTORIES = {
    'dict',
    'list',
    'set',
    'bytearray',
    'defaultdict',
    'OrderedDict',
    'deque',
    'Counter',
    'ChainMap',
    'WeakValueDictionary',
    'WeakKeyDictionary',
    'WeakSet',
}

#: Methods that mutate a container in place.
MUTATORS = {
    'append',
    'appendleft',
    'extend',
    'extendleft',
    'insert',
    'add',
    'update',
    'setdefault',
    'pop',
    'popitem',
    'popleft',
    'remove',
    'discard',
    'clear',
    '__setitem__',
    '__delitem__',
}

#: Decorators that memoise a function on its arguments for the life of the process.
MEMO_DECORATORS = {'lru_cache', 'cache', 'cached'}

#: Names whose value is the node's configuration (the taint sources).
CONFIG_NAMES = {'config', 'settings', 'connConfig'}

#: Name words of a beginGlobal call that opens something (a connection, a client, a worker).
OPENER_WORDS = {
    'connect',
    'open',
    'start',
    'client',
    'session',
    'pool',
    'load',
    'spawn',
    'launch',
    'popen',
    'thread',
    'subscribe',
    'listen',
}

#: Capitalised callees that build a value, not a resource.
VALUE_TYPES = {
    'Decimal',
    'Fraction',
    'Path',
    'PurePath',
    'UUID',
    'Lock',
    'RLock',
    'Event',
    'Condition',
    'Semaphore',
    'BoundedSemaphore',
}

#: Class names whose body the class-mutable rule inspects.
NODE_CLASSES = ('IGlobal', 'IInstance')


# =============================================================================
# Findings
# =============================================================================


@dataclass(frozen=True)
class Finding:
    """One contract violation at one source line."""

    rule: str
    path: str
    line: int
    message: str

    def __str__(self) -> str:
        """Render as ``path:line: [rule] message``."""
        return f'{self.path}:{self.line}: [{self.rule}] {self.message}'


# =============================================================================
# services*.json: param-flagged leaf names
# =============================================================================


def strip_jsonc(s: str) -> str:
    """Remove ``//`` comments and trailing commas from a JSONC document (never inside a string)."""
    out, i, n, instr = [], 0, len(s), False
    while i < n:
        c = s[i]
        if instr:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(s[i + 1])
                i += 2
                continue
            if c == '"':
                instr = False
            i += 1
            continue
        if c == '"':
            instr = True
            out.append(c)
            i += 1
            continue
        if c == '/' and i + 1 < n and s[i + 1] == '/':
            while i < n and s[i] != '\n':
                i += 1
            continue
        out.append(c)
        i += 1
    return _drop_trailing_commas(''.join(out))


def _drop_trailing_commas(s: str) -> str:
    """Drop each comma that only whitespace separates from a closing brace or bracket, outside strings."""
    out, i, n, instr = [], 0, len(s), False
    while i < n:
        c = s[i]
        if instr:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(s[i + 1])
                i += 2
                continue
            if c == '"':
                instr = False
            i += 1
            continue
        if c == '"':
            instr = True
        elif c == ',':
            j = i + 1
            while j < n and s[j].isspace():
                j += 1
            if j < n and s[j] in '}]':
                i += 1
                continue
        out.append(c)
        i += 1
    return ''.join(out)


def param_names(node_dir: Path) -> Set[str]:
    """
    Return the leaf names the node's services*.json flag ``param: true``.

    A leaf's name is its ``name`` when it carries one, else the last dotted
    segment of the definition key or the ``base`` it aliases (services-schema:
    the final property name is the last component of the reference).
    """
    names: Set[str] = set()

    def visit(value, key: Optional[str]) -> None:
        # Step 1: a dict flagged param contributes its leaf name.
        if isinstance(value, dict):
            if value.get('param') is True:
                name = value.get('name') or value.get('base') or key
                if isinstance(name, str) and name:
                    names.add(name.rsplit('.', 1)[-1])
            # Step 2: walk on; a propertyDefinitions entry is named by its key.
            for k, v in value.items():
                visit(v, k)
        elif isinstance(value, list):
            for v in value:
                visit(v, None)

    for f in sorted(node_dir.rglob('services*.json')):
        try:
            visit(json.loads(strip_jsonc(f.read_text(encoding='utf-8'))), None)
        except (OSError, ValueError):
            continue
    return names


# =============================================================================
# AST helpers
# =============================================================================


def call_name(node: ast.AST) -> Optional[str]:
    """Return the called name of a Call (``f`` for ``f()`` and ``a.b.f()``)."""
    if not isinstance(node, ast.Call):
        return None
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def root_name(node: ast.AST) -> Optional[str]:
    """Return the left-most Name of an attribute / subscript / call chain."""
    while True:
        if isinstance(node, ast.Attribute):
            node = node.value
        elif isinstance(node, ast.Subscript):
            node = node.value
        elif isinstance(node, ast.Call):
            node = node.func
        elif isinstance(node, ast.Name):
            return node.id
        else:
            return None


def is_mutable(expr: Optional[ast.AST]) -> bool:
    """True when ``expr`` builds a mutable container."""
    if isinstance(expr, (ast.Dict, ast.List, ast.Set, ast.DictComp, ast.ListComp, ast.SetComp)):
        return True
    return call_name(expr) in MUTABLE_FACTORIES


def mentions_config(expr: ast.AST, tainted: Set[str]) -> bool:
    """True when ``expr`` reads the node's configuration or a name derived from it."""
    for sub in ast.walk(expr):
        if isinstance(sub, ast.Attribute) and sub.attr in CONFIG_NAMES:
            return True
        if isinstance(sub, ast.Name) and (sub.id in CONFIG_NAMES or sub.id in tainted):
            return True
    return False


def assigned_names(target: ast.AST) -> Iterator[str]:
    """Yield the plain names bound by an assignment target."""
    if isinstance(target, ast.Name):
        yield target.id
    elif isinstance(target, (ast.Tuple, ast.List)):
        for elt in target.elts:
            yield from assigned_names(elt)


def flat_targets(target: ast.AST) -> Iterator[ast.AST]:
    """Yield each single target of an assignment target, descending into unpacking."""
    if isinstance(target, (ast.Tuple, ast.List)):
        for elt in target.elts:
            yield from flat_targets(elt)
    elif isinstance(target, ast.Starred):
        yield from flat_targets(target.value)
    else:
        yield target


def write_targets(stmt: ast.AST) -> List[ast.AST]:
    """Return every single target a statement writes (an annotation without a value writes nothing)."""
    if isinstance(stmt, (ast.Assign, ast.Delete)):
        roots = stmt.targets
    elif isinstance(stmt, ast.AugAssign):
        roots = [stmt.target]
    elif isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
        roots = [stmt.target]
    else:
        return []
    return [t for root in roots for t in flat_targets(root)]


def assigned_value(stmt: ast.AST) -> Optional[ast.AST]:
    """Return the value an Assign / AnnAssign stores, else None."""
    if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
        return stmt.value
    return None


def own_nodes(scope: ast.AST) -> Iterator[ast.AST]:
    """Yield the nodes of ``scope``'s own body, never entering a nested function, lambda or class."""
    todo = list(ast.iter_child_nodes(scope))
    while todo:
        sub = todo.pop()
        yield sub
        if not isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            todo.extend(ast.iter_child_nodes(sub))


def local_names(func: ast.AST) -> Set[str]:
    """Return the names ``func`` binds in its own scope: parameters, assignments, imports, defs."""
    names: Set[str] = set()
    args = func.args
    for a in args.posonlyargs + args.args + args.kwonlyargs + [args.vararg, args.kwarg]:
        if a is not None:
            names.add(a.arg)
    declared: Set[str] = set()
    for sub in own_nodes(func):
        if isinstance(sub, ast.Name) and isinstance(sub.ctx, (ast.Store, ast.Del)):
            names.add(sub.id)
        elif isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(sub.name)
        elif isinstance(sub, (ast.Import, ast.ImportFrom)):
            names.update((a.asname or a.name).split('.')[0] for a in sub.names)
        elif isinstance(sub, ast.Global):
            declared.update(sub.names)
    return names - declared


def global_names(func: ast.AST) -> Set[str]:
    """Return the names ``func`` declares ``global`` in its own scope."""
    return {n for sub in own_nodes(func) if isinstance(sub, ast.Global) for n in sub.names}


def function_scopes(node: ast.AST, enclosing: frozenset = frozenset()) -> Iterator[tuple]:
    """
    Yield ``(function, bound)`` for every function under ``node``.

    ``bound`` holds the names the function or an enclosing function binds: a
    name outside it resolves to the module. Class scopes are not enclosing.
    """
    for sub in own_nodes(node):
        if isinstance(sub, ast.ClassDef):
            yield from function_scopes(sub, enclosing)
        elif isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            bound = (enclosing - global_names(sub)) | local_names(sub)
            yield sub, bound
            yield from function_scopes(sub, bound)


def function_taint(func: ast.AST) -> Set[str]:
    """Return the names of ``func`` assigned from config, iterated until no new name is tainted."""
    tainted: Set[str] = set()
    while True:
        before = len(tainted)
        for sub in ast.walk(func):
            value = assigned_value(sub)
            if value is not None and mentions_config(value, tainted):
                for t in write_targets(sub):
                    tainted.update(assigned_names(t))
            elif isinstance(sub, (ast.For, ast.comprehension)) and mentions_config(sub.iter, tainted):
                tainted.update(assigned_names(sub.target))
        if len(tainted) == before:
            return tainted


def paired_values(target: ast.AST, value: ast.AST) -> Iterator[tuple]:
    """
    Yield ``(name, value)`` for each plain name an assignment binds.

    A literal unpacking (``a, b = [], {}``) pairs each name with its own value;
    any other unpacking yields the names with the whole value, which is mutable
    only when the value itself is a container.
    """
    if isinstance(target, ast.Name):
        yield target.id, value
    elif isinstance(target, (ast.Tuple, ast.List)):
        if (
            isinstance(value, (ast.Tuple, ast.List))
            and len(value.elts) == len(target.elts)
            and not any(isinstance(e, ast.Starred) for e in target.elts + value.elts)
        ):
            for t, v in zip(target.elts, value.elts):
                yield from paired_values(t, v)
        else:
            for name in assigned_names(target):
                yield name, None


def functions(tree: ast.AST) -> Iterator[ast.AST]:
    """Yield every function and method in a module, at any depth."""
    for sub in ast.walk(tree):
        if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            yield sub


def reached_nodes(func: ast.AST) -> List[ast.AST]:
    """
    Return the nodes a function runs: its own body, plus the local functions it calls by name.

    A nested function that is defined but never called contributes nothing; one
    the body calls directly (``close_client()``) runs, and so does whatever it
    calls by name in turn.
    """
    reached: List[ast.AST] = []
    seen: Set[int] = set()
    todo = [func]
    while todo:
        scope = todo.pop()
        if id(scope) in seen:
            continue
        seen.add(id(scope))
        body = list(own_nodes(scope))
        reached.extend(body)
        local_defs = {sub.name: sub for sub in body if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef))}
        called = {sub.func.id for sub in body if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name)}
        todo.extend(local_defs[name] for name in sorted(called & set(local_defs)))
    return reached


def self_attrs(node: ast.AST) -> Set[str]:
    """Return every ``self.<attr>`` a method reaches (not an uncalled nested function's)."""
    return {
        sub.attr
        for sub in reached_nodes(node)
        if isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name) and sub.value.id == 'self'
    }


def self_calls(node: ast.AST) -> Set[str]:
    """Return the names of the ``self.<method>(...)`` calls a method reaches."""
    return {
        sub.func.attr
        for sub in reached_nodes(node)
        if isinstance(sub, ast.Call)
        and isinstance(sub.func, ast.Attribute)
        and isinstance(sub.func.value, ast.Name)
        and sub.func.value.id == 'self'
    }


def method_closure(methods: Dict[str, ast.AST], start: str) -> List[ast.AST]:
    """Return ``start`` and every same-class method it reaches through ``self.<m>()``."""
    seen, order, todo = set(), [], [start]
    while todo:
        name = todo.pop()
        if name in seen or name not in methods:
            continue
        seen.add(name)
        order.append(methods[name])
        todo.extend(sorted(self_calls(methods[name]), reverse=True))
    return order


def alias_flow(body: List[ast.stmt], aliases: Set[str], is_source, scan) -> Set[str]:
    """
    Walk ``body`` in execution order, tracking the names that may alias a source; return the set after it.

    ``scan(expr, aliases)`` is called on every expression with the alias set
    that holds where it runs. Both arms of a branch are walked and their sets
    merged by union (a name aliases after the join if it may on any path); a
    loop is walked as zero or more passes; a plain rebinding on the straight
    line ends the alias. Nested function and class bodies do not run here.
    """
    aliases = set(aliases)
    for stmt in body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if isinstance(stmt, ast.If):
            scan(stmt.test, aliases)
            aliases = alias_flow(stmt.body, aliases, is_source, scan) | alias_flow(
                stmt.orelse, aliases, is_source, scan
            )
        elif isinstance(stmt, (ast.For, ast.AsyncFor, ast.While)):
            scan(stmt.iter if isinstance(stmt, (ast.For, ast.AsyncFor)) else stmt.test, aliases)
            entry = set(aliases)
            for _ in range(2):  # a second pass carries what one iteration leaves into the next
                start = set(entry)
                if isinstance(stmt, (ast.For, ast.AsyncFor)):
                    start -= set(assigned_names(stmt.target))
                entry |= alias_flow(stmt.body, start, is_source, scan)
            aliases = alias_flow(stmt.orelse, entry, is_source, scan)
        elif isinstance(stmt, (ast.With, ast.AsyncWith)):
            for item in stmt.items:
                scan(item.context_expr, aliases)
                if item.optional_vars is not None:
                    aliases -= set(assigned_names(item.optional_vars))
            aliases = alias_flow(stmt.body, aliases, is_source, scan)
        elif isinstance(stmt, (ast.Try, getattr(ast, 'TryStar', ast.Try))):
            after = alias_flow(stmt.body, aliases, is_source, scan)
            anywhere = aliases | after
            outs = [alias_flow(stmt.orelse, after, is_source, scan)]
            outs += [alias_flow(h.body, anywhere, is_source, scan) for h in stmt.handlers]
            aliases = alias_flow(stmt.finalbody, set().union(*outs), is_source, scan)
        elif isinstance(stmt, ast.Match):
            scan(stmt.subject, aliases)
            outs = [aliases] + [alias_flow(case.body, aliases, is_source, scan) for case in stmt.cases]
            aliases = set().union(*outs)
        else:
            # A simple statement: its reads run before its bindings.
            scan(stmt, aliases)
            value = assigned_value(stmt)
            for t in write_targets(stmt):
                if isinstance(t, ast.Name):
                    if isinstance(stmt, ast.Assign) and value is not None and is_source(value):
                        aliases.add(t.id)
                    else:
                        aliases.discard(t.id)
    return aliases


def opens(value: ast.AST, tainted: Set[str]) -> bool:
    """
    True when an assigned value opens something: a constructed object or an opener call.

    A constructor (a capitalised callee other than a value type) or a callee whose
    name says it connects, opens, starts, loads or spawns. A call made on the
    configuration (``cfg.base_url.strip()``) computes a value and never opens.
    """
    if not isinstance(value, ast.Call):
        return False
    root = root_name(value.func)
    if root in CONFIG_NAMES or root in tainted:
        return False
    if isinstance(value.func, ast.Attribute):
        inner = value.func.value
        if isinstance(inner, ast.Attribute) and inner.attr in CONFIG_NAMES:
            return False
    name = call_name(value) or ''
    if name[:1].isupper():
        return name not in VALUE_TYPES
    words = {w.lower() for w in re.findall(r'[A-Z]?[a-z]+|[A-Z]+(?![a-z])', name)}
    return bool(words & OPENER_WORDS)


# =============================================================================
# The rules
# =============================================================================


class FileLint:
    """Run every rule over one parsed source file."""

    def __init__(self, path: Path, rel: str, tree: ast.Module, params: Set[str]):
        """Hold the file's tree, its display path and the node's param names."""
        self.path = path
        self.rel = rel
        self.tree = tree
        self.params = params
        self.findings: List[Finding] = []

    def add(self, rule: str, node: ast.AST, message: str) -> None:
        """Record one finding at ``node``'s line."""
        self.findings.append(Finding(rule, self.rel, getattr(node, 'lineno', 0), message))

    def run(self) -> List[Finding]:
        """Run every rule; return the findings in line order."""
        self.module_cache()
        self.bag_write()
        self.class_mutable()
        self.print_logging()
        self.global_unclosed()
        self.param_in_global()
        self.caller_write()
        self.introspection()
        self.glb_pipetype()
        return sorted(self.findings, key=lambda f: (f.line, f.rule))

    # -------------------------------------------------------------------------
    # module-cache
    # -------------------------------------------------------------------------

    def module_cache(self) -> None:
        """Module-level containers written from functions, globals rebound from config, memoised config."""
        # Step 1: the module-level names bound to a mutable container.
        containers: Dict[str, ast.AST] = {}
        for stmt in self.tree.body:
            if isinstance(stmt, ast.Assign) and is_mutable(stmt.value):
                for t in stmt.targets:
                    for name in assigned_names(t):
                        containers[name] = stmt
            elif isinstance(stmt, ast.AnnAssign) and is_mutable(stmt.value):
                for name in assigned_names(stmt.target):
                    containers[name] = stmt

        # Step 2: any function that writes one of them keeps state at module scope.
        # A name the function (or an enclosing one) binds itself is not the module's.
        reported: Set[str] = set()
        for func, bound in function_scopes(self.tree):
            for sub in own_nodes(func):
                written = [
                    t.value.id
                    for t in write_targets(sub)
                    if isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name)
                ]
                if (
                    isinstance(sub, ast.Call)
                    and isinstance(sub.func, ast.Attribute)
                    and sub.func.attr in MUTATORS
                    and isinstance(sub.func.value, ast.Name)
                ):
                    written.append(sub.func.value.id)
                for name in written:
                    if name in containers and name not in bound and name not in reported:
                        reported.add(name)
                        self.add(
                            'module-cache',
                            sub,
                            f'module-level container "{name}" is written from function code: module scope is '
                            'shared by every control; keep per-control objects on the IGlobal',
                        )

        # Step 3: a module global rebound from config inside a function.
        for func in functions(self.tree):
            if isinstance(func, ast.Lambda):
                continue
            declared = {n for s in ast.walk(func) if isinstance(s, ast.Global) for n in s.names}
            if not declared:
                continue
            tainted = function_taint(func)
            for sub in ast.walk(func):
                if isinstance(sub, ast.Assign) and mentions_config(sub.value, tainted):
                    for t in sub.targets:
                        for name in assigned_names(t):
                            if name in declared:
                                self.add(
                                    'module-cache',
                                    sub,
                                    f'module global "{name}" is built from config: it outlives the control; '
                                    'build it in beginGlobal and keep it on the IGlobal',
                                )

        # Step 4: a memoised function called with config-derived arguments.
        memo: Set[str] = set()
        for func in functions(self.tree):
            if isinstance(func, ast.Lambda):
                continue
            for dec in func.decorator_list:
                target = dec.func if isinstance(dec, ast.Call) else dec
                if (isinstance(target, ast.Name) and target.id in MEMO_DECORATORS) or (
                    isinstance(target, ast.Attribute) and target.attr in MEMO_DECORATORS
                ):
                    memo.add(func.name)
        if memo:
            for func in functions(self.tree):
                tainted = function_taint(func)
                for sub in ast.walk(func):
                    if call_name(sub) in memo:
                        args = list(sub.args) + [k.value for k in sub.keywords]
                        if any(mentions_config(a, tainted) for a in args):
                            self.add(
                                'module-cache',
                                sub,
                                f'"{call_name(sub)}" is memoised for the life of the process and called with '
                                'config: the cache is keyed across controls',
                            )

    # -------------------------------------------------------------------------
    # bag-write
    # -------------------------------------------------------------------------

    def bag_write(self) -> None:
        """Writes into the endpoint bag."""

        def is_bag(expr: ast.AST) -> bool:
            return (isinstance(expr, ast.Name) and expr.id == 'bag') or (
                isinstance(expr, ast.Attribute) and expr.attr == 'bag'
            )

        for sub in ast.walk(self.tree):
            for t in write_targets(sub):
                if isinstance(t, ast.Subscript) and is_bag(t.value):
                    self.add('bag-write', sub, 'write into the endpoint bag: keep the object on the IGlobal')
            if (
                isinstance(sub, ast.Call)
                and isinstance(sub.func, ast.Attribute)
                and sub.func.attr in MUTATORS
                and is_bag(sub.func.value)
            ):
                self.add('bag-write', sub, 'write into the endpoint bag: keep the object on the IGlobal')

    # -------------------------------------------------------------------------
    # class-mutable
    # -------------------------------------------------------------------------

    def class_mutable(self) -> None:
        """Mutable containers in the class body of an IGlobal / IInstance."""
        for cls in ast.walk(self.tree):
            if not isinstance(cls, ast.ClassDef) or not cls.name.endswith(NODE_CLASSES):
                continue
            for stmt in cls.body:
                value = assigned_value(stmt)
                if value is None:
                    continue
                roots = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
                for root in roots:
                    for name, item in paired_values(root, value):
                        if is_mutable(item):
                            self.add(
                                'class-mutable',
                                stmt,
                                f'{cls.name}.{name} is a class-level mutable shared by every control and binding: '
                                'initialise it in __init__ / begin*',
                            )

    # -------------------------------------------------------------------------
    # print-logging
    # -------------------------------------------------------------------------

    def print_logging(self) -> None:
        """``print`` calls and the ``logging`` module."""
        for sub in ast.walk(self.tree):
            if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name) and sub.func.id == 'print':
                self.add('print-logging', sub, 'print in node code: use rocketlib debug / warning / error')
            elif isinstance(sub, ast.Import) and any(a.name.split('.')[0] == 'logging' for a in sub.names):
                self.add('print-logging', sub, 'logging in node code: use rocketlib debug / warning / error')
            elif isinstance(sub, ast.ImportFrom) and (sub.module or '').split('.')[0] == 'logging' and not sub.level:
                self.add('print-logging', sub, 'logging in node code: use rocketlib debug / warning / error')

    # -------------------------------------------------------------------------
    # global-unclosed
    # -------------------------------------------------------------------------

    def global_unclosed(self) -> None:
        """Objects beginGlobal builds on self that endGlobal never touches."""
        for cls in ast.walk(self.tree):
            if not isinstance(cls, ast.ClassDef):
                continue
            methods = {m.name: m for m in cls.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))}
            if 'beginGlobal' not in methods:
                continue

            # Step 1: the attributes beginGlobal (and the methods it calls) build.
            built: Dict[str, ast.AST] = {}
            for method in method_closure(methods, 'beginGlobal'):
                tainted = function_taint(method)
                for sub in ast.walk(method):
                    value = assigned_value(sub)
                    if value is None or not opens(value, tainted):
                        continue
                    for t in write_targets(sub):
                        if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == 'self':
                            # The earliest build of an attribute is the one reported, whatever the visit order
                            if t.attr not in built or sub.lineno < built[t.attr].lineno:
                                built[t.attr] = sub
            if not built:
                continue

            # Step 2: what endGlobal (and the methods it calls) touches.
            touched: Set[str] = set()
            for method in method_closure(methods, 'endGlobal'):
                touched |= self_attrs(method)
            for attr, stmt in built.items():
                if attr not in touched:
                    self.add(
                        'global-unclosed',
                        stmt,
                        f'beginGlobal builds self.{attr} and endGlobal never closes or drops it',
                    )

    # -------------------------------------------------------------------------
    # param-in-global
    # -------------------------------------------------------------------------

    def param_in_global(self) -> None:
        """A param-flagged key read through self.config inside beginGlobal."""
        if not self.params:
            return
        for cls in ast.walk(self.tree):
            if not isinstance(cls, ast.ClassDef):
                continue
            for method in cls.body:
                if not isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) or method.name != 'beginGlobal':
                    continue

                def is_self_config(expr: ast.AST) -> bool:
                    return (
                        isinstance(expr, ast.Attribute)
                        and expr.attr == 'config'
                        and isinstance(expr.value, ast.Name)
                        and expr.value.id == 'self'
                    )

                # Each read is judged against the names that MAY alias self.config where it
                # runs: branches merge by union, a straight-line rebinding ends the alias.
                found: Dict[int, tuple] = {}

                def scan(expr: ast.AST, aliases: Set[str]) -> None:
                    def is_config(e: ast.AST) -> bool:
                        return is_self_config(e) or (isinstance(e, ast.Name) and e.id in aliases)

                    for sub in ast.walk(expr):
                        key = None
                        if isinstance(sub, ast.Attribute) and is_config(sub.value):
                            key = sub.attr
                        elif isinstance(sub, ast.Subscript) and is_config(sub.value):
                            if isinstance(sub.slice, ast.Constant) and isinstance(sub.slice.value, str):
                                key = sub.slice.value
                        elif (
                            isinstance(sub, ast.Call)
                            and isinstance(sub.func, ast.Attribute)
                            and sub.func.attr == 'get'
                            and is_config(sub.func.value)
                            and sub.args
                            and isinstance(sub.args[0], ast.Constant)
                        ):
                            key = sub.args[0].value
                        if key in self.params:
                            found[id(sub)] = (sub, key)

                alias_flow(method.body, set(), is_self_config, scan)
                for sub, key in sorted(found.values(), key=lambda f: (f[0].lineno, f[0].col_offset)):
                    self.add(
                        'param-in-global',
                        sub,
                        f'"{key}" is a parameter: beginGlobal cannot know a per-call value; '
                        'read it from self.settings in IInstance',
                    )

    # -------------------------------------------------------------------------
    # caller-write
    # -------------------------------------------------------------------------

    def caller_write(self) -> None:
        """Class-level caller / _caller, and any assignment to .caller / ._caller."""
        names = ('caller', '_caller')
        for sub in ast.walk(self.tree):
            if isinstance(sub, ast.ClassDef):
                for stmt in sub.body:
                    if any(isinstance(t, ast.Name) and t.id in names for t in write_targets(stmt)):
                        self.add('caller-write', stmt, f'class-level caller on {sub.name}: the engine binds it')
            for t in write_targets(sub):
                if isinstance(sub, ast.Delete):
                    continue
                if isinstance(t, ast.Attribute) and t.attr in names:
                    self.add('caller-write', sub, f'assignment to .{t.attr}: the caller is bound once by the engine')
            if (
                isinstance(sub, ast.Call)
                and isinstance(sub.func, ast.Name)
                and sub.func.id == 'setattr'
                and len(sub.args) >= 2
                and isinstance(sub.args[1], ast.Constant)
                and sub.args[1].value in names
            ):
                self.add('caller-write', sub, 'setattr of the caller: the caller is bound once by the engine')

    # -------------------------------------------------------------------------
    # introspection
    # -------------------------------------------------------------------------

    def introspection(self) -> None:
        """gc, inspect.stack and sys.modules reaching another package."""

        def is_sys_modules(expr: ast.AST) -> bool:
            return (
                isinstance(expr, ast.Attribute)
                and expr.attr == 'modules'
                and isinstance(expr.value, ast.Name)
                and expr.value.id == 'sys'
            )

        def is_own_name(expr: Optional[ast.AST]) -> bool:
            return isinstance(expr, ast.Name) and expr.id == '__name__'

        # Step 1: sys.modules[__name__] and sys.modules.get(__name__) look up this module itself.
        own: Set[int] = set()
        for sub in ast.walk(self.tree):
            if isinstance(sub, ast.Subscript) and is_sys_modules(sub.value) and is_own_name(sub.slice):
                own.add(id(sub.value))
            elif (
                isinstance(sub, ast.Call)
                and isinstance(sub.func, ast.Attribute)
                and sub.func.attr == 'get'
                and is_sys_modules(sub.func.value)
                and sub.args
                and is_own_name(sub.args[0])
            ):
                own.add(id(sub.func.value))

        # Step 2: everything else.
        for sub in ast.walk(self.tree):
            if isinstance(sub, ast.Import) and any(a.name == 'gc' for a in sub.names):
                self.add('introspection', sub, 'gc in node code: a node never walks other objects')
            elif isinstance(sub, ast.ImportFrom) and sub.module in ('gc',) and not sub.level:
                self.add('introspection', sub, 'gc in node code: a node never walks other objects')
            elif isinstance(sub, ast.ImportFrom) and sub.module == 'inspect' and not sub.level:
                if any(a.name == 'stack' for a in sub.names):
                    self.add('introspection', sub, 'inspect.stack in node code: a node never reads other frames')
            elif (
                isinstance(sub, ast.Attribute)
                and sub.attr == 'stack'
                and isinstance(sub.value, ast.Name)
                and sub.value.id == 'inspect'
            ):
                self.add('introspection', sub, 'inspect.stack in node code: a node never reads other frames')
            elif is_sys_modules(sub) and id(sub) not in own:
                self.add('introspection', sub, 'sys.modules in node code: a node never reaches another package')

    # -------------------------------------------------------------------------
    # glb-pipetype
    # -------------------------------------------------------------------------

    def glb_pipetype(self) -> None:
        """Any .glb or .pipeType read; a plain write or delete reads nothing, an augmented one does."""
        augmented = {id(sub.target) for sub in ast.walk(self.tree) if isinstance(sub, ast.AugAssign)}
        for sub in ast.walk(self.tree):
            if (
                isinstance(sub, ast.Attribute)
                and sub.attr in ('glb', 'pipeType')
                and (isinstance(sub.ctx, ast.Load) or id(sub) in augmented)
            ):
                self.add(
                    'glb-pipetype',
                    sub,
                    f'.{sub.attr} read: the node identity is self.config.node (id, name, provider, physicalType)',
                )


# =============================================================================
# Entry points
# =============================================================================


def node_sources(node_dir: Path) -> Iterable[Path]:
    """Yield the node's Python sources (never caches)."""
    for path in sorted(node_dir.rglob('*.py')):
        if '__pycache__' not in path.parts:
            yield path


def lint_node(node_dir: Path) -> List[Finding]:
    """Lint every Python source of one node package."""
    node_dir = Path(node_dir)
    params = param_names(node_dir)
    findings: List[Finding] = []
    for path in node_sources(node_dir):
        rel = path.relative_to(node_dir.parent).as_posix()
        try:
            tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
        except SyntaxError as e:
            findings.append(Finding('syntax', rel, e.lineno or 0, f'cannot parse: {e.msg}'))
            continue
        findings.extend(FileLint(path, rel, tree, params).run())
    return findings


def node_dirs(root: Path) -> List[Path]:
    """Every node package under ``root``: a directory carrying Python sources."""
    return sorted(p for p in Path(root).iterdir() if p.is_dir() and p.name != '__pycache__' and any(node_sources(p)))


def main() -> None:
    """Lint the named node directories (or ``--all <root>``); exit 1 on any finding."""
    args = sys.argv[1:]
    if not args or (args[0] == '--all' and len(args) != 2):
        print(__doc__)
        sys.exit(2)
    roots = args[1:] if args[0] == '--all' else args
    missing = [a for a in roots if not Path(a).is_dir()]
    if missing:
        print(f'not a directory: {", ".join(missing)}', file=sys.stderr)
        sys.exit(2)
    dirs = node_dirs(Path(args[1])) if args[0] == '--all' else [Path(a) for a in args]

    total = 0
    for d in dirs:
        findings = lint_node(d)
        total += len(findings)
        for f in findings:
            print(f)
    print(f'\n{len(dirs)} node(s), {total} finding(s)')
    sys.exit(1 if total else 0)


if __name__ == '__main__':
    main()
