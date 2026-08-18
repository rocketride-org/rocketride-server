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
that forwards and then calls a same-class helper is checked by walking into
that helper too (`_forwards_own_lane` / `_reaches_prevent_default` in
`_Analyzer`), so the `_forward_answer()`-style helper pattern from #1849 does
not read as clean just because the forward and the `preventDefault()` call
live in different methods.

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
        ('search_exa', 'writeQuestions'),  # #2041
        # These two call preventDefault() in *other* handlers, so a file-level
        # search calls them clean. The offending handler does not.
        ('llamaparse', 'writeTable'),  # #2041
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


class _Analyzer:
    """Per-file analysis: resolves same-class helper calls transitively and cycle-safely.

    One instance per `IInstance.py` file, built from its `IInstance` class body,
    so `_forwards_own_lane`/`_reaches_prevent_default` can look up a same-class
    helper by name and recurse into it.
    """

    def __init__(self, class_methods: Dict[str, ast.FunctionDef]):
        self._methods = class_methods

    def forwards_own_lane(self, func: ast.FunctionDef, lane: str) -> bool:
        """True when `func` forwards on `lane`, directly or via a same-class helper."""
        return self._walks_to(func, lane, self._is_forward_call, set())

    def reaches_prevent_default(self, func: ast.FunctionDef) -> bool:
        """True when `func` calls `self.preventDefault()`, directly or via a same-class helper."""
        return self._walks_to(func, None, self._is_prevent_default_call, set())

    def unresolved_calls(self, func: ast.FunctionDef, lane: str) -> List[str]:
        """Same-class `self.<method>()` calls from `func` (transitively) that resolve to nothing.

        Only meaningful when `func` forwards on `lane`: an unresolved call from
        a handler that never forwards at all cannot hide a missing
        preventDefault(), so callers should only surface this for handlers
        `forwards_own_lane` already returned True for.
        """
        unresolved: List[str] = []
        self._collect_unresolved(func, unresolved, set())
        return unresolved

    def _walks_to(self, func: ast.FunctionDef, lane, predicate, visited: Set[str]) -> bool:
        for node in ast.walk(func):
            if not isinstance(node, ast.Call):
                continue
            if predicate(node, lane):
                return True
            helper = _is_self_method_call(node)
            if helper is None or helper in visited:
                continue
            target = self._methods.get(helper)
            if target is None:
                continue  # unresolved: not a violation signal by itself, see unresolved_calls
            visited.add(helper)
            if self._walks_to(target, lane, predicate, visited):
                return True
        return False

    def _collect_unresolved(self, func: ast.FunctionDef, out: List[str], visited: Set[str]) -> None:
        for node in ast.walk(func):
            if not isinstance(node, ast.Call):
                continue
            helper = _is_self_method_call(node)
            if helper is None:
                target_desc = self._describe_unresolvable(node.func)
                if target_desc is not None:
                    out.append(f'{target_desc} (line {node.lineno})')
                continue
            if helper == 'preventDefault':
                continue  # terminal, not a helper to resolve further; handled by reaches_prevent_default
            if helper in visited:
                continue
            target = self._methods.get(helper)
            if target is None:
                out.append(f'self.{helper}(...) [not defined on this class] (line {node.lineno})')
                continue
            visited.add(helper)
            self._collect_unresolved(target, out, visited)

    @staticmethod
    def _describe_unresolvable(target: ast.expr) -> Optional[str]:
        """Describe a call target worth flagging as unresolved, or None to ignore it.

        Deliberately narrow: only attribute calls through something other than
        `self` (e.g. `self.instance.foo()`, `super().foo()`) are candidates -
        these are exactly the shapes that could plausibly forward or call
        preventDefault() through a path this analyzer does not follow. Bare
        function calls, builtins, and calls on unrelated locals are noise and
        are not reported.
        """
        if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Call):
            inner = target.value.func
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

    if unresolved:
        print('UNRESOLVED (forwards on own lane; calls something this analyzer cannot follow):')
        for u in unresolved:
            print(f'  {u.node}.{u.handler} (line {u.line}): {u.reason}')
        print()

    if not new and not unresolved:
        print(f'Clean: no new violations, no unresolved calls ({len(known)} known violation(s) still tracked).')


def main() -> int:
    """Run the scan, print the full report, and return a shell-friendly exit code.

    Exit 0: no new violations and nothing unresolved (known violations may
    still be present - they are tracked, not exempted). Exit 1: a new
    violation or an unresolved forwarding call was found.
    """
    violations, unresolved = scan()
    _print_report(violations, unresolved)

    new = [v for v in violations if v.key not in KNOWN_VIOLATIONS]
    stale = sorted(set(KNOWN_VIOLATIONS) - {v.key for v in violations})
    if stale:
        print(f'Stale KNOWN_VIOLATIONS entries (already fixed, remove them): {stale}')

    return 1 if (new or unresolved or stale) else 0


# ============================================================================
# Pytest wrapper
# ============================================================================


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
    """A handler that forwards on its own lane must be fully resolvable.

    An unresolved call (through something other than a same-class `self.<method>()`)
    from a forwarding handler must be triaged by a human, not silently assumed
    to reach preventDefault(). If this fires on a real base-class/helper
    pattern, extend the analyzer to follow it rather than suppressing the
    finding.
    """
    _violations, unresolved = scan()
    assert not unresolved, (
        'these handlers forward on their own lane via a call this analyzer cannot resolve:\n'
        + '\n'.join(f'  {u.node}.{u.handler} (line {u.line}): {u.reason}' for u in unresolved)
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
