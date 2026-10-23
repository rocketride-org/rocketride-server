# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Autopipe makes sure each filter it inserts is known to the engine before inserting it."""

import importlib
from types import SimpleNamespace
from unittest.mock import MagicMock

from rocketlib import OPEN_MODE

# The package re-exports the IGlobal class under the module's own name
autopipe = importlib.import_module('nodes.autopipe.IGlobal')


def test_each_inserted_filter_is_ensured_first(monkeypatch):
    calls = []
    monkeypatch.setattr(autopipe.node_packages, 'ensure', lambda provider: calls.append(('ensure', provider)))
    monkeypatch.setattr(autopipe.Config, 'getNodeConfig', lambda name, config: {})
    endpoint = MagicMock()
    endpoint.openMode = OPEN_MODE.INSTANCE
    endpoint.taskConfig = {'service': {'include': [{'ocr': True}]}, 'autopipe': {}}
    endpoint.insertFilter.side_effect = lambda provider, config: calls.append(('insert', provider))
    node = autopipe.IGlobal.__new__(autopipe.IGlobal)
    node.IEndpoint = SimpleNamespace(endpoint=endpoint)

    node.beginGlobal()

    assert calls == [('ensure', 'parse'), ('insert', 'parse'), ('ensure', 'ocr'), ('insert', 'ocr')]
