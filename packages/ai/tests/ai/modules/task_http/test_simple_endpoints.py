"""
Unit tests for the simple ai.modules.task_http endpoints.

``task_Execute`` / ``task_Status`` / ``task_Cancel`` all follow the same
pattern: construct a ``RocketRideClient``, connect, call one method, return
``response(...)`` and ensure disconnect runs in a ``finally`` block.

Tests mount each endpoint on a minimal FastAPI app, patch
``RocketRideClient`` at the module level, and drive via TestClient.
``task_data.py`` is much larger and is not covered here; the simpler
three endpoints give the highest coverage-per-line ratio.
"""

from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import ai.modules.task_http  # noqa: F401 (load the package)

task_status_mod = sys.modules['ai.modules.task_http.task_status']
task_cancel_mod = sys.modules['ai.modules.task_http.task_cancel']
task_exec_mod = sys.modules['ai.modules.task_http.task_exec']


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_app(endpoint, port=12345, account_auth='ak_test', *, method='GET', path='/x'):
    """
    Build a FastAPI app with the endpoint mounted on `path`.

    Adds a middleware that injects ``request.state.account`` so the endpoints
    can read ``request.state.account.auth`` without going through the real
    AuthMiddleware.

    Args:
        endpoint: the async handler function.
        port: integer port that ``server.get_port()`` will return.
        account_auth: value placed on ``request.state.account.auth``.
        method: HTTP method to register.
        path: URL path.

    Returns:
        FastAPI: ready for TestClient.
    """
    app = FastAPI()
    server = MagicMock()
    server.get_port = MagicMock(return_value=port)
    app.state.server = server

    @app.middleware('http')
    async def _inject_account(request, call_next):
        """Inject a fake account info onto request.state."""
        request.state.account = SimpleNamespace(auth=account_auth)
        return await call_next(request)

    if method.upper() == 'POST':
        app.post(path)(endpoint)
    elif method.upper() == 'PUT':
        app.put(path)(endpoint)
    else:
        app.get(path)(endpoint)
    return app


# ---------------------------------------------------------------------------
# task_Status
# ---------------------------------------------------------------------------


def test_task_status_returns_client_status(monkeypatch):
    """task_Status forwards to RocketRideClient.get_task_status and returns its body."""
    client = MagicMock()
    client.connect = AsyncMock()
    client.disconnect = AsyncMock()
    client.get_task_status = AsyncMock(return_value={'state': 'RUNNING', 'name': 'task-1'})
    monkeypatch.setattr(task_status_mod, 'RocketRideClient', MagicMock(return_value=client))

    app = _build_app(task_status_mod.task_Status, path='/status')
    r = TestClient(app).get('/status?token=tk_x', headers={'authorization': 'Bearer ak_test'})

    assert r.status_code == 200
    body = r.json()
    assert body['status'] == 'OK'
    assert body['data'] == {'state': 'RUNNING', 'name': 'task-1'}
    client.get_task_status.assert_awaited_once_with('tk_x')
    client.disconnect.assert_awaited_once()


def test_task_status_returns_error_envelope_when_client_raises(monkeypatch):
    """If get_task_status raises, the endpoint returns the standard error envelope."""
    client = MagicMock()
    client.connect = AsyncMock()
    client.disconnect = AsyncMock()
    client.get_task_status = AsyncMock(side_effect=RuntimeError('unknown token'))
    monkeypatch.setattr(task_status_mod, 'RocketRideClient', MagicMock(return_value=client))

    app = _build_app(task_status_mod.task_Status, path='/status')
    r = TestClient(app).get('/status?token=tk_bad', headers={'authorization': 'Bearer ak_test'})

    assert r.status_code == 400
    body = r.json()
    assert body['status'] == 'Error'
    assert 'unknown token' in body['error']['message']
    # disconnect is always called in finally
    client.disconnect.assert_awaited_once()


# ---------------------------------------------------------------------------
# task_Cancel
# ---------------------------------------------------------------------------


def test_task_cancel_terminates_and_returns_ok(monkeypatch):
    """task_Cancel calls RocketRideClient.terminate and returns an OK envelope."""
    client = MagicMock()
    client.connect = AsyncMock()
    # disconnect is called both inside the try and in finally — make it always succeed.
    client.disconnect = AsyncMock()
    client.terminate = AsyncMock()
    monkeypatch.setattr(task_cancel_mod, 'RocketRideClient', MagicMock(return_value=client))

    app = _build_app(task_cancel_mod.task_Cancel, path='/cancel')
    r = TestClient(app).get('/cancel?token=tk_x', headers={'authorization': 'Bearer ak_test'})

    assert r.status_code == 200
    assert r.json() == {'status': 'OK'}
    client.terminate.assert_awaited_once_with('tk_x')


def test_task_cancel_returns_error_when_terminate_raises(monkeypatch):
    """If terminate raises, the endpoint returns an error envelope."""
    client = MagicMock()
    client.connect = AsyncMock()
    client.disconnect = AsyncMock()
    client.terminate = AsyncMock(side_effect=RuntimeError('cannot terminate'))
    monkeypatch.setattr(task_cancel_mod, 'RocketRideClient', MagicMock(return_value=client))

    app = _build_app(task_cancel_mod.task_Cancel, path='/cancel')
    r = TestClient(app).get('/cancel?token=tk_x', headers={'authorization': 'Bearer ak_test'})

    assert r.status_code == 400
    assert r.json()['status'] == 'Error'


# ---------------------------------------------------------------------------
# task_Execute
# ---------------------------------------------------------------------------


def test_task_execute_calls_client_use_and_returns_token(monkeypatch):
    """task_Execute forwards pipeline + threads to client.use() and returns the new token."""
    client = MagicMock()
    client.connect = AsyncMock()
    client.disconnect = AsyncMock()
    client.use = AsyncMock(return_value={'token': 'tk_new'})
    monkeypatch.setattr(task_exec_mod, 'RocketRideClient', MagicMock(return_value=client))

    app = _build_app(task_exec_mod.task_Execute, path='/exec', method='POST')
    pipeline = {'source': 'src', 'components': []}
    r = TestClient(app).post(
        '/exec?threads=8',
        json=pipeline,
        headers={'authorization': 'Bearer ak_test'},
    )

    assert r.status_code == 200
    assert r.json() == {'status': 'OK', 'data': {'token': 'tk_new'}}
    client.use.assert_awaited_once()
    kwargs = client.use.await_args.kwargs
    assert kwargs['pipeline'] == pipeline
    assert kwargs['threads'] == 8
    assert kwargs['args'] == []  # no trace flag


def test_task_execute_forwards_trace_flag(monkeypatch):
    """A ``trace`` query parameter is converted to a ``--trace=...`` arg."""
    client = MagicMock()
    client.connect = AsyncMock()
    client.disconnect = AsyncMock()
    client.use = AsyncMock(return_value={'token': 'tk_new'})
    monkeypatch.setattr(task_exec_mod, 'RocketRideClient', MagicMock(return_value=client))

    app = _build_app(task_exec_mod.task_Execute, path='/exec', method='POST')
    r = TestClient(app).post(
        '/exec?trace=verbose',
        json={'components': []},
        headers={'authorization': 'Bearer ak_test'},
    )
    assert r.status_code == 200
    assert client.use.await_args.kwargs['args'] == ['--trace=verbose']


def test_task_execute_returns_error_envelope_on_client_failure(monkeypatch):
    """A client.use() exception becomes the standard error envelope."""
    client = MagicMock()
    client.connect = AsyncMock()
    client.disconnect = AsyncMock()
    client.use = AsyncMock(side_effect=RuntimeError('pipeline invalid'))
    monkeypatch.setattr(task_exec_mod, 'RocketRideClient', MagicMock(return_value=client))

    app = _build_app(task_exec_mod.task_Execute, path='/exec', method='POST')
    r = TestClient(app).post(
        '/exec',
        json={'components': []},
        headers={'authorization': 'Bearer ak_test'},
    )
    assert r.status_code == 400
    body = r.json()
    assert body['status'] == 'Error'
    assert 'pipeline invalid' in body['error']['message']
