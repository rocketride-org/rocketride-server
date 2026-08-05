"""Unit tests for the depends cache helpers (engine_cache_dir / model_cache_dir).

These live in depends.py (engine-lib) but are consumed by the vision nodes; the
ai test suite runs via the engine, where ``depends`` is importable.
"""

import os

from depends import engine_cache_dir, model_cache_dir


def test_engine_cache_dir_returns_cache_path():
    assert engine_cache_dir().endswith('cache')


def test_engine_cache_dir_create_true_makes_dir():
    path = engine_cache_dir(create=True)
    assert os.path.isdir(path)


def test_model_cache_dir_path_under_engine_cache():
    name = 'unit_test_model'
    path = model_cache_dir(name, create=True)
    assert path == os.path.join(engine_cache_dir(), 'models', name)
    assert os.path.isdir(path)
    os.rmdir(path)  # best-effort cleanup of the leaf


def test_model_cache_dir_create_false_does_not_create():
    name = 'unit_test_no_create_model'
    expected = os.path.join(engine_cache_dir(), 'models', name)
    if os.path.isdir(expected):
        os.rmdir(expected)
    path = model_cache_dir(name, create=False)
    assert path == expected
    assert not os.path.isdir(path)
