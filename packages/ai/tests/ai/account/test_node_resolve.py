# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Deciding which published nodes a run has to fetch.

What these pin is the decision, not the fetching: that a pipeline of stock
nodes resolves to nothing at all, that a node with no pin stops the run before
any bytes move, and that the failure names what is missing and where it looked.
"""

from __future__ import annotations

import pytest

from ai.account import node_resolve


def _pipeline(*providers):
    """A pipeline shell carrying one component per provider named."""
    return {'components': [{'provider': name, 'config': {}} for name in providers]}


@pytest.fixture
def published(monkeypatch):
    """Whatever the caller has pins for, keyed by node id."""
    entries = {}

    async def resolve_node_pins(org_id, user_id, team_ids):
        return list(entries.values())

    monkeypatch.setattr(node_resolve, 'resolve_node_pins', resolve_node_pins)

    def add(node_id, version=1, **extra):
        entries[node_id] = {'id': node_id, 'version': version, 'requirements': [], **extra}

    return add


# =============================================================================
# DETECTION
# =============================================================================


class TestProviders:
    """Reading what a pipeline asks for."""

    def test_every_provider_is_named(self):
        assert node_resolve.providers_of(_pipeline('llm_openai', 'store_chroma')) == {'llm_openai', 'store_chroma'}

    def test_a_provider_used_twice_counts_once(self):
        assert node_resolve.providers_of(_pipeline('llm_openai', 'llm_openai')) == {'llm_openai'}

    def test_a_pipeline_with_no_components_asks_for_nothing(self):
        assert node_resolve.providers_of({}) == set()

    def test_malformed_components_are_skipped_not_fatal(self):
        # A pipeline is user input; a stray null must not take the run down
        # before it starts.
        pipeline = {'components': [None, 'nonsense', {'provider': 'llm_openai'}, {'no_provider': 1}]}
        assert node_resolve.providers_of(pipeline) == {'llm_openai'}

    def test_missing_is_what_the_engine_lacks(self):
        assert node_resolve.missing_from({'a', 'b'}, {'b'}) == {'a'}


# =============================================================================
# THE PLAN
# =============================================================================


class TestPlan:
    """What a run has to go and get, before anything moves."""

    @pytest.mark.asyncio
    async def test_a_pipeline_of_stock_nodes_resolves_nothing(self, published):
        # The common case: no lookup, no fetch, no cost.
        plan = await node_resolve.plan_for(_pipeline('llm_openai'), {'llm_openai'}, 'org1', 'u1', [])
        assert plan == []

    @pytest.mark.asyncio
    async def test_a_published_node_is_planned_with_its_version(self, published):
        published('ticket_feed', version=3)
        plan = await node_resolve.plan_for(_pipeline('llm_openai', 'ticket_feed'), {'llm_openai'}, 'org1', 'u1', [])
        assert [(entry['id'], entry['version']) for entry in plan] == [('ticket_feed', 3)]

    @pytest.mark.asyncio
    async def test_an_unpinned_node_stops_the_run(self, published):
        with pytest.raises(node_resolve.UnresolvedNodes) as caught:
            await node_resolve.plan_for(_pipeline('ticket_feed'), set(), 'org1', 'u1', [])
        assert caught.value.names == ['ticket_feed']

    @pytest.mark.asyncio
    async def test_the_failure_names_the_node_and_the_org(self, published):
        # "not found" is a dead end; naming the org tells someone what to do.
        with pytest.raises(node_resolve.UnresolvedNodes) as caught:
            await node_resolve.plan_for(_pipeline('ticket_feed'), set(), 'acme', 'u1', [])
        assert 'ticket_feed' in str(caught.value)
        assert 'acme' in str(caught.value)

    @pytest.mark.asyncio
    async def test_one_unresolvable_node_stops_the_whole_run(self, published):
        # Not "fetch what we can": a run missing one of its nodes cannot work,
        # so it fails before downloading the others.
        published('ticket_feed')
        with pytest.raises(node_resolve.UnresolvedNodes) as caught:
            await node_resolve.plan_for(_pipeline('ticket_feed', 'sentiment'), set(), 'org1', 'u1', [])
        assert caught.value.names == ['sentiment']

    @pytest.mark.asyncio
    async def test_every_missing_node_is_reported_at_once(self, published):
        # Fixing them one run at a time would be miserable.
        with pytest.raises(node_resolve.UnresolvedNodes) as caught:
            await node_resolve.plan_for(_pipeline('b_node', 'a_node'), set(), 'org1', 'u1', [])
        assert caught.value.names == ['a_node', 'b_node']

    @pytest.mark.asyncio
    async def test_a_node_the_engine_carries_is_never_looked_up(self, published):
        # A published node sharing a name with a built-in must not shadow it:
        # what the engine has already wins, and nothing is fetched.
        published('llm_openai', version=9)
        plan = await node_resolve.plan_for(_pipeline('llm_openai'), {'llm_openai'}, 'org1', 'u1', [])
        assert plan == []
