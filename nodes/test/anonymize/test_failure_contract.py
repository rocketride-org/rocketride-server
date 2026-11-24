# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for the anonymize node's failure contract in ``IInstance``.

If ``writeClassifications`` fails, ``closing()`` must not emit the text the node
was holding, which is still the unredacted input. ``IInstance.py`` is loaded by
file path under a synthetic package, with ``rocketlib`` and the package's
``IGlobal`` stubbed through ``monkeypatch`` so they are restored afterwards. The
package's ``anonymize`` helper module is the real one, loaded the same way.

The redaction (style and mask character) is the call's own setting, read from
``self.settings`` when the classifications arrive, so a setting that does not
resolve is one more way ``writeClassifications`` can fail.

Usage:
    ./builder.cmd nodes:test --pytest-pattern=anonymize --verbose
"""

import importlib.util
from pathlib import Path
import sys
import types

import pytest


def _load(monkeypatch, root: Path, package: types.ModuleType, name: str):
    """Load ``<root>/<name>.py`` as a submodule of the synthetic package; removed again with the test."""
    spec = importlib.util.spec_from_file_location(f'{package.__name__}.{name}', root / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def make_instance(monkeypatch):
    """Build an ``IInstance`` whose recognizer and settings the test supplies; returns it with what it emitted."""
    root = Path(__file__).parents[2] / 'src/nodes/anonymize'
    package = types.ModuleType('_anonymize_failure_contract')
    package.__path__ = [str(root)]
    glb = types.ModuleType(package.__name__ + '.IGlobal')
    glb.IGlobal = type('IGlobal', (), {})
    monkeypatch.setitem(sys.modules, package.__name__, package)
    monkeypatch.setitem(sys.modules, glb.__name__, glb)
    monkeypatch.setitem(sys.modules, 'rocketlib', types.SimpleNamespace(Entry=object, IInstanceBase=object))
    _load(monkeypatch, root, package, 'anonymize')
    module = _load(monkeypatch, root, package, 'IInstance')

    def _make(handle_classifications, settings):
        instance = module.IInstance()
        assert instance._anonymize_error is None, 'the class default must exist before open() runs'
        emitted = []
        instance.IGlobal = types.SimpleNamespace(
            recognizer=types.SimpleNamespace(handleClassifications=handle_classifications)
        )
        instance.instance = types.SimpleNamespace(writeText=emitted.append)
        instance.settings = settings
        return instance, emitted

    return _make


def test_failed_classification_cannot_emit_on_closing(make_instance):
    """A failed ``writeClassifications`` makes ``closing()`` raise and emit nothing; ``open()`` resets it."""
    calls = []

    def fail(*args, **redaction):
        calls.append(redaction)
        raise RuntimeError('injected prediction failure')

    settings = types.SimpleNamespace(redactionStyle='mask', anonymizeChar='X', entityTypes=['person'])
    instance, emitted = make_instance(fail, settings)
    instance.open(None)
    instance.target_object_text = 'Alice Example'
    with pytest.raises(RuntimeError, match='prediction failure'):
        instance.writeClassifications({}, {}, {})
    assert calls == [{'redaction_style': 'mask', 'anonymize_char': 'X'}], 'the recognizer got this call redaction'
    with pytest.raises(RuntimeError, match='failed anonymization'):
        instance.closing()
    assert emitted == []
    instance.open(None)
    assert instance._anonymize_error is None


def test_a_redaction_setting_that_does_not_resolve_cannot_emit_on_closing(make_instance):
    """The call's redaction is read inside the guard: when it fails, the held text is still unredacted."""

    class Unresolved:
        """Settings whose every read fails, as a value that does not fit its definition does."""

        def __getattr__(self, name):
            raise ValueError(f'{name} does not resolve')

    def never_called(*args, **redaction):
        raise AssertionError('the recognizer must not run without a redaction')

    instance, emitted = make_instance(never_called, Unresolved())
    instance.open(None)
    instance.target_object_text = 'Alice Example'
    with pytest.raises(ValueError, match='redactionStyle does not resolve'):
        instance.writeClassifications({}, {}, {})
    with pytest.raises(RuntimeError, match='failed anonymization'):
        instance.closing()
    assert emitted == []
