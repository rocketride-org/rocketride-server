# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Every LLM model selector offers a custom branch.

The old definitions accepted a hand-written ``model`` id next to the profile;
a converted selector refuses an id it does not list (plan section 5.6.2), so a
self-hosted or brand-new model is reachable only through the ``custom`` branch:
``customModel`` (required) plus editable token limits, which ChatBase and the
validators read in place of the selector value. Nebius shares the
``llm_openai_api`` driver and must offer it too; the plain ``llm_openai_api``
definition has a free-text ``model`` leaf instead of a selector and is skipped.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import rocketlib
from rocketlib.config import ConfigError, resolveConfig

from test.framework.discovery import _parse_service_json
from test.framework.pipeline import _LLM_MOCK_CREDENTIALS, SchemaPaths

_NODES = Path(__file__).resolve().parents[1] / 'src' / 'nodes'


def _selector_services() -> list:
    """(service file, logical type) of every llm_* definition whose model is a selector."""
    found = []
    for path in sorted(_NODES.glob('llm_*/services*.json')):
        service = _parse_service_json(str(path))
        if not service:
            continue
        selector = next(
            (p for p in service.get('properties') or [] if isinstance(p, dict) and p.get('name') == 'model'), None
        )
        if selector is not None and isinstance(selector.get('enum'), dict):
            found.append((f'{path.parent.name}/{path.name}', service['protocol'].split(':', 1)[0]))
    return found


_SERVICES = _selector_services()


def test_the_selector_definitions_are_found():
    files = [service_file for service_file, _ in _SERVICES]
    assert 'llm_kimi/services.json' in files
    assert 'llm_openai_api/services.nebius.json' in files
    assert 'llm_openai_api/services.json' not in files


@pytest.mark.parametrize('service_file, logical_type', _SERVICES)
def test_the_custom_branch_declares_the_model_id_and_its_limits(service_file, logical_type):
    service = _parse_service_json(str(_NODES / service_file))
    paths = SchemaPaths(service.get('propertyDefinitions') or {}, service.get('properties') or [])
    assert 'custom' in paths.selectors['model'], f'{service_file}: the model selector has no custom branch'
    assert paths.path_for('customModel', 'custom') == 'custom.customModel'
    assert paths.path_for('modelTotalTokens', 'custom') == 'custom.modelTotalTokens'
    assert paths.path_for('modelOutputTokens', 'custom') == 'custom.modelOutputTokens'


@pytest.mark.parametrize('service_file, logical_type', _SERVICES)
def test_a_custom_model_id_resolves_through_the_engine(service_file, logical_type):
    """The id the catalog does not list resolves on the custom branch; the selector refuses it elsewhere."""
    schema = rocketlib.getServiceSchema(logical_type)
    assert schema is not None, f'{logical_type} is not registered with the engine'
    service = _parse_service_json(str(_NODES / service_file))
    paths = SchemaPaths(service.get('propertyDefinitions') or {}, service.get('properties') or [])
    # The framework's mock credentials, kept to the leaves this schema declares
    # (a local-endpoint node has no key to give)
    package = service_file.split('/', 1)[0]
    mock = {'apikey': 'mock-key', **_LLM_MOCK_CREDENTIALS.get(package, {})}
    credentials = {key: value for key, value in mock.items() if key in paths.leaves}

    view = resolveConfig(schema, {**credentials, 'model': 'custom', 'custom': {'customModel': 'my-own-model'}})
    assert view['model'] == 'custom'
    assert view['customModel'] == 'my-own-model'
    assert view['modelTotalTokens'] > 0

    with pytest.raises(ConfigError, match="'my-own-model'"):
        resolveConfig(schema, {**credentials, 'model': 'my-own-model'})
