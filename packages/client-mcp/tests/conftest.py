# MIT License
# Copyright (c) 2026 Aparavi Software AG
# Pytest configuration and fixtures for rocketride-mcp tests.
#
# Follows the same patterns as client-python and nodes/test:
# - Load .env from repo root
# - TEST_CONFIG from ROCKETRIDE_URI / ROCKETRIDE_APIKEY (or ROCKETRIDE_AUTH)
# - server_available fixture skips when no server; client fixture yields real RocketRideClient

import sys
from pathlib import Path

# Ensure rocketride_mcp is importable. engine.exe uses an embedded Python in isolated mode,
# which ignores PYTHONPATH at startup, so we add the package path to sys.path from here.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
for _path in (_REPO_ROOT / 'build' / 'clients' / 'mcp' / 'src', _REPO_ROOT / 'packages' / 'client-mcp' / 'src'):
    if _path.exists() and str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

import os
import asyncio
from typing import Any, AsyncGenerator, Iterator, TypedDict
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio

# Load .env from repo root before imports that use env
PROJECT_ROOT = _REPO_ROOT
try:
    from dotenv import load_dotenv

    load_dotenv(PROJECT_ROOT / '.env')
except ImportError:
    pass


class _TestConfig(TypedDict):
    uri: str
    auth: str
    timeout: float


# Test configuration (same env vars as client-python and nodes)
TEST_CONFIG: _TestConfig = {
    'uri': os.getenv('ROCKETRIDE_URI', 'http://localhost:5565') or 'http://localhost:5565',
    'auth': os.getenv('ROCKETRIDE_APIKEY') or os.getenv('ROCKETRIDE_AUTH', 'MYAPIKEY') or '',
    'timeout': float(os.getenv('ROCKETRIDE_TEST_TIMEOUT', '30.0')),
}


@pytest.fixture(scope='session')
def event_loop() -> Iterator[asyncio.AbstractEventLoop]:
    """Create event loop for async tests (same as nodes/test)."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope='session')
async def server_available() -> bool:
    """Skip if RocketRide server is not reachable (same pattern as nodes/test)."""
    try:
        from rocketride import RocketRideClient

        client = RocketRideClient(uri=TEST_CONFIG['uri'], auth=TEST_CONFIG['auth'])
        await client.connect()
        await client.ping()
        await client.disconnect()
        return True
    except Exception:
        pytest.skip(
            f'Server not available at {TEST_CONFIG["uri"]}. Set ROCKETRIDE_URI and ROCKETRIDE_APIKEY and ensure server is running.'
        )


@pytest_asyncio.fixture
async def client(server_available: bool) -> AsyncGenerator[Any, None]:
    """
    Provide a connected RocketRideClient when server is available.
    Skips the test when server is not running (e.g. unit-only runs).
    """
    from rocketride import RocketRideClient

    _client = RocketRideClient(uri=TEST_CONFIG['uri'], auth=TEST_CONFIG['auth'])
    await _client.connect()
    try:
        yield _client
    finally:
        if _client.is_connected():
            await _client.disconnect()


# -----------------------------------------------------------------------------
# Unit-test fixtures (no server required)
# -----------------------------------------------------------------------------


@pytest.fixture
def env_rocketride(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set ROCKETRIDE_* env vars so load_settings() succeeds."""
    monkeypatch.setenv('ROCKETRIDE_AUTH', 'test-api-key')
    monkeypatch.setenv('ROCKETRIDE_URI', 'wss://test.example.com')


@pytest.fixture
def mock_rocketride_client() -> MagicMock:
    """Minimal mock RocketRideClient for unit tests (no server)."""
    client = MagicMock()
    client.build_request = MagicMock(return_value={'command': 'rrext_get_tasks'})
    client.request = AsyncMock(
        return_value={
            'body': {
                'tasks': [
                    {'name': 'Task1', 'description': 'First task'},
                    {'name': 'Task2', 'description': 'Second task'},
                ],
            },
        }
    )
    return client


def pytest_configure(config: pytest.Config) -> None:
    """Register custom markers (same pattern as nodes/test)."""
    config.addinivalue_line(
        'markers',
        'requires_server: mark test as requiring a running RocketRide server',
    )
