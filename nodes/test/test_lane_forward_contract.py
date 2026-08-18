# =============================================================================
# RocketRide Engine
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

"""
Static guard for the lane-forwarding contract, across every node.

After a Python lane handler returns, the engine calls the parent implementation
too, and the parent forwards the same payload downstream. `preventDefault()` is
the only thing that suppresses it (`__checkCallParent` in
`engLib/python/call.hpp:200-214` inspects nothing else). So an override that
forwards on its own lane and then returns normally delivers everything twice:

    def writeAnswers(self, answer):
        ...
        self.instance.writeAnswers(answer)     # our forward
        self.preventDefault()                  # without this, the engine forwards again

The defect is invisible by construction - no error, no log, just duplicate
output downstream - which is how it reached six nodes before anyone noticed
(#1638, #1849, #2041). `test_lane_forward_once.py` measures the real behaviour
on a running engine, but only for the node it drives. This walks the AST of
every node instead, so a new node - or a new handler in a node already on the
allowlist - cannot reintroduce the same shape unnoticed.

The rule checked here is deliberately coarse: a handler that forwards on its
own lane must call `preventDefault()` somewhere reachable from it. Whether
every *branch* reaches it is not decidable this way - that needs real
dataflow analysis, which is out of scope (see #2042). A handler with no call
at all, anywhere on any path, is the shape that has actually shipped broken,
six times; that is what this catches. Resolution is transitive: a handler
that forwards and then calls a same-class helper - or a helper it defines and
calls locally - is checked by walking into that helper too
(`_forwards_own_lane` / `_reaches_prevent_default` in `_Analyzer`), so the
`_forward_answer()`-style helper pattern from #1849 does not read as clean
just because the forward and the `preventDefault()` call live in different
methods.

A call the analyzer cannot resolve - a call through something other than
`self`, an attribute chain, a name not defined as a method on the class - is
reported as **unresolved**, not assumed to reach `preventDefault()`. A silent
"assume clean" here is exactly how a helper-based violation would slip past a
checker that only followed direct calls, which is the gap #2042 opened
against the very first version of this file.

`KNOWN_VIOLATIONS` is the set of `(node, handler)` pairs that are broken
today. It is a ratchet, not an exemption: `test_no_new_lane_forward_violations`
fails on anything outside it, and `test_known_violations_are_still_violations`
fails when an entry is fixed without being removed, so the list can only
shrink. Handler-level granularity matters here specifically because it is
per-`(node, handler)`, not per-node: a *new* violation in a handler of a node
that already has a different violating handler on the list must still fail.

Run directly for a full report (also how the `nodes:lane-contract` builder
task invokes it):

    python nodes/test/test_lane_forward_contract.py

Or via pytest, as part of `builder nodes:test-contracts` (no server needed):

    pytest nodes/test/test_lane_forward_contract.py -v
"""

from __future__ import annotations

import ast
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

# Lane handlers the engine dispatches to Python and then forwards itself.
LANE_METHODS = frozenset(
    {
        'writeAnswers',
        'writeQuestions',
        'writeDocuments',
        'writeText',
        'writeTable',
        'writeWords',
        'writeJson',
        'writeTag',
    }
)

# (node, handler) pairs that forward on their own lane without ever reaching
# preventDefault(). Each double-delivers on every path that forwards. Remove
# an entry together with its fix - a stale entry fails
# test_known_violations_are_still_violations below.
KNOWN_VIOLATIONS = frozenset(
    {
        ('memory_persistent', 'writeQuestions'),  # #1638
        ('memory_persistent', 'writeAnswers'),  # #1638
        ('anomaly_detector', 'writeText'),  # #2041
        ('anomaly_detector', 'writeDocuments'),  # #2041
        ('ner', 'writeText'),  # #2041
        ('ner', 'writeDocuments'),  # #2041
        ('llm_vision_mistral', 'writeDocuments'),  # #2041
        # guardrails.writeQuestions/writeAnswers each call preventDefault() in
        # their own blocked-content branch, so the (deliberately coarse, see
        # module docstring) analyzer does not flag them - #1849 is real but
        # invisible to a check that isn't branch-sensitive. writeDocuments has
        # no blocking path at all, so it has no preventDefault() call anywhere
        # and the analyzer catches it directly.
        ('guardrails', 'writeDocuments'),  # #1849
    }
)

# (node, handler) pairs that forward on their own lane and also call
# self.instance.<other-method>(...) or super().<method>(...) somewhere in the
# same handler - a shape this analyzer deliberately does not resolve (see
# _describe_unresolvable), so whether the handler is actually compliant is
# unverified rather than assumed either way. Same ratchet discipline as
# KNOWN_VIOLATIONS: test_no_unresolved_forwarding_calls fails on anything
# outside this set, test_known_unresolved_are_still_unresolved fails when an
# entry is resolved (by extending the analyzer or refactoring the node)
# without being removed.
KNOWN_UNRESOLVED = frozenset(
    {
        # hasListener(...) checks before forwarding on other lanes; each also
        # calls preventDefault() directly, so likely compliant, but this
        # analyzer does not follow hasListener's effect on delivery.
        ('llamaparse', 'writeTable'),  # #2041
        ('llamaparse', 'writeDocuments'),
        ('ocr', 'writeDocuments'),
        # Forwards on writeQuestions AND writeAnswers/writeText via
        # hasListener-gated self.instance calls, with no preventDefault()
        # anywhere - this one is plausibly a genuine violation the unresolved
        # calls are masking, not just noise. Worth a human look.
        ('search_exa', 'writeQuestions'),  # #2041
    }
)

NODES_DIR = Path(__file__).resolve().parent.parent / 'src' / 'nodes'


@dataclass(order=True)
class Violation:
    """One handler that forwards on its own lane without reaching preventDefault()."""

    node: str
    handler: str
    line: int

    @property
    def key(self) -> Tuple[str, str]:
        return (self.node, self.handler)


@dataclass(order=True)
class Unresolved:
    """One handler whose forwarding call graph the analyzer could not fully resolve.

    Reported separately from Violation: this means "unknown", not "clean". A
    call the analyzer cannot follow (through something other than a same-class
    `self.<method>()`, e.g. a base class in another file, an imported
    function, or a call through a non-`self` object) must not be silently
    treated as reaching preventDefault() just because no violation was proven.
    """

    node: str
    handler: str
    line: int
    reason: str

    @property
    def key(self) -> Tuple[str, str]:
        return (self.node, self.handler)


def _is_self_attr_call(call: ast.Call, owner_attr: str, method: str) -> bool:
    """True when `call` is `self.<owner_attr>.<method>(...)`, e.g. `self.instance.writeText(...)`."""
    target = call.func
    if not (isinstance(target, ast.Attribute) and target.attr == method):
        return False
    owner = target.value
    return (
        isinstance(owner, ast.Attribute)
        and owner.attr == owner_attr
        and isinstance(owner.value, ast.Name)
        and owner.value.id == 'self'
    )


def _is_self_method_call(call: ast.Call) -> Optional[str]:
    """Return the method name when `call` is `self.<method>(...)`, else None."""
    target = call.func
    if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == 'self':
        return target.attr
    return None


class _OwnScopeCalls(ast.NodeVisitor):
    """Collects `ast.Call` nodes that execute as part of a function's own body -
    not inside a nested `def`/`async def`/`lambda`/`class`, which may never
    run. `ast.walk` does not respect scope boundaries: an unreferenced nested
    helper containing `self.preventDefault()` would otherwise make a
    forwarding handler that never actually calls it read as compliant, and a
    nested helper with an unresolvable call could fail the contract for a
    handler that never invokes it.
    """

    def __init__(self):
        self.calls: List[ast.Call] = []

    def visit_Call(self, node: ast.Call) -> None:
        self.calls.append(node)
        self.generic_visit(node)  # still look inside the call's own args/keywords

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        pass  # do not descend into a nested function's body

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        pass

    def visit_Lambda(self, node: ast.Lambda) -> None:
        pass

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        pass


def _calls_in_own_scope(func: ast.FunctionDef) -> List[ast.Call]:
    """`ast.Call` nodes in `func`'s own execution, excluding nested def/lambda/class bodies."""
    collector = _OwnScopeCalls()
    for stmt in func.body:
        collector.visit(stmt)
    return collector.calls


def _local_helpers(func: ast.FunctionDef) -> Dict[str, ast.FunctionDef]:
    """Map of name -> FunctionDef for helpers defined directly in `func`'s own body.

    A handler that organizes its own logic into a nested `def` and then calls
    it is still running that code as part of its own execution - unlike the
    uncalled-nested-helper case `_OwnScopeCalls` deliberately excludes (see
    TestScopeBoundaries), an *invoked* local helper's `self.preventDefault()`
    or unresolvable call is not optional context, it is on the path the
    handler actually takes. Resolved the same way a same-class `self.<method>()`
    helper is: only reachable via a real call, never by merely being defined.
    """
    return {stmt.name: stmt for stmt in func.body if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef))}


class _Analyzer:
    """Per-file analysis: resolves same-class helper calls transitively and cycle-safely.

    One instance per `IInstance.py` file, built from its `IInstance` class body,
    so `_forwards_own_lane`/`_reaches_prevent_default` can look up a same-class
    helper by name and recurse into it.
    """

    def __init__(self, class_methods: Dict[str, ast.FunctionDef]):
        self._methods = class_methods

    def forwards_own_lane(self, func: ast.FunctionDef, lane: str) -> bool:
        """True when `func` forwards on `lane`, directly or via a same-class or local helper."""
        return self._walks_to(func, lane, self._is_forward_call, set())

    def reaches_prevent_default(self, func: ast.FunctionDef) -> bool:
        """True when `func` calls `self.preventDefault()`, directly or via a same-class or local helper."""
        return self._walks_to(func, None, self._is_prevent_default_call, set())

    def unresolved_calls(self, func: ast.FunctionDef, lane: str) -> List[str]:
        """Calls from `func` (transitively, through same-class and local helpers) that resolve to nothing.

        Only meaningful when `func` forwards on `lane`: an unresolved call from
        a handler that never forwards at all cannot hide a missing
        preventDefault(), so callers should only surface this for handlers
        `forwards_own_lane` already returned True for.
        """
        unresolved: List[str] = []
        self._collect_unresolved(func, lane, unresolved, set())
        return unresolved

    def _resolve_call(self, call: ast.Call, local_helpers: Dict[str, ast.FunctionDef]) -> Optional[ast.FunctionDef]:
        """Resolve `call` to a `FunctionDef` this analyzer can recurse into: a same-class
        `self.<method>()`, or a helper defined directly in the enclosing function and
        actually invoked by name (see `_local_helpers`). Anything else - a module-level
        function, a call through some other object - is not resolvable here.
        """
        helper = _is_self_method_call(call)
        if helper is not None:
            return self._methods.get(helper)
        target = call.func
        if isinstance(target, ast.Name) and target.id in local_helpers:
            return local_helpers[target.id]
        return None

    def _walks_to(self, func: ast.FunctionDef, lane, predicate, visited: Set[int]) -> bool:
        local_helpers = _local_helpers(func)
        for node in _calls_in_own_scope(func):
            if predicate(node, lane):
                return True
            target = self._resolve_call(node, local_helpers)
            if target is None or id(target) in visited:
                continue  # unresolved: not a violation signal by itself, see unresolved_calls
            visited.add(id(target))
            if self._walks_to(target, lane, predicate, visited):
                return True
        return False

    def _collect_unresolved(self, func: ast.FunctionDef, lane: str, out: List[str], visited: Set[int]) -> None:
        local_helpers = _local_helpers(func)
        for node in _calls_in_own_scope(func):
            if self._is_forward_call(node, lane):
                continue  # the expected forward itself - accounted for by forwards_own_lane, not unresolved
            helper = _is_self_method_call(node)
            if helper == 'preventDefault':
                continue  # terminal, not a helper to resolve further; handled by reaches_prevent_default
            target = self._resolve_call(node, local_helpers)
            if target is not None:
                if id(target) in visited:
                    continue
                visited.add(id(target))
                self._collect_unresolved(target, lane, out, visited)
                continue
            if helper is not None:
                out.append(f'self.{helper}(...) [not defined on this class] (line {node.lineno})')
                continue
            target_desc = self._describe_unresolvable(node.func)
            if target_desc is not None:
                out.append(f'{target_desc} (line {node.lineno})')

    @staticmethod
    def _describe_unresolvable(target: ast.expr) -> Optional[str]:
        """Describe a call target worth flagging as unresolved, or None to ignore it.

        Deliberately narrow, on purpose in both directions:

        - `self.instance.<method>(...)` for any `<method>` other than the
          current lane (that one shape is excluded by the caller before
          reaching here) - `self.instance` is the same engine-provided proxy
          every lane forward goes through, so another call on it (a different
          lane, `hasListener(...)`, a hypothetical `stop_forwarding()`) could
          plausibly affect delivery semantics in a way this analyzer does not
          otherwise follow.
        - `super().<method>(...)` - could resolve to a base class override in
          another file this analyzer never reads.

        Deliberately does NOT flag `self.<other_attr>.<method>(...)` in
        general (e.g. `self.documents.extend(...)`, a plain list on ordinary
        instance state): that owns no connection to the forwarding contract,
        and flagging it would bury real findings in noise. If a real node
        ever forwards or suppresses through some other attribute, that shape
        should be added here deliberately, not caught by an overbroad rule.
        """
        if not isinstance(target, ast.Attribute):
            return None
        owner = target.value
        if (
            isinstance(owner, ast.Attribute)
            and owner.attr == 'instance'
            and isinstance(owner.value, ast.Name)
            and owner.value.id == 'self'
        ):
            return f'self.instance.{target.attr}(...)'
        if isinstance(owner, ast.Call):
            inner = owner.func
            if isinstance(inner, ast.Name) and inner.id == 'super':
                return f'super().{target.attr}(...)'
        return None

    @staticmethod
    def _is_forward_call(call: ast.Call, lane: str) -> bool:
        return _is_self_attr_call(call, 'instance', lane)

    @staticmethod
    def _is_prevent_default_call(call: ast.Call, _lane) -> bool:
        target = call.func
        return (
            isinstance(target, ast.Attribute)
            and target.attr == 'preventDefault'
            and isinstance(target.value, ast.Name)
            and target.value.id == 'self'
        )


def _class_methods(tree: ast.Module) -> Dict[str, ast.FunctionDef]:
    """Map method name -> FunctionDef for the file's `IInstance` class (or the first class found)."""
    target_class = None
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == 'IInstance':
            target_class = node
            break
    if target_class is None:
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                target_class = node
                break
    if target_class is None:
        return {}
    return {item.name: item for item in target_class.body if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))}


def scan() -> Tuple[List[Violation], List[Unresolved]]:
    """Scan every `nodes/src/nodes/*/IInstance.py` for the lane-forwarding contract.

    Returns:
        (violations, unresolved) - violations are handlers proven to forward
        without reaching preventDefault(); unresolved are handlers that
        forward and call something outside this analyzer's reach, so whether
        they reach preventDefault() is genuinely unknown rather than assumed.
    """
    violations: List[Violation] = []
    unresolved: List[Unresolved] = []

    for path in sorted(NODES_DIR.glob('*/IInstance.py')):
        tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
        methods = _class_methods(tree)
        analyzer = _Analyzer(methods)

        for name, func in methods.items():
            if name not in LANE_METHODS:
                continue
            if not analyzer.forwards_own_lane(func, name):
                continue

            unresolved_calls = analyzer.unresolved_calls(func, name)
            if unresolved_calls:
                unresolved.append(
                    Unresolved(
                        node=path.parent.name,
                        handler=name,
                        line=func.lineno,
                        reason='; '.join(unresolved_calls),
                    )
                )
                continue

            if not analyzer.reaches_prevent_default(func):
                violations.append(Violation(node=path.parent.name, handler=name, line=func.lineno))

    return violations, unresolved


def _print_report(violations: List[Violation], unresolved: List[Unresolved]) -> None:
    new = sorted(v for v in violations if v.key not in KNOWN_VIOLATIONS)
    known = sorted(v for v in violations if v.key in KNOWN_VIOLATIONS)
    new_unresolved = sorted(u for u in unresolved if u.key not in KNOWN_UNRESOLVED)
    known_unresolved = sorted(u for u in unresolved if u.key in KNOWN_UNRESOLVED)

    if new:
        print('NEW VIOLATIONS (forward on own lane, preventDefault() never reached):')
        for v in new:
            print(f'  {v.node}.{v.handler} (line {v.line})')
        print()

    if known:
        print(f'Known violations ({len(known)}, tracked in KNOWN_VIOLATIONS):')
        for v in known:
            print(f'  {v.node}.{v.handler} (line {v.line})')
        print()

    if new_unresolved:
        print('NEW UNRESOLVED (forwards on own lane; calls something this analyzer cannot follow):')
        for u in new_unresolved:
            print(f'  {u.node}.{u.handler} (line {u.line}): {u.reason}')
        print()

    if known_unresolved:
        print(f'Known unresolved ({len(known_unresolved)}, tracked in KNOWN_UNRESOLVED):')
        for u in known_unresolved:
            print(f'  {u.node}.{u.handler} (line {u.line}): {u.reason}')
        print()

    if not new and not new_unresolved:
        print(
            f'Clean: no new violations, no new unresolved calls ({len(known)} known violation(s), '
            f'{len(known_unresolved)} known unresolved handler(s) still tracked).'
        )


def main() -> int:
    """Run the scan, print the full report, and return a shell-friendly exit code.

    Exit 0: no new violations and no new unresolved calls (known entries may
    still be present - they are tracked, not exempted). Exit 1: a new
    violation, a new unresolved forwarding call, or a stale allowlist entry
    was found.
    """
    violations, unresolved = scan()
    _print_report(violations, unresolved)

    new = [v for v in violations if v.key not in KNOWN_VIOLATIONS]
    stale = sorted(set(KNOWN_VIOLATIONS) - {v.key for v in violations})
    if stale:
        print(f'Stale KNOWN_VIOLATIONS entries (already fixed, remove them): {stale}')

    new_unresolved = [u for u in unresolved if u.key not in KNOWN_UNRESOLVED]
    stale_unresolved = sorted(set(KNOWN_UNRESOLVED) - {u.key for u in unresolved})
    if stale_unresolved:
        print(f'Stale KNOWN_UNRESOLVED entries (now resolved, remove them): {stale_unresolved}')

    return 1 if (new or new_unresolved or stale or stale_unresolved) else 0


def _analyzer_for(source: str) -> _Analyzer:
    """Build an `_Analyzer` from an inline `IInstance` class body, for scope-boundary tests."""
    tree = ast.parse(source)
    return _Analyzer(_class_methods(tree))


# ============================================================================
# Pytest wrapper
# ============================================================================


class TestScopeBoundaries:
    """Regression coverage for the scope-boundary bug flagged on PR #2039/#2043's review:
    `ast.walk` does not respect nested def/lambda/class boundaries, so a call inside an
    uncalled nested helper could previously be mistaken for something the handler itself
    reaches. `_calls_in_own_scope` fixes this by not descending into nested callables.
    """

    def test_uncalled_nested_helper_does_not_hide_a_violation(self):
        """A preventDefault() call buried in a nested, never-invoked helper must not count."""
        analyzer = _analyzer_for(
            """
class IInstance:
    def writeText(self, text):
        def _never_called():
            self.preventDefault()
        self.instance.writeText(text)
"""
        )
        func = analyzer._methods['writeText']
        assert analyzer.forwards_own_lane(func, 'writeText') is True
        assert analyzer.reaches_prevent_default(func) is False

    def test_uncalled_nested_helper_does_not_manufacture_an_unresolved_call(self):
        """An unresolvable call buried in a nested, never-invoked helper must not surface."""
        analyzer = _analyzer_for(
            """
class IInstance:
    def writeTable(self, table):
        def _never_called():
            super().finalize(table)
        self.instance.writeTable(table)
        self.preventDefault()
"""
        )
        func = analyzer._methods['writeTable']
        assert analyzer.forwards_own_lane(func, 'writeTable') is True
        assert analyzer.reaches_prevent_default(func) is True
        assert analyzer.unresolved_calls(func, 'writeTable') == []

    def test_lambda_body_is_also_out_of_scope(self):
        """The same rule applies to a lambda assigned but never invoked."""
        analyzer = _analyzer_for(
            """
class IInstance:
    def writeText(self, text):
        _unused = lambda: self.preventDefault()
        self.instance.writeText(text)
"""
        )
        func = analyzer._methods['writeText']
        assert analyzer.forwards_own_lane(func, 'writeText') is True
        assert analyzer.reaches_prevent_default(func) is False

    def test_invoked_nested_helper_reaching_prevent_default_counts(self):
        """The counterpart to test_uncalled_nested_helper_does_not_hide_a_violation: when the
        nested helper IS actually called, its self.preventDefault() must count - it runs as
        part of the handler's own execution, just organized into a local function.
        """
        analyzer = _analyzer_for(
            """
class IInstance:
    def writeText(self, text):
        def _finish():
            self.preventDefault()
        self.instance.writeText(text)
        _finish()
"""
        )
        func = analyzer._methods['writeText']
        assert analyzer.forwards_own_lane(func, 'writeText') is True
        assert analyzer.reaches_prevent_default(func) is True
        assert analyzer.unresolved_calls(func, 'writeText') == []

    def test_invoked_nested_helper_with_unresolvable_call_surfaces_as_unresolved(self):
        """An invoked local helper's own unresolvable call must still surface - going quiet just
        because it is one level of nesting away would repeat the same silent-assume-clean gap
        #2042 opened against direct calls.
        """
        analyzer = _analyzer_for(
            """
class IInstance:
    def writeTable(self, table):
        def _finish():
            self.instance.hasListener('writeAnswers')
        self.instance.writeTable(table)
        _finish()
"""
        )
        func = analyzer._methods['writeTable']
        assert analyzer.forwards_own_lane(func, 'writeTable') is True
        unresolved = analyzer.unresolved_calls(func, 'writeTable')
        assert len(unresolved) == 1
        assert 'self.instance.hasListener(...)' in unresolved[0]


class TestUnresolvedAttributeChainCalls:
    """Regression coverage for the self-attribute-chain gap flagged on PR #2043's review:
    `_describe_unresolvable` originally recognized only `super().<method>()`, so a call
    like `self.instance.stop_forwarding()` was silently ignored - a forwarding handler
    with that shape read as a definite Violation (or clean) instead of Unresolved.
    """

    def test_self_instance_other_method_call_is_unresolved_not_a_violation(self):
        """`self.instance.<other-method>()` in a forwarding handler must surface as unresolved,
        not get silently ignored and mis-scored as a proven violation.
        """
        analyzer = _analyzer_for(
            """
class IInstance:
    def writeText(self, text):
        self.instance.writeText(text)
        self.instance.hasListener('writeAnswers')
"""
        )
        func = analyzer._methods['writeText']
        assert analyzer.forwards_own_lane(func, 'writeText') is True
        unresolved = analyzer.unresolved_calls(func, 'writeText')
        assert len(unresolved) == 1
        assert 'self.instance.hasListener(...)' in unresolved[0]

    def test_own_lane_forward_is_excluded_from_unresolved(self):
        """The handler's own expected forward call must not double-count as unresolved."""
        analyzer = _analyzer_for(
            """
class IInstance:
    def writeText(self, text):
        self.instance.writeText(text)
        self.preventDefault()
"""
        )
        func = analyzer._methods['writeText']
        assert analyzer.forwards_own_lane(func, 'writeText') is True
        assert analyzer.unresolved_calls(func, 'writeText') == []

    def test_unrelated_self_attribute_call_is_not_flagged(self):
        """A plain `self.<other_attr>.<method>()` unrelated to `self.instance` (e.g. a list on
        ordinary instance state) must not be flagged - only `self.instance.*` and `super().*`
        plausibly affect forwarding semantics.
        """
        analyzer = _analyzer_for(
            """
class IInstance:
    def writeDocuments(self, docs):
        self.documents.extend(docs)
        self.instance.writeDocuments(docs)
        self.preventDefault()
"""
        )
        func = analyzer._methods['writeDocuments']
        assert analyzer.forwards_own_lane(func, 'writeDocuments') is True
        assert analyzer.unresolved_calls(func, 'writeDocuments') == []


def test_nodes_directory_was_actually_scanned():
    """Guard the guard: an empty or moved node tree must not read as a pass."""
    handlers = sum(
        1
        for path in NODES_DIR.glob('*/IInstance.py')
        for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'), filename=str(path)))
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in LANE_METHODS
    )
    assert handlers > 20, (
        f'only {handlers} lane handlers found under {NODES_DIR} - the scan is not reaching the '
        f'nodes, so a clean result here means nothing'
    )


def test_no_unresolved_forwarding_calls():
    """A newly-unresolvable forwarding handler must be triaged by a human, not silently
    assumed to reach preventDefault(). Same ratchet shape as
    test_no_new_lane_forward_violations: entries already tracked in KNOWN_UNRESOLVED
    do not fail here (see test_known_unresolved_are_still_unresolved for their half of
    the ratchet); anything new does.
    """
    _violations, unresolved = scan()
    new_unresolved = sorted(u for u in unresolved if u.key not in KNOWN_UNRESOLVED)

    assert not new_unresolved, (
        'these handlers forward on their own lane via a call this analyzer cannot resolve:\n'
        + '\n'.join(f'  {u.node}.{u.handler} (line {u.line}): {u.reason}' for u in new_unresolved)
        + '\nTriage: verify the unresolved call cannot skip the forward or double-forward, then add '
        '(node, handler) to KNOWN_UNRESOLVED, or extend the analyzer to follow the call if it fits a '
        'general pattern.'
    )


def test_known_unresolved_are_still_unresolved():
    """A handler resolved by extending the analyzer or refactoring the node must be removed
    from KNOWN_UNRESOLVED, so the list only shrinks.
    """
    _violations, unresolved = scan()
    found = {u.key for u in unresolved}
    stale = sorted(set(KNOWN_UNRESOLVED) - found)

    assert not stale, (
        f'{stale} are no longer unresolved - remove them from KNOWN_UNRESOLVED (they now show up as '
        f'either clean or a tracked Violation)'
    )


def test_no_new_lane_forward_violations():
    """A handler that forwards on its own lane must reach preventDefault()."""
    violations, _unresolved = scan()
    new = sorted(v for v in violations if v.key not in KNOWN_VIOLATIONS)

    assert not new, (
        'these handlers forward on their own lane without reaching preventDefault(), so the '
        'engine forwards the same payload a second time and everything downstream sees it twice:\n'
        + '\n'.join(f'  {v.node}.{v.handler} (line {v.line})' for v in new)
        + '\nFix: call self.preventDefault() after the forward (it raises, so it must come after), '
        'or drop the explicit forward and let the engine pass the payload through. Then add '
        '(node, handler) to KNOWN_VIOLATIONS only if you are deliberately deferring the fix.'
    )


def test_known_violations_are_still_violations():
    """A fixed handler must be removed from KNOWN_VIOLATIONS, so the list only shrinks."""
    violations, _unresolved = scan()
    found = {v.key for v in violations}
    stale = sorted(set(KNOWN_VIOLATIONS) - found)

    assert not stale, (
        f'{stale} no longer violate the contract - remove them from KNOWN_VIOLATIONS so the guard keeps protecting them'
    )


if __name__ == '__main__':
    sys.exit(main())
