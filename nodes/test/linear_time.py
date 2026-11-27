# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The linear-time check, shared with the ai tests and loaded from there by path."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_PATH = Path(__file__).resolve().parents[2] / 'packages' / 'ai' / 'tests' / 'ai' / 'linear_time.py'
_spec = importlib.util.spec_from_file_location('nodes_test_linear_time', _PATH)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)

assert_linear_time = _module.assert_linear_time
