# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Load the Wave node's modules from source for the tests in this directory.

The modules import ``rocketlib`` and ``ai.common``, so the fixture needs the
engine's Python (``./builder nodes:test``) and skips elsewhere. The loading
itself is in _load_wave.py, shared with the eager prompt scenarios and the bench.
"""

from types import SimpleNamespace

import pytest
from _load_wave import load_wave_modules


@pytest.fixture(scope='session')
def wave() -> SimpleNamespace:
    """The Wave node's modules, loaded from source: ``wave.planner``, ``wave.executor``, ``wave.rocketride_agent``."""
    pytest.importorskip('rocketlib', reason='needs the engine Python: ./builder nodes:test')
    return load_wave_modules()
