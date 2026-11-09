# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The output limit can be set on a custom model, wherever the node uses it.

Each LLM node sends ``modelOutputTokens`` to its provider as the reply's length limit
(``max_tokens``). Built-in models pin their own limit as a constant of their branch.
A custom model (the "custom" branch of the model selector, where the user types the
model id) carries an editable limit of its own, defaulting to the node's default
model's limit, so a custom model that sets nothing keeps the limit it always had
rather than ChatBase's 4,096 fallback, which a reasoning model can spend entirely
on thinking and return nothing.

These tests check, for every service whose model selector offers a custom model and
whose driver sends the value: the custom branch declares the field (an integer from
1,024) and, through the node's real startup path on the engine-resolved schema, that
a value typed in the form reaches the request, that a custom model without one keeps
the default model's limit, that a limit written at the top level (where the old
format kept it) is refused by name, and that another branch's leftover block is
ignored, not reported.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import rocketlib
from rocketlib.config import ConfigError, resolveConfig

from test.framework.discovery import _parse_service_json
from test.framework.pipeline import SchemaPaths

_NODES = Path(__file__).resolve().parents[2] / 'src' / 'nodes'
while str(_NODES) in sys.path:
    sys.path.remove(str(_NODES))
sys.path.insert(0, str(_NODES))

from llm_openai import openai_client  # noqa: E402


def _uses_output_limit(node_dir: Path) -> bool:
    """True when the node's driver sends the configured output limit to its provider."""
    return any('self._modelOutputTokens' in p.read_text(encoding='utf-8') for p in node_dir.glob('*.py'))


def _service(service_file: str) -> dict:
    service = _parse_service_json(str(_NODES / service_file))
    assert service is not None
    return service


def _model_selector(service: dict) -> dict | None:
    """The ``model`` selector of a converted definition, or None when the model is a plain leaf."""
    for prop in service.get('properties') or []:
        if isinstance(prop, dict) and prop.get('name') == 'model' and isinstance(prop.get('enum'), dict):
            return prop
    return None


def _custom_services() -> list:
    """Every service file of an LLM node that sends the output limit and offers a custom model.

    A node can define several services, one per file, all run by its one driver
    (llm_openai_api also serves Nebius from services.nebius.json).
    """
    found = []
    for node_dir in sorted(_NODES.glob('llm_*')):
        if not _uses_output_limit(node_dir):
            continue
        for path in sorted(node_dir.glob('services*.json')):
            service_file = f'{node_dir.name}/{path.name}'
            selector = _model_selector(_service(service_file))
            if selector is not None and 'custom' in selector['enum']:
                found.append(service_file)
    return found


def _custom_output_field(service: dict, service_file: str) -> dict:
    """The custom branch's leaf that resolves as modelOutputTokens."""
    paths = SchemaPaths(service.get('propertyDefinitions') or {}, service.get('properties') or [])
    path = paths.path_for('modelOutputTokens', 'custom')
    assert path == 'custom.modelOutputTokens', f'{service_file}: the custom branch has no output limit ({path})'
    selector = _model_selector(service)
    definitions = service['propertyDefinitions']
    for specifier in selector['enum']['custom']['properties']:
        name = specifier if isinstance(specifier, str) else specifier.get('base') or specifier.get('name')
        if str(name).rsplit('.', 1)[-1] == 'modelOutputTokens':
            field = dict(definitions.get(name) or (specifier if isinstance(specifier, dict) else {}))
            while 'base' in field:
                field = {**definitions[field.pop('base')], **field}
            return field
    raise AssertionError(f'{service_file}: the custom branch lists no modelOutputTokens leaf')


def test_the_services_are_found():
    """Guards the discovery below: the services this change is about must all be in it."""
    services = _custom_services()
    for service_file in (
        'llm_anthropic/services.json',
        'llm_openai/services.json',
        'llm_openai_api/services.nebius.json',
        'llm_bedrock/services.json',
        'llm_ollama/services.json',
        'llm_xai/services.json',
    ):
        assert service_file in services


@pytest.mark.parametrize('service_file', _custom_services())
def test_the_custom_branch_offers_the_output_limit(service_file):
    """A whole number from 1,024.

    ChatBase refuses anything under 1,024 or not a whole number when the node
    starts, so the form refuses it first. Defaults are never written by the form
    (plan section 5.6.2), so the leaf may carry the default model's limit without
    rewriting a pipeline that never set one.
    """
    field = _custom_output_field(_service(service_file), service_file)
    assert field['type'] == 'integer'
    assert field.get('minimum', 0) >= 1024


class _RecordingClient:
    """Stand-in for the OpenAI clients that records what it was built with."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs


def _sent_limit(chat) -> int:
    """The output limit the driver gave the client: max_tokens, or max_completion_tokens for reasoning models."""
    kwargs = chat._llm.kwargs
    return kwargs.get('max_tokens') or kwargs.get('model_kwargs', {}).get('max_completion_tokens')


def _start_openai_node(monkeypatch, conn_config: dict):
    """Start the OpenAI node the way its IGlobal does: resolve the stored config, hand the view to Chat."""
    monkeypatch.setattr(openai_client, 'ChatOpenAI', _RecordingClient)
    monkeypatch.setattr(openai_client, 'OpenAI', _RecordingClient)
    schema = rocketlib.getServiceSchema('llm_openai')
    assert schema is not None, 'llm_openai is not registered with the engine'
    return openai_client.Chat('llm_openai', resolveConfig(schema, conn_config), {})


_CUSTOM = {'customModel': 'my-model', 'modelTotalTokens': 200000}


def _default_output_limit() -> int:
    """The default model's pinned output limit, which the custom branch inherits."""
    service = _service('llm_openai/services.json')
    selector = _model_selector(service)
    branch = selector['enum'][selector['default']]
    return next(
        p['default'] for p in branch['properties'] if isinstance(p, dict) and p.get('name') == 'modelOutputTokens'
    )


def test_a_value_from_the_form_reaches_the_request(monkeypatch):
    """Custom OpenAI model, output limit 32,000 typed in the form: the client is built with it."""
    chat = _start_openai_node(
        monkeypatch, {'model': 'custom', 'apikey': 'sk-test', 'custom': {**_CUSTOM, 'modelOutputTokens': 32000}}
    )
    assert _sent_limit(chat) == 32000


def test_a_custom_model_without_a_value_keeps_the_default_models_limit(monkeypatch):
    """Nothing set in the form: the default model's limit applies, clamped to the custom window."""
    chat = _start_openai_node(monkeypatch, {'model': 'custom', 'apikey': 'sk-test', 'custom': dict(_CUSTOM)})
    assert _sent_limit(chat) == min(_default_output_limit(), _CUSTOM['modelTotalTokens'])


def test_a_top_level_limit_is_refused_by_name(monkeypatch):
    """The old format kept a hand-written limit at the top level; the schema has no leaf there."""
    conn = {
        'model': 'custom',
        'apikey': 'sk-test',
        'modelOutputTokens': 32000,
        'custom': {**_CUSTOM, 'modelOutputTokens': 8192},
    }
    with pytest.raises(ConfigError, match='unknown config key "modelOutputTokens"'):
        _start_openai_node(monkeypatch, conn)


def test_a_stale_block_of_another_branch_is_not_reported(monkeypatch):
    """Only the selected branch's settings are in play; the custom block is kept for a switch back."""
    service = _service('llm_openai/services.json')
    default_model = _model_selector(service)['default']
    chat = _start_openai_node(
        monkeypatch, {'model': default_model, 'apikey': 'sk-test', 'custom': {**_CUSTOM, 'modelOutputTokens': 8192}}
    )
    assert chat._model == default_model
    assert _sent_limit(chat) == _default_output_limit()
