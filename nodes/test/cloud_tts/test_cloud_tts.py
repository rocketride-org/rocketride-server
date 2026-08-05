# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Network-free unit tests for cloud_tts vendor selection and registry wiring.

Loads IGlobal with stubbed engine deps (no rocketlib / model server / network)
so the dispatch logic — which vendor a logicalType resolves to, and that each
vendor is wired to its own synth function — is pinned without a live API call.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'cloud_tts'

# Reuse the contract-test JSONC parser (handles // comments and :// URLs). Imported
# package-relative: putting nodes/test on sys.path would let its node-named subpackages
# shadow the real node packages under src/nodes (see #1687).
from ..test_contracts import parse_service_json

_SERVICES = ['services.tts_openai.json', 'services.tts_elevenlabs.json']


def _load_iglobal():
    """Import nodes/cloud_tts/IGlobal.py standalone, stubbing engine-only deps.

    Stubs the engine-only modules only while the node imports, then restores
    sys.modules so the rocketlib/ai stubs never leak to sibling tests.
    """
    # Save prior state so the stubs are scoped to the import below.
    _core = ('rocketlib', 'ai', 'ai.common', 'ai.common.config')
    _saved = {name: sys.modules.get(name) for name in _core}

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    rocketlib.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config'})
    sys.modules['rocketlib'] = rocketlib

    sys.modules['ai'] = types.ModuleType('ai')
    sys.modules['ai'].__path__ = []  # mark as package so sub-imports resolve
    sys.modules['ai.common'] = types.ModuleType('ai.common')
    sys.modules['ai.common'].__path__ = []
    ai_cfg = types.ModuleType('ai.common.config')
    ai_cfg.Config = type('Config', (), {})
    sys.modules['ai.common.config'] = ai_cfg

    # Synthetic package so IGlobal's `from . import openai_tts, elevenlabs_tts` resolves.
    pkg = types.ModuleType('cloud_tts')
    pkg.__path__ = [str(_DIR)]
    sys.modules['cloud_tts'] = pkg
    try:
        for name in ('openai_tts', 'elevenlabs_tts', 'rime_tts', 'IGlobal'):
            spec = importlib.util.spec_from_file_location(f'cloud_tts.{name}', _DIR / f'{name}.py')
            module = importlib.util.module_from_spec(spec)
            sys.modules[f'cloud_tts.{name}'] = module
            spec.loader.exec_module(module)
        return sys.modules['cloud_tts.IGlobal']
    finally:
        for name, mod in _saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


_ig = _load_iglobal()


class TestResolveEngine:
    def test_openai_logical_type(self):
        assert _ig._resolve_engine('tts_openai://node/1') == 'openai'

    def test_elevenlabs_logical_type(self):
        assert _ig._resolve_engine('tts_elevenlabs://node/1') == 'elevenlabs'

    def test_case_insensitive(self):
        assert _ig._resolve_engine('TTS_OPENAI://X') == 'openai'

    def test_unknown_logical_type_raises(self):
        with pytest.raises(Exception):
            _ig._resolve_engine('audio_tts://kokoro')


class TestEngineRegistry:
    def test_each_vendor_wired_to_its_own_synth(self):
        from cloud_tts import elevenlabs_tts, openai_tts

        assert _ig._ENGINES['openai']['synthesize'] is openai_tts.synthesize
        assert _ig._ENGINES['elevenlabs']['synthesize'] is elevenlabs_tts.synthesize

    @pytest.mark.parametrize('engine', ['openai', 'elevenlabs'])
    def test_entry_has_required_fields(self, engine):
        spec = _ig._ENGINES[engine]
        assert callable(spec['synthesize'])
        for key in ('default_model', 'default_voice', 'env_key', 'label'):
            assert spec[key], f'{engine} missing {key}'


class TestVoiceWiredUnderProfile:
    """Guards the review fix: voice must be merged under the selected profile
    (form-object), never orphaned in the top-level shape — otherwise
    Config.getNodeConfig drops it and cfg.get('voice') silently defaults.
    """

    @pytest.mark.parametrize('svc', _SERVICES)
    def test_voice_absent_from_top_level_shape(self, svc):
        data = parse_service_json(_DIR / svc)
        voice = f'{data["prefix"]}.voice'
        for section in data['shape']:
            assert voice not in section['properties']

    @pytest.mark.parametrize('svc', _SERVICES)
    def test_voice_present_in_every_profile_form_object(self, svc):
        data = parse_service_json(_DIR / svc)
        prefix = data['prefix']
        voice = f'{prefix}.voice'
        for profile_key in data['preconfig']['profiles']:
            form = data['fields'][f'{prefix}.{profile_key}']
            assert voice in form['properties'], f'{profile_key} form-object missing {voice}'


# --------------------------------------------------------------------------- #
# Rime — the third vendor registration (services.tts_rime.json + rime_tts).
# Rime speakers are MODEL-SPECIFIC, so it does not share the single-global-voice
# enum the OpenAI/ElevenLabs registrations use: each profile carries its own
# `tts_rime.<model>.voice` enum (leaf key `voice`) inside the profile form-object.
# --------------------------------------------------------------------------- #

_RIME_URL = 'https://users.rime.ai/v1/rime-tts'
_RIME_MODELS = ['coda', 'arcana', 'mistv3', 'mistv2']


class _FakeResponse:
    def __init__(self, content=b'MP3BYTES', raise_exc=None):
        self.content = content
        self._raise = raise_exc

    def raise_for_status(self):
        if self._raise is not None:
            raise self._raise


class _FakeRequests:
    """Captures the outgoing request and replays a configurable response."""

    def __init__(self):
        self.last = None
        self.response = _FakeResponse()

    def post(self, url, json=None, headers=None, timeout=None, **kw):
        self.last = types.SimpleNamespace(url=url, json=json, headers=headers, timeout=timeout)
        return self.response


@pytest.fixture
def fake_requests():
    """Install a stub `requests` (lazily imported inside rime_tts.synthesize)."""
    fake = _FakeRequests()
    req_mod = types.ModuleType('requests')
    req_mod.post = fake.post
    saved = sys.modules.get('requests')
    sys.modules['requests'] = req_mod
    try:
        yield fake
    finally:
        if saved is None:
            sys.modules.pop('requests', None)
        else:
            sys.modules['requests'] = saved


class TestRimeVendorContract:
    """rime_tts.synthesize — Rime's HTTP shape, discriminating an OpenAI/ElevenLabs
    copy-paste left unadapted (Rime uses modelId/speaker + Bearer + Accept, no
    response_format and no xi-api-key).
    """

    def test_posts_to_rime_endpoint(self, fake_requests):
        from cloud_tts import rime_tts

        rime_tts.synthesize('Hello from RocketRide', 'coda', 'astra', 'rk_test')
        assert fake_requests.last.url == _RIME_URL
        assert fake_requests.last.timeout == 120

    def test_body_uses_rime_field_names(self, fake_requests):
        from cloud_tts import rime_tts

        rime_tts.synthesize('hi', 'mistv3', 'cove', 'rk_test')
        body = fake_requests.last.json
        assert body == {'text': 'hi', 'speaker': 'cove', 'modelId': 'mistv3'}
        assert 'response_format' not in body  # OpenAI leftover would break Rime
        assert 'model' not in body and 'model_id' not in body and 'voice' not in body

    def test_bearer_auth_and_mpeg_accept(self, fake_requests):
        from cloud_tts import rime_tts

        rime_tts.synthesize('hi', 'coda', 'astra', 'secret-key')
        headers = fake_requests.last.headers
        assert headers['Authorization'] == 'Bearer secret-key'
        assert headers['Content-Type'] == 'application/json'
        assert headers['Accept'] == 'audio/mpeg'
        assert 'xi-api-key' not in headers  # ElevenLabs leftover

    def test_returns_response_bytes(self, fake_requests):
        from cloud_tts import rime_tts

        fake_requests.response = _FakeResponse(content=b'REALMP3')
        assert rime_tts.synthesize('hi', 'coda', 'astra', 'k') == b'REALMP3'

    def test_raises_on_http_error(self, fake_requests):
        from cloud_tts import rime_tts

        fake_requests.response = _FakeResponse(raise_exc=RuntimeError('boom'))
        with pytest.raises(RuntimeError):
            rime_tts.synthesize('hi', 'coda', 'astra', 'k')

    def test_text_passed_verbatim_as_json(self, fake_requests):
        from cloud_tts import rime_tts

        rime_tts.synthesize('Hello from RocketRide', 'coda', 'astra', 'k')
        assert fake_requests.last.json['text'] == 'Hello from RocketRide'
        assert isinstance(fake_requests.last.json, dict)  # json=, not data=


class TestRimeDispatch:
    def test_logical_type_resolves_to_rime(self):
        assert _ig._resolve_engine('tts_rime://node/1') == 'rime'
        assert _ig._resolve_engine('TTS_RIME://X') == 'rime'

    def test_registry_entry_wired_to_rime_synth(self):
        from cloud_tts import rime_tts

        spec = _ig._ENGINES['rime']
        assert spec['synthesize'] is rime_tts.synthesize
        assert spec['default_model'] == 'coda'
        assert spec['default_voice'] == 'astra'
        assert spec['env_key'] == 'RIME_API_KEY'
        assert spec['label']

    def test_synthesize_dispatches_model_scoped_speaker(self, fake_requests):
        """Shared engine → rime_tts: the model-scoped speaker (held as `_voice`)
        must reach Rime as `speaker`, and synthesize returns (mp3 bytes, audio/mpeg)
        with no temp file. Guards the old always-`astra` bug at the dispatch layer.
        """
        fake_requests.response = _FakeResponse(content=b'AUDIO')
        g = _ig.IGlobal()
        g._engine, g._model, g._voice, g._api_key = 'rime', 'mistv3', 'cove', 'k'
        raw, mime = g.synthesize('speak this')
        assert (raw, mime) == (b'AUDIO', 'audio/mpeg')
        assert fake_requests.last.json == {'text': 'speak this', 'speaker': 'cove', 'modelId': 'mistv3'}

    def test_synthesize_rejects_empty_audio(self, fake_requests):
        """A 200 with an empty body must raise, not hand back a zero-byte clip."""
        fake_requests.response = _FakeResponse(content=b'')
        g = _ig.IGlobal()
        g._engine, g._model, g._voice, g._api_key = 'rime', 'mistv3', 'cove', 'k'
        with pytest.raises(Exception, match='no audio'):
            g.synthesize('speak this')


class TestRimeSchema:
    """services.tts_rime.json — model-scoped speaker enums must merge under `voice`.

    A speaker field left bare in a conditional branch (or in the top-level shape) is a
    sibling of the profile selector and is silently dropped by getNodeConfig — the exact
    trap that made the old standalone node always synthesize with the default speaker.
    """

    _SVC = 'services.tts_rime.json'

    def _data(self):
        return parse_service_json(_DIR / self._SVC)

    def test_shares_cloud_tts_engine(self):
        data = self._data()
        assert data['path'] == 'nodes.cloud_tts'
        assert data['prefix'] == 'tts_rime'
        assert data['classType'] == ['audio']
        assert 'experimental' in data['capabilities']

    def test_profiles_carry_model_and_voice(self):
        profiles = self._data()['preconfig']['profiles']
        assert set(profiles) == set(_RIME_MODELS)
        for name, prof in profiles.items():
            assert prof['model'] == name
            assert prof['voice']  # default speaker the shared engine reads as cfg['voice']
            assert 'apikey' in prof

    def test_each_form_object_carries_its_model_voice_field(self):
        data = self._data()
        for model in _RIME_MODELS:
            form = data['fields'][f'tts_rime.{model}']
            assert form['object'] == model  # object must equal the profile name to merge
            assert f'tts_rime.{model}.voice' in form['properties']

    def test_voice_fields_absent_from_top_level_shape(self):
        data = self._data()
        shape_props = [p for section in data['shape'] for p in section['properties']]
        for model in _RIME_MODELS:
            assert f'tts_rime.{model}.voice' not in shape_props
        assert 'tts_rime.voice' not in shape_props

    def test_voice_defaults_are_in_enum(self):
        data = self._data()
        for model in _RIME_MODELS:
            field = data['fields'][f'tts_rime.{model}.voice']
            values = [row[0] for row in field['enum']]
            assert field['default'] in values, f'{model} default {field["default"]} not in enum'

    def test_conditional_covers_every_model(self):
        data = self._data()
        cond = {c['value']: c['properties'] for c in data['fields']['tts_rime.profile']['conditional']}
        assert set(cond) == set(_RIME_MODELS)
        for model in _RIME_MODELS:
            assert f'tts_rime.{model}' in cond[model]
