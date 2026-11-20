# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""services.json invariants for every node with a profile selector.

Generalizes the per-node check added for store_weaviate (#1952) into one
sweep over every node's services.json, per #1953: a node's profile choice
has two entry points that are meant to agree --

- `preconfig.default`, the fallback when a config carries no `profile` key
  (resolved in `packages/ai/src/ai/common/config.py`), and
- the profile field's own `default`, which is what the editor pre-fills into
  a fresh node and what the generated README params table documents.

When they disagree, which one a user lands on depends on how the config
reached the node: a hand-written `.pipe` gets one, an editor-created node
gets the other. This sweep catches the next node that copies an existing
one as a starting point and carries the drift forward, rather than relying
on someone noticing during review.

The profile-selector field is identified generically by its `enum`, a fixed
`"*>preconfig.profiles.*.title"` reference every node with this shape uses
to populate the dropdown from `preconfig.profiles` -- there is no other way
to name "the field that chooses a preconfig profile" from the schema alone.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

_NODES_SRC = Path(__file__).resolve().parent.parent / 'src' / 'nodes'
_PROFILE_ENUM_MARKER = ['*>preconfig.profiles.*.title']

Case = Tuple[str, Path, Dict[str, Any], str, Dict[str, Any]]


def _strip_jsonc(raw: str) -> str:
    """Drop // and /* */ comments, leaving comment-like text inside strings alone.

    services.json is JSONC, and `//` also occurs inside real values (a
    `documentation` URL), so this tracks string state rather than
    pattern-matching. Ported from store_weaviate/test_services_profile_default.py.
    """
    out: List[str] = []
    i, n = 0, len(raw)
    in_string = False
    while i < n:
        ch = raw[i]
        if in_string:
            out.append(ch)
            if ch == '\\' and i + 1 < n:
                out.append(raw[i + 1])
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
        elif ch == '"':
            in_string = True
            out.append(ch)
            i += 1
        elif raw.startswith('//', i):
            i = raw.find('\n', i)
            if i == -1:
                break
        elif raw.startswith('/*', i):
            end = raw.find('*/', i + 2)
            i = n if end == -1 else end + 2
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


def _load_services(path: Path) -> Dict[str, Any]:
    """Parse a services*.json file (JSONC) into a plain dict."""
    return json.loads(_strip_jsonc(path.read_text(encoding='utf-8')))


def _discover_profile_bearing_cases() -> List[Case]:
    """Find every services*.json with a preconfig.default and its profile-selector field(s)."""
    found: List[Case] = []
    for node_dir in sorted(_NODES_SRC.iterdir()):
        if not node_dir.is_dir() or node_dir.name.startswith('_'):
            continue
        for service_file in sorted(node_dir.glob('service*.json')):
            try:
                svc = _load_services(service_file)
            except (json.JSONDecodeError, OSError) as e:
                # Fail the sweep, not silently skip: a services.json this sweep
                # cannot even parse is exactly the kind of file that must not
                # quietly evade the default-consistency check below.
                raise AssertionError(f'{service_file}: failed to parse as JSONC: {e}') from e
            preconfig = svc.get('preconfig')
            if not isinstance(preconfig, dict) or 'default' not in preconfig:
                continue
            fields = svc.get('fields')
            if not isinstance(fields, dict):
                continue
            for field_key, field_def in fields.items():
                if isinstance(field_def, dict) and field_def.get('enum') == _PROFILE_ENUM_MARKER:
                    found.append((node_dir.name, service_file, svc, field_key, field_def))
    return found


_CASES = _discover_profile_bearing_cases()
_CASE_IDS = [f'{node_name}:{field_key}' for node_name, _path, _svc, field_key, _field in _CASES]


@pytest.mark.parametrize('case', _CASES, ids=_CASE_IDS)
def test_preconfig_default_matches_profile_field_default(case: Case):
    """The two entry points for a node's profile choice must agree (#1953)."""
    node_name, path, svc, field_key, field_def = case
    preconfig_default = svc['preconfig']['default']
    field_default = field_def.get('default')
    assert preconfig_default == field_default, (
        f'{node_name} ({path}): preconfig.default is {preconfig_default!r} but {field_key}.default '
        f'is {field_default!r}; which one a user lands on would depend on whether their config '
        f'arrived with a profile key or fell through to the field default'
    )


@pytest.mark.parametrize('case', _CASES, ids=_CASE_IDS)
def test_default_profile_is_declared(case: Case):
    """The default named in preconfig.default must actually exist in preconfig.profiles."""
    node_name, path, svc, _field_key, _field_def = case
    default = svc['preconfig']['default']
    profiles = svc['preconfig'].get('profiles', {})
    assert default in profiles, (
        f'{node_name} ({path}): default profile {default!r} is not defined in preconfig.profiles'
    )


def test_the_sweep_actually_discovered_the_known_profile_bearing_nodes():
    """Guard against a silently-empty or broken sweep passing vacuously."""
    discovered = {node_name for node_name, *_ in _CASES}
    expected = {'store_weaviate', 'store_chroma', 'store_pinecone', 'anonymize'}
    missing = expected - discovered
    assert not missing, f'expected profile-bearing nodes not discovered by the sweep: {sorted(missing)}'
