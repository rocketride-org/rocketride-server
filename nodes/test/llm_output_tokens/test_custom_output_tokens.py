# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The output limit can be set on a custom model, wherever the node uses it.

Each LLM node sends ``modelOutputTokens`` to its provider as the reply's length limit
(``max_tokens``). Built-in models carry their own limit. A custom model (the "custom"
profile, where the user types the model name) had no field for it, so it got
whatever the node fell back to: on nodes that resolve their settings twice, the
default profile's limit (128,000 on Anthropic and OpenAI); elsewhere ChatBase's
4,096, which a reasoning model can spend entirely on thinking and return nothing.
Either way the settings form could not change it.

These tests check, for every node that sends the value and offers a custom model:
the custom form has the field (optional, no default, so an old pipeline is left as
it was), and, through the node's real startup path, that a value typed in the form
reaches the request, that a custom model without one keeps the limit it had, and
that a hand-written top-level limit that overrides the form is reported.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

from test.framework.discovery import _parse_service_json

_NODES = Path(__file__).resolve().parents[2] / 'src' / 'nodes'
_CONFIG_PY = Path(__file__).resolve().parents[3] / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'config.py'


def _uses_output_limit(node_dir: Path) -> bool:
    """True when the node's driver sends the configured output limit to its provider."""
    return any('self._modelOutputTokens' in p.read_text(encoding='utf-8') for p in node_dir.glob('*.py'))


def _service(service_file: str) -> dict:
    service = _parse_service_json(str(_NODES / service_file))
    assert service is not None
    return service


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
            if 'custom' in (_service(service_file).get('preconfig', {}).get('profiles') or {}):
                found.append(service_file)
    return found


def _custom_form_fields(service: dict) -> list:
    """The field ids the settings form shows when the "custom" profile is chosen."""
    fields = service['fields']
    shown = []
    for selector in fields.values():
        options = selector.get('conditional') if isinstance(selector, dict) else None
        for option in options or []:
            if option.get('value') != 'custom':
                continue
            for name in option.get('properties') or []:
                shown.extend(fields.get(name, {}).get('properties') or [])
    return shown


def _output_field(service: dict, service_file: str) -> dict:
    """The custom form's field that saves as modelOutputTokens (a field saves under the last part of its id)."""
    shown = _custom_form_fields(service)
    ids = [name for name in shown if name.split('.')[-1] == 'modelOutputTokens']
    assert ids, f'{service_file}: the custom model form has no output limit field ({shown})'
    return service['fields'][ids[0]]


def test_the_services_are_found():
    """Guards the discovery below: the services this change is about must all be in it."""
    services = _custom_services()

    for service_file in (
        'llm_anthropic/services.json',
        'llm_openai/services.json',
        'llm_openai_api/services.json',
        'llm_openai_api/services.nebius.json',
        'llm_bedrock/services.json',
        'llm_ollama/services.json',
        'llm_xai/services.json',
    ):
        assert service_file in services


@pytest.mark.parametrize('service_file', _custom_services())
def test_the_custom_form_offers_the_output_limit(service_file):
    """An optional whole number from 1,024, with no default.

    ChatBase refuses anything under 1,024 or not a whole number when the node
    starts, so the form refuses it first. Optional, because fields are required
    otherwise and a custom model saved before this field existed would show as not
    configured. No default, because the form saves its default into the settings:
    opening and saving an old pipeline would then write a limit it never had (a
    custom model has had its node's default limit, not 4,096; see the startup test).
    """
    field = _output_field(_service(service_file), service_file)

    assert field['type'] == 'integer'
    assert field.get('minimum', 0) >= 1024
    assert field.get('optional') is True
    assert 'default' not in field


def _real_get_node_config(service: dict, warnings: list | None = None):
    """The real Config.getNodeConfig, behind a rocketlib stub that serves ``service``."""

    class FakeIJson:
        @staticmethod
        def toDict(value):
            return dict(value)

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.getServiceDefinition = lambda logicalType: service
    rocketlib.IJson = FakeIJson
    rocketlib.warning = warnings.append if warnings is not None else (lambda *a, **kw: None)
    stubs = {'rocketlib': rocketlib}
    if importlib.util.find_spec('json5') is None:
        json5 = types.ModuleType('json5')
        json5.loads = json.loads
        stubs['json5'] = json5

    saved = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    name = '_llm_output_tokens_config_under_test'
    try:
        spec = importlib.util.spec_from_file_location(name, _CONFIG_PY)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module.Config.getNodeConfig
    finally:
        sys.modules.pop(name, None)
        for key, value in saved.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value


class _RecordingChatOpenAI:
    """Stand-in for langchain_openai.ChatOpenAI that records what it was built with."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs


def _openai_stub() -> types.ModuleType:
    """Stand-in for the openai package: the driver builds a raw client for reasoning models."""
    stub = types.ModuleType('openai')
    stub.OpenAI = _RecordingChatOpenAI
    for name in ('APIError', 'AuthenticationError', 'RateLimitError', 'APIConnectionError'):
        setattr(stub, name, type(name, (Exception,), {}))
    return stub


def _sent_limit(chat) -> int:
    """The output limit the driver gave the client: max_tokens, or max_completion_tokens for reasoning models."""
    kwargs = chat._llm.kwargs
    return kwargs.get('max_tokens') or kwargs.get('model_kwargs', {}).get('max_completion_tokens')


def _start_openai_node(monkeypatch, conn_config: dict, warnings: list | None = None):
    """Start the OpenAI node the way its IGlobal does, with the client stubbed.

    IGlobal.beginGlobal resolves the node's settings and passes the result to Chat,
    and ChatBase resolves them again. Both resolutions are the real getNodeConfig.
    The second has no "profile" left, so it fills what is still missing from the
    node's default profile.
    """
    from ai.common.config import Config

    get_node_config = _real_get_node_config(_service('llm_openai/services.json'), warnings)
    stub = types.ModuleType('langchain_openai')
    stub.ChatOpenAI = _RecordingChatOpenAI
    monkeypatch.setitem(sys.modules, 'langchain_openai', stub)
    monkeypatch.setitem(sys.modules, 'openai', _openai_stub())
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(get_node_config))
    spec = importlib.util.spec_from_file_location(
        '_llm_openai_client_output', _NODES / 'llm_openai' / 'openai_client.py'
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    config = get_node_config('llm_openai', conn_config)  # what IGlobal.beginGlobal does
    return module.Chat('llm_openai', config, {})


_CUSTOM = {'model': 'my-model', 'apikey': 'sk-test', 'modelTotalTokens': 200000}


def test_a_value_from_the_form_reaches_the_request(monkeypatch):
    """Custom OpenAI model, output limit 32,000 typed in the form: the client is built with it."""
    chat = _start_openai_node(monkeypatch, {'profile': 'custom', 'custom': {**_CUSTOM, 'modelOutputTokens': 32000}})

    assert _sent_limit(chat) == 32000


def test_a_custom_model_saved_before_this_change_keeps_its_limit(monkeypatch):
    """Nothing changes until someone sets the field.

    A custom model without a value has always got its node's default limit through
    the second resolution (128,000 for OpenAI today), not the 4,096 fallback, so the
    custom profile must not gain a value of its own.
    """
    service = _service('llm_openai/services.json')
    default = service['preconfig']['profiles'][service['preconfig']['default']]['modelOutputTokens']

    chat = _start_openai_node(monkeypatch, {'profile': 'custom', 'custom': dict(_CUSTOM)})

    assert 'modelOutputTokens' not in service['preconfig']['profiles']['custom']
    assert _sent_limit(chat) == min(default, _CUSTOM['modelTotalTokens'])


def test_a_hand_written_top_level_limit_that_differs_from_the_form_is_reported(monkeypatch):
    """Before the field existed, the limit could only be written into the pipeline by hand.

    A top-level value beats the nested one the form edits, so an edit in the form
    would change nothing. getNodeConfig keeps that rule and says so, while it still
    sees both values (IGlobal's resolution; ChatBase only gets the result).
    """
    warnings = []
    conn = {'profile': 'custom', 'modelOutputTokens': 32000, 'custom': {**_CUSTOM, 'modelOutputTokens': 8192}}

    chat = _start_openai_node(monkeypatch, conn, warnings)

    assert _sent_limit(chat) == 32000
    assert len(warnings) == 1
    assert '32000 at the top level' in warnings[0] and '8192 in the "custom" settings' in warnings[0]


def test_a_stale_block_of_another_profile_is_not_reported(monkeypatch):
    """Only the selected profile's settings are in play; another profile's leftovers are not."""
    service = _service('llm_openai/services.json')
    warnings = []
    conn = {'profile': service['preconfig']['default'], 'modelOutputTokens': 32000}
    conn['custom'] = {**_CUSTOM, 'modelOutputTokens': 8192}

    _start_openai_node(monkeypatch, conn, warnings)

    assert warnings == []
