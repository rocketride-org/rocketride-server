# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for reading `list_indexes()` entries.

Two shapes have to work. Older pinecone clients yielded plain dicts; from v7
they yield IndexModel description objects, which expose attributes and no
`.get()`. Calling `.get()` on one raises
`'IndexModel' object has no attribute 'get'`, and requirements.txt pins no
version, so which shape arrives depends on when the dependency was resolved.

The serverless check is covered separately because `IndexSpec.to_dict()` emits
every variant it knows about, unset ones included: a pod-based index describes
itself as `{'serverless': None, 'pod': {...}}`. Testing key membership rather
than the value reports pod-based indexes as serverless and emits the opposite
compatibility warning to the one the user needs.

IGlobal is imported directly with its two engine imports stubbed. The driver
module is deliberately untouched -- it pulls in `depends` and the pinecone SDK
at import time, and none of that is needed to exercise these helpers.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

_IGLOBAL_PATH = Path(__file__).resolve().parents[3] / 'nodes' / 'src' / 'nodes' / 'store_pinecone' / 'IGlobal.py'


@contextmanager
def _stubbed_engine_imports() -> Iterator[types.ModuleType]:
    """Import IGlobal.py with `ai.common.store` and `rocketlib` stubbed out."""
    saved = {name: sys.modules.get(name) for name in ('ai', 'ai.common', 'ai.common.store', 'rocketlib')}

    ai = types.ModuleType('ai')
    common = types.ModuleType('ai.common')
    store = types.ModuleType('ai.common.store')
    store.StoreGlobalBase = type('StoreGlobalBase', (), {})
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.warning = lambda *args, **kwargs: None

    sys.modules.update({'ai': ai, 'ai.common': common, 'ai.common.store': store, 'rocketlib': rocketlib})
    try:
        spec = importlib.util.spec_from_file_location('store_pinecone_iglobal', _IGLOBAL_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        yield module
    finally:
        for name, original in saved.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original
        sys.modules.pop('store_pinecone_iglobal', None)


@pytest.fixture(name='iglobal')
def _iglobal() -> Iterator[types.ModuleType]:
    with _stubbed_engine_imports() as module:
        yield module


class _Spec:
    """Stand-in for IndexSpec: unset variants are present and None."""

    def __init__(self, serverless=None, pod=None):
        self.serverless = serverless
        self.pod = pod

    def to_dict(self):
        return {'serverless': self.serverless, 'pod': self.pod, 'byoc': None}


class _IndexModel:
    """Stand-in for a v7+ description object: attributes, and no `.get()`."""

    def __init__(self, name, spec):
        self.name = name
        self.spec = spec


_SERVERLESS_SPEC = {'cloud': 'aws', 'region': 'us-east-1'}
_POD_SPEC = {'environment': 'us-east1-gcp', 'pod_type': 'p1.x1'}


def test_index_model_has_no_get_method():
    """Guards the premise: the old `.get()` call is what fails on v7+ entries."""
    with pytest.raises(AttributeError):
        _IndexModel('idx', _Spec()).get('name')


def test_reads_name_from_a_dict_entry(iglobal):
    entry = {'name': 'my-index', 'spec': {'serverless': _SERVERLESS_SPEC}}
    assert iglobal._index_field(entry, 'name') == 'my-index'


def test_reads_name_from_a_model_entry(iglobal):
    entry = _IndexModel('my-index', _Spec(serverless=_SERVERLESS_SPEC))
    assert iglobal._index_field(entry, 'name') == 'my-index'


def test_missing_field_returns_the_default(iglobal):
    assert iglobal._index_field(_IndexModel('my-index', _Spec()), 'absent', 'fallback') == 'fallback'
    assert iglobal._index_field({'name': 'my-index'}, 'absent', 'fallback') == 'fallback'


def test_nested_spec_object_is_converted_to_a_mapping(iglobal):
    entry = _IndexModel('my-index', _Spec(serverless=_SERVERLESS_SPEC))
    assert iglobal._index_field(entry, 'spec') == {'serverless': _SERVERLESS_SPEC, 'pod': None, 'byoc': None}


@pytest.mark.parametrize(
    ('entry_factory', 'expected'),
    [
        # A pod-based spec still carries a 'serverless' key, set to None.
        (lambda: _IndexModel('idx', _Spec(pod=_POD_SPEC)), False),
        (lambda: _IndexModel('idx', _Spec(serverless=_SERVERLESS_SPEC)), True),
        (lambda: {'name': 'idx', 'spec': {'serverless': None, 'pod': _POD_SPEC}}, False),
        (lambda: {'name': 'idx', 'spec': {'serverless': _SERVERLESS_SPEC}}, True),
        # An entry with no spec at all must not be reported as serverless.
        (lambda: {'name': 'idx'}, False),
    ],
    ids=['model-pod', 'model-serverless', 'dict-pod', 'dict-serverless', 'no-spec'],
)
def test_serverless_detection_reads_the_value_not_the_key(iglobal, entry_factory, expected):
    assert iglobal._is_serverless(entry_factory()) is expected
