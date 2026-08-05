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

"""
Pytest configuration and shared fixtures for client-python tests.

Provides TEST_CONFIG, ensure_clean_pipeline, and a connected client fixture
following the same patterns as client-mcp/tests/conftest.py.
"""

# Configure Python path for tests to import rocketride from source
import sys
from pathlib import Path

src_path = Path(__file__).parent.parent / 'src'
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))

import os
from typing import Any, AsyncGenerator, Dict

import pytest_asyncio

from rocketride import RocketRideClient


# =========================================================================
# TEST CONFIGURATION
# =========================================================================

TEST_CONFIG: Dict[str, Any] = {
    'uri': os.getenv('ROCKETRIDE_URI', 'http://localhost:5565'),
    'auth': os.getenv('ROCKETRIDE_APIKEY', 'MYAPIKEY'),
    'timeout': 30.0,
}


async def ensure_clean_pipeline(client: RocketRideClient, token: str) -> None:
    """Clean up pipeline if it exists, ignoring errors."""
    try:
        await client.terminate(token)
    except Exception:
        pass


# =========================================================================
# FIXTURES
# =========================================================================


@pytest_asyncio.fixture
async def client() -> AsyncGenerator[RocketRideClient, None]:
    """Provide a connected RocketRideClient, disconnecting on teardown."""
    _client = RocketRideClient(uri=TEST_CONFIG['uri'], auth=TEST_CONFIG['auth'])
    await _client.connect()
    try:
        yield _client
    finally:
        if _client.is_connected():
            await _client.disconnect()
