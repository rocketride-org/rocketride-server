"""
Unit tests for ai.common.account.pipeline_validation.AccountPipelineValidation.

The validator walks a pipeline graph (BFS from ``source``, following the
``input[].from`` lane wiring) and gathers every plan that any reachable node
declares via its service.json schema (``plans`` array). It then returns
True only if the supplied account has every required plan.

External deps:

- ``ai.web.AccountInfo`` — only used as a type hint; the real ``ai.web``
  package is loaded normally so the import succeeds. Tests pass a
  ``SimpleNamespace`` with a ``plans`` attribute at the call site; the
  identity of ``AccountInfo`` is never inspected at runtime.
- ``rocketlib.getServiceDefinition(provider)`` — returns the schema dict for
  a provider id, or None if unknown. Tests patch it via monkeypatch.
"""

from types import SimpleNamespace

import pytest

from ai.common.account import pipeline_validation as pv


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _account(plans):
    """
    Build a stand-in for ``ai.web.AccountInfo`` carrying only what the
    validator reads (a ``plans`` collection).

    Args:
        plans: iterable of plan-name strings.

    Returns:
        SimpleNamespace: an object with a ``plans`` attribute.
    """
    return SimpleNamespace(plans=list(plans))


@pytest.fixture
def patch_service_definitions(monkeypatch):
    """
    Patch ``rocketlib.getServiceDefinition`` with a mapping-driven fake.

    Returns a dict that the test populates: ``{provider_id: schema_dict}``.
    Unknown provider ids resolve to ``None`` (matching real behaviour).

    Args:
        monkeypatch: pytest's monkeypatch fixture.

    Returns:
        dict: caller-mutable provider -> schema map.
    """
    schemas: dict = {}

    def _lookup(provider_id):
        """Return the schema for *provider_id* or None if not in the map."""
        return schemas.get(provider_id)

    monkeypatch.setattr(pv, 'getServiceDefinition', _lookup)
    return schemas


# ---------------------------------------------------------------------------
# validate() — happy paths
# ---------------------------------------------------------------------------


def test_validate_empty_pipeline_passes(patch_service_definitions):
    """A pipeline with no source / components requires no plans, so any account passes."""
    validator = pv.AccountPipelineValidation()
    assert validator.validate(_account([]), {}) is True


def test_validate_pipeline_without_components_passes(patch_service_definitions):
    """Source without components yields no required plans."""
    validator = pv.AccountPipelineValidation()
    pipeline = {'source': 'src', 'components': []}
    assert validator.validate(_account([]), pipeline) is True


def test_validate_passes_when_account_has_all_required_plans(patch_service_definitions):
    """Account with all the required plans passes."""
    patch_service_definitions['providerA'] = {'plans': ['pro']}
    patch_service_definitions['providerB'] = {'plans': ['enterprise']}

    pipeline = {
        'source': 'a',
        'components': [
            {'id': 'a', 'provider': 'providerA', 'input': []},
            {'id': 'b', 'provider': 'providerB', 'input': [{'from': 'a'}]},
        ],
    }
    validator = pv.AccountPipelineValidation()
    assert validator.validate(_account(['pro', 'enterprise']), pipeline) is True


# ---------------------------------------------------------------------------
# validate() — failure paths
# ---------------------------------------------------------------------------


def test_validate_rejects_when_missing_required_plan(patch_service_definitions):
    """Missing one required plan is enough to reject."""
    patch_service_definitions['providerA'] = {'plans': ['pro']}
    patch_service_definitions['providerB'] = {'plans': ['enterprise']}

    pipeline = {
        'source': 'a',
        'components': [
            {'id': 'a', 'provider': 'providerA', 'input': []},
            {'id': 'b', 'provider': 'providerB', 'input': [{'from': 'a'}]},
        ],
    }
    validator = pv.AccountPipelineValidation()
    assert validator.validate(_account(['pro']), pipeline) is False


def test_validate_rejects_when_account_has_no_plans(patch_service_definitions):
    """An empty account.plans list cannot satisfy any required plan."""
    patch_service_definitions['providerA'] = {'plans': ['pro']}
    pipeline = {
        'source': 'a',
        'components': [{'id': 'a', 'provider': 'providerA', 'input': []}],
    }
    validator = pv.AccountPipelineValidation()
    assert validator.validate(_account([]), pipeline) is False


# ---------------------------------------------------------------------------
# _get_pipeline_required_plans() — graph traversal
# ---------------------------------------------------------------------------


def test_required_plans_only_includes_reachable_nodes(patch_service_definitions):
    """BFS starts from ``source``; nodes outside the source's reach are ignored."""
    patch_service_definitions['providerA'] = {'plans': ['plan-a']}
    patch_service_definitions['providerB'] = {'plans': ['plan-b']}
    patch_service_definitions['providerC'] = {'plans': ['plan-c']}

    pipeline = {
        'source': 'a',
        'components': [
            # Reachable from source 'a'
            {'id': 'a', 'provider': 'providerA', 'input': []},
            {'id': 'b', 'provider': 'providerB', 'input': [{'from': 'a'}]},
            # Unreachable orphan node — must be ignored.
            {'id': 'c', 'provider': 'providerC', 'input': [{'from': 'orphan'}]},
        ],
    }
    validator = pv.AccountPipelineValidation()
    plans = validator._get_pipeline_required_plans(pipeline)
    assert plans == {'plan-a', 'plan-b'}


def test_required_plans_handles_branching_graph(patch_service_definitions):
    """A diamond graph (a -> b, a -> c, b/c -> d) collects every node's plans once."""
    patch_service_definitions['pA'] = {'plans': ['a']}
    patch_service_definitions['pB'] = {'plans': ['b', 'shared']}
    patch_service_definitions['pC'] = {'plans': ['c', 'shared']}
    patch_service_definitions['pD'] = {'plans': ['d']}

    pipeline = {
        'source': 'a',
        'components': [
            {'id': 'a', 'provider': 'pA', 'input': []},
            {'id': 'b', 'provider': 'pB', 'input': [{'from': 'a'}]},
            {'id': 'c', 'provider': 'pC', 'input': [{'from': 'a'}]},
            {'id': 'd', 'provider': 'pD', 'input': [{'from': 'b'}, {'from': 'c'}]},
        ],
    }
    validator = pv.AccountPipelineValidation()
    plans = validator._get_pipeline_required_plans(pipeline)
    assert plans == {'a', 'b', 'c', 'd', 'shared'}


def test_required_plans_handles_unknown_node_id(patch_service_definitions):
    """A child reference whose target id is missing from `nodes` is silently skipped."""
    patch_service_definitions['pA'] = {'plans': ['a']}
    pipeline = {
        'source': 'a',
        'components': [
            {'id': 'a', 'provider': 'pA', 'input': []},
            # 'b' references 'a' but 'b' itself never gets a definition we can find.
            {'id': 'b', 'provider': 'unknown_provider', 'input': [{'from': 'a'}]},
        ],
    }
    validator = pv.AccountPipelineValidation()
    plans = validator._get_pipeline_required_plans(pipeline)
    # 'a' contributes plan 'a'; 'b' has no schema -> contributes nothing.
    assert plans == {'a'}


def test_required_plans_handles_provider_without_plans_key(patch_service_definitions):
    """A schema with no 'plans' key is treated as contributing nothing (not crashing)."""
    patch_service_definitions['pA'] = {}  # no 'plans' field at all
    pipeline = {
        'source': 'a',
        'components': [{'id': 'a', 'provider': 'pA', 'input': []}],
    }
    validator = pv.AccountPipelineValidation()
    plans = validator._get_pipeline_required_plans(pipeline)
    assert plans == set()


def test_required_plans_no_source_returns_empty(patch_service_definitions):
    """Without a 'source' field there are no required plans."""
    pipeline = {'components': [{'id': 'x', 'provider': 'pA'}]}
    validator = pv.AccountPipelineValidation()
    assert validator._get_pipeline_required_plans(pipeline) == set()


def test_required_plans_visited_set_prevents_revisit(monkeypatch):
    """A node referenced from multiple parents is only visited once (cycle/dup safety)."""
    schemas = {'pA': {'plans': ['pA']}, 'pB': {'plans': ['pB']}}
    call_count: dict = {}

    def _counting_lookup(provider_id):
        """Increment a per-provider counter and return the matching schema."""
        call_count[provider_id] = call_count.get(provider_id, 0) + 1
        return schemas.get(provider_id)

    monkeypatch.setattr(pv, 'getServiceDefinition', _counting_lookup)

    pipeline = {
        'source': 'a',
        'components': [
            {'id': 'a', 'provider': 'pA', 'input': []},
            # 'b' is referenced twice as a child of 'a' (duplicate edge).
            {'id': 'b', 'provider': 'pB', 'input': [{'from': 'a'}, {'from': 'a'}]},
        ],
    }
    validator = pv.AccountPipelineValidation()
    plans = validator._get_pipeline_required_plans(pipeline)

    assert plans == {'pA', 'pB'}
    # 'b' was queued by both edges from 'a' but should only be processed once.
    assert call_count.get('pB') == 1
