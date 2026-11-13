# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for the anonymize node's failure contract in ``IInstance``.

If ``writeClassifications`` fails, ``closing()`` must not emit the text the node
was holding, which is still the unredacted input. ``IInstance.py`` is loaded by
file path under a synthetic package, with ``rocketlib`` and the package's
``IGlobal`` stubbed through ``monkeypatch`` so they are restored afterwards.

Usage:
    ./builder.cmd nodes:test --pytest-pattern=anonymize --verbose
"""

import importlib.util
from pathlib import Path
import sys
import types

import pytest


def test_failed_classification_cannot_emit_on_closing(monkeypatch):
    """A failed ``writeClassifications`` makes ``closing()`` raise and emit nothing; ``open()`` resets it."""
    root = Path(__file__).parents[2] / 'src/nodes/anonymize'
    package = types.ModuleType('_anonymize_failure_contract')
    package.__path__ = [str(root)]
    glb = types.ModuleType(package.__name__ + '.IGlobal')
    glb.IGlobal = type('IGlobal', (), {})
    monkeypatch.setitem(sys.modules, package.__name__, package)
    monkeypatch.setitem(sys.modules, glb.__name__, glb)
    monkeypatch.setitem(sys.modules, 'rocketlib', types.SimpleNamespace(Entry=object, IInstanceBase=object))
    spec = importlib.util.spec_from_file_location(package.__name__ + '.IInstance', root / 'IInstance.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    instance = module.IInstance()
    assert instance._anonymize_error is None, 'the class default must exist before open() runs'
    emitted = []

    def fail(*args):
        raise RuntimeError('injected prediction failure')

    instance.IGlobal = types.SimpleNamespace(recognizer=types.SimpleNamespace(handleClassifications=fail))
    instance.instance = types.SimpleNamespace(writeText=emitted.append)
    instance.open(None)
    instance.target_object_text = 'Alice Example'
    with pytest.raises(RuntimeError, match='prediction failure'):
        instance.writeClassifications({}, {}, {})
    with pytest.raises(RuntimeError, match='failed anonymization'):
        instance.closing()
    assert emitted == []
    instance.open(None)
    assert instance._anonymize_error is None
