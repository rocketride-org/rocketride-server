# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Pytest configuration and fixtures for node integration tests.

This module provides:
- Server availability checking
- RocketRideClient fixtures
- Dynamic test generation from service.json 'test' configs

Configuration via environment variables:
    ROCKETRIDE_URI           - Server URI (default: http://localhost:5565)
    ROCKETRIDE_APIKEY        - API key for authentication (default: MYAPIKEY)
    ROCKETRIDE_INCLUDE_SKIP  - Comma-separated node names to opt into (e.g. embedding_image,ocr).
                               Use to run skip_nodes when explicitly requested.

Running tests:
    # Run all tests (requires server)
    builder nodes:test

    # Run contract tests only (no server needed)
    pytest nodes/test/test_contracts.py -v

    # Run dynamic node tests
    pytest nodes/test/test_dynamic.py -v
"""

import os
import sys
import asyncio
import pytest
import pytest_asyncio
from pathlib import Path
from typing import Dict, Any, List

# Add project paths
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / 'dist' / 'server'))

# Load environment variables
try:
    from dotenv import load_dotenv

    load_dotenv(PROJECT_ROOT / '.env')
except ImportError:
    pass  # dotenv is optional


# =============================================================================
# Test Configuration
# =============================================================================


class TestConfig:
    """Test configuration loaded from environment variables."""

    def __init__(self) -> None:
        """Initialize test configuration from ROCKETRIDE_* environment variables."""
        self.uri = os.getenv('ROCKETRIDE_URI', 'http://localhost:5565')
        self.auth = os.getenv('ROCKETRIDE_APIKEY', 'MYAPIKEY')
        self.timeout = float(os.getenv('ROCKETRIDE_TEST_TIMEOUT', '30.0'))

    def as_dict(self) -> Dict[str, Any]:
        """
        Return the test configuration as a dictionary.

        Returns:
            Dictionary containing the test configuration.
        """
        return {'uri': self.uri, 'auth': self.auth, 'timeout': self.timeout}


# Global config instance
TEST_CONFIG = TestConfig()


# =============================================================================
# Server Availability
# =============================================================================


async def is_server_available() -> bool:
    """Check if test server is available."""
    try:
        from rocketride import RocketRideClient

        client = RocketRideClient(uri=TEST_CONFIG.uri, auth=TEST_CONFIG.auth)
        await client.connect()
        await client.ping()
        await client.disconnect()
        return True
    except Exception:
        return False


@pytest_asyncio.fixture(scope='session')
async def server_available():
    """Check server availability once per session."""
    available = await is_server_available()
    if not available:
        pytest.skip(f"Server not available at {TEST_CONFIG.uri}. Run 'builder nodes:test' to start server automatically.")
    return True


# =============================================================================
# Client Fixtures
# =============================================================================


@pytest_asyncio.fixture
async def client(server_available):  # noqa: ARG001 — pytest fixture dependency, not unused
    """
    Provide a connected RocketRideClient for tests.

    Usage:
        async def test_something(client):
            result = await client.use(pipeline=pipeline)
            ...
    """
    from rocketride import RocketRideClient

    _client = RocketRideClient(uri=TEST_CONFIG.uri, auth=TEST_CONFIG.auth)
    await _client.connect()

    yield _client

    if _client.is_connected():
        try:
            await asyncio.wait_for(_client.disconnect(), timeout=10.0)
        except (asyncio.TimeoutError, Exception):
            pass  # Best-effort cleanup — don't let teardown hang the suite


@pytest.fixture
def test_config():
    """Provide test configuration."""
    return TEST_CONFIG


# =============================================================================
# Test Markers
# =============================================================================


def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line('markers', 'requires_server: mark test as requiring a running server')
    config.addinivalue_line('markers', 'node(name): mark test as testing a specific node')
    config.addinivalue_line('markers', 'skip_node: test for a node in skip_nodes (excluded from default run; run with -m skip_node or -k <node_name>)')


# =============================================================================
# Dynamic Node Test Framework
# =============================================================================

from .framework import discover_testable_nodes, NodeTestConfig, NodeTestRunner


@pytest.fixture(scope='session')
def testable_nodes() -> List[NodeTestConfig]:
    """Discover all nodes with test configurations."""
    return discover_testable_nodes()


@pytest_asyncio.fixture
async def node_test_runner(client):
    """
    Fixture to create a TestRunner for a specific node config.

    Usage:
        @pytest.mark.parametrize('node_config', [...])
        async def test_node(node_test_runner, node_config):
            runner = await node_test_runner(node_config)
            ...
    """
    runners = []

    async def _create_runner(config: NodeTestConfig, profile: str | None = None) -> NodeTestRunner:
        runner = NodeTestRunner(client, config, profile)
        await runner.setup()
        runners.append(runner)
        return runner

    yield _create_runner

    # Cleanup all runners
    for runner in runners:
        await runner.teardown()


def _build_parametrize_list(configs, skip_nodes=None, include_skip=None):
    """Build (config, profile) pairs and ids for parametrize, applying skip_nodes filter."""
    available_configs = []
    ids = []
    for config in configs:
        if skip_nodes and config.node_name in skip_nodes:
            if include_skip is None or config.node_name not in include_skip:
                continue
        if config.has_required_env_vars():
            if not config.profiles:
                available_configs.append((config, None))
                ids.append(config.get_test_id())
            else:
                for profile in config.profiles:
                    available_configs.append((config, profile))
                    ids.append(f'{config.get_test_id()}:{profile}')
    return available_configs, ids


def pytest_generate_tests(metafunc):
    """
    Generate dynamic tests for nodes with test configurations.

    This function is called by pytest to generate test cases dynamically.
    It finds all nodes with 'test' (or 'fulltest') configurations and creates
    test cases for each profile and test case defined.
    """
    if 'node_test_config' in metafunc.fixturenames:
        configs = discover_testable_nodes()

        # Skip in dynamic node tests only (contract/other tests unchanged). These nodes are
        # excluded because they pull large libraries, use heavy models, or depend on local
        # services, which would cause CI timeouts or OOM. Opt-in via ROCKETRIDE_INCLUDE_SKIP:
        #   ROCKETRIDE_INCLUDE_SKIP=embedding_image pytest nodes/test/test_dynamic.py -v -k embedding_image
        # Groups: ML/heavy (anonymize, ocr, ner, embedding_image); image/video (image_cleanup, frame_grabber); LLM/local (llm_anthropic, llm_ollama).
        skip_nodes = {
            'anonymize',
            'ocr',
            'ner',
            'embedding_image',
            'image_cleanup',
            'frame_grabber',
            'audio_transcribe',  # it downloads faster-whisper model (1.5GB)
            # Temporarily exclude nodes with failing tests until they can be fixed and re-enabled:
            'index_search',
        }
        include_skip = {n.strip() for n in os.environ.get('ROCKETRIDE_INCLUDE_SKIP', '').split(',') if n.strip()}

        available_configs, ids = _build_parametrize_list(configs, skip_nodes, include_skip)
        metafunc.parametrize('node_test_config', available_configs, ids=ids)

    if 'node_fulltest_config' in metafunc.fixturenames:
        # Fulltest: discovers 'fulltest' key in service*.json — no skip_nodes filter,
        # these are run explicitly via model_server:fulltest.
        configs = discover_testable_nodes(test_key='fulltest')
        available_configs, ids = _build_parametrize_list(configs)
        metafunc.parametrize('node_fulltest_config', available_configs, ids=ids)
