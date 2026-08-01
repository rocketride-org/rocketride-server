"""Code -> doc direction: public surface that documentation fails to cover.

Three findings, ordered by how loudly they mislead a reader:

``STALE_PARAMS``   the generated schema table disagrees with ``services*.json``.
                   Worst kind: confidently wrong. Happens when someone edits a
                   node's schema and never re-runs ``nodes:docs-generate``.
``MISSING_PARAMS`` a node README with no generated block at all, contrary to
                   the co-located documentation rule in AGENTS.md.
``MISSING_DOC``    a node that ships Python but no README whatsoever.
``UNREADABLE``     a schema or README that could not be read or parsed. Reported
                   rather than skipped: a malformed ``services*.json`` yields no
                   declared fields, which would otherwise look identical to a
                   node with nothing to document and hide real drift.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

STALE_PARAMS = 'STALE_PARAMS'
MISSING_PARAMS = 'MISSING_PARAMS'
MISSING_DOC = 'MISSING_DOC'
UNREADABLE = 'UNREADABLE'

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


def strip_jsonc(text: str) -> str:
    """Drop ``//`` line comments so JSONC ``services.json`` files parse.

    Several nodes ship commented schemas. A plain ``json.loads`` raises on
    those, and swallowing the error silently reports the node as having no
    parameters at all -- so real drift would never surface. Quote state is
    tracked so ``https://`` inside a string value survives.
    """
    out: list[str] = []
    in_string = False
    escaped = False
    index = 0
    while index < len(text):
        char = text[index]
        if in_string:
            out.append(char)
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            out.append(char)
            index += 1
            continue
        if char == '/' and index + 1 < len(text) and text[index + 1] == '/':
            while index < len(text) and text[index] != '\n':
                index += 1
            continue
        out.append(char)
        index += 1
    return ''.join(out)


def _is_user_facing_param(value: object) -> bool:
    """True for a real settable parameter, false for a profile grouping.

    This mirrors ``nodes:docs-generate`` exactly, because that generator decides
    what the table contains and is therefore the only correct oracle::

        if (field && field.object !== undefined) continue; // Skip profile definitions

    (``nodes/scripts/gen-node-tables.mjs``). A profile group carries ``object``/
    ``properties`` and merely bundles other keys under a preset, so it is
    excluded from the table and from this comparison.

    Requiring a ``type`` key here as well -- which this did originally -- is
    stricter than the generator, and produced phantom STALE_PARAMS on every
    node with a typeless field: the generator emits such a field with an empty
    Type cell, the audit refused to count it as declared, and the diff surfaced
    as "in docs but not in schema". Ten of the repository's findings were this
    false positive rather than real drift.
    """
    return isinstance(value, dict) and 'object' not in value


def schema_params(node_dir: Path) -> set[str]:
    """User-facing param keys declared across every ``services*.json``."""
    keys: set[str] = set()
    for services in sorted(node_dir.glob('services*.json')):
        try:
            data = json.loads(strip_jsonc(services.read_text(encoding='utf-8', errors='replace')))
        except (OSError, json.JSONDecodeError):
            continue
        fields = data.get('fields')
        if isinstance(fields, dict):
            keys.update(key for key, value in fields.items() if _is_user_facing_param(value))
    return keys


def unreadable_schemas(node_dir: Path) -> list[str]:
    """Names of ``services*.json`` files that could not be read or parsed.

    Separate from :func:`schema_params` so that a broken schema is reported as
    a finding instead of quietly contributing zero declared params -- which
    reads exactly like a node that has nothing to document.
    """
    broken = []
    for services in sorted(node_dir.glob('services*.json')):
        try:
            json.loads(strip_jsonc(services.read_text(encoding='utf-8', errors='replace')))
        except (OSError, json.JSONDecodeError) as exc:
            broken.append(f'{services.name} ({type(exc).__name__})')
    return broken


def audit_node(node_dir: Path, root: Path) -> list[Gap]:
    """Every documentation gap for a single node directory."""
    name = node_dir.name
    has_python = any(node_dir.glob('*.py'))
    if not has_python:
        return []

    broken = unreadable_schemas(node_dir)
    if broken:
        # Stop here: declared params are unknowable, so any STALE/MISSING
        # verdict computed from them would be noise on top of a real problem.
        return [Gap(UNREADABLE, name, 'unparseable schema: ' + '; '.join(broken))]

    readme = node_dir / 'README.md'
    if not readme.exists():
        count = len(list(node_dir.glob('*.py')))
        return [Gap(MISSING_DOC, name, f'{count} Python file(s), no README.md')]

    try:
        text = readme.read_text(encoding='utf-8', errors='replace')
    except OSError as exc:
        return [Gap(UNREADABLE, name, f'README.md could not be read ({type(exc).__name__})')]

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
