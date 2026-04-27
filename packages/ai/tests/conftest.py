"""Pytest configuration."""

# Add src directory to Python path BEFORE any imports
import sys
from pathlib import Path

# Add the src directory to Python path so tests can import from ai.*
src_path = Path(__file__).parent.parent / 'src'
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))

# Mock depends and rocketlib modules BEFORE anything else
from unittest.mock import MagicMock


# Mock rocketlib module
mock_rocketlib = MagicMock()
mock_rocketlib.debug = MagicMock()
sys.modules['rocketlib'] = mock_rocketlib

# Mock depends module — bundled with the engine binary at packages/server/engine-lib,
# not installable via pip. Without this, importing anything under ai.* fails because
# ai/__init__.py does `from depends import depends`.
if 'depends' not in sys.modules:
    mock_depends = MagicMock()
    mock_depends.depends = MagicMock(return_value=None)
    sys.modules['depends'] = mock_depends
