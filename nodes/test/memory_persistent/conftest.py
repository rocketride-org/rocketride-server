# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Local pytest configuration for the memory_persistent test suite.

This conftest puts the shared ``nodes/test/mocks/`` directory on ``sys.path``
so the ``redis_fake`` fixture package is importable from the test files
without per-file ``sys.path`` manipulation.
"""

from __future__ import annotations

import sys
from pathlib import Path

_MOCKS_DIR = Path(__file__).resolve().parent.parent / 'mocks'
if str(_MOCKS_DIR) not in sys.path:
    sys.path.insert(0, str(_MOCKS_DIR))
