"""Pytest configuration."""

# Add src directory to Python path BEFORE any imports
import sys
from pathlib import Path

# Add the src directory to sys.path so tests can import from ai.*
src_path = Path(__file__).parent.parent / 'src'
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))

# Mock depends and rocketlib modules BEFORE anything else
from unittest.mock import MagicMock


class MockIJson(dict):
    """Mock IJson class that supports isinstance checks and dict methods."""

    pass


# Mock rocketlib module
mock_rocketlib = MagicMock()
mock_rocketlib.debug = MagicMock()
mock_rocketlib.warning = MagicMock()
mock_rocketlib.getServiceDefinition = MagicMock()
mock_rocketlib.IJson = MockIJson
sys.modules['rocketlib'] = mock_rocketlib

# Mock depends module
sys.modules['depends'] = MagicMock()
