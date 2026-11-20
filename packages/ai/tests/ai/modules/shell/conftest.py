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

"""Shared fixtures for the shell module tests: page-map isolation, and the #1022 app-origin tests (see ``isolation_support``)."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

import ai.modules.shell.shell as shell_mod

from . import isolation_support as sup


@pytest.fixture(autouse=True)
def _public_pages_state(monkeypatch):
    """Every test starts on a fresh page map and an empty store.

    The fresh ``PageMap`` holds the legacy aggregate, runs no rebuild and has
    its own rebuild lock (a lock binds to the event loop that first waits on
    it). ``_built_at = inf`` keeps the refresh backstop from scheduling a
    rebuild against the real account singleton. No web server is wired, so no
    live route check is installed. The render caches start empty and are
    dropped on every swap and data-source invalidation, as after startup;
    swap and data-source listeners a test adds are dropped with the page map.
    The artifact store is the hostile fixture's in-memory ``FILES`` (empty
    unless a test seeds it), so unit tests never touch a real store. The
    render, snapshot and feed caches, the unusable-snapshot memory, the
    storage-warning and storage-failure memories and the snapshot reads in
    flight start empty, with their production budgets, and the store read
    slots start free.
    """
    import ai.modules.shell.data_sources as ds
    import ai.modules.shell.pages as pages
    import ai.modules.shell.public_pages as pp

    from .hostile_fixtures import FILES, file_info, read_file

    fresh = pp.PageMap()
    fresh._built_at = float('inf')
    monkeypatch.setattr(pp, 'page_map', fresh)
    monkeypatch.setattr(pages, '_web_server', None)
    monkeypatch.setattr(
        pages, '_render_cache', pages._FifoCache(pages._RENDER_CACHE_MAX_BYTES, pages._RENDER_CACHE_MAX)
    )
    monkeypatch.setattr(pages, '_snapshot_cache', pages._FifoCache(pages._SNAPSHOT_CACHE_MAX_BYTES))
    monkeypatch.setattr(pages, '_atom_cache', {})
    monkeypatch.setattr(
        pages, '_unusable_snapshots', pages._FifoCache(pages._UNUSABLE_SNAPSHOTS_MAX, pages._UNUSABLE_SNAPSHOTS_MAX)
    )
    monkeypatch.setattr(
        pages, '_storage_warned', pages._FifoCache(pages._STORAGE_WARNED_MAX, pages._STORAGE_WARNED_MAX)
    )
    monkeypatch.setattr(
        pages, '_storage_failures', pages._FifoCache(pages._STORAGE_FAILURES_MAX, pages._STORAGE_FAILURES_MAX)
    )
    monkeypatch.setattr(pages, '_snapshot_reads', {})
    # A semaphore binds to the event loop it first waits on; TestClient runs each request on a fresh one.
    monkeypatch.setattr(pages, '_snapshot_read_slots', asyncio.Semaphore(pages._SNAPSHOT_READ_SLOTS))
    monkeypatch.setattr(pages, '_documents', {})
    monkeypatch.setattr(ds, '_listeners', [])
    # As register_public_pages installs them.
    pp.on_swap(pages._clear_rendered)
    ds.on_invalidate(pages._drop_rendered_for)
    FILES.clear()
    monkeypatch.setattr(pp, 'read_artifact_file', read_file)
    monkeypatch.setattr(pp, 'artifact_file_info', file_info)


def _clear_caches() -> None:
    caches = [shell_mod._version_dir_cache, shell_mod._app_auth_cache]
    ao = sup.module_or_none('ai.modules.shell.app_origin')
    if ao is not None:
        # The fix's own TTL caches are module-level dicts whose names end in ``cache``.
        caches += [v for k, v in vars(ao).items() if k.endswith('cache') and isinstance(v, dict)]
    for cache in caches:
        cache.clear()


@pytest.fixture
def clean_caches():
    """Serving caches are process-wide: start and end every test empty."""
    _clear_caches()
    yield
    _clear_caches()


@pytest.fixture
def clock(monkeypatch):
    """A controllable ``time.time``."""
    return sup.FakeClock(monkeypatch)


@pytest.fixture
def isolation_env(tmp_path, monkeypatch, clean_caches):
    """A valid ``enforce`` configuration over a complete static tree (OSS account edition).

    ``env.set(NAME=value)`` changes one variable (``None`` unsets it) and
    ``env.rebuild_static(...)`` rewrites the static tree (see ``write_static_tree``).
    """
    from ai.account import account

    monkeypatch.setattr(account, 'capabilities', ('oss',), raising=False)
    static = sup.write_static_tree(tmp_path)
    monkeypatch.setattr(shell_mod, '_shell_root', str(static / 'shell'))
    monkeypatch.setattr(shell_mod, '_apps_root', str(static / 'apps'))
    values = sup.valid_env()
    sup.apply_env(monkeypatch, values)

    def set_vars(**overrides):
        for name, value in overrides.items():
            if value is None:
                monkeypatch.delenv(name, raising=False)
            else:
                monkeypatch.setenv(name, value)

    def rebuild_static(**kwargs):
        import shutil

        shutil.rmtree(tmp_path / 'static')
        new = sup.write_static_tree(tmp_path, **kwargs)
        monkeypatch.setattr(shell_mod, '_shell_root', str(new / 'shell'))
        return new

    return SimpleNamespace(
        static=static,
        values=values,
        set=set_vars,
        rebuild_static=rebuild_static,
        config=lambda: sup.need(sup.load_module('ai.modules.shell.app_origin'), 'load_isolation_config')(
            __import__('os').environ
        ),
    )


@pytest.fixture
def registry(monkeypatch, clean_caches):
    """A SaaS-edition fake registry over the account singleton (``registry.install`` re-runs it for OSS)."""
    reg = sup.FakeRegistry()
    reg.install(monkeypatch, saas=True)
    return reg


@pytest.fixture
def store_reads(monkeypatch):
    """The fake store; the fixture value is the list of paths read."""
    return sup.install_store(monkeypatch)


class ServedApp:
    """One published third-party app behind the app-host middleware (SaaS edition, ``enforce``)."""

    APP = 'acme.thirdparty'

    def __init__(self, env, reg, reads, hits):
        self.env = env
        self.registry = reg
        self.reads = reads
        self.hits = hits
        self.label = sup.label_for(self.APP)
        self.host = sup.app_host_of(self.label)
        self._client = None

    @property
    def config(self):
        # Lazy: a missing fix module must fail the TEST, not the fixture.
        return self.env.config()

    @property
    def client(self):
        from fastapi.testclient import TestClient

        if self._client is None:
            inner = sup.shell_inner_app(self.hits)
            self._client = TestClient(sup.outer_app(inner, self.config), base_url=sup.SHELL_ORIGIN)
        return self._client

    def token(self, app=None, version=1, user='u1', org='org-1') -> str:
        ao = sup.load_module('ai.modules.shell.app_origin')
        return sup.need(ao, 'mint_frame_token')(app or self.APP, version, user, org, config=self.config)

    def get(self, path, host=None, headers=None, **kwargs):
        merged = {'host': host or self.host}
        merged.update(headers or {})
        return self.client.get(path, headers=merged, **kwargs)

    def get_bundle(self, token=None, file='remoteEntry.js', version=1, host=None, headers=None):
        return self.get(f'/_t/{token or self.token()}/v{version}/{file}', host=host, headers=headers)


@pytest.fixture
def served_app(isolation_env, registry, store_reads, clock):
    """``acme.thirdparty`` v1 (public, ready) served through AppHostMiddleware; user ``u1`` in ``org-1``."""
    registry.add(ServedApp.APP, 1)
    hits: list = []
    return ServedApp(isolation_env, registry, store_reads, hits)
