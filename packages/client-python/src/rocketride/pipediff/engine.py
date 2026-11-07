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
The semantic diff engine for RocketRide ``.pipe`` pipeline files.

This module is the pure, network-free core of ``rocketride diff``. It loads and
validates pipeline JSON, then computes the semantic difference between two
pipelines: added/removed/re-provisioned/reconfigured nodes, added/removed edges,
version changes, and a coarse layout-changed flag. Nothing here touches the
RocketRide engine, a server, or the network — it is deliberately restricted to
local file and in-memory JSON work.

Semantic model (see :mod:`rocketride.pipediff.model` for the shapes):
    - **Nodes** are matched by their ``id``. Provider (node-type) changes and
      deep config changes are reported independently.
    - **Config** is deep-diffed into readable dotted paths (``config.a.b[0]``),
      handling nested dictionaries and lists.
    - **Edges** are the set of directed wires reconstructed from every
      component's ``input[]`` (data lanes) and ``control[]`` (agent orchestration
      lanes); added and removed wires are reported as a set difference.
    - **Layout** — each component's ``ui`` block and the top-level ``viewport``
      are ignored by default and summarised by ``layout_changed``. When
      ``include_layout`` is set, ``ui`` differences are additionally enumerated
      as ``ui.*`` field changes on the affected node and the ``viewport``
      difference as ``viewport.*`` changes on the diff itself.
    - **Canvas groups** — the editor nests a group's children under the group's
      ``config.pipeline.components``. Those children are flattened into the node
      set and diffed like any other node, so a drag inside a group is layout and
      a rewire inside a group is an edge change; group membership is the child's
      ``ui.parentId``, which is layout too.

Functions:
    load_pipe: Read and validate a pipe from a path or an already-parsed dict.
    deep_diff_config: Deep-diff two config dicts into a list of ``FieldChange``.
    diff_pipes: Compute the full ``PipeDiff`` between two pipeline dicts.

Exceptions:
    PipeDiffError: Raised for unreadable, unparseable, or structurally invalid
        pipelines, with human-readable context about the offending source.
        Re-exported here from :mod:`rocketride.pipediff._pipejson`, where the
        parsing and validation rules shared with ``gitref`` live.
"""

from __future__ import annotations

import math
import os
import sys
from collections.abc import Iterable, Iterator
from typing import Any, NamedTuple

from ._pipejson import PipeDiffError, group_children, iter_components, json_equal, parse_pipe_json, validate_pipe
from .model import EdgeChange, FieldChange, NodeChange, PipeDiff

# The entry points and the error they raise; the other names imported from the
# shared private module are not engine API.
__all__ = ['PipeDiffError', 'deep_diff_config', 'diff_pipes', 'load_pipe']

# Message for a comparison that exhausts the interpreter's recursion limit.
_TOO_DEEP = 'Pipeline nesting is too deep to compare'

# Messages for a value that exists on one side only: it is never compared, but the
# diff carries it into every report (see :func:`_require_reportable`).
_CYCLIC_VALUE = 'Pipeline contains a value that refers to itself, which cannot be reported'
_TOO_DEEP_TO_REPORT = 'Pipeline contains a value nested too deeply to report'


def load_pipe(path_or_obj: str | os.PathLike[str] | dict) -> dict:
    """
    Load and validate a pipeline definition from a path or a parsed object.

    Accepts either a filesystem path (``str`` or ``os.PathLike``) pointing at a
    ``.pipe`` JSON file, or an already-parsed ``dict`` (for example, the object
    returned by resolving a git ref). In both cases the result is validated to be
    a JSON object containing a ``components`` list of id-bearing objects.

    Args:
        path_or_obj: A path to a ``.pipe`` file, or a parsed pipeline ``dict``.

    Returns:
        The validated pipeline as a ``dict`` (the same object when a dict is
        passed in; a freshly parsed object when a path is passed in).

    Raises:
        PipeDiffError: If the file cannot be read, is not valid UTF-8, the JSON
            cannot be parsed, the top level is not an object, ``components`` is
            missing or not a list, any component is not an object with a
            non-empty string ``id``, or any component's ``input``/``control``
            wiring is not a list of well-formed wire objects.
    """
    if isinstance(path_or_obj, dict):
        # An in-memory dict never went through the JSON decoder's numeric
        # callbacks, so it alone needs the finite-number walk.
        _validate_finite_numbers(path_or_obj, '<dict>')
        return validate_pipe(path_or_obj, '<dict>')

    if isinstance(path_or_obj, (str, os.PathLike)):
        source = os.fspath(path_or_obj)
        try:
            with open(source, encoding='utf-8') as handle:
                text = handle.read()
        except FileNotFoundError as exc:
            raise PipeDiffError(f'Pipe file not found: {source}') from exc
        except UnicodeDecodeError as exc:
            raise PipeDiffError(f'{source} is not valid UTF-8: {exc}') from exc
        except OSError as exc:
            raise PipeDiffError(f'Could not read pipe file {source}: {exc}') from exc
        return parse_pipe_json(text, source)

    raise PipeDiffError(f'load_pipe expects a path or dict, got {type(path_or_obj).__name__}')


def _validate_finite_numbers(obj: Any, source: str) -> None:
    """Reject nonfinite floats in an in-memory pipe without recursive walks.

    ``load_pipe`` also accepts in-memory objects, bypassing the JSON decoder's
    numeric callbacks. Traverse all fields, including layout/ignored metadata,
    so such callers cannot introduce non-JSON numbers into a later report. A
    seen set also keeps shared or cyclic in-memory containers from looping.

    Each pending value carries only a link to its parent's breadcrumb, and the
    readable path is built for the one value that fails, so memory stays
    proportional to the size of the input.
    """
    pending: list[tuple[Any, Any]] = [(obj, None)]
    seen = set()
    while pending:
        value, crumb = pending.pop()
        if isinstance(value, float) and not math.isfinite(value):
            raise PipeDiffError(f'{source}: non-finite number at {_crumb_path(crumb)}')
        if isinstance(value, (dict, list)):
            identity = id(value)
            if identity in seen:
                continue
            seen.add(identity)
            if isinstance(value, dict):
                pending.extend((child, (crumb, f'.{key}')) for key, child in value.items())
            else:
                pending.extend((child, (crumb, index)) for index, child in enumerate(value))


def _crumb_path(crumb: Any) -> str:
    """Spell a breadcrumb chain from :func:`_validate_finite_numbers` as ``$.a[0].b``."""
    parts = []
    while crumb is not None:
        crumb, step = crumb
        parts.append(f'[{step}]' if isinstance(step, int) else step)
    return '$' + ''.join(reversed(parts))


def _node_config(component: dict) -> Any:
    """
    Return the config that belongs to the node itself.

    For a canvas group that excludes ``config.pipeline.components``: the children
    are diffed as nodes in their own right, so leaving them in the group's config
    would report every child edit a second time, as a positional change of the
    group. Any other key under ``config.pipeline`` is kept and diffed.
    """
    config = component.get('config')
    if group_children(component) is None:
        return config
    pipeline = {key: value for key, value in config['pipeline'].items() if key != 'components'}
    own = {key: value for key, value in config.items() if key != 'pipeline'}
    if pipeline:
        own['pipeline'] = pipeline
    return own


def deep_diff_config(old: dict | None, new: dict | None) -> list[FieldChange]:
    """
    Deep-diff two component config dictionaries into dotted-path field changes.

    Recursively compares nested dictionaries and lists, producing one
    :class:`FieldChange` per differing leaf. Dict keys extend the path with
    ``.key``; list elements extend it with ``[index]``. List differences are
    reported index-by-index, with trailing extra elements reported as added or
    removed. Every path is prefixed with ``config`` so it reads as a fully
    qualified path (for example ``config.instructions[0]`` or
    ``config.default.strlen``).

    Args:
        old: The previous config dict (``None`` is treated as an empty dict).
        new: The new config dict (``None`` is treated as an empty dict).

    Returns:
        The list of field changes, ordered deterministically by key/index. Empty
        when the two configs are equal.

    Raises:
        PipeDiffError: If the configs nest too deeply to compare, or a value that
            appears in only one of them (and so is reported whole) is cyclic or
            nested too deeply to serialise; this includes cyclic in-memory configs.
    """
    try:
        changes = _diff_config(old, new)
    except RecursionError as exc:
        raise PipeDiffError(_TOO_DEEP) from exc
    _require_reportable(_changed_values(changes))
    return changes


def _diff_config(old: dict | None, new: dict | None) -> list[FieldChange]:
    """Deep-diff two configs (``None`` is an empty dict) without checking the values it stores."""
    return _diff_value(old if old is not None else {}, new if new is not None else {}, 'config')


def diff_pipes(old: dict, new: dict, *, include_layout: bool = False) -> PipeDiff:
    """
    Compute the semantic difference between two pipeline dictionaries.

    Nodes are matched by ``id``, including canvas-group children nested under a
    group's ``config.pipeline.components`` (see :func:`iter_components`). For each
    matched node the provider and config are compared independently; unmatched
    nodes become added/removed changes.
    Edges are compared as a set of directed ``(from, lane, to)`` triples drawn
    from every component's ``input[]`` and ``control[]`` wiring. The top-level
    ``version`` change is always reported. Canvas layout (each ``ui`` block and
    the ``viewport``) is summarised by ``layout_changed`` and, when
    ``include_layout`` is set, enumerated as ``ui.*`` field changes per node plus
    ``viewport.*`` changes on the diff itself.

    Exactly three top-level keys are read -- ``components``, ``version``, and
    ``viewport``. Every other top-level key a ``.pipe`` carries (``project_id``,
    ``isLocked``, and anything a later schema adds) is ignored, because it is
    editor/session metadata rather than pipeline behaviour.

    Args:
        old: The previous pipeline (already loaded/validated via ``load_pipe``).
        new: The new pipeline (already loaded/validated via ``load_pipe``).
        include_layout: When ``True``, fold each node's ``ui`` differences into
            its field changes (paths prefixed ``ui``) and enumerate the top-level
            ``viewport`` difference into ``PipeDiff.viewport_changes`` (paths
            prefixed ``viewport``), so canvas churn is opted back into the
            reported changes and counts as semantic. The ``layout_changed`` flag
            is computed either way.

    Returns:
        A :class:`PipeDiff` describing every node, edge, version, and layout
        difference between ``old`` and ``new``.

    Raises:
        PipeDiffError: If the pipelines nest too deeply to compare, including a
            cyclic in-memory config that :func:`load_pipe` accepted, or if a value
            that appears on one side only (and so is reported whole) is cyclic or
            nested too deeply to serialise.
    """
    # The comparison recurses through nested config, so very deep or cyclic
    # in-memory values exhaust the interpreter's recursion limit. Report that as
    # the library's own error instead of a raw RecursionError.
    try:
        return _diff_pipes(old, new, include_layout)
    except RecursionError as exc:
        raise PipeDiffError(_TOO_DEEP) from exc


def _diff_pipes(old: dict, new: dict, include_layout: bool) -> PipeDiff:
    """Compute the diff for :func:`diff_pipes`, which converts recursion failures."""
    # One walk per pipeline yields everything the comparison needs about its
    # components. The index lives only for this call; nothing is attached to the
    # caller's dicts.
    old_index = _index_pipe(old)
    new_index = _index_pipe(new)
    old_components = old_index.components
    new_components = new_index.components
    old_ids = set(old_components)
    new_ids = set(new_components)

    node_changes: list[NodeChange] = []

    for component_id in sorted(new_ids - old_ids):
        node_changes.append(
            NodeChange(
                id=component_id,
                kind='added',
                provider_new=new_components[component_id].get('provider'),
            )
        )
    for component_id in sorted(old_ids - new_ids):
        node_changes.append(
            NodeChange(
                id=component_id,
                kind='removed',
                provider_old=old_components[component_id].get('provider'),
            )
        )
    for component_id in sorted(old_ids & new_ids):
        old_component = old_components[component_id]
        new_component = new_components[component_id]

        provider_old = old_component.get('provider')
        provider_new = new_component.get('provider')
        # JSON equality, as for ``version`` below: ``0 == False`` in Python.
        if not json_equal(provider_old, provider_new):
            node_changes.append(
                NodeChange(
                    id=component_id,
                    kind='provider',
                    provider_old=provider_old,
                    provider_new=provider_new,
                )
            )

        field_changes = _diff_config(_node_config(old_component), _node_config(new_component))
        if include_layout:
            field_changes = field_changes + _diff_value(
                _layout_block(old_component.get('ui')), _layout_block(new_component.get('ui')), 'ui'
            )
        if field_changes:
            node_changes.append(NodeChange(id=component_id, kind='config', field_changes=field_changes))

    old_edges = old_index.edges
    new_edges = new_index.edges
    edge_changes: list[EdgeChange] = []
    for edge in sorted(new_edges - old_edges, key=_edge_sort_key):
        edge_changes.append(EdgeChange(from_id=edge[0], lane=edge[1], to_id=edge[2], kind='added'))
    for edge in sorted(old_edges - new_edges, key=_edge_sort_key):
        edge_changes.append(EdgeChange(from_id=edge[0], lane=edge[1], to_id=edge[2], kind='removed'))

    version_change: tuple[Any, Any] | None = None
    old_version = old.get('version')
    new_version = new.get('version')
    # Compared with :func:`json_equal`, not ``!=``: Python treats ``False == 0``
    # and ``True == 1``.
    if not json_equal(old_version, new_version):
        version_change = (old_version, new_version)

    layout_changed = _layout_changed(old, new, old_components, new_components, old_ids & new_ids)

    # The top-level viewport is layout, so it is enumerated only when the caller
    # opts layout in; a viewport-only edit then reports concrete `viewport.*`
    # paths and counts as a change.
    viewport_changes: list[FieldChange] = []
    if include_layout:
        viewport_changes = _diff_value(
            _layout_block(old.get('viewport')), _layout_block(new.get('viewport')), 'viewport'
        )

    # A value present on one side only is stored whole, not compared, so nothing
    # above has walked it. Make sure what the diff hands back can be serialised.
    _require_reportable(_reported_values(node_changes, version_change, viewport_changes))

    return PipeDiff(
        node_changes=node_changes,
        edge_changes=edge_changes,
        version_change=version_change,
        layout_changed=layout_changed,
        viewport_changes=viewport_changes,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


class _PipeIndex(NamedTuple):
    """What a comparison needs to know about one pipeline's components."""

    components: dict[str, dict]
    edges: set[tuple[Any, Any, Any]]


def _index_pipe(pipe: dict) -> _PipeIndex:
    """
    Index a pipeline's components by ``id`` and reconstruct its directed wires in one walk.

    Canvas-group children are included (see :func:`iter_components`). Non-object
    components and components without an ``id`` are skipped defensively
    (``load_pipe`` normally rejects those upstream, and also rejects duplicate ids
    so that no component can be shadowed here).

    Each component's ``input[]`` entries become data edges
    ``(input.from, input.lane, component.id)`` and its ``control[]`` entries
    become orchestration edges ``(control.from, control.classType, component.id)``.
    Control edges are included because agent workflows express their
    agent-to-llm/tool/memory wiring exclusively through ``control[]``; ignoring
    them would make the diff blind to agent reconfiguration. Canvas-group
    children are wired the same way and are included.

    Args:
        pipe: A pipeline dict.

    Returns:
        The components keyed by id, and the set of ``(from, lane, to)`` triples.
    """
    components: dict[str, dict] = {}
    edges: set[tuple[Any, Any, Any]] = set()
    for component, _parent, _index in iter_components(pipe):
        to_id = component['id']
        components[to_id] = component
        for wire in component.get('input') or []:
            if isinstance(wire, dict):
                edges.add((wire.get('from'), wire.get('lane'), to_id))
        for wire in component.get('control') or []:
            if isinstance(wire, dict):
                edges.add((wire.get('from'), wire.get('classType'), to_id))
    return _PipeIndex(components, edges)


def _changed_values(changes: Iterable[FieldChange]) -> Iterator[Any]:
    """Yield the values a list of field changes stores."""
    for change in changes:
        yield change.old
        yield change.new


def _reported_values(
    node_changes: Iterable[NodeChange],
    version_change: tuple[Any, Any] | None,
    viewport_changes: Iterable[FieldChange],
) -> Iterator[Any]:
    """Yield every value a diff stores whole: providers, field-change sides and the version."""
    for node_change in node_changes:
        yield node_change.provider_old
        yield node_change.provider_new
        yield from _changed_values(node_change.field_changes)
    if version_change is not None:
        yield from version_change
    yield from _changed_values(viewport_changes)


def _require_reportable(values: Iterable[Any]) -> None:
    """
    Raise :class:`PipeDiffError` if any value is cyclic or nested too deeply to serialise.

    The comparison recurses only where both sides have a value, so a container that
    exists on one side only is stored in the diff as it is. If it contains itself, or
    nests past the recursion limit, every report built from the diff would fail
    (``ValueError: Circular reference detected`` or ``RecursionError``). Only a cycle
    can arrive through the CLI's JSON input; the depth bound exists for in-memory
    callers. Only values the diff stores are walked, so the cost follows the
    report's size.

    The walk is iterative with an explicit stack, so it cannot hit the limit it
    guards. A container met again while it is still being walked is a cycle. One met
    again after it was finished is merely shared: it is not walked again (a
    diamond-shaped value costs one walk, not one per path), but the height recorded
    when it finished is added to where it is met now.

    The depth bound is the recursion limit, which is what the pure-Python encoder
    behind the CLI's indented JSON output can serialise (about one frame per level).
    No pipeline nests anywhere near it.

    Args:
        values: The values to check; scalars are accepted and skipped.

    Raises:
        PipeDiffError: If a value contains itself or nests deeper than the bound.
    """
    max_depth = sys.getrecursionlimit()
    for root in values:
        if not isinstance(root, (dict, list)):
            continue
        walking = {id(root)}
        heights: dict[int, int] = {}  # finished containers: levels of nesting they hold
        stack = [[root, iter(root.values() if isinstance(root, dict) else root), 1]]
        while stack:
            frame = stack[-1]
            for child in frame[1]:
                if not isinstance(child, (dict, list)):
                    continue
                identity = id(child)
                if identity in walking:
                    raise PipeDiffError(_CYCLIC_VALUE)
                height = heights.get(identity)
                if height is not None:
                    if len(stack) + height > max_depth:
                        raise PipeDiffError(_TOO_DEEP_TO_REPORT)
                    frame[2] = max(frame[2], height + 1)
                    continue
                if len(stack) >= max_depth:
                    raise PipeDiffError(_TOO_DEEP_TO_REPORT)
                walking.add(identity)
                stack.append([child, iter(child.values() if isinstance(child, dict) else child), 1])
                break
            else:
                stack.pop()
                walking.discard(id(frame[0]))
                heights[id(frame[0])] = frame[2]
                if stack:
                    stack[-1][2] = max(stack[-1][2], frame[2] + 1)


def _edge_sort_key(edge: tuple[Any, Any, Any]) -> tuple[str, str, str]:
    """
    Provide a total, deterministic ordering for edge triples.

    Coerces each element to ``str`` so triples containing ``None`` (malformed
    wires missing a ``from``/``lane``) still sort without raising.

    Args:
        edge: A ``(from, lane, to)`` triple.

    Returns:
        A ``(str, str, str)`` sort key.
    """
    return (str(edge[0]), str(edge[1]), str(edge[2]))


def _layout_block(value: Any) -> Any:
    """
    Normalize a ``viewport``/``ui`` block for comparison, mapping only ``None``.

    An omitted or explicitly-null layout block is the same canvas as an empty
    object, so both compare equal to ``{}``. Every other value is returned
    untouched: ``false``, ``0`` and ``""`` are values :func:`load_pipe` accepts,
    and each differs from ``{}``.

    A scalar ``viewport``/``ui`` is not rejected by validation: :func:`_diff_value`
    falls back to an equality comparison and reports it as a single
    ``viewport``/``ui`` change.

    Args:
        value: The raw ``viewport``/``ui`` value, or ``None`` when absent or null.

    Returns:
        ``{}`` when ``value`` is ``None``, otherwise ``value`` unchanged.
    """
    return {} if value is None else value


def _layout_changed(
    old: dict,
    new: dict,
    old_components: dict[str, dict],
    new_components: dict[str, dict],
    common_ids: set[str],
) -> bool:
    """
    Determine whether any pure-layout data differs between two pipelines.

    Layout is the top-level ``viewport`` plus each retained component's ``ui``
    block. Added/removed nodes are excluded: their appearance/disappearance is
    already a semantic change, so counting their ``ui`` here would be redundant
    noise. This flag is a coarse hint and never gates the exit code by itself.

    Args:
        old: The previous pipeline dict.
        new: The new pipeline dict.
        old_components: The old components indexed by id.
        new_components: The new components indexed by id.
        common_ids: Ids present in both pipelines.

    Returns:
        ``True`` if the viewport or any retained node's ui block differs.
    """
    # Normalize exactly as the layout field diffs do (:func:`_layout_block`): an
    # omitted or null ``viewport``/``ui`` is the same canvas as an empty object.
    if not json_equal(_layout_block(old.get('viewport')), _layout_block(new.get('viewport'))):
        return True
    for component_id in common_ids:
        if not json_equal(
            _layout_block(old_components[component_id].get('ui')),
            _layout_block(new_components[component_id].get('ui')),
        ):
            return True
    return False


def _diff_value(old: Any, new: Any, path: str) -> list[FieldChange]:
    """
    Recursively diff two arbitrary JSON values at ``path``.

    Dispatches on type: two dicts are diffed key-wise, two lists index-wise, and
    anything else is compared for equality. This is the shared engine behind both
    the config diff and (when layout is opted in) the ui diff.

    Args:
        old: The previous value.
        new: The new value.
        path: The dotted path accumulated so far for this position.

    Returns:
        The field changes at or beneath ``path``. Empty when equal.
    """
    if isinstance(old, dict) and isinstance(new, dict):
        return _diff_mapping(old, new, path)
    if isinstance(old, list) and isinstance(new, list):
        return _diff_sequence(old, new, path)
    if not json_equal(old, new):
        return [FieldChange(path=path, kind='changed', old=old, new=new)]
    return []


def _diff_mapping(old: dict, new: dict, prefix: str) -> list[FieldChange]:
    """
    Diff two dictionaries, extending ``prefix`` with ``.key`` per entry.

    Keys are visited in sorted order so output is deterministic regardless of the
    input insertion order.

    Args:
        old: The previous dict.
        new: The new dict.
        prefix: The dotted path of the dict itself.

    Returns:
        The field changes for every added, removed, or changed key.
    """
    changes: list[FieldChange] = []
    for key in sorted(set(old) | set(new), key=str):
        child_path = f'{prefix}.{key}'
        in_old = key in old
        in_new = key in new
        if in_old and not in_new:
            changes.append(FieldChange(path=child_path, kind='removed', old=old[key], new=None))
        elif in_new and not in_old:
            changes.append(FieldChange(path=child_path, kind='added', old=None, new=new[key]))
        else:
            changes.extend(_diff_value(old[key], new[key], child_path))
    return changes


def _diff_sequence(old: list, new: list, prefix: str) -> list[FieldChange]:
    """
    Diff two lists positionally, extending ``prefix`` with ``[index]``.

    Elements at shared indices are diffed recursively (so nested dict/list
    elements produce fine-grained paths). Trailing elements present on only one
    side are reported as added or removed at their index.

    Args:
        old: The previous list.
        new: The new list.
        prefix: The dotted path of the list itself.

    Returns:
        The field changes across all indices.
    """
    changes: list[FieldChange] = []
    shared = min(len(old), len(new))
    for index in range(shared):
        changes.extend(_diff_value(old[index], new[index], f'{prefix}[{index}]'))
    for index in range(shared, len(new)):
        changes.append(FieldChange(path=f'{prefix}[{index}]', kind='added', old=None, new=new[index]))
    for index in range(shared, len(old)):
        changes.append(FieldChange(path=f'{prefix}[{index}]', kind='removed', old=old[index], new=None))
    return changes
