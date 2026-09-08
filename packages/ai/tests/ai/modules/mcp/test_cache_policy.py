# Copyright 2026 Aparavi Software AG. MIT License.
import pytest

from mcp.client import Client


@pytest.mark.asyncio
async def test_list_tools_carries_cache_hints(fake_engine):
    from ai.modules.mcp.handlers import build_mcp_server
    from ai.modules.mcp.cache_policy import TOOLS_TTL_MS, CACHE_SCOPE

    server = build_mcp_server(lambda: fake_engine)
    async with Client(server) as client:
        result = await client.list_tools()
    # python-side snake_case fields, wire-aliased ttlMs/cacheScope (sdk-api-notes.md §3)
    assert result.ttl_ms == TOOLS_TTL_MS
    assert result.cache_scope == CACHE_SCOPE


@pytest.mark.asyncio
async def test_list_tools_order_is_deterministic_and_pinned(fake_engine):
    """Spec 2026-07-28 SHOULD: deterministic order for client/prompt caching.

    Pins the exact registration order from tools/__init__.register_all:
    introspection, execution, capability, visibility, logs.
    """
    from ai.modules.mcp.handlers import build_mcp_server

    server = build_mcp_server(lambda: fake_engine)
    async with Client(server) as client:
        names_1 = [t.name for t in (await client.list_tools()).tools]
        names_2 = [t.name for t in (await client.list_tools()).tools]
    assert names_1 == names_2
    from .conftest import EXPECTED_TOOL_NAMES

    # Full ordered pin — a reordering anywhere in the list must fail, not
    # just at the first/last few names.
    assert names_1 == list(EXPECTED_TOOL_NAMES)


@pytest.mark.asyncio
async def test_list_resources_carries_cache_hints(fake_engine):
    from ai.modules.mcp.handlers import build_mcp_server
    from ai.modules.mcp.cache_policy import RESOURCES_LIST_TTL_MS, CACHE_SCOPE

    server = build_mcp_server(lambda: fake_engine)
    async with Client(server) as client:
        result = await client.list_resources()
    assert result.ttl_ms == RESOURCES_LIST_TTL_MS
    assert result.cache_scope == CACHE_SCOPE


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'uri,ttl_name',
    [
        ('rocketride://status', 'STATUS_READ_TTL_MS'),
        ('rocketride://pipelines', 'PIPELINES_READ_TTL_MS'),
    ],
)
async def test_read_resource_carries_cache_hints(fake_engine, uri, ttl_name):
    from ai.modules.mcp import cache_policy
    from ai.modules.mcp.handlers import build_mcp_server

    server = build_mcp_server(lambda: fake_engine)
    async with Client(server) as client:
        result = await client.read_resource(uri)
    assert result.ttl_ms == getattr(cache_policy, ttl_name)
    assert result.cache_scope == cache_policy.CACHE_SCOPE


@pytest.mark.asyncio
async def test_read_resource_unknown_uri_defaults_to_uncached(monkeypatch, fake_engine):
    """Unknown URIs must default to ttl_ms == 0 (safe uncached).

    Pins the else branch to prevent regression to the binary if/else that
    silently inherited 30s pipelines TTL.
    """
    from ai.modules.mcp import cache_policy, resources as resources_mod
    from ai.modules.mcp.handlers import build_mcp_server

    # Monkeypatch read_resource to accept the unknown URI without raising
    original_read_resource = resources_mod.read_resource

    async def _read_resource_permissive(client, uri):
        if uri in ('rocketride://status', 'rocketride://pipelines'):
            return await original_read_resource(client, uri)
        # For unknown URIs, return a dummy response so we can test cache logic
        return '{}'

    monkeypatch.setattr(resources_mod, 'read_resource', _read_resource_permissive)

    # STATUS_READ_TTL_MS is also 0, so make the else branch distinguishable
    # from the status branch — the assert below must fail if unknown URIs
    # ever fall through to the status TTL.
    import ai.modules.mcp.handlers as handlers_mod

    monkeypatch.setattr(handlers_mod, 'STATUS_READ_TTL_MS', 5_000)

    server = build_mcp_server(lambda: fake_engine)
    async with Client(server) as client:
        result = await client.read_resource('rocketride://unknown')
    assert result.ttl_ms == 0
    assert result.cache_scope == cache_policy.CACHE_SCOPE
