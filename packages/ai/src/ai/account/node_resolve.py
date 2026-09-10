# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

# =============================================================================
# NODE RESOLVE — what a pipeline needs that this machine does not have
#
# A published node is never installed. When a pipeline names one the engine
# does not carry, the run fetches it, uses it, and drops it. This module is
# the first half of that: deciding WHICH nodes a run has to go and get, and
# at which version, before anything is downloaded or written.
#
# Kept separate from the fetching on purpose. Detection is pure — a pipeline
# dict, the names the engine already knows, and the caller's pins — so it can
# answer "will this run work?" without touching the network or the disk.
# =============================================================================

"""Deciding which published nodes a pipeline run has to resolve."""

from __future__ import annotations

from typing import Any, Dict, List, Set

from rocketlib import debug

from ai.account.node_deploy import resolve_node_pins


def providers_of(pipeline: Dict[str, Any]) -> Set[str]:
    """Every node type a pipeline names, once each.

    A component's ``provider`` IS the node's protocol id, which is the same id
    a node publishes under — so nothing has to be translated between what a
    pipeline asks for and what the registry holds.
    """
    providers: Set[str] = set()
    for component in pipeline.get('components') or []:
        if not isinstance(component, dict):
            continue
        provider = component.get('provider')
        if isinstance(provider, str) and provider:
            providers.add(provider)
    return providers


def missing_from(providers: Set[str], known: Set[str]) -> Set[str]:
    """The named nodes this engine does not already carry.

    Everything a normal pipeline names is built in, so this is empty for
    almost every run — which is the point. A pipeline of stock nodes must not
    pay for this feature existing.
    """
    return {name for name in providers if name not in known}


class UnresolvedNodes(Exception):
    """A run named nodes it has no way to get.

    Carries the names and the org they were looked for in: "node not found" is
    a dead end, while "not published to you in <org>" tells someone what to do
    about it.
    """

    def __init__(self, names: List[str], org_id: str):
        self.names = names
        self.org_id = org_id
        listed = ', '.join(sorted(names))
        super().__init__(
            f'this pipeline uses {listed}, which this engine does not have and '
            f'which is not published to you in {org_id!r}'
        )


async def plan_for(
    pipeline: Dict[str, Any],
    known: Set[str],
    org_id: str,
    user_id: str | None,
    team_ids: List[str],
) -> List[Dict[str, Any]]:
    """What this run has to fetch, resolved to exact versions.

    Returns one availability entry per node that has to be brought in —
    empty when the engine already carries everything, which is the common
    case and costs one set difference.

    Nothing is fetched or written here. A pin that does not exist stops the
    run BEFORE any bytes move, rather than downloading what it can and
    failing halfway through.

    Raises:
        UnresolvedNodes: a named node with no pin for this caller.
    """
    wanted = missing_from(providers_of(pipeline), known)
    if not wanted:
        return []

    available = {entry['id']: entry for entry in await resolve_node_pins(org_id, user_id, team_ids)}
    unresolved = sorted(name for name in wanted if name not in available)
    if unresolved:
        raise UnresolvedNodes(unresolved, org_id)

    plan = [available[name] for name in sorted(wanted)]
    debug(f'[node_resolve] {len(plan)} node(s) to resolve: {", ".join(entry["id"] for entry in plan)}')
    return plan
