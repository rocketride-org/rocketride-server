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
Semantic diff data model for RocketRide ``.pipe`` pipeline files.

This module defines the immutable-ish value objects that describe *what changed*
between two pipeline definitions, independent of how the change is rendered. The
engine (:mod:`rocketride.pipediff.engine`) produces these objects and the
reporters (:mod:`rocketride.pipediff.reporters`) consume them, so the shapes here
are the contract between the two halves of the ``rocketride diff`` feature.

The model deliberately mirrors the three semantic axes of a pipeline:
    - **Nodes** — the components on the canvas (``NodeChange``).
    - **Edges** — the directed wiring between components (``EdgeChange``).
    - **Config** — the per-node settings, expressed as dotted field paths
      (``FieldChange``, nested inside a ``NodeChange``).

Canvas layout (each component's ``ui`` block and the top-level ``viewport``) is
*not* enumerated field-by-field by default; it is summarised by
``PipeDiff.layout_changed`` so that coordinate churn never drowns out real
changes. When the caller opts layout in, per-node ``ui.*`` changes join that
node's ``field_changes`` and the top-level viewport delta lands in
``PipeDiff.viewport_changes``.

Classes:
    FieldChange: A single dotted-path change within a component's config/ui.
    NodeChange: An added, removed, re-provisioned, or reconfigured component.
    EdgeChange: An added or removed directed wire between two components.
    PipeDiff: The complete semantic difference between two pipelines.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional

# Kind discriminators, kept as module-level aliases so the engine, reporters,
# and tests all refer to the same closed vocabularies.
FieldChangeKind = Literal['added', 'removed', 'changed']
NodeChangeKind = Literal['added', 'removed', 'provider', 'config']
EdgeChangeKind = Literal['added', 'removed']


@dataclass(frozen=True)
class FieldChange:
    """
    A single field-level change inside a component, keyed by a dotted path.

    Field changes are produced by the config deep-diff and (when layout is opted
    in) the ui deep-diff. Paths are fully qualified and human-readable, e.g.
    ``config.default.strlen``, ``config.instructions[0]``, or ``ui.position.x``.
    List elements are addressed with ``[index]`` suffixes.

    Attributes:
        path: Dotted path to the changed value, relative to the component
            (prefixed with ``config`` or ``ui`` so it reads as an absolute path).
        kind: ``"added"`` (present only in the new pipe), ``"removed"`` (present
            only in the old pipe), or ``"changed"`` (present in both, differing).
        old: The previous value, or ``None`` for an ``"added"`` change.
        new: The new value, or ``None`` for a ``"removed"`` change.
    """

    path: str
    kind: FieldChangeKind
    old: Any = None
    new: Any = None


@dataclass
class NodeChange:
    """
    A change to a single pipeline component (node), identified by its ``id``.

    A component that exists on both sides may yield *two* ``NodeChange`` entries:
    one with ``kind="provider"`` if its provider (node type) changed, and one
    with ``kind="config"`` if its settings changed. This keeps ``kind`` a single
    closed value while still expressing both facts.

    Attributes:
        id: The component id (stable identity used to match nodes across pipes).
        kind: The nature of the change:
            - ``"added"``: node exists only in the new pipe (``provider_new`` set).
            - ``"removed"``: node exists only in the old pipe (``provider_old`` set).
            - ``"provider"``: node exists in both; its provider changed
              (both ``provider_old`` and ``provider_new`` set).
            - ``"config"``: node exists in both; one or more fields changed
              (``field_changes`` non-empty). With layout opted in, ``field_changes``
              may include ``ui.*`` paths in addition to ``config.*`` paths.
        provider_old: The component's provider before the change, when relevant.
        provider_new: The component's provider after the change, when relevant.
        field_changes: The dotted-path field changes for a ``"config"`` change.
    """

    id: str
    kind: NodeChangeKind
    provider_old: Optional[str] = None
    provider_new: Optional[str] = None
    field_changes: list[FieldChange] = field(default_factory=list)


@dataclass(frozen=True)
class EdgeChange:
    """
    An added or removed directed wire between two components.

    Edges are reconstructed from each component's ``input[]`` lanes (data wiring)
    and ``control[]`` entries (agent orchestration wiring). Both are directed
    ``from`` a source component ``to`` the component that declares them, labelled
    by a lane: the ``lane`` string for data edges, the ``classType`` string for
    control edges (e.g. ``"llm"``, ``"tool"``, ``"memory"``).

    Attributes:
        from_id: The source component id (the ``from`` value on the wire).
        lane: The lane label (data ``lane`` or control ``classType``).
        to_id: The destination component id (the component declaring the wire).
        kind: ``"added"`` (only in the new pipe) or ``"removed"`` (only in the old).
    """

    from_id: str
    lane: str
    to_id: str
    kind: EdgeChangeKind


@dataclass
class PipeDiff:
    """
    The complete semantic difference between two ``.pipe`` pipelines.

    This is the single object handed to every reporter. It separates true
    semantic change (nodes, edges, version) from cosmetic canvas churn
    (``layout_changed``), which is the entire point of ``rocketride diff``.

    Attributes:
        node_changes: All component-level changes, ordered deterministically
            (added, then removed, then per-id provider/config changes).
        edge_changes: All wiring changes (added edges first, then removed).
        version_change: ``(old_version, new_version)`` when the top-level
            ``version`` field differs, else ``None``. Always computed regardless
            of layout options, since a version bump is semantically meaningful.
        layout_changed: ``True`` when the top-level ``viewport`` or any retained
            component's ``ui`` block differs. This is a coarse hint only; layout
            details are enumerated as ``ui.*`` field changes (per node) and
            ``viewport_changes`` only when the caller opts layout in.
        viewport_changes: The top-level ``viewport`` differences as ``viewport.*``
            dotted paths. Populated only when the caller passes
            ``include_layout``; empty otherwise. When non-empty it counts as a
            change, so ``--include-layout`` on a viewport-only edit exits ``1``.
    """

    node_changes: list[NodeChange] = field(default_factory=list)
    edge_changes: list[EdgeChange] = field(default_factory=list)
    version_change: Optional[tuple[Any, Any]] = None
    layout_changed: bool = False
    viewport_changes: list[FieldChange] = field(default_factory=list)

    @property
    def has_semantic_changes(self) -> bool:
        """
        Whether this diff contains any change that should gate a non-zero exit.

        Returns ``True`` when there are node changes, edge changes, a version
        change, or enumerated ``viewport_changes``. Pure layout churn
        (``layout_changed`` with nothing enumerated) does **not** count, so a
        canvas-only move exits ``0`` unless the caller opted layout in with
        ``include_layout``.

        Returns:
            ``True`` if any change that should gate the exit code is present.
        """
        return bool(self.node_changes or self.edge_changes or self.version_change is not None or self.viewport_changes)
