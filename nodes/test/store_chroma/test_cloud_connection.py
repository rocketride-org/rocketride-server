# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""How the Chroma store reaches Chroma Cloud.

Two defects stacked here and each is silent in its own way, so each gets a
test that fails if the fix is undone:

- the cloud branch was never taken, because ``getNodeConfig`` consumes the
  ``profile`` key while merging that profile's contents, so the store only ever
  saw ``local``;
- authentication moved off the removed ``Settings`` / ``TokenAuthClientProvider``
  path onto the ``x-chroma-token`` header, and Chroma Cloud additionally wants
  the tenant and database;
Loads ``chroma.py`` the way the sibling suites do, stubbing only the
third-party packages.
"""

from __future__ import annotations

import importlib.util
import math
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

_STUB_MODULE_NAMES = (
    'chromadb',
    'chromadb.config',
    'chromadb.api',
    'chromadb.api.fastapi',
    'numpy',
    'chroma_cloud_under_test',
)

#: Every kwarg the store hands to chromadb.HttpClient, newest call last.
_CLIENT_CALLS: list[dict] = []


def _install_stubs() -> None:
    """Stub the third-party packages `chroma.py` imports at module scope."""
    chromadb = types.ModuleType('chromadb')

    class _HttpClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            _CLIENT_CALLS.append(dict(kwargs))

    chromadb.HttpClient = _HttpClient
    chromadb.Collection = object
    sys.modules['chromadb'] = chromadb

    chromadb_config = types.ModuleType('chromadb.config')

    class Settings:
        def __init__(self, *_a: object, **_k: object) -> None:
            pass

    chromadb_config.Settings = Settings
    sys.modules['chromadb.config'] = chromadb_config

    # The timeout shim reaches for chromadb.api.fastapi and replaces the httpx
    # name inside it, so the module has to exist for the shim to apply.
    chromadb_api = types.ModuleType('chromadb.api')
    chromadb_fastapi = types.ModuleType('chromadb.api.fastapi')
    chromadb_api.fastapi = chromadb_fastapi
    sys.modules['chromadb.api'] = chromadb_api
    sys.modules['chromadb.api.fastapi'] = chromadb_fastapi

    numpy_mod = types.ModuleType('numpy')
    numpy_mod.exp = math.exp
    numpy_mod.int64 = int
    sys.modules['numpy'] = numpy_mod


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    original = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
    _install_stubs()
    try:
        yield
    finally:
        for name in _STUB_MODULE_NAMES:
            if original.get(name) is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original[name]


def _load_module():
    """Import `chroma.py`. The caller must already hold the stub context."""
    nodes_root = Path(__file__).resolve().parent.parent.parent
    chroma_py = nodes_root / 'src' / 'nodes' / 'store_chroma' / 'chroma.py'
    spec = importlib.util.spec_from_file_location('chroma_cloud_under_test', chroma_py)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _connect(monkeypatch: pytest.MonkeyPatch, config: dict) -> dict:
    """Build a Store with `config` and return the kwargs it passed to HttpClient.

    Both the import and the construction run inside the stub context: the shim
    installs itself while the Store is being built, so `chromadb.api.fastapi`
    has to still be the stub at that point, not just while importing.
    """
    _CLIENT_CALLS.clear()
    with _scoped_stubs():
        module = _load_module()

        # getNodeConfig merges the selected profile and is exercised elsewhere;
        # here the point is what the store does with the config it holds.
        monkeypatch.setattr(module.Config, 'getNodeConfig', staticmethod(lambda *_a, **_k: config))
        monkeypatch.setattr(module.DocumentStoreBase, '__init__', lambda self, *_a, **_k: None)

        module.Store('chroma', {}, {})

    assert _CLIENT_CALLS, 'the store never constructed a client'
    return _CLIENT_CALLS[-1]


class TestProfileResolution:
    """Which branch runs: `getNodeConfig` eats `profile`, so `mode` carries it."""

    def test_mode_cloud_takes_the_cloud_branch(self, monkeypatch: pytest.MonkeyPatch) -> None:
        kwargs = _connect(monkeypatch, {'mode': 'cloud', 'host': 'api.trychroma.com', 'apikey': 'k'})
        assert kwargs.get('ssl') is True

    def test_profile_cloud_still_works_for_direct_configs(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # A config that reaches the node without going through profile merging
        # still has `profile`, so it stays a fallback rather than being dropped.
        kwargs = _connect(monkeypatch, {'profile': 'cloud', 'host': 'api.trychroma.com', 'apikey': 'k'})
        assert kwargs.get('ssl') is True

    def test_absent_selection_stays_local(self, monkeypatch: pytest.MonkeyPatch) -> None:
        kwargs = _connect(monkeypatch, {'host': 'localhost'})
        assert 'ssl' not in kwargs

    def test_mode_wins_over_a_stale_profile(self, monkeypatch: pytest.MonkeyPatch) -> None:
        kwargs = _connect(monkeypatch, {'mode': 'cloud', 'profile': 'local', 'host': 'h', 'apikey': 'k'})
        assert kwargs.get('ssl') is True


class TestCloudTransport:
    """TLS and the header: plain HTTP against the TLS port is the hang."""

    def test_tls_is_requested(self, monkeypatch: pytest.MonkeyPatch) -> None:
        kwargs = _connect(monkeypatch, {'mode': 'cloud', 'host': 'api.trychroma.com', 'apikey': 'k'})
        assert kwargs['ssl'] is True

    def test_api_key_travels_in_the_x_chroma_token_header(self, monkeypatch: pytest.MonkeyPatch) -> None:
        kwargs = _connect(monkeypatch, {'mode': 'cloud', 'host': 'h', 'apikey': 'secret'})
        assert kwargs['headers'] == {'x-chroma-token': 'secret'}

    def test_no_api_key_sends_no_headers(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # A self-hosted server behind TLS needs no token; sending an empty one
        # would be rejected rather than ignored.
        kwargs = _connect(monkeypatch, {'mode': 'cloud', 'host': 'h'})
        assert kwargs['headers'] is None

    def test_local_sends_neither(self, monkeypatch: pytest.MonkeyPatch) -> None:
        kwargs = _connect(monkeypatch, {'mode': 'local', 'host': 'localhost', 'apikey': 'k'})
        assert 'ssl' not in kwargs
        assert 'headers' not in kwargs


class TestTenantAndDatabase:
    """Chroma Cloud is multi-tenant; self-hosted servers reject the kwargs."""

    def test_both_are_forwarded_when_set(self, monkeypatch: pytest.MonkeyPatch) -> None:
        kwargs = _connect(
            monkeypatch,
            {'mode': 'cloud', 'host': 'h', 'apikey': 'k', 'tenant': 't1', 'database': 'db1'},
        )
        assert kwargs['tenant'] == 't1'
        assert kwargs['database'] == 'db1'

    def test_omitted_rather_than_passed_empty(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Passing tenant='' is not the same as not passing it: chromadb would
        # send an empty tenant instead of using its default.
        kwargs = _connect(monkeypatch, {'mode': 'cloud', 'host': 'h', 'apikey': 'k', 'tenant': '', 'database': ''})
        assert 'tenant' not in kwargs
        assert 'database' not in kwargs

    def test_one_without_the_other_is_allowed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        kwargs = _connect(monkeypatch, {'mode': 'cloud', 'host': 'h', 'apikey': 'k', 'tenant': 't1'})
        assert kwargs['tenant'] == 't1'
        assert 'database' not in kwargs

    def test_whitespace_only_counts_as_absent(self, monkeypatch: pytest.MonkeyPatch) -> None:
        kwargs = _connect(monkeypatch, {'mode': 'cloud', 'host': 'h', 'apikey': 'k', 'tenant': '   '})
        assert 'tenant' not in kwargs


class TestTlsIsConfigurable:
    """Chroma Cloud is HTTPS-only, but this profile also covers plain-HTTP servers."""

    def test_tls_is_on_by_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        kwargs = _connect(monkeypatch, {'mode': 'cloud', 'host': 'h', 'apikey': 'k'})
        assert kwargs['ssl'] is True

    def test_tls_can_be_turned_off(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # A self-hosted server behind plain HTTP with token auth worked before
        # the Settings path was removed; it must keep working.
        kwargs = _connect(monkeypatch, {'mode': 'cloud', 'host': 'h', 'apikey': 'k', 'ssl': False})
        assert kwargs['ssl'] is False

    def test_the_string_false_from_an_env_var_turns_it_off(self, monkeypatch: pytest.MonkeyPatch) -> None:
        kwargs = _connect(monkeypatch, {'mode': 'cloud', 'host': 'h', 'apikey': 'k', 'ssl': 'false'})
        assert kwargs['ssl'] is False

    def test_an_unresolved_placeholder_keeps_tls_on(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # '${...}' is a missing env var, not a deliberate opt-out, so it must not
        # silently downgrade the connection to plaintext.
        kwargs = _connect(monkeypatch, {'mode': 'cloud', 'host': 'h', 'apikey': 'k', 'ssl': '${ROCKETRIDE_CHROMA_SSL}'})
        assert kwargs['ssl'] is True
