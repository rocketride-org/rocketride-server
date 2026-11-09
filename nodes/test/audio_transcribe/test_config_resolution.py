# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Resolver tests for audio_transcribe's model configuration (#2067).

test_decode_params.py proves what IGlobal does with a resolved config but says nothing
about how that config is produced. This file runs the *real* resolver -- the engine's
schema for the real services.json, through ``rocketlib.resolveConfig`` -- which is where
#2067 lived: with one shared model field defaulted to "base", picking "medium" and
pressing Save wrote model=base and the node quietly transcribed with base. In the
converted definition the model IS the selector, so the stored value is the model.

No server, no FFmpeg, no model download, no GPU, no network.
"""

from __future__ import annotations

import importlib.util
import os

import pytest
import rocketlib
from rocketlib.config import ConfigError, resolveConfig

_HERE = os.path.dirname(os.path.abspath(__file__))
_NODE_DIR = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'audio_transcribe')
_SERVICES_JSON = os.path.join(_NODE_DIR, 'services.json')
_DISCOVERY_PY = os.path.join(_HERE, '..', 'framework', 'discovery.py')

_LOGICAL_TYPE = 'audio_transcribe'

# Every key IGlobal.beginGlobal() reads out of the resolved config.
_KEYS_IGLOBAL_READS = (
    'model',
    'language',
    'compute_type',
    'chunk_duration',
    'beam_size',
    'vad_filter',
    'vad_threshold',
    'vad_min_silence_duration_ms',
    'vad_speech_pad_ms',
    'vad_max_speech_duration_s',
)

_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3']


def _parse_services_json():
    """Parse via the repo's JSONC reader -- services.json has comments and trailing commas."""
    spec = importlib.util.spec_from_file_location('_audio_transcribe_discovery', _DISCOVERY_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod._parse_service_json(_SERVICES_JSON)


_SERVICE = _parse_services_json()
_DEFINITIONS = _SERVICE['propertyDefinitions']


def _schema():
    """The engine-resolved schema the node's IGlobal reads through."""
    schema = rocketlib.getServiceSchema(_LOGICAL_TYPE)
    assert schema is not None, f'{_LOGICAL_TYPE} is not registered with the engine'
    return schema


def _resolve(conn_config):
    """Resolve a node config exactly as IGlobal.beginGlobal() would."""
    return resolveConfig(_schema(), conn_config)


def _declared_defaults():
    """Short name -> declared default of every leaf; what an untouched save would write."""
    return {name.rsplit('.', 1)[-1]: field['default'] for name, field in _DEFINITIONS.items() if 'default' in field}


# -----------------------------------------------------------------------------
# What a stored config resolves to
# -----------------------------------------------------------------------------


def test_unconfigured_node_resolves_to_base_english():
    config = _resolve({})

    assert config['model'] == 'base'
    assert config['language'] == 'en'


def test_resolution_covers_every_key_iglobal_reads():
    config = _resolve({})

    assert sorted(config) == sorted(_KEYS_IGLOBAL_READS)


@pytest.mark.parametrize('model', _MODELS)
def test_selecting_a_model_selects_it(model):
    assert _resolve({'model': model})['model'] == model


@pytest.mark.parametrize('model', _MODELS)
def test_an_untouched_save_cannot_downgrade_the_selected_model(model):
    """The regression this file exists for.

    A form that materialises every declared default writes the model it shows, never a
    shared fallback, because the model is the selector and has no second home.
    """
    written = {**_declared_defaults(), 'model': model}
    config = _resolve(written)

    assert config['model'] == model
    for key in _KEYS_IGLOBAL_READS:
        assert config[key] == written[key], f'{key} moved on an untouched save of {model}'


def test_overrides_survive_alongside_the_model():
    """Editing a knob must not cost you the model, and picking a model must not cost you the knob."""
    config = _resolve(
        {'model': 'medium', 'beam_size': 1, 'language': 'de', 'vad_filter': False, 'compute_type': 'int8'}
    )

    assert config['model'] == 'medium'
    assert config['beam_size'] == 1
    assert config['language'] == 'de'
    assert config['vad_filter'] is False
    assert config['compute_type'] == 'int8'


def test_a_stale_model_value_is_an_error_naming_the_options():
    """A value the schema does not list fails loudly instead of running a different model."""
    with pytest.raises(ConfigError, match="'sentence-v9'.*not one of its options") as raised:
        _resolve({'model': 'sentence-v9'})
    for model in _MODELS:
        assert model in str(raised.value)


def test_a_key_the_schema_does_not_declare_is_an_error():
    """The old per-profile objects are gone: a leftover one is named, not ignored."""
    with pytest.raises(ConfigError, match='unknown config key "medium"'):
        _resolve({'model': 'medium', 'medium': {'beam_size': 1}})


def test_a_display_title_never_reaches_a_key_iglobal_reads():
    """The selector's titles label the models; they are schema, not config."""
    assert 'title' not in _resolve({'model': 'large-v3'})


# -----------------------------------------------------------------------------
# The schema side: every model has to be reachable from the UI
# -----------------------------------------------------------------------------


def test_the_model_selector_is_visible():
    """It was `"hidden": true` once, so the node offered no way to pick a model at all."""
    assert not _DEFINITIONS['transcribe.model'].get('hidden')


def test_the_selector_enumerates_every_model():
    assert sorted(_DEFINITIONS['transcribe.model']['enum']) == sorted(_MODELS)


def test_every_model_declares_a_title():
    """The selector displays the branch titles; a missing one lists blank."""
    for model, branch in _DEFINITIONS['transcribe.model']['enum'].items():
        assert branch.get('title'), f'model {model} has no title to display'


def test_the_model_is_the_only_selector():
    """Every other knob is shared by all models and stored flat, so switching models keeps them."""
    leaves = _schema()['properties']
    assert [leaf['path'] for leaf in leaves] == list(_KEYS_IGLOBAL_READS)
    assert all(not isinstance(leaf.get('enum'), dict) for leaf in leaves if leaf['name'] != 'model')
