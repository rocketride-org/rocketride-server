# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""Explicitly imported Redis unit fixtures scoped to tests that request them."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from test.mocks.redis_fake import FakeRedis
from nodes.tool_redis.IInstance import IInstance
from nodes.tool_redis.IValidator import CALL_KEYS
from nodes.tool_redis.redis_client import RedisStore, Settings


def tool_for(store: RedisStore) -> IInstance:
    """One call whose control holds ``store``'s client and whose settings are ``store``'s.

    The node builds each call's store from the control's client and the call's
    settings, so this instance builds a store equal to ``store`` on every call.
    """
    instance = IInstance.__new__(IInstance)
    instance.IGlobal = SimpleNamespace(client=store.client)
    # The call's settings (IInstanceBase.settings serves them once set)
    instance._settings = {key: getattr(store.settings, key) for key in CALL_KEYS}
    return instance


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
    return tool_for(store)


@pytest.fixture
def fake_store():
    return RedisStore(FakeRedis(), Settings(allow_writes=True, key_prefix='rr:test:'))
