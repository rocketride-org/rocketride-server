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
    ROCKETRIDE_URI      - Server URI (default: http://localhost:5565)
    ROCKETRIDE_APIKEY   - API key for authentication (default: MYAPIKEY)

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
    
    def __init__(self):
        self.uri = os.getenv('ROCKETRIDE_URI', 'http://localhost:5565')
        self.auth = os.getenv('ROCKETRIDE_APIKEY', 'MYAPIKEY')
        self.timeout = float(os.getenv('ROCKETRIDE_TEST_TIMEOUT', '30.0'))
    
    def as_dict(self) -> Dict[str, Any]:
        return {
            'uri': self.uri,
            'auth': self.auth,
            'timeout': self.timeout
        }


# Global config instance
TEST_CONFIG = TestConfig()


# =============================================================================
# Server Availability
# =============================================================================

async def is_server_available() -> bool:
    """Check if test server is available."""
    try:
        from rocketride import RocketRideClient
        
        client = RocketRideClient(
            uri=TEST_CONFIG.uri,
            auth=TEST_CONFIG.auth
        )
        await client.connect()
        await client.ping()
        await client.disconnect()
        return True
    except Exception:
        return False


@pytest.fixture(scope='session')
def event_loop():
    """Create event loop for async tests."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope='session')
async def server_available():
    """Check server availability once per session."""
    available = await is_server_available()
    if not available:
        pytest.skip(
            f"Server not available at {TEST_CONFIG.uri}. "
            "Run 'builder nodes:test' to start server automatically."
        )
    return True


# =============================================================================
# Client Fixtures
# =============================================================================

@pytest_asyncio.fixture
async def client(server_available):
    """
    Provide a connected RocketRideClient for tests.
    
    Usage:
        async def test_something(client):
            result = await client.use(pipeline=pipeline)
            ...
    """
    from rocketride import RocketRideClient
    
    _client = RocketRideClient(
        uri=TEST_CONFIG.uri,
        auth=TEST_CONFIG.auth
    )
    await _client.connect()
    
    yield _client
    
    if _client.is_connected():
        await _client.disconnect()


@pytest.fixture
def test_config():
    """Provide test configuration."""
    return TEST_CONFIG


# =============================================================================
# Test Markers
# =============================================================================

def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line(
        'markers',
        'requires_server: mark test as requiring a running server'
    )
    config.addinivalue_line(
        'markers',
        'node(name): mark test as testing a specific node'
    )


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
    
    async def _create_runner(config: NodeTestConfig, profile: str = None) -> NodeTestRunner:
        runner = NodeTestRunner(client, config, profile)
        await runner.setup()
        runners.append(runner)
        return runner
    
    yield _create_runner
    
    # Cleanup all runners
    for runner in runners:
        await runner.teardown()


def pytest_generate_tests(metafunc):
    """
    Generate dynamic tests for nodes with test configurations.
    
    This function is called by pytest to generate test cases dynamically.
    It finds all nodes with 'test' configurations and creates test cases
    for each profile and test case defined.
    """
    if 'node_test_config' in metafunc.fixturenames:
        configs = discover_testable_nodes()
        
        # Filter to nodes that have required env vars
        available_configs = []
        ids = []
        
        # Skip in dynamic node tests only (contract/other tests unchanged). These nodes are
        # excluded because they pull large libraries, use heavy models, or depend on local
        # services, which would cause CI timeouts or OOM. To run them locally:
        #   pytest nodes/test/test_dynamic.py -v -k <node_name>
        skip_nodes = {
            'anonymize', 'llm_anthropic', 'llm_ollama',
            'ocr', 'ner', 'image_cleanup', 'frame_grabber',
        }

        for config in configs:
            if config.node_name in skip_nodes:
                continue
            if config.has_required_env_vars():
                # If no profiles, add once with None profile
                if not config.profiles:
                    available_configs.append((config, None))
                    ids.append(config.get_test_id())
                else:
                    # Add once per profile
                    for profile in config.profiles:
                        available_configs.append((config, profile))
                        ids.append(f"{config.get_test_id()}:{profile}")
        
        metafunc.parametrize('node_test_config', available_configs, ids=ids)
