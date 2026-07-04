"""
Pytest bootstrap for the framework's own unit tests.

This conftest exists for one purpose: make the ``contract_checks`` package
importable from the test files when pytest is invoked on this directory.
The engine binary's default ``sys.path`` doesn't include
``tools/contract_checks/src``, so we insert it here before any test file
runs ``from contract_checks.X import ...``.

Note: the contract-verification path (``builder check-externals:run``) does
NOT go through pytest. It invokes ``tools/contract_checks/cli.py`` directly.
This conftest only matters for ``builder check-externals:test``, which runs
the framework's own unit tests (``test_extractor.py``, ``test_runner.py``).
"""

from __future__ import annotations

import sys
from pathlib import Path


_SRC_DIR = Path(__file__).resolve().parents[1] / 'src'
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))
