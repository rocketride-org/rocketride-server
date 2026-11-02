"""Regression coverage for providers in the engine's shipped nodes namespace."""

import sys
from types import ModuleType, SimpleNamespace

import pytest

from ai.common.embedding import getEmbedding


def test_embedding_factory_loads_a_node_provider(monkeypatch):
    provider = 'embedding_factory_test'
    module = ModuleType(f'nodes.{provider}')
    module.getEmbedding = lambda: lambda name, config, bag: SimpleNamespace(name=name, config=config, bag=bag)
    monkeypatch.setitem(sys.modules, module.__name__, module)
    config = {'profile': 'test'}
    bag = {}

    embedding = getEmbedding(provider, config, bag)

    assert embedding.name == provider
    assert embedding.config is config
    assert embedding.bag is bag


def test_embedding_factory_rejects_a_non_embedding_node(monkeypatch):
    provider = 'embedding_factory_test'
    monkeypatch.setitem(sys.modules, f'nodes.{provider}', ModuleType(f'nodes.{provider}'))

    with pytest.raises(Exception, match='is not an embedding provider'):
        getEmbedding(provider, {}, {})
