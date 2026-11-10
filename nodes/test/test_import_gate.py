# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""CI import gate: a node package is "converted" when its validator imports light.

In CONFIG / PIPELINE_CONFIG mode the engine imports ``<path>.IValidator`` (or falls
back to ``rocketlib.IValidatorBase``) and nothing else. ``IGlobal.py`` and
``IInstance.py`` are never imported there, so a node may keep its heavy imports at
module top. This gate pins that contract for every python node package: importing
the validator under the GPU import guard (the hosted-engine backstop) must leave
``<path>.IGlobal`` and ``<path>.IInstance`` out of ``sys.modules``.

A red node has one of: a package ``__init__`` that re-exports the classes, an
``IValidator.py`` that imports ``IGlobal``/``IInstance``, or a validator that
imports a GPU library directly.

Usage:
    engine.exe -m pytest nodes/test/test_import_gate.py -v
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path
from typing import List

import pytest

from ai.common.models.gpu_guard import _BLOCKED_MODULES, _GPUImportBlocker

from .framework.discovery import _parse_service_json

NODES_SRC = Path(__file__).resolve().parent.parent / 'src' / 'nodes'


# =============================================================================
# Discovery
# =============================================================================


def _python_node_packages() -> List[str]:
    """Return the module path of every python node package, sorted.

    Every ``services*.json`` with ``"node": "python"`` names its package in
    ``path`` (``nodes.store_qdrant``); several service files may share one
    package, so the list is deduplicated.
    """
    packages = set()
    for service_file in NODES_SRC.rglob('services*.json'):
        if '__pycache__' in service_file.parts:
            continue
        data = _parse_service_json(str(service_file))
        if data is None:
            # A definition this gate cannot read is a definition it cannot
            # check: fail, like the other malformed-definition branches
            pytest.fail(f'{service_file.relative_to(NODES_SRC)}: could not be parsed')
        path = data.get('path')
        if data.get('node') != 'python':
            # A C++ node names its directory in `path`; a python package path
            # (`nodes.<name>`) without `"node": "python"` is a definition the
            # engine would hand to the C++ factory, so it must not slip past
            # the gate unnoticed.
            if isinstance(path, str) and path.startswith('nodes.'):
                pytest.fail(f'{service_file.relative_to(NODES_SRC)}: a python package path needs "node": "python"')
            continue
        if not isinstance(path, str) or not path:
            pytest.fail(f'{service_file.relative_to(NODES_SRC)}: a python node needs a "path" (its package)')
        packages.add(path)
    return sorted(packages)


PACKAGES = _python_node_packages()


# =============================================================================
# The gate
# =============================================================================


@pytest.mark.parametrize('package', PACKAGES)
def test_validator_imports_without_the_global(package: str) -> None:
    """Importing the node's validator leaves IGlobal/IInstance out of sys.modules.

    Args:
        package: The node package, e.g. ``nodes.store_qdrant``.
    """
    before = set(sys.modules)
    blocker = _GPUImportBlocker(_BLOCKED_MODULES)
    sys.meta_path.insert(0, blocker)
    try:
        validator = f'{package}.IValidator'
        # Step 1: the package's own validator when the file exists ...
        if importlib.util.find_spec(validator) is not None:
            module = importlib.import_module(validator)
            assert hasattr(module, 'IValidator'), f'{validator} has no IValidator class'
        else:
            # Step 2: ... otherwise the framework default, which validates the schema
            from rocketlib import IValidatorBase  # noqa: F401

        # Step 3: the run-path modules must not have ridden along
        heavy = [name for name in (f'{package}.IGlobal', f'{package}.IInstance') if name in sys.modules]
        assert not heavy, (
            f'{package}: importing the validator loaded {", ".join(heavy)}. '
            'Config mode imports <path>.IValidator only: keep __init__.py empty and the validator import-light.'
        )
    finally:
        sys.meta_path.remove(blocker)
        # Step 4: leave sys.modules as found so one node cannot colour the next
        for name in set(sys.modules) - before:
            sys.modules.pop(name, None)
