# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""services.json / schema invariants for the Chroma `top_k` retrieval knob (#1411).

Two things drift easily and are silent when they do:

1. The `vector.top_k` bounds in `services.common.vector.json` and the runtime
   bounds in `Store._coerceTopK` are written in different files. If they
   disagree, a value the editor accepts blows up at node startup (bounds too
   loose) or a legal value is unreachable from the UI (bounds too tight).
2. A field only reaches the editor if it is listed in the profile's
   `properties` array. Both Chroma profiles must list `vector.top_k` — this
   array is a recurring merge-conflict site (it is also where `chroma.tenant`
   / `chroma.database` / `chroma.ssl` live), so a bad conflict resolution can
   drop the knob without any test noticing.

These are pure JSON reads; no engine build or node import required.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src' / 'nodes'
_CHROMA_SERVICES = _NODES_SRC / 'store_chroma' / 'services.json'
_COMMON_VECTOR = _NODES_SRC / 'core' / 'services.common.vector.json'
_CHROMA_PY = _NODES_SRC / 'store_chroma' / 'chroma.py'


def _strip_jsonc(raw: str) -> str:
    """Drop // and /* */ comments, leaving comment-like text inside strings alone.

    services.json is JSONC, and `//` also occurs inside real values (URLs), so
    this tracks string state rather than pattern-matching.
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


def _load(path: Path) -> dict:
    return json.loads(_strip_jsonc(path.read_text(encoding='utf-8')))


def _top_k_schema() -> dict:
    return _load(_COMMON_VECTOR)['fields']['vector.top_k']


def _runtime_max_top_k() -> int:
    """Read Store.MAX_TOP_K from source, without importing chroma.py.

    chroma.py pulls in chromadb/numpy/rocketlib at import; this file is meant to
    run standalone, so the constant is parsed out of the source text instead.
    """
    import ast

    tree = ast.parse(_CHROMA_PY.read_text(encoding='utf-8'))
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == 'Store':
            for stmt in node.body:
                if (
                    isinstance(stmt, ast.AnnAssign)
                    and isinstance(stmt.target, ast.Name)
                    and stmt.target.id == 'MAX_TOP_K'
                    and isinstance(stmt.value, ast.Constant)
                ):
                    return stmt.value.value
    raise AssertionError('Store.MAX_TOP_K not found in chroma.py')


def test_top_k_declared_as_integer():
    """A fractional top_k must be rejected by the editor, not by _coerceTopK at startup."""
    assert _top_k_schema()['type'] == 'integer'


def test_top_k_schema_bounds_match_runtime_bounds():
    schema = _top_k_schema()
    assert schema['minimum'] == 1
    assert schema['maximum'] == _runtime_max_top_k(), (
        'services.common.vector.json vector.top_k maximum must match Store.MAX_TOP_K; '
        'otherwise the editor accepts a value that raises ValueError at node startup.'
    )


@pytest.mark.parametrize('profile', ['chroma.local', 'chroma.cloud'])
def test_top_k_exposed_on_both_chroma_profiles(profile):
    properties = _load(_CHROMA_SERVICES)['fields'][profile]['properties']
    assert 'vector.top_k' in properties, (
        f'{profile}.properties must list vector.top_k or the knob is invisible in the editor. '
        'This array is a frequent merge-conflict site — check the conflict resolution.'
    )
