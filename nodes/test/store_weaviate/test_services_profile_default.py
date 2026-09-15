# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""services.json invariants for the Weaviate store node.

The node declares its connection profile twice: `preconfig.default` is the
fallback when a config carries no `profile` key, and `weaviate.profile.default`
is what the editor writes into a fresh node. Both describe the same choice, so
they must agree — otherwise which one a user lands on depends on how the config
reached the node (see #1777).
"""

from __future__ import annotations

import json
from pathlib import Path

_NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'store_weaviate'
_SERVICES_PATH = _NODE_DIR / 'services.json'


def _strip_jsonc(raw: str) -> str:
    """Drop // and /* */ comments, leaving comment-like text inside strings alone.

    services.json is JSONC, and `//` also occurs inside real values (the
    `documentation` URL), so this tracks string state rather than pattern-matching.
    """
    out: list[str] = []
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


def _services() -> dict:
    return json.loads(_strip_jsonc(_SERVICES_PATH.read_text(encoding='utf-8')))


def test_preconfig_default_matches_profile_field_default():
    svc = _services()
    preconfig_default = svc['preconfig']['default']
    field_default = svc['fields']['weaviate.profile']['default']
    assert preconfig_default == field_default, (
        f'preconfig.default is {preconfig_default!r} but weaviate.profile.default is '
        f'{field_default!r}; the connection profile a user gets would depend on whether '
        f'it arrived via preconfig or fell through to the field default'
    )


def test_default_profile_exists_and_can_connect_unconfigured():
    """The default profile must ship a usable host, not an empty one to fill in."""
    svc = _services()
    profiles = svc['preconfig']['profiles']
    default = svc['preconfig']['default']
    assert default in profiles, f'default profile {default!r} is not defined'
    # weaviate.py strips the host before use, so a whitespace-only value is as
    # unusable as an empty one — check what the runtime would actually see.
    host = profiles[default].get('host')
    assert isinstance(host, str) and host.strip(), (
        f'default profile {default!r} ships an empty host, so an unconfigured node cannot connect'
    )


def test_every_profile_choice_is_reachable_from_the_field():
    """Each preconfig profile needs a conditional branch, or its fields never render."""
    svc = _services()
    branches = {c['value'] for c in svc['fields']['weaviate.profile']['conditional']}
    assert branches == set(svc['preconfig']['profiles'])
