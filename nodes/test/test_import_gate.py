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

The imports run in ONE fresh child interpreter (``framework/import_gate_probe.py``
on the engine's Python), not in the pytest process: a node test collected earlier
may already hold a package's ``IGlobal`` in ``sys.modules``, and a GPU library a
fixture imported before the guard would pass the blocker unchallenged. The child
evicts each package before importing its validator, so every probe is a first
import, and the report is checked per package here so a red node is named.

A red node has one of: a package ``__init__`` that re-exports the classes, an
``IValidator.py`` that imports ``IGlobal``/``IInstance``, or a validator that
imports a GPU library directly.

Usage:
    engine.exe -m pytest nodes/test/test_import_gate.py -v
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Dict, List

import pytest

from .framework.discovery import _parse_service_json

NODES_SRC = Path(__file__).resolve().parent.parent / 'src' / 'nodes'
PROBE = Path(__file__).resolve().parent / 'framework' / 'import_gate_probe.py'

# Tests run on the engine's Python, so the engine directory is the interpreter's.
_ENGINE_DIR = Path(sys.executable).resolve().parent


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
        if not isinstance(data, dict):
            # A definition this gate cannot read (unparseable, or a top-level
            # value that is not an object) is a definition it cannot check:
            # fail, like the other malformed-definition branches
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


@pytest.fixture(scope='module')
def probe_report() -> Dict[str, Dict[str, object]]:
    """Run the probe once for every package in a fresh engine interpreter; return its report."""
    run = subprocess.run(
        [sys.executable, str(PROBE)],
        input=json.dumps(PACKAGES),
        capture_output=True,
        text=True,
        timeout=900,
        cwd=str(_ENGINE_DIR),
        check=False,
    )
    if run.returncode != 0:
        tail = run.stdout[-1500:] + '\n' + run.stderr[-1500:]
        pytest.fail(f'import gate probe failed (exit {run.returncode}):\n{tail}')
    try:
        # The report is the probe's last stdout line (engine status lines may precede it)
        report = json.loads(run.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        tail = run.stdout[-1500:] + '\n' + run.stderr[-1500:]
        pytest.fail(f'import gate probe printed no report:\n{tail}')
    missing = sorted(set(PACKAGES) - set(report))
    assert not missing, f'import gate probe reported nothing for {missing}'
    return report


@pytest.mark.parametrize('package', PACKAGES)
def test_validator_imports_without_the_global(package: str, probe_report: Dict[str, Dict[str, object]]) -> None:
    """Importing the node's validator leaves IGlobal/IInstance out of sys.modules.

    Args:
        package: The node package, e.g. ``nodes.store_qdrant``.
        probe_report: The fresh-interpreter report, one entry per package.
    """
    result = probe_report[package]
    assert result['error'] is None, (
        f'{package}: importing the validator failed: {result["error"]}. '
        'Config mode imports <path>.IValidator only: keep it import-light (rocketlib, stdlib, light clients).'
    )
    heavy = result['heavy']
    assert not heavy, (
        f'{package}: importing the validator loaded {", ".join(heavy)}. '
        'Config mode imports <path>.IValidator only: keep __init__.py empty and the validator import-light.'
    )
