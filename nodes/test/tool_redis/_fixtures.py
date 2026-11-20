# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""Explicitly imported unit fixtures; live tests retain the SDK client fixture."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from test.mocks.redis_fake import FakeRedis
from nodes.tool_redis import IInstance
from nodes.tool_redis.redis_client import RedisStore, Settings


@pytest.fixture
def client():
    client = MagicMock()
    client.pipeline.return_value.__enter__.return_value = client.pipeline.return_value
    return client


@pytest.fixture
def store(client):
    return RedisStore(
        client, Settings.from_config({'key_prefix': 'rr:test:', 'allow_writes': True, 'max_value_bytes': 8})
    )


@pytest.fixture
def tool(store):
    instance = IInstance.__new__(IInstance)
    instance.IGlobal = SimpleNamespace(store=store)
    return instance


@pytest.fixture
def fake_store():
    return RedisStore(FakeRedis(), Settings(allow_writes=True, key_prefix='rr:test:'))
