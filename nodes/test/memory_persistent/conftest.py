# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Local pytest configuration for the memory_persistent test suite.

Appends the shared ``nodes/test/mocks/`` directory to ``sys.path`` so the
``redis_fake`` fixture package is importable from the test files without
per-file ``sys.path`` manipulation.

We *append* rather than ``insert(0, ...)``: the real libraries in
``dist/server`` (e.g. ``weaviate``, ``pinecone``) must keep priority — those
shadow-style mocks are only meant to be activated subprocess-side via the
``ROCKETRIDE_MOCK`` env var, not at unit-test collection time.
"""

from __future__ import annotations

import sys
from pathlib import Path

_MOCKS_DIR = str(Path(__file__).resolve().parent.parent / 'mocks')
if _MOCKS_DIR not in sys.path:
    sys.path.append(_MOCKS_DIR)
