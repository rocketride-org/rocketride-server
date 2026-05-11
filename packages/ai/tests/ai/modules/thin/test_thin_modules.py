"""
Unit tests for the small "thin" modules under ``ai.modules``.

These modules are mostly registry / CLI / facade glue:

- ``ai.modules.pipe.pipe_validate`` — source-resolution wrapper around
  ``validatePipeline``
- ``ai.modules.services.services`` — list / lookup a service definition
- ``ai.modules.clients.clients`` — find-latest-file helper + download
  endpoints (Python wheel, TypeScript tgz, VSCode vsix)
- ``ai.modules.dropper.dropper`` — static-file SPA fallback with path-traversal
  guard

Each file is small (9–34 statements), so the tests focus on the public
function bodies and the error / fallback paths, not on import-time wiring.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest


# ---------------------------------------------------------------------------
# pipe_Validate
# ---------------------------------------------------------------------------


import ai.modules.pipe.pipe_validate as pipe_validate_mod


@pytest.mark.asyncio
async def test_pipe_validate_uses_explicit_source_param(monkeypatch):
    """An explicit ``source`` param wins over both the field and the implied source."""
    captured = {}

    def fake_validate(payload):
        """Record the payload that the C++ binding receives."""
        captured['payload'] = payload
        return {'ok': True}

    monkeypatch.setattr(pipe_validate_mod, 'validatePipeline', fake_validate)

    pipeline = {'components': [{'id': 'a', 'config': {'mode': 'Source'}}], 'source': 'field-src'}
    result = await pipe_validate_mod.pipe_Validate(MagicMock(), pipeline, source='explicit-src')

    body = result.body.decode() if hasattr(result, 'body') else str(result)
    assert 'OK' in body
    assert captured['payload']['pipeline']['source'] == 'explicit-src'
    assert captured['payload']['pipeline']['version'] == 1


@pytest.mark.asyncio
async def test_pipe_validate_uses_pipeline_field_source(monkeypatch):
    """If no explicit param, the ``source`` field on the pipeline is used."""
    captured = {}
    monkeypatch.setattr(
        pipe_validate_mod,
        'validatePipeline',
        lambda payload: captured.setdefault('payload', payload) or {'ok': True},
    )

    pipeline = {'source': 'field-src', 'components': []}
    await pipe_validate_mod.pipe_Validate(MagicMock(), pipeline)
    assert captured['payload']['pipeline']['source'] == 'field-src'


@pytest.mark.asyncio
async def test_pipe_validate_resolves_implied_source(monkeypatch):
    """A single component with ``config.mode == 'Source'`` becomes the implied source."""
    captured = {}
    monkeypatch.setattr(
        pipe_validate_mod,
        'validatePipeline',
        lambda payload: captured.setdefault('payload', payload) or {'ok': True},
    )

    pipeline = {
        'components': [
            {'id': 'src', 'config': {'mode': 'Source'}},
            {'id': 'sink', 'config': {'mode': 'Sink'}},
        ]
    }
    await pipe_validate_mod.pipe_Validate(MagicMock(), pipeline)
    assert captured['payload']['pipeline']['source'] == 'src'


@pytest.mark.asyncio
async def test_pipe_validate_rejects_multiple_implied_sources(monkeypatch):
    """Two Source-mode components without an explicit choice raise ValueError."""
    monkeypatch.setattr(pipe_validate_mod, 'validatePipeline', lambda payload: {'ok': True})

    pipeline = {
        'components': [
            {'id': 'src1', 'config': {'mode': 'Source'}},
            {'id': 'src2', 'config': {'mode': 'Source'}},
        ]
    }
    result = await pipe_validate_mod.pipe_Validate(MagicMock(), pipeline)
    body = result.body.decode() if hasattr(result, 'body') else str(result)
    # Must be the specific multi-source error — a generic 'Error' envelope
    # could come from an unrelated failure inside validatePipeline.
    assert 'multiple source' in body.lower()


@pytest.mark.asyncio
async def test_pipe_validate_preserves_explicit_version(monkeypatch):
    """An explicit ``version`` on the pipeline is preserved unchanged."""
    captured = {}
    monkeypatch.setattr(
        pipe_validate_mod,
        'validatePipeline',
        lambda payload: captured.setdefault('payload', payload) or {'ok': True},
    )

    pipeline = {'version': 3, 'components': [], 'source': 'src'}
    await pipe_validate_mod.pipe_Validate(MagicMock(), pipeline)
    assert captured['payload']['pipeline']['version'] == 3


@pytest.mark.asyncio
async def test_pipe_validate_wraps_validate_pipeline_errors(monkeypatch):
    """A validatePipeline RuntimeError comes back as an error envelope."""

    def boom(payload):
        """Always raise — exercises the except branch in pipe_Validate."""
        raise RuntimeError('bad config')

    monkeypatch.setattr(pipe_validate_mod, 'validatePipeline', boom)
    pipeline = {'components': [], 'source': 'x'}
    result = await pipe_validate_mod.pipe_Validate(MagicMock(), pipeline)
    body = result.body.decode() if hasattr(result, 'body') else str(result)
    assert 'Error' in body
    assert 'bad config' in body


# ---------------------------------------------------------------------------
# services_get
# ---------------------------------------------------------------------------


import ai.modules.services.services as services_mod


@pytest.mark.asyncio
async def test_services_get_returns_all_when_no_filter(monkeypatch):
    """No ``service`` query param -> getServiceDefinitions() is called for the full list."""
    all_defs = {'svc-a': {'name': 'A'}, 'svc-b': {'name': 'B'}}
    monkeypatch.setattr(services_mod, 'getServiceDefinitions', lambda: all_defs)

    # Pass service=None explicitly — outside FastAPI, the Query(None) default
    # is the Query *object*, which is truthy. Inside FastAPI the resolver
    # extracts the None default.
    result = await services_mod.services_get(service=None)
    body = result.body.decode() if hasattr(result, 'body') else str(result)
    assert 'OK' in body
    assert 'svc-a' in body


@pytest.mark.asyncio
async def test_services_get_returns_one_when_filter_matches(monkeypatch):
    """A specific service name returns just that schema."""
    monkeypatch.setattr(services_mod, 'getServiceDefinition', lambda name: {'name': name})

    result = await services_mod.services_get(service='svc-x')
    body = result.body.decode() if hasattr(result, 'body') else str(result)
    assert 'OK' in body
    assert 'svc-x' in body


@pytest.mark.asyncio
async def test_services_get_returns_error_when_filter_misses(monkeypatch):
    """If the requested service is unknown, the function returns an error envelope."""
    monkeypatch.setattr(services_mod, 'getServiceDefinition', lambda name: None)

    result = await services_mod.services_get(service='ghost')
    body = result.body.decode() if hasattr(result, 'body') else str(result)
    assert 'Error' in body
    assert 'ghost' in body


# ---------------------------------------------------------------------------
# clients._find_latest_file (pure logic)
# ---------------------------------------------------------------------------


import ai.modules.clients.clients as clients_mod


def test_find_latest_file_returns_none_when_no_match(tmp_path):
    """An empty directory yields None."""
    result = clients_mod._find_latest_file(tmp_path, '*.whl')
    assert result is None


def test_find_latest_file_picks_newest_by_mtime(tmp_path):
    """Among multiple matches, the one with the newest mtime wins."""
    older = tmp_path / 'older.whl'
    older.write_text('old')
    newer = tmp_path / 'newer.whl'
    newer.write_text('new')
    # Force ordering — make `newer` strictly newer than `older`.
    import os
    import time

    past = time.time() - 100
    os.utime(older, (past, past))

    picked = clients_mod._find_latest_file(tmp_path, '*.whl')
    assert picked == newer


def test_find_latest_file_glob_filters_extension(tmp_path):
    """Only files matching the glob pattern are considered."""
    (tmp_path / 'a.whl').write_text('w')
    (tmp_path / 'a.tgz').write_text('t')
    picked = clients_mod._find_latest_file(tmp_path, '*.tgz')
    assert picked.name == 'a.tgz'


def test_get_clients_root_returns_path():
    """_get_clients_root returns a Path pointing at ./clients."""
    root = clients_mod._get_clients_root()
    assert isinstance(root, Path)
    assert root.name == 'clients'


# ---------------------------------------------------------------------------
# clients.client_python_file / client_typescript / client_vscode
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_client_python_file_returns_404_for_missing_specific_version(monkeypatch, tmp_path):
    """Asking for a specific wheel that doesn't exist returns a 404 JSONResponse."""
    monkeypatch.setattr(clients_mod, '_get_clients_root', lambda: tmp_path)
    # tmp_path/python/dist does not exist — file.exists() is False
    result = await clients_mod.client_python_file(MagicMock(), 'missing-1.0.whl')
    assert result.status_code == 404


@pytest.mark.asyncio
async def test_client_python_file_serves_specific_version(monkeypatch, tmp_path):
    """An existing wheel file is served via FileResponse."""
    dist = tmp_path / 'python' / 'dist'
    dist.mkdir(parents=True)
    wheel = dist / 'rocketlib_client_python-1.0-py3-none-any.whl'
    wheel.write_text('binary-content')
    monkeypatch.setattr(clients_mod, '_get_clients_root', lambda: tmp_path)

    result = await clients_mod.client_python_file(MagicMock(), wheel.name)
    # FileResponse exposes .path; JSONResponse does not. Compare as Path
    # because the attribute is a PathLib object on some Starlette versions.
    assert Path(getattr(result, 'path', '')) == wheel


@pytest.mark.asyncio
async def test_client_python_file_resolves_latest(monkeypatch, tmp_path):
    """'latest' in the filename triggers the find-latest path."""
    dist = tmp_path / 'python' / 'dist'
    dist.mkdir(parents=True)
    wheel = dist / 'rocketlib_client_python-2.0-py3-none-any.whl'
    wheel.write_text('content')
    monkeypatch.setattr(clients_mod, '_get_clients_root', lambda: tmp_path)

    result = await clients_mod.client_python_file(MagicMock(), 'rocketlib_client_python-latest-py3-none-any.whl')
    assert Path(getattr(result, 'path', '')) == wheel


@pytest.mark.asyncio
async def test_client_python_file_latest_returns_404_when_none(monkeypatch, tmp_path):
    """'latest' requested but no wheels exist -> 404."""
    monkeypatch.setattr(clients_mod, '_get_clients_root', lambda: tmp_path)
    result = await clients_mod.client_python_file(MagicMock(), 'anything-latest.whl')
    assert result.status_code == 404


@pytest.mark.asyncio
async def test_client_typescript_returns_404_when_no_package(monkeypatch, tmp_path):
    """No tgz files -> 404 JSONResponse."""
    monkeypatch.setattr(clients_mod, '_get_clients_root', lambda: tmp_path)
    result = await clients_mod.client_typescript(MagicMock())
    assert result.status_code == 404


@pytest.mark.asyncio
async def test_client_typescript_serves_latest_package(monkeypatch, tmp_path):
    """An existing tgz is served by FileResponse."""
    dist = tmp_path / 'typescript' / 'dist'
    dist.mkdir(parents=True)
    pkg = dist / 'rocketlib-client-typescript-1.0.0.tgz'
    pkg.write_text('payload')
    monkeypatch.setattr(clients_mod, '_get_clients_root', lambda: tmp_path)

    result = await clients_mod.client_typescript(MagicMock())
    assert Path(getattr(result, 'path', '')) == pkg


@pytest.mark.asyncio
async def test_client_vscode_returns_404_when_no_extension(monkeypatch, tmp_path):
    """No vsix files -> 404."""
    monkeypatch.setattr(clients_mod, '_get_clients_root', lambda: tmp_path)
    result = await clients_mod.client_vscode(MagicMock())
    assert result.status_code == 404


@pytest.mark.asyncio
async def test_client_vscode_serves_latest_extension(monkeypatch, tmp_path):
    """An existing vsix is served by FileResponse."""
    ext = tmp_path / 'rocketlib-1.2.3.vsix'
    ext.write_text('payload')
    monkeypatch.setattr(clients_mod, '_get_clients_root', lambda: tmp_path)

    result = await clients_mod.client_vscode(MagicMock())
    assert Path(getattr(result, 'path', '')) == ext


# ---------------------------------------------------------------------------
# dropper.dropper — path traversal + SPA fallback
# ---------------------------------------------------------------------------


import ai.modules.dropper.dropper  # noqa: F401 (ensure the submodule is loaded)

# The package's __init__.py does `from .dropper import dropper`, so the
# attribute `ai.modules.dropper.dropper` is the *function*, not the submodule.
# Reach for the submodule via sys.modules to get back to the real module.
dropper_mod = sys.modules['ai.modules.dropper.dropper']


@pytest.mark.asyncio
async def test_dropper_serves_existing_file(monkeypatch, tmp_path):
    """A requested file that exists under dropper_root is served directly."""
    monkeypatch.setattr(dropper_mod, 'dropper_root', str(tmp_path))
    (tmp_path / 'index.html').write_text('<html></html>')
    (tmp_path / 'app.js').write_text('console.log()')

    req = MagicMock()
    req.path_params = {'file_path': 'app.js'}
    result = await dropper_mod.dropper(req)
    assert getattr(result, 'path', None) is not None
    assert 'app.js' in str(result.path)


@pytest.mark.asyncio
async def test_dropper_falls_back_to_index_when_file_missing(monkeypatch, tmp_path):
    """A request for a missing file returns the SPA fallback (index.html)."""
    monkeypatch.setattr(dropper_mod, 'dropper_root', str(tmp_path))
    (tmp_path / 'index.html').write_text('<html>SPA</html>')

    req = MagicMock()
    req.path_params = {'file_path': 'route/that/spa/handles'}
    result = await dropper_mod.dropper(req)
    assert 'index.html' in str(result.path)


@pytest.mark.asyncio
async def test_dropper_returns_index_for_root_request(monkeypatch, tmp_path):
    """An empty file_path serves index.html."""
    monkeypatch.setattr(dropper_mod, 'dropper_root', str(tmp_path))
    (tmp_path / 'index.html').write_text('<html></html>')

    req = MagicMock()
    req.path_params = {}
    result = await dropper_mod.dropper(req)
    assert 'index.html' in str(result.path)


@pytest.mark.asyncio
async def test_dropper_blocks_path_traversal(monkeypatch, tmp_path):
    """A '..' in the path is rejected — falls back to index.html within dropper_root."""
    monkeypatch.setattr(dropper_mod, 'dropper_root', str(tmp_path))
    (tmp_path / 'index.html').write_text('<html></html>')
    # Create a sibling directory that the attacker is trying to read.
    sibling = tmp_path.parent / 'secrets'
    sibling.mkdir(exist_ok=True)
    (sibling / 'secret.txt').write_text('top-secret')

    req = MagicMock()
    req.path_params = {'file_path': '../secrets/secret.txt'}
    result = await dropper_mod.dropper(req)
    # The fallback path must be within dropper_root.
    path_str = str(getattr(result, 'path', ''))
    assert 'secret.txt' not in path_str
