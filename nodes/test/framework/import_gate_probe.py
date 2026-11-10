# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Child-process probe for the node import gate (``test_import_gate.py``).

Runs on the engine's Python in a FRESH interpreter so that nothing the pytest
session imported earlier (a node test that loaded ``IGlobal``, a GPU library a
fixture pulled in) can hide or fake a violation. Reads the package list as JSON
on stdin, imports each package's validator under the GPU import guard, and
prints one JSON object on stdout::

    {"nodes.store_qdrant": {"heavy": [], "error": null}, ...}

``heavy`` lists the ``<path>.IGlobal`` / ``<path>.IInstance`` modules the
validator import loaded; ``error`` is the import failure text (a blocked GPU
import surfaces here), or null.

Usage (what the gate does):
    engine.exe nodes/test/framework/import_gate_probe.py < packages.json
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import sys
from typing import Dict, List, Optional

from ai.common.models.gpu_guard import _BLOCKED_MODULES, _GPUImportBlocker


# =============================================================================
# Probe
# =============================================================================


def _evict(package: str) -> None:
    """Drop the package and every submodule from ``sys.modules`` so its import is fresh."""
    prefix = f'{package}.'
    for name in [name for name in sys.modules if name == package or name.startswith(prefix)]:
        sys.modules.pop(name, None)


def _probe(package: str) -> Dict[str, object]:
    """Import ``package``'s validator (or the framework default) and report what rode along.

    Args:
        package: The node package, e.g. ``nodes.store_qdrant``.

    Returns:
        ``{"heavy": [...], "error": str | None}``.
    """
    _evict(package)
    error: Optional[str] = None
    try:
        validator = f'{package}.IValidator'
        # Step 1: the package's own validator when the file exists ...
        if importlib.util.find_spec(validator) is not None:
            module = importlib.import_module(validator)
            if not hasattr(module, 'IValidator'):
                error = f'{validator} has no IValidator class'
        else:
            # Step 2: ... otherwise the framework default, which validates the schema
            from rocketlib import IValidatorBase  # noqa: F401
    except Exception as exc:  # the GPU blocker raises ImportError; anything else is a broken validator
        error = f'{type(exc).__name__}: {exc}'

    # Step 3: the run-path modules must not have ridden along
    heavy: List[str] = [name for name in (f'{package}.IGlobal', f'{package}.IInstance') if name in sys.modules]
    return {'heavy': heavy, 'error': error}


def main() -> int:
    """Probe every package named on stdin; print the JSON report."""
    packages = json.loads(sys.stdin.read())
    # One blocker for the interpreter's life: the hosted-engine backstop that
    # refuses torch / tensorflow / onnxruntime / cupy at import
    sys.meta_path.insert(0, _GPUImportBlocker(_BLOCKED_MODULES))
    report = {package: _probe(package) for package in packages}
    json.dump(report, sys.stdout)
    return 0


if __name__ == '__main__':
    sys.exit(main())
