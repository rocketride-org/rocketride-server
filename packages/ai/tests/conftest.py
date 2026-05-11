"""Pytest configuration."""

# Add src directory to Python path BEFORE any imports
import sys
from pathlib import Path

# Add the src directory to Python path so tests can import from ai.*
src_path = Path(__file__).parent.parent / 'src'
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))

# NOTE: rocketlib and engLib used to be mocked here. They are real modules
# bundled with the engine binary (rocketlib lives at
# packages/server/engine-lib/rocketlib-python/lib/rocketlib; engLib is a
# C-extension built into the engine) and provide everything ai/ imports —
# `debug`, `getServiceDefinition`, `IGlobalBase`, `error`, `warning`, etc.
# Mocking rocketlib turned `IGlobalBase` into a MagicMock instance, which
# triggered a metaclass conflict when ai/common/database/db_global_base.py
# subclassed it. Tests now use the real modules.
