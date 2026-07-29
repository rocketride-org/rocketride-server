"""Code -> doc direction: public surface that documentation fails to cover.

Three findings, ordered by how loudly they mislead a reader:

``STALE_PARAMS``   the generated schema table disagrees with ``services*.json``.
                   Worst kind: confidently wrong. Happens when someone edits a
                   node's schema and never re-runs ``nodes:docs-generate``.
``MISSING_PARAMS`` a node README with no generated block at all, contrary to
                   the co-located documentation rule in AGENTS.md.
``MISSING_DOC``    a node that ships Python but no README whatsoever.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

STALE_PARAMS = 'STALE_PARAMS'
MISSING_PARAMS = 'MISSING_PARAMS'
MISSING_DOC = 'MISSING_DOC'

_GENERATED_BLOCK = re.compile(
    r'<!--\s*ROCKETRIDE:GENERATED:PARAMS START\s*-->(.*?)<!--\s*ROCKETRIDE:GENERATED:PARAMS END\s*-->',
    re.DOTALL,
)
# A row of the generated schema table: | `key` | `type` | ... |
_PARAM_ROW = re.compile(r'^\|\s*`([^`]+)`\s*\|', re.MULTILINE)


@dataclass(frozen=True)
class Gap:
    """One documentation gap, with the evidence that proves it."""

    kind: str
    node: str
    detail: str


def documented_params(readme_text: str) -> set[str] | None:
    """Param keys listed in the README's generated block, or None if absent."""
    match = _GENERATED_BLOCK.search(readme_text)
    if match is None:
        return None
    return set(_PARAM_ROW.findall(match.group(1)))


def _is_user_facing_param(value: object) -> bool:
    """True for a real settable parameter, false for a profile grouping.

    ``fields`` holds two different kinds of entry. A parameter carries a
    ``type`` (``{"type": "string", "title": ...}``). A profile group carries
    ``object``/``properties`` and merely bundles other keys under a preset --
    ``nodes:docs-generate`` does not put those in the schema table, so neither
    do we, or every profile-based node reports phantom drift.
    """
    return isinstance(value, dict) and 'type' in value and 'object' not in value


def schema_params(node_dir: Path) -> set[str]:
    """User-facing param keys declared across every ``services*.json``."""
    keys: set[str] = set()
    for services in sorted(node_dir.glob('services*.json')):
        try:
            data = json.loads(services.read_text(encoding='utf-8', errors='replace'))
        except (OSError, json.JSONDecodeError):
            continue
        fields = data.get('fields')
        if isinstance(fields, dict):
            keys.update(key for key, value in fields.items() if _is_user_facing_param(value))
    return keys


def audit_node(node_dir: Path, root: Path) -> list[Gap]:
    """Every documentation gap for a single node directory."""
    name = node_dir.name
    has_python = any(node_dir.glob('*.py'))
    if not has_python:
        return []

    readme = node_dir / 'README.md'
    if not readme.exists():
        count = len(list(node_dir.glob('*.py')))
        return [Gap(MISSING_DOC, name, f'{count} Python file(s), no README.md')]

    try:
        text = readme.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return []

    declared = schema_params(node_dir)
    documented = documented_params(text)

    if documented is None:
        if declared:
            return [
                Gap(
                    MISSING_PARAMS,
                    name,
                    f'{len(declared)} param(s) in services*.json, no ROCKETRIDE:GENERATED:PARAMS block',
                )
            ]
        return []

    # Only meaningful when the node actually declares a schema; a node with no
    # fields legitimately generates an empty table.
    if not declared:
        return []

    undocumented = declared - documented
    phantom = documented - declared
    if not undocumented and not phantom:
        return []

    parts = []
    if undocumented:
        parts.append(f'in schema but not in docs: {", ".join(sorted(undocumented)[:6])}')
    if phantom:
        parts.append(f'in docs but not in schema: {", ".join(sorted(phantom)[:6])}')
    return [Gap(STALE_PARAMS, name, '; '.join(parts) + ' (re-run nodes:docs-generate)')]


def audit_nodes(root: Path) -> list[Gap]:
    """Every documentation gap across every node."""
    nodes_root = root / 'nodes' / 'src' / 'nodes'
    if not nodes_root.is_dir():
        return []
    gaps: list[Gap] = []
    for node_dir in sorted(p for p in nodes_root.iterdir() if p.is_dir()):
        gaps.extend(audit_node(node_dir, root))
    return gaps
