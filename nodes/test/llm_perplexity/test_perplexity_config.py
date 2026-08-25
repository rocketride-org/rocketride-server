# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Configuration contract tests for the Perplexity node."""

from pathlib import Path

from test.framework.discovery import _parse_service_json


_SERVICES_PATH = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'llm_perplexity' / 'services.json'


def _load_services() -> dict:
    """Load and parse the Perplexity service configuration."""
    services = _parse_service_json(str(_SERVICES_PATH))
    assert services is not None
    return services


def test_profile_selector_default_matches_preconfig_default():
    services = _load_services()

    assert services['fields']['perplexity.profile']['default'] == services['preconfig']['default']


def test_default_profile_is_declared_and_selectable():
    services = _load_services()
    default = services['preconfig']['default']
    selector_values = {option['value'] for option in services['fields']['perplexity.profile']['conditional']}

    assert default in services['preconfig']['profiles']
    assert default in selector_values


def test_node_test_configuration_exercises_the_default_profile():
    services = _load_services()

    assert services['test']['profiles'] == [services['preconfig']['default']]
