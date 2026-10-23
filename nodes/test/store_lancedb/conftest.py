# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Shared fixtures for the store_lancedb tests.

LanceDB is embedded, so these tests run the real driver against a real LanceDB
table in a temporary directory: no mocks and no Docker. The Doc models and
DocumentStoreBase are real too. Run them with the built engine, which installs
the node's requirements when the driver is imported.
"""

from __future__ import annotations

import random
from typing import Any, Callable, Dict

import pytest

pytest.importorskip('rocketlib', reason='Run these tests with the built engine')

from ai.common.config import Config  # noqa: E402

from nodes.store_lancedb import lancedb_store  # noqa: E402


@pytest.fixture
def rng() -> random.Random:
    return random.Random(2804)


@pytest.fixture
def make_store(tmp_path, monkeypatch) -> Callable[..., Any]:
    """Return a factory that opens a Store on a temporary directory.

    Keyword arguments override the node configuration. Each call opens a new
    Store on the same directory unless ``uri`` says otherwise, which lets a
    test check what a fresh engine process would see.
    """
    defaults: Dict[str, Any] = {
        'uri': str(tmp_path / 'lancedb'),
        'table': 'ROCKETRIDE',
        'distance': 'cosine',
        'searchMode': 'vector',
        'indexAfterRows': 0,
        'optimizeAfterWrites': 0,
        'score': 0.5,
    }
    monkeypatch.setattr(lancedb_store, 'CONST_TASK_DATA_PATH', str(tmp_path / 'data'))

    def factory(**overrides: Any):
        config = {**defaults, **overrides}
        monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda provider, connConfig: dict(config)))
        return lancedb_store.Store('lancedb', {}, {})

    return factory
