"""Node callbacks must not emit text if an earlier classification callback failed."""

import importlib.util
from pathlib import Path
import sys
import types

import pytest


def test_failed_classification_cannot_emit_on_closing(monkeypatch):
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
