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

# Mock fastapi module with submodule structure
mock_fastapi = MagicMock()
mock_fastapi.FastAPI = MagicMock()
mock_fastapi.Request = MagicMock()
mock_fastapi.Body = MagicMock()
mock_fastapi.Header = MagicMock()
mock_fastapi.Query = MagicMock()
mock_fastapi.UploadFile = MagicMock()
mock_fastapi.File = MagicMock()

mock_fastapi_middleware = MagicMock()
mock_fastapi_middleware.cors = MagicMock()
mock_fastapi_middleware.cors.CORSMiddleware = MagicMock()
mock_fastapi.middleware = mock_fastapi_middleware

sys.modules['fastapi'] = mock_fastapi
sys.modules['fastapi.middleware'] = mock_fastapi_middleware
sys.modules['fastapi.middleware.cors'] = mock_fastapi_middleware.cors
