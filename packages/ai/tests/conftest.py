"""Pytest configuration."""

# Add src directory to Python path BEFORE any imports
import sys
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock

# Add the src directory to Python path so tests can import from ai.*
src_path = Path(__file__).parent.parent / 'src'
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))


class MockIJson(dict):
    """Mock IJson class that supports isinstance checks and dict methods."""


# Mock rocketlib module using ModuleType for explicit attribute declaration
mock_rocketlib = ModuleType('rocketlib')
mock_rocketlib.debug = MagicMock()
mock_rocketlib.warning = MagicMock()
mock_rocketlib.getServiceDefinition = MagicMock()
mock_rocketlib.IJson = MockIJson
sys.modules['rocketlib'] = mock_rocketlib

# Mock depends module using ModuleType for explicit attribute declaration
mock_depends = ModuleType('depends')
mock_depends.depends = MagicMock()
sys.modules['depends'] = mock_depends


# Mock fastapi module with recursive submodule structure
class MockFastAPIModule:
    """Mock module that creates sub-modules on demand to handle any fastapi import."""

    def __init__(self, name):
        self._name = name

    def __getattr__(self, name):
        full_name = f'{self._name}.{name}' if self._name else name
        submodule = MockFastAPIModule(full_name)
        sys.modules[full_name] = submodule
        return submodule

    def __call__(self, *args, **kwargs):
        return MagicMock()


sys.modules['fastapi'] = MockFastAPIModule('fastapi')
