# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Configuration contract tests for the Perplexity node.

The model is the selector of the converted definition: its default must be one
of its branches, and the node's test group must exercise that default.
"""

from pathlib import Path

from test.framework.discovery import _parse_service_json

_SERVICES_PATH = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'llm_perplexity' / 'services.json'


def _load_services() -> dict:
    """Load and parse the Perplexity service configuration."""
    services = _parse_service_json(str(_SERVICES_PATH))
    assert services is not None
    return services


def _model_selector(services: dict) -> dict:
    """The ``model`` selector of the node's properties."""
    selector = next(p for p in services['properties'] if isinstance(p, dict) and p.get('name') == 'model')
    assert isinstance(selector['enum'], dict), 'the model selector must be an enum with property sets'
    return selector


def test_default_model_is_declared_and_selectable():
    selector = _model_selector(_load_services())
    assert selector['default'] in selector['enum']


def test_every_branch_pins_its_context_window():
    """The context optimizer's catalog reads the per-model window from the resolved schema."""
    selector = _model_selector(_load_services())
    for model, branch in selector['enum'].items():
        windows = [p for p in branch['properties'] if isinstance(p, dict) and p.get('name') == 'modelTotalTokens']
        assert windows and windows[0]['default'] > 0, f'{model} declares no modelTotalTokens'


def test_node_test_configuration_exercises_the_default_model():
    services = _load_services()
    assert services['test']['profiles'] == [_model_selector(services)['default']]
