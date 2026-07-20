# =============================================================================
# MIT License — Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for ``ast_deps`` — provider resolution and AST dependency discovery.

Tests needing the real node/ai source tree are skipped when it is not reachable.
"""

from __future__ import annotations

import os

import pytest

import ast_deps as A

# tests/ -> rocketlib-python -> engine-lib -> server -> packages -> repo root
_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), *([os.pardir] * 5)))
_NODES_SRC = os.path.join(_REPO, 'nodes', 'src')
_AI_SRC = os.path.join(_REPO, 'packages', 'ai', 'src')
_FIXTURES = os.path.join(_REPO, 'nodes', 'test', 'fixtures')

_HAVE_TREE = os.path.isdir(os.path.join(_NODES_SRC, 'nodes')) and os.path.isdir(os.path.join(_AI_SRC, 'ai'))
_needs_tree = pytest.mark.skipif(not _HAVE_TREE, reason='node/ai source tree not reachable')
_needs_fixtures = pytest.mark.skipif(
    not os.path.isdir(os.path.join(_FIXTURES, 'nodes', 'vtest_alpha')), reason='vtest fixtures not present'
)


# --- JSONC parsing ----------------------------------------------------------


def test_strip_jsonc_preserves_scheme_in_strings():
    import json

    src = '{ // a comment\n  "protocol": "webhook://", /* blk */ "path": "nodes.webhook" }'
    data = json.loads(A.strip_jsonc(src))
    assert data['protocol'] == 'webhook://'  # the // inside the string must survive
    assert data['path'] == 'nodes.webhook'


def test_strip_jsonc_trailing_commas():
    import json

    assert json.loads(A.strip_jsonc('{"a": 1, "b": [1, 2,], }')) == {'a': 1, 'b': [1, 2]}


def test_string_consts_flatten():
    import ast

    node = ast.parse("X = ['a.txt', ('b.txt', 'c.txt')]").body[0].value
    assert A._string_consts(node) == ['a.txt', 'b.txt', 'c.txt']


# --- provider -> module resolution ------------------------------------------


@_needs_tree
def test_provider_aliases_share_one_dir():
    idx = A.ProviderIndex(_NODES_SRC)
    for prov in ('webhook', 'chat', 'dropper'):
        entry = idx.resolve(prov)
        assert entry is not None and entry.node_path == 'nodes.webhook'
        assert any(f.endswith('IInstance.py') for f in entry.entry_files)


@_needs_tree
def test_provider_subpackage_path():
    idx = A.ProviderIndex(_NODES_SRC)
    assert idx.resolve('remote').node_path == 'nodes.remote.client'
    assert idx.resolve('remote_server').node_path == 'nodes.remote.server'


@_needs_tree
def test_provider_name_not_equal_dir():
    idx = A.ProviderIndex(_NODES_SRC)
    assert idx.resolve('text-output').node_path == 'nodes.text_output'
    assert idx.resolve('anonymize_text').node_path == 'nodes.anonymize'


@_needs_tree
def test_provider_native_and_unknown():
    idx = A.ProviderIndex(_NODES_SRC)
    for native in ('parse', 'filesys'):
        entry = idx.resolve(native)
        assert entry is not None and entry.native and entry.entry_files == []
    assert idx.resolve('does_not_exist') is None


# --- transitive walk --------------------------------------------------------


@_needs_tree
@pytest.mark.parametrize(
    'provider, must_include',
    [
        ('detect', {'requirements_detection.txt', 'requirements_vision.txt'}),
        ('audio_transcribe', {'requirements_whisper.txt'}),
        ('anonymize_text', {'requirements_gliner.txt'}),
    ],
)
def test_golden_requirement_sets(provider, must_include):
    res = A.discover_for_providers([provider], _NODES_SRC, _AI_SRC)
    assert not res.unresolved_providers
    basenames = {os.path.basename(p) for p in res.requirement_files}
    assert must_include <= basenames, f'{provider} missing {must_include - basenames}'
    # torch is reached through each heavy node's local (non-model-server) branch
    assert any('torch' in os.path.relpath(p, _REPO).replace(os.sep, '/') for p in res.requirement_files)
    assert res.dynamic_imports == []


@_needs_tree
def test_only_needed_excludes_unrelated_families():
    res = A.discover_for_providers(['detect'], _NODES_SRC, _AI_SRC)
    basenames = {os.path.basename(p) for p in res.requirement_files}
    assert 'requirements_whisper.txt' not in basenames
    assert 'requirements_gliner.txt' not in basenames


@_needs_tree
def test_dynamic_import_is_flagged():
    # preprocessor_code resolves its module from a config-driven dict at runtime
    res = A.discover_for_providers(['preprocessor_code'], _NODES_SRC, _AI_SRC)
    assert res.dynamic_imports


# --- conflict fixture nodes -------------------------------------------------


@_needs_fixtures
def test_fixture_nodes_pin_conflicting_versions_without_ai():
    idx = A.ProviderIndex(_FIXTURES)
    roots_ai = _AI_SRC if _HAVE_TREE else _FIXTURES
    for prov, pin in (('vtest_alpha', 'tabulate==0.8.10'), ('vtest_beta', 'tabulate==0.9.0')):
        entry = idx.resolve(prov)
        assert entry is not None and not entry.native
        res = A.discover(entry.entry_files, {'nodes': _FIXTURES, 'ai': roots_ai})
        contents = ''.join(open(r, encoding='utf-8').read() for r in res.requirement_files)
        assert pin in contents
        assert res.reached_modules == []
        assert 'tabulate' in res.third_party


@_needs_fixtures
def test_discover_for_providers_dedupes_repeated_providers(monkeypatch):
    # a pipeline may hold many nodes of one type; each provider must resolve once
    seen = []
    orig = A.ProviderIndex.resolve

    def counting(self, provider):
        seen.append(provider)
        return orig(self, provider)

    monkeypatch.setattr(A.ProviderIndex, 'resolve', counting)
    res = A.discover_for_providers(['vtest_alpha', 'vtest_alpha', 'vtest_beta', 'vtest_alpha'], _FIXTURES, _FIXTURES)
    assert seen == ['vtest_alpha', 'vtest_beta']
    assert {os.path.basename(r) for r in res.requirement_files} >= {'requirements.txt'}
