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

# Mock depends module (provides dependency installation at import time)
mock_depends = MagicMock()
mock_depends.depends = MagicMock()
sys.modules['depends'] = mock_depends

# Mock rocketlib module
mock_rocketlib = MagicMock()
mock_rocketlib.debug = MagicMock()
sys.modules['rocketlib'] = mock_rocketlib

# Mock rocketride module (provides core classes used by ai.web.server)
mock_rocketride = MagicMock()
sys.modules['rocketride'] = mock_rocketride
sys.modules['rocketride.core'] = MagicMock()
