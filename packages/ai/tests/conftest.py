"""Pytest configuration."""

# Add src directory to Python path BEFORE any imports
import sys
from pathlib import Path

# Add the src directory to sys.path so tests can import from ai.*
src_path = Path(__file__).parent.parent / 'src'
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))

# Mock depends and rocketlib modules BEFORE anything else
from types import ModuleType
from unittest.mock import MagicMock


class MockDepends(ModuleType):
    """Mock depends module for testing."""

    def __init__(self):
        """Initialize mock depends module."""
        super().__init__('depends')
        self.depends = lambda *args, **kwargs: None


# Mock depends module
sys.modules['depends'] = MockDepends()
sys.modules['depends'].depends = lambda *args, **kwargs: None

# Mock rocketlib module
mock_rocketlib = MagicMock()
mock_rocketlib.debug = MagicMock()
sys.modules['rocketlib'] = mock_rocketlib

# Mock depends module (used by ai/__init__.py to install requirements)
mock_depends = MagicMock()
sys.modules['depends'] = mock_depends
