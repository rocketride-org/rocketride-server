"""Regression tests for the temporary engine import helper."""

import importlib
import sys
import types

from tests._engine_stubs import import_with_engine_stubs


def _write_package(tmp_path, package_name, child_source):
    package = tmp_path / package_name
    package.mkdir()
    (package / '__init__.py').write_text('')
    (package / 'child.py').write_text(child_source)
    return package


def test_import_with_engine_stubs_restores_modules_and_parent_attributes(tmp_path, monkeypatch):
    """Temporary imports must not leak modules or child attributes."""
    _write_package(tmp_path, 'test_helper_parent', 'VALUE = 1\n')
    monkeypatch.syspath_prepend(str(tmp_path))

    parent = importlib.import_module('test_helper_parent')
    original_child = types.ModuleType('test_helper_parent.child')
    parent.child = original_child
    monkeypatch.setitem(sys.modules, 'test_helper_parent.child', original_child)

    imported = import_with_engine_stubs('test_helper_parent.child')

    assert imported is not original_child
    assert sys.modules['test_helper_parent'] is parent
    assert sys.modules['test_helper_parent.child'] is original_child
    assert parent.child is original_child


def test_import_with_engine_stubs_removes_transitive_modules(tmp_path, monkeypatch):
    """Modules created by a temporary import disappear after it returns."""
    package = _write_package(tmp_path, 'test_helper_transitive', 'import test_helper_transitive.extra\n')
    (package / 'extra.py').write_text('VALUE = 1\n')
    monkeypatch.syspath_prepend(str(tmp_path))

    import_with_engine_stubs('test_helper_transitive.child')

    assert 'test_helper_transitive.child' not in sys.modules
    assert 'test_helper_transitive.extra' not in sys.modules
