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
Package-private building blocks shared by the pipe-diff modules.

``engine``, ``gitref`` and ``reporters`` all need the same few rules about what a
``.pipe`` document is: how its JSON text is decoded, what makes its structure
valid, which components it contains once canvas groups are flattened, when two
JSON values are equal, and the one error type they all raise. Keeping them here,
in a module with no sibling imports, gives the package a one-way dependency
graph instead of modules reaching into each other's underscore names::

    model, _pipejson          (no sibling imports)
    engine, gitref, reporters (each imports only the two above)

``engine`` re-exports :class:`PipeDiffError`, so ``rocketride.pipediff`` and
``rocketride.pipediff.engine`` keep handing out the same class.

Nothing here is public API. The leading underscore on the module is the contract;
the names inside are plain because they are shared between package modules, not
because callers outside the package may use them.

Functions:
    parse_pipe_json: Decode pipeline JSON text under the strict numeric policy and
        validate its structure.
    validate_pipe: Check that a decoded value is a well-formed pipeline.
    iter_components: Walk a pipeline's components, descending into canvas groups.
    describe_location: Name a component yielded by ``iter_components`` for an error.
    group_children: Return the children of a canvas group.
    json_equal: Compare two JSON values the way JSON does, not the way Python does.

Exceptions:
    PipeDiffError: Raised for unreadable, unparseable, or structurally invalid
        pipelines, with human-readable context about the offending source.
"""

from __future__ import annotations

import json
import math
from collections.abc import Iterator
from typing import Any

__all__ = [
    'PipeDiffError',
    'describe_location',
    'group_children',
    'iter_components',
    'json_equal',
    'parse_pipe_json',
    'validate_pipe',
]


class PipeDiffError(Exception):
    """
    Raised when a ``.pipe`` file cannot be read, parsed, or validated.

    The message always carries enough context (the source path or ``<dict>`` plus
    the specific problem) for the CLI to print an actionable usage error and exit
    with code ``2``. It is used both by :func:`rocketride.pipediff.engine.load_pipe`
    (file/JSON/shape errors) and by :func:`rocketride.pipediff.gitref.resolve_git_ref`
    (git/parse errors).
    """


# The class lives here so every pipediff module can raise it without importing the
# engine (which imports this module). It is reported under the documented import
# path, ``rocketride.pipediff``, so tracebacks and reprs name something callers can
# import, and pickles resolve it by that name. The cost is that
# ``inspect.getsource(PipeDiffError)`` fails, because ``inspect`` looks the class up
# in the module it claims; a traceback still shows the real file and line.
PipeDiffError.__module__ = 'rocketride.pipediff'


def parse_pipe_json(text: str, source: str) -> dict:
    """Parse file/Git JSON with one numeric policy and source-aware errors.

    JSON integer values retain Python's exact integer representation. Fractional
    and exponent literals use finite binary64 floats, including normal rounding;
    overflow and conversion of a nonzero value to zero are rejected rather than
    silently collapsing distinct input values or emitting invalid JSON later.
    """
    try:
        obj = json.loads(text, parse_float=_parse_finite_float, parse_constant=_reject_json_constant)
    except (ValueError, RecursionError) as exc:
        raise PipeDiffError(f'Invalid JSON in {source}: {exc}') from exc
    return validate_pipe(obj, source)


def _parse_finite_float(literal: str) -> float:
    """Keep supported float rounding while rejecting overflow/zero-underflow."""
    number = float(literal)
    if not math.isfinite(number):
        raise ValueError(f'numeric literal {literal!r} is outside the supported finite float range')
    # Check the coefficient rather than the exponent: 0e-9999 and -0e9999 are
    # legitimate zero values, while a nonzero coefficient that becomes 0.0 has
    # underflowed. No Decimal object or alternate numeric type reaches reporters.
    coefficient = literal.lower().split('e', 1)[0]
    if number == 0.0 and any(digit in '123456789' for digit in coefficient):
        raise ValueError(f'numeric literal {literal!r} underflows the supported finite float range')
    return number


def _reject_json_constant(literal: str) -> None:
    """Reject Python's permissive NaN/Infinity extensions to JSON syntax."""
    raise ValueError(f'non-JSON numeric constant {literal!r}')


def validate_pipe(obj: Any, source: str) -> dict:
    """
    Validate that ``obj`` is a well-formed pipeline object and return it.

    Args:
        obj: The candidate pipeline (any JSON-decoded value).
        source: A label for error messages (a path, or ``"<dict>"``).

    Returns:
        The validated pipeline ``dict`` (``obj`` unchanged).

    Raises:
        PipeDiffError: If ``obj`` is not an object, lacks a ``components`` list,
            contains a component that is not an id-bearing object, reuses a
            component ``id``, or contains a component whose ``input``/``control``
            wiring is malformed.
    """
    if not isinstance(obj, dict):
        raise PipeDiffError(f'{source}: pipe must be a JSON object, got {type(obj).__name__}')
    components = obj.get('components')
    if not isinstance(components, list):
        raise PipeDiffError(f"{source}: pipe is missing a 'components' list")
    # Ids are the diff's matching key: a duplicate would silently hide the earlier
    # node and any change to it, so it is an actionable error. Canvas-group children
    # are nodes too (see :func:`iter_components`), so ids must be unique across every
    # nesting level.
    #
    # Only the ids are remembered, and a component's location is spelled only for the
    # one that fails: a valid pipe pays for no per-component text.
    seen_ids: set[str] = set()
    for component, parent, index in iter_components(obj, include_invalid=True):
        if not isinstance(component, dict):
            raise PipeDiffError(f'{source}: component at {describe_location(parent, index)} is not an object')
        component_id = component.get('id')
        if not isinstance(component_id, str) or not component_id:
            raise PipeDiffError(f"{source}: component at {describe_location(parent, index)} is missing a string 'id'")
        if component_id in seen_ids:
            first = next(
                describe_location(first_parent, first_index)
                for earlier, first_parent, first_index in iter_components(obj)
                if earlier['id'] == component_id
            )
            raise PipeDiffError(
                f"{source}: duplicate component id '{component_id}' at {describe_location(parent, index)}"
                f' (already used at {first})'
            )
        seen_ids.add(component_id)
        _validate_wires(component, component_id, source)
    return obj


def group_children(component: Any) -> list | None:
    """
    Return the children of a canvas group, or ``None`` for any other component.

    The editor saves a group's children inside the group component itself, under
    ``config.pipeline.components`` (``getProjectComponents`` in the canvas
    ``util/graph.ts``), and loads any component carrying such a list back as a
    group (``getNodesFromProject``). Each child keeps its own ``ui`` block with a
    group-relative position and a ``parentId``.
    """
    if not isinstance(component, dict):
        return None
    config = component.get('config')
    pipeline = config.get('pipeline') if isinstance(config, dict) else None
    children = pipeline.get('components') if isinstance(pipeline, dict) else None
    return children if isinstance(children, list) else None


def describe_location(parent: dict | None, index: int) -> str:
    """
    Name a component for an error message.

    Args:
        parent: The canvas group holding the component, or ``None`` at the top
            level (as yielded by :func:`iter_components`).
        index: The component's index in its containing list.

    Returns:
        ``index 0`` at the top level, ``'group_1' config.pipeline.components[0]``
        inside a group.
    """
    if parent is None:
        return f'index {index}'
    return f"'{parent.get('id')}' config.pipeline.components[{index}]"


def iter_components(pipe: dict, *, include_invalid: bool = False) -> Iterator[tuple[Any, dict | None, int]]:
    """
    Walk a pipeline's components, including canvas-group children.

    Group children are diffed as ordinary nodes, matched by ``id`` like every
    other component: their ``ui`` is layout, their ``input``/``control`` wiring
    is edges, and their provider and config are compared on the child.

    The walk is iterative, so arbitrarily nested groups cannot exhaust the
    recursion limit, and lazy, so a caller that needs several facts about each
    component (validity, id, wires) gathers them in one pass. Its working set is
    one list iterator per nesting level being walked, plus one integer per group
    expanded: no location text is built, and nothing is kept once the consumer has
    moved past a component. Spell a location with :func:`describe_location`, and
    only when an error needs it.

    Args:
        pipe: A pipeline dict.
        include_invalid: Also yield entries that are not id-bearing objects, so
            validation can report them; diffing skips them.

    Yields:
        ``(component, parent, index)`` in document order (a group before its
        children), where ``parent`` is the enclosing canvas group (``None`` at the
        top level) and ``index`` the position in the containing list.
    """
    expanded: set[int] = set()
    top_level = pipe.get('components')
    levels: list[tuple[Iterator[tuple[int, Any]], dict | None]] = []
    if isinstance(top_level, list):
        levels.append((enumerate(top_level), None))
    while levels:
        siblings, parent = levels[-1]
        for index, component in siblings:
            if include_invalid or (isinstance(component, dict) and isinstance(component.get('id'), str)):
                yield component, parent, index
            children = group_children(component)
            # An in-memory dict can nest itself; expand each group once so the walk
            # always ends (validation then reports the repeat as a duplicate id).
            if children and id(component) not in expanded:
                expanded.add(id(component))
                levels.append((enumerate(children), component))
                break
        else:
            levels.pop()


# The wire collections a component may declare, mapped to the key that labels the
# lane on each wire: ``input`` wires carry a data ``lane``, ``control`` wires carry
# the orchestration ``classType`` (llm/tool/memory/...).
_WIRE_COLLECTIONS = {'input': 'lane', 'control': 'classType'}


def _validate_wires(component: dict, component_id: str, source: str) -> None:
    """
    Validate a component's ``input``/``control`` wire collections.

    Edge extraction reads ``from`` and ``lane``/``classType`` off every wire into a
    ``set``, so a collection that is not a list, an unhashable ``from``/``lane`` (a
    list or dict), or a wire missing ``from`` must be an actionable exit-2 error
    here and not a traceback or a nonsense edge later.

    Args:
        component: The component object to check.
        component_id: The component's id, used for error context.
        source: A label for error messages (a path, or ``"<dict>"``).

    Raises:
        PipeDiffError: If a wire collection is not a list, a wire is not an
            object, or a wire's ``from``/lane label is not a non-empty string.
    """
    for key, lane_key in _WIRE_COLLECTIONS.items():
        wires = component.get(key)
        if wires is None:
            continue
        if not isinstance(wires, list):
            raise PipeDiffError(f"{source}: component '{component_id}' field '{key}' must be a list")
        for wire_index, wire in enumerate(wires):
            where = f"component '{component_id}' {key}[{wire_index}]"
            if not isinstance(wire, dict):
                raise PipeDiffError(f'{source}: {where} is not an object')
            from_id = wire.get('from')
            if not isinstance(from_id, str) or not from_id:
                raise PipeDiffError(f"{source}: {where} is missing a string 'from'")
            lane = wire.get(lane_key)
            if not isinstance(lane, str) or not lane:
                raise PipeDiffError(f"{source}: {where} is missing a string '{lane_key}'")


def json_equal(old: Any, new: Any) -> bool:
    """
    Compare two JSON values the way JSON does, not the way Python does.

    Python treats ``False == 0`` and ``True == 1`` as equal, so a plain ``!=``
    would miss a ``false`` -> ``0`` edit and report no change. Booleans are
    compared only against booleans; dicts and lists are compared element-wise
    with the same rule; everything else falls back to ``==``.

    Args:
        old: The previous JSON value.
        new: The new JSON value.

    Returns:
        ``True`` when the two values are the same JSON value.
    """
    if isinstance(old, bool) or isinstance(new, bool):
        return isinstance(old, bool) and isinstance(new, bool) and old == new
    if isinstance(old, dict) and isinstance(new, dict):
        return old.keys() == new.keys() and all(json_equal(old[k], new[k]) for k in old)
    if isinstance(old, list) and isinstance(new, list):
        return len(old) == len(new) and all(json_equal(a, b) for a, b in zip(old, new))
    if isinstance(old, (dict, list)) or isinstance(new, (dict, list)):
        return False
    return old == new
