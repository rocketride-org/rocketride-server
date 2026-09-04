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

Functions:
    load_pipe: Read and validate a pipe from a path or an already-parsed dict.
    deep_diff_config: Deep-diff two config dicts into a list of ``FieldChange``.
    diff_pipes: Compute the full ``PipeDiff`` between two pipeline dicts.

Exceptions:
    PipeDiffError: Raised for unreadable, unparseable, or structurally invalid
        pipelines, with human-readable context about the offending source.
"""

from __future__ import annotations

import json
import os
from typing import Any

from .model import EdgeChange, FieldChange, NodeChange, PipeDiff


class PipeDiffError(Exception):
    """
    Raised when a ``.pipe`` file cannot be read, parsed, or validated.

    The message always carries enough context (the source path or ``<dict>`` plus
    the specific problem) for the CLI to print an actionable usage error and exit
    with code ``2``. It is used both by :func:`load_pipe` (file/JSON/shape errors)
    and by :func:`rocketride.pipediff.gitref.resolve_git_ref` (git/parse errors).
    """


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
        return _validate_pipe(path_or_obj, '<dict>')

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
        try:
            obj = json.loads(text)
        except json.JSONDecodeError as exc:
            raise PipeDiffError(f'Invalid JSON in {source}: {exc}') from exc
        return _validate_pipe(obj, source)

    raise PipeDiffError(f'load_pipe expects a path or dict, got {type(path_or_obj).__name__}')


def _validate_pipe(obj: Any, source: str) -> dict:
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
    # Ids are the diff's matching key, so a duplicate is not a harmless quirk:
    # indexing by id keeps only the last component with that id, which would
    # silently hide the earlier node and any change to it. Reject it as an
    # actionable exit-2 error instead of emitting a diff that is quietly wrong.
    seen_ids: dict[str, int] = {}
    for index, component in enumerate(components):
        if not isinstance(component, dict):
            raise PipeDiffError(f'{source}: component at index {index} is not an object')
        component_id = component.get('id')
        if not isinstance(component_id, str) or not component_id:
            raise PipeDiffError(f"{source}: component at index {index} is missing a string 'id'")
        first_index = seen_ids.get(component_id)
        if first_index is not None:
            raise PipeDiffError(
                f"{source}: duplicate component id '{component_id}' at index {index} "
                f'(already used at index {first_index})'
            )
        seen_ids[component_id] = index
        _validate_wires(component, component_id, source)
    return obj


# The wire collections a component may declare, mapped to the key that labels the
# lane on each wire: ``input`` wires carry a data ``lane``, ``control`` wires carry
# the orchestration ``classType`` (llm/tool/memory/...).
_WIRE_COLLECTIONS = {'input': 'lane', 'control': 'classType'}


def _validate_wires(component: dict, component_id: str, source: str) -> None:
    """
    Validate a component's ``input``/``control`` wire collections.

    Edge extraction reads ``from`` and ``lane``/``classType`` off every wire and
    puts the resulting triples into a ``set``. Without this check a non-list
    collection raises ``TypeError``, an unhashable ``from``/``lane`` (a list or
    dict) raises ``TypeError`` inside ``set.add``, and a wire missing ``from``
    silently produces a ``(None, None, id)`` edge — all of which surface as a
    traceback or a nonsense diff instead of an actionable exit-2 error.

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
    """
    return _diff_value(old if old is not None else {}, new if new is not None else {}, 'config')


def diff_pipes(old: dict, new: dict, *, include_layout: bool = False) -> PipeDiff:
    """
    Compute the semantic difference between two pipeline dictionaries.

    Nodes are matched by ``id``. For each matched node the provider and config
    are compared independently; unmatched nodes become added/removed changes.
    Edges are compared as a set of directed ``(from, lane, to)`` triples drawn
    from every component's ``input[]`` and ``control[]`` wiring. The top-level
    ``version`` change is always reported. Canvas layout (each ``ui`` block and
    the ``viewport``) is summarised by ``layout_changed`` and, when
    ``include_layout`` is set, enumerated as ``ui.*`` field changes per node plus
    ``viewport.*`` changes on the diff itself.

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
    """
    old_components = _components_by_id(old)
    new_components = _components_by_id(new)
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
        if provider_old != provider_new:
            node_changes.append(
                NodeChange(
                    id=component_id,
                    kind='provider',
                    provider_old=provider_old,
                    provider_new=provider_new,
                )
            )

        field_changes = deep_diff_config(old_component.get('config'), new_component.get('config'))
        if include_layout:
            field_changes = field_changes + _diff_value(
                _layout_block(old_component.get('ui')), _layout_block(new_component.get('ui')), 'ui'
            )
        if field_changes:
            node_changes.append(NodeChange(id=component_id, kind='config', field_changes=field_changes))

    old_edges = _extract_edges(old)
    new_edges = _extract_edges(new)
    edge_changes: list[EdgeChange] = []
    for edge in sorted(new_edges - old_edges, key=_edge_sort_key):
        edge_changes.append(EdgeChange(from_id=edge[0], lane=edge[1], to_id=edge[2], kind='added'))
    for edge in sorted(old_edges - new_edges, key=_edge_sort_key):
        edge_changes.append(EdgeChange(from_id=edge[0], lane=edge[1], to_id=edge[2], kind='removed'))

    version_change: tuple[Any, Any] | None = None
    old_version = old.get('version')
    new_version = new.get('version')
    if old_version != new_version:
        version_change = (old_version, new_version)

    layout_changed = _layout_changed(old, new, old_components, new_components, old_ids & new_ids)

    # The top-level viewport is layout, so it is enumerated only when the caller
    # opts layout in. Doing so is what makes `--include-layout` match its
    # documented contract: a viewport-only edit then reports concrete
    # `viewport.*` paths and counts as a change (exit 1) instead of exiting 0
    # with nothing to show.
    viewport_changes: list[FieldChange] = []
    if include_layout:
        viewport_changes = _diff_value(
            _layout_block(old.get('viewport')), _layout_block(new.get('viewport')), 'viewport'
        )

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


def _components_by_id(pipe: dict) -> dict[str, dict]:
    """
    Index a pipeline's components by their ``id``.

    Non-object components and components without an ``id`` are skipped defensively
    (``load_pipe`` normally rejects those upstream, and also rejects duplicate ids
    so that no component can be shadowed here).

    Args:
        pipe: A pipeline dict.

    Returns:
        A mapping of component id to the component object.
    """
    indexed: dict[str, dict] = {}
    for component in pipe.get('components', []) or []:
        if isinstance(component, dict) and isinstance(component.get('id'), str):
            indexed[component['id']] = component
    return indexed


def _extract_edges(pipe: dict) -> set[tuple[Any, Any, Any]]:
    """
    Reconstruct the set of directed wires in a pipeline.

    Each component's ``input[]`` entries become data edges
    ``(input.from, input.lane, component.id)`` and its ``control[]`` entries
    become orchestration edges ``(control.from, control.classType, component.id)``.
    Control edges are included because agent workflows express their
    agent-to-llm/tool/memory wiring exclusively through ``control[]``; ignoring
    them would make the diff blind to agent reconfiguration.

    Args:
        pipe: A pipeline dict.

    Returns:
        A set of ``(from, lane, to)`` triples.
    """
    edges: set[tuple[Any, Any, Any]] = set()
    for component in pipe.get('components', []) or []:
        if not isinstance(component, dict):
            continue
        to_id = component.get('id')
        for wire in component.get('input') or []:
            if isinstance(wire, dict):
                edges.add((wire.get('from'), wire.get('lane'), to_id))
        for wire in component.get('control') or []:
            if isinstance(wire, dict):
                edges.add((wire.get('from'), wire.get('classType'), to_id))
    return edges


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
    object, so both must compare equal to ``{}``. Every other value is returned
    untouched: a blanket ``or {}`` also folded the *non-null* falsy JSON values
    ``false``, ``0`` and ``""`` into ``{}``, and :func:`load_pipe` accepts those,
    so ``viewport: false`` versus ``viewport: {}`` reported no change and exited
    ``0`` even under ``--include-layout``.

    Validation deliberately stays out of this: :func:`_validate_pipe` rejects only
    shapes the diff cannot process (a non-object component, a non-list
    ``components``/wire collection, an unhashable wire endpoint). A scalar
    ``viewport``/``ui`` processes fine — :func:`_diff_value` falls back to an
    equality comparison and reports it as a single ``viewport``/``ui`` change —
    so rejecting it would be stricter than the rest of the loader without making
    any diff correct that is not already correct.

    Args:
        value: The raw ``viewport``/``ui`` value, or ``None`` when absent or null.

    Returns:
        ``{}`` when ``value`` is ``None``, otherwise ``value`` unchanged.
    """
    return {} if value is None else value


def _json_equal(old: Any, new: Any) -> bool:
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
        return old.keys() == new.keys() and all(_json_equal(old[k], new[k]) for k in old)
    if isinstance(old, list) and isinstance(new, list):
        return len(old) == len(new) and all(_json_equal(a, b) for a, b in zip(old, new))
    if isinstance(old, (dict, list)) or isinstance(new, (dict, list)):
        return False
    return old == new


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
    # Without this, None vs {} set layout_changed while producing no ``ui.*``/
    # ``viewport.*`` change, so ``--include-layout`` reported a layout change with
    # nothing to show and still exited 0.
    if not _json_equal(_layout_block(old.get('viewport')), _layout_block(new.get('viewport'))):
        return True
    for component_id in common_ids:
        if not _json_equal(
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
    if not _json_equal(old, new):
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
