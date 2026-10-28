# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The model id and vendor a Bedrock node sends, at save time and at run time.

The node adds a cross-region prefix (``us.``, ``eu.``, ``apac.``) to a plain model id.
The save-time check left ARNs and already-prefixed ids alone, as the README says, but
the pipeline prefixed every id, so ``us.anthropic.claude-...`` passed the check and then
went out as ``us.us.anthropic.claude-...``, and an ARN went out as ``us.arn:aws:...``.
ARNs also failed because langchain-aws refuses to guess the vendor from one and the node
never passed ``provider``.

These tests run the real IGlobal and driver against a ChatBedrock stand-in that records
what it is built with, so they check both paths send the same id. No key or network is
used.
"""

from __future__ import annotations

import contextvars
import importlib.util
import sys
import types
from pathlib import Path

import pytest

_PACKAGE = 'llm_bedrock_under_test'
_NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'llm_bedrock'

_SONNET = 'anthropic.claude-sonnet-4-5-20250929-v1:0'
_PROFILE_ARN = f'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.{_SONNET}'
_PROVISIONED_ARN = 'arn:aws:bedrock:us-east-1:123456789012:provisioned-model/abc123xyz'


def _load(monkeypatch, overrides: dict | None = None):
    """Load the node's driver and IGlobal against stub SDKs.

    Args:
        monkeypatch: pytest monkeypatch fixture
        overrides: keys to change in the node configuration

    Returns:
        (driver module, IGlobal instance, ChatBedrock builds, warnings)
    """
    builds: list[dict] = []
    warnings: list[str] = []
    config = {
        'model': _SONNET,
        'accessKey': 'AKIDEXAMPLE',
        'secretKey': 'secret-example',
        'region': 'us-east-1',
        'modelTotalTokens': 200000,
        'modelOutputTokens': 8192,
    }
    config.update(overrides or {})

    class Config:
        """Serves the configuration under test."""

        @staticmethod
        def getNodeConfig(_logical_type, _conn_config):
            """Return a copy of the configuration under test."""
            return dict(config)

    class ChatBase:
        """Stand-in for the shared chat base: keeps the fields the driver reads."""

        def __init__(self, provider, conn_config, _bag):
            """Read the model and output limit the way ChatBase does."""
            node_config = Config.getNodeConfig(provider, conn_config)
            self._model = node_config.get('model')
            self._modelOutputTokens = node_config.get('modelOutputTokens')

    class ChatBedrock:
        """Records the arguments the node builds the client with."""

        def __init__(self, **kwargs):
            """Record the build."""
            builds.append(kwargs)
            self.model_id = kwargs.get('model')

        def invoke(self, _prompt):
            """Answer the save-time probe."""
            return types.SimpleNamespace(content='Hello.')

    stubs = {
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.chat': types.ModuleType('ai.common.chat'),
        'ai.common.config': types.ModuleType('ai.common.config'),
        'ai.common.llm_native_stream': types.ModuleType('ai.common.llm_native_stream'),
        'langchain_aws': types.ModuleType('langchain_aws'),
        'rocketlib': types.ModuleType('rocketlib'),
        'depends': types.ModuleType('depends'),
    }
    stubs['ai.common.chat'].ChatBase = ChatBase
    stubs['ai.common.config'].Config = Config
    stubs['ai.common.config'].check_credential_resolved = lambda *args, **kwargs: None
    stubs['ai.common.config'].warn_if_credential_unresolved = lambda *args, **kwargs: False
    stubs['ai.common.llm_native_stream'].PROMPT_CACHE_PREFIX_VAR = contextvars.ContextVar('prefix', default=None)
    stubs['ai.common.llm_native_stream'].apply_prompt_cache_breakpoint = lambda *args, **kwargs: None
    stubs['langchain_aws'].ChatBedrock = ChatBedrock
    stubs['rocketlib'].IGlobalBase = object
    stubs['rocketlib'].warning = warnings.append
    stubs['depends'].depends = lambda _requirements: None

    package = types.ModuleType(_PACKAGE)
    package.__path__ = [str(_NODE_DIR)]
    stubs[_PACKAGE] = package
    for name, module in stubs.items():
        monkeypatch.setitem(sys.modules, name, module)

    modules = {}
    for name in ('bedrock', 'IGlobal'):
        spec = importlib.util.spec_from_file_location(f'{_PACKAGE}.{name}', _NODE_DIR / f'{name}.py')
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, f'{_PACKAGE}.{name}', module)
        spec.loader.exec_module(module)
        modules[name] = module

    instance = modules['IGlobal'].IGlobal()
    instance.glb = types.SimpleNamespace(logicalType='bedrock', connConfig={})
    return modules['bedrock'], instance, builds, warnings


@pytest.fixture
def driver(monkeypatch):
    """The real driver module, loaded against the stubs."""
    return _load(monkeypatch)[0]


class TestResolveModelId:
    """The one function both paths use to compute the id."""

    @pytest.mark.parametrize(
        'region, expected',
        [
            ('us-east-1', 'us.'),
            ('eu-west-1', 'eu.'),
            ('ap-southeast-2', 'apac.'),
            ('ca-central-1', 'us.'),
            ('', 'us.'),
            (None, 'us.'),
        ],
    )
    def test_a_plain_id_gets_the_region_prefix(self, driver, region, expected):
        """The region decides the prefix, as before."""
        model = 'meta.llama3-3-70b-instruct-v1:0'
        assert driver.resolve_model_id(model, region) == expected + model

    @pytest.mark.parametrize('prefix', ['us', 'eu', 'apac', 'au', 'jp', 'us-gov', 'global', 'amer', 'sa'])
    def test_an_already_prefixed_id_is_left_alone(self, driver, prefix):
        """Every geographic prefix langchain-aws knows is kept, not doubled."""
        model = f'{prefix}.{_SONNET}'
        assert driver.resolve_model_id(model, 'eu-west-1') == model

    @pytest.mark.parametrize('arn', [_PROFILE_ARN, _PROVISIONED_ARN])
    def test_an_arn_is_left_alone(self, driver, arn):
        """An ARN is sent as configured."""
        assert driver.resolve_model_id(arn, 'us-east-1') == arn

    def test_an_empty_model_stays_empty(self, driver):
        """Nothing to prefix before the model is entered."""
        assert driver.resolve_model_id('', 'us-east-1') == ''


class TestResolveModelVendor:
    """The vendor passed as ChatBedrock's provider."""

    def test_a_plain_id_needs_no_vendor(self, driver):
        """langchain-aws reads it from the id itself."""
        assert driver.resolve_model_vendor('us.' + _SONNET) is None

    @pytest.mark.parametrize(
        'arn, vendor',
        [
            (_PROFILE_ARN, 'anthropic'),
            (f'arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.{_SONNET}', 'anthropic'),
            ('arn:aws:bedrock:us-east-1::foundation-model/meta.llama3-3-70b-instruct-v1:0', 'meta'),
            (
                'arn:aws:bedrock:us-east-1:123456789012:custom-model/amazon.titan-text-express-v1:0:8k/abc123',
                'amazon',
            ),
        ],
    )
    def test_an_arn_that_names_its_model_gives_the_vendor(self, driver, arn, vendor):
        """Foundation models, system inference profiles and custom models name their model."""
        assert driver.resolve_model_vendor(arn) == vendor

    @pytest.mark.parametrize(
        'arn',
        [
            _PROVISIONED_ARN,
            'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3',
            'arn:aws:bedrock:us-east-1:123456789012:imported-model/a1b2c3',
        ],
    )
    def test_an_opaque_arn_gives_no_vendor(self, driver, arn):
        """The node does not guess a vendor it cannot read."""
        assert driver.resolve_model_vendor(arn) is None

    def test_a_configured_vendor_wins(self, driver):
        """The Provider field is used as entered, trimmed and lower-cased."""
        assert driver.resolve_model_vendor(_PROVISIONED_ARN, ' Anthropic ') == 'anthropic'
        assert driver.resolve_model_vendor(_PROFILE_ARN, 'meta') == 'meta'


class TestBothPathsAgree:
    """The save-time probe and the pipeline build the client the same way."""

    @pytest.mark.parametrize(
        'overrides, model, vendor',
        [
            ({}, 'us.' + _SONNET, None),
            ({'region': 'eu-west-1'}, 'eu.' + _SONNET, None),
            ({'model': 'us.' + _SONNET}, 'us.' + _SONNET, None),
            ({'model': 'global.' + _SONNET, 'region': 'eu-west-1'}, 'global.' + _SONNET, None),
            ({'model': _PROFILE_ARN}, _PROFILE_ARN, 'anthropic'),
            ({'model': _PROVISIONED_ARN, 'modelProvider': 'anthropic'}, _PROVISIONED_ARN, 'anthropic'),
        ],
    )
    def test_same_id_and_vendor(self, monkeypatch, overrides, model, vendor):
        """Whatever the config, both builds get the same model and provider."""
        driver, instance, builds, warnings = _load(monkeypatch, overrides)

        instance.validateConfig()
        driver.Chat('bedrock', {}, {})

        assert warnings == []
        assert len(builds) == 2
        for build in builds:
            assert build['model'] == model
            assert build.get('provider') == vendor

    def test_an_opaque_arn_without_provider_is_reported_at_save_time(self, monkeypatch):
        """The user is told to set Provider instead of seeing langchain-aws's error."""
        _driver, instance, builds, warnings = _load(monkeypatch, {'model': _PROVISIONED_ARN})

        instance.validateConfig()

        assert builds == []
        assert len(warnings) == 1
        assert 'Set Provider' in warnings[0]

    def test_an_opaque_arn_without_provider_stops_the_pipeline(self, monkeypatch):
        """The pipeline refuses to start with the same message, not a failure on the first call."""
        driver, _instance, builds, _warnings = _load(monkeypatch, {'model': _PROVISIONED_ARN})

        with pytest.raises(ValueError, match='Set Provider'):
            driver.Chat('bedrock', {}, {})

        assert builds == []
