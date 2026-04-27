# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow_if_else global state. Reads condition, timeout, and per-branch targets."""

from __future__ import annotations

import logging
import os
from typing import Dict, List

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE

from ..flow_base import SandboxError, cond, evaluate_expression

_logger = logging.getLogger('rocketride.flow')

# [IFELSE-DEBUG] — writes to a file so the engine subprocess output is
# visible to the user. Remove once the routing bug is closed.
_DEBUG_LOG_PATH = os.environ.get('IFELSE_DEBUG_LOG', '/tmp/ifelse-debug.log')


def _dbg(msg: str) -> None:
    try:
        with open(_DEBUG_LOG_PATH, 'a') as f:
            f.write(msg + '\n')
    except Exception:
        pass


class IGlobal(IGlobalBase):
    """Global state for flow_if_else.

    ``branches`` is a map from branch name (``"then"`` / ``"else"``) to the
    list of downstream node IDs on that branch. The canvas populates it
    automatically when the user wires edges out of the branched output
    ports; the Python side just reads the resolved dict.
    """

    condition: str = 'True'
    timeout_s: float = 5.0
    branches: Dict[str, List[str]] = {}

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        _dbg(f'[IFELSE-DEBUG] beginGlobal cfg keys = {list(cfg.keys())}')
        _dbg(f'[IFELSE-DEBUG] beginGlobal cfg = {cfg!r}')
        # The UI writes the user's current value into the BARE key
        # (`condition`) while the dotted `flow_if_else.condition` lingers
        # from the preconfig profile and never gets overwritten. Prefer
        # the bare key so UI edits take effect immediately; fall back to
        # the dotted form for callers that populate only the canonical
        # schema name.
        raw_condition = cfg.get('condition', cfg.get('flow_if_else.condition'))
        if isinstance(raw_condition, str) and raw_condition.strip():
            self.condition = raw_condition
        self.timeout_s = _parse_timeout(cfg)
        self.branches = _parse_branches(cfg.get('flow_if_else.branches', cfg.get('branches')))
        _dbg(f'[IFELSE-DEBUG] resolved condition={self.condition!r} timeout_s={self.timeout_s} branches={self.branches}')

        # Dry-eval the condition at pipeline load rather than on the first
        # chunk. Catches syntax errors, forbidden AST nodes, dunder access,
        # and NameError on unbound identifiers — the garbage-string case
        # (user typed "asfasdfasdfasf") would otherwise silently fail-closed
        # to ELSE on every chunk with no UI surface.
        _validate_condition(self.condition, _node_id(self))

        # Topology lint: THEN and ELSE wired to the same targets makes the
        # If/Else a no-op — the condition has no effect on routing. Legal,
        # but almost always unintentional; warn so the user doesn't wonder
        # why their condition seems to be ignored.
        then_targets = frozenset(self.branches.get('then', []))
        else_targets = frozenset(self.branches.get('else', []))
        if then_targets and then_targets == else_targets:
            _logger.warning(
                'flow_if_else %s: THEN and ELSE have identical targets %s — condition has no effect on downstream routing',
                _node_id(self),
                sorted(then_targets),
            )

    def endGlobal(self) -> None:
        return None

    def targets_for(self, branch: str) -> List[str]:
        """Return the list of downstream node IDs for the given branch."""
        return list(self.branches.get(branch, []))


# Lane names the engine exposes as expression bindings. Keep in sync with
# `driver.py::_LANE_DEFAULTS` + `services.json` `description` field. Used
# only for dry-eval at load time — the actual runtime binding is a single
# lane per invocation. Defaults match the runtime types so subscripting
# (`image[:4]`) and length checks work without raising on the inactive
# lanes: bytes lanes get `b''`, text/table get `''`, list lanes get `[]`.
_EXPECTED_LANE_BINDINGS = {
    'text': '',
    'image': b'',
    'audio': b'',
    'video': b'',
    'table': '',
    'documents': [],
    'questions': [],
    'answers': [],
    'classifications': [],
}


def _validate_condition(expression: str, node_id: str) -> None:
    """Parse and dry-eval the condition; raise on failure at load time.

    Populates dummy values for every known lane name so a condition
    referencing any valid lane passes. Only truly invalid expressions
    (unknown identifier, forbidden AST node, bad syntax) raise.
    """
    bindings = {**_EXPECTED_LANE_BINDINGS, 'state': {}, 'cond': cond}
    try:
        evaluate_expression(expression, bindings)
    except SandboxError as exc:
        raise ValueError(f'flow_if_else {node_id}: invalid condition {expression!r}: {exc}') from exc


def _node_id(ig: 'IGlobal') -> str:
    """Best-effort node identifier for log context."""
    for attr in ('nodeId', 'node_id', 'id'):
        value = getattr(ig.glb, attr, None) if hasattr(ig, 'glb') else None
        if isinstance(value, str) and value:
            return value
    return '<unknown>'


def _parse_timeout(cfg: dict) -> float:
    """Clamp the configured timeout into `[1, 60]` seconds; fall back to 5.0 on invalid input."""
    raw = cfg.get('flow_if_else.timeout_s', cfg.get('timeout_s'))
    if raw is None:
        return 5.0
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 5.0
    return max(1.0, min(value, 60.0))


def _parse_branches(raw: object) -> Dict[str, List[str]]:
    """Normalise the branches map: drop non-string/empty entries; default empty lists.

    The incoming ``raw`` can be either a plain Python dict/list or an
    ``IJson``-wrapped equivalent produced by the config layer. ``IJson``
    values look like dicts/lists but are distinct classes, so
    ``isinstance(x, dict)`` and ``isinstance(x, list)`` both return False
    and the strict checks silently threw the mapping away. Use duck-
    typing (``items`` / ``__iter__``) so both shapes are accepted.
    """
    result: Dict[str, List[str]] = {'then': [], 'else': []}
    if raw is None or not hasattr(raw, 'items'):
        return result
    for branch, targets in raw.items():
        if not isinstance(branch, str):
            continue
        if isinstance(targets, (str, bytes)) or not hasattr(targets, '__iter__'):
            continue
        result[branch] = [t for t in targets if isinstance(t, str) and t]
    return result
