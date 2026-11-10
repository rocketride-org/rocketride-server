# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
The Chroma retrieval limit (top_k) as the resolver hands it to the store.

top_k is shared by both host types, optional (unset means the caller's own
limit applies) and bounded to what Store._coerceTopK accepts, so the editor
and the node refuse the same values.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest
import rocketlib
from rocketlib.config import ConfigError, resolveConfig

_CHROMA_PY = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'store_chroma' / 'chroma.py'


def _resolve(conn_config):
    """Resolve a node config exactly as IGlobal.beginGlobal() would."""
    schema = rocketlib.getServiceSchema('chroma')
    assert schema is not None, 'chroma is not registered with the engine'
    return resolveConfig(schema, conn_config)


def _runtime_max_top_k() -> int:
    """Read Store.MAX_TOP_K from source, without importing chroma.py.

    chroma.py pulls in chromadb/numpy at import; this file is meant to run
    standalone, so the constant is parsed out of the source text instead.
    """
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


def _leaves(properties, out):
    """Collect every leaf of the resolved schema by path, descending into the selector branches."""
    for prop in properties:
        if 'path' in prop:
            out.setdefault(prop['path'], prop)
        if isinstance(prop.get('enum'), dict):
            for branch in prop['enum'].values():
                _leaves(branch.get('properties') or [], out)
    return out


def _top_k_leaf() -> dict:
    """The resolved top_k leaf: shared by both host types, so its path carries no branch prefix."""
    leaves = _leaves(rocketlib.getServiceSchema('chroma')['properties'], {})
    assert 'top_k' in leaves, f'top_k must be hoisted above the host type; leaves: {sorted(leaves)}'
    return leaves['top_k']


def test_top_k_is_unset_by_default():
    """Unset means the caller's own retrieval limit applies, on both host types."""
    assert _resolve({})['top_k'] is None
    assert _resolve({'profile': 'cloud', 'cloud': {'host': 'h', 'apikey': 'k'}})['top_k'] is None


def test_top_k_is_an_integer_shared_by_both_host_types():
    """One stored key serves both branches, and it is an integer: a fraction is refused by the resolver."""
    assert _resolve({'top_k': 7})['top_k'] == 7
    assert _resolve({'profile': 'cloud', 'cloud': {'host': 'h', 'apikey': 'k'}, 'top_k': 7})['top_k'] == 7
    with pytest.raises(ConfigError, match='top_k'):
        _resolve({'top_k': 7.5})


def test_top_k_bounds_match_the_runtime_bounds():
    """The schema maximum is Store.MAX_TOP_K; otherwise the editor accepts a value the store refuses at startup."""
    leaf = _top_k_leaf()
    assert leaf['minimum'] == 1
    assert leaf['maximum'] == _runtime_max_top_k()
    with pytest.raises(ConfigError, match='top_k'):
        _resolve({'top_k': 0})
    with pytest.raises(ConfigError, match='top_k'):
        _resolve({'top_k': _runtime_max_top_k() + 1})


def test_an_env_placeholder_passes_the_schema_check():
    """A ${ROCKETRIDE_*} reference is typed only once expanded, so it resolves as written."""
    assert _resolve({'top_k': '${ROCKETRIDE_TOP_K}'})['top_k'] == '${ROCKETRIDE_TOP_K}'
