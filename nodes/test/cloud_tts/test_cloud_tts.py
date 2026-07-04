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

# Reuse the contract-test JSONC parser (handles // comments and :// URLs).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_contracts import parse_service_json  # noqa: E402

_SERVICES = ['services.tts_openai.json', 'services.tts_elevenlabs.json']


def _load_iglobal():
    """Import nodes/cloud_tts/IGlobal.py standalone, stubbing engine-only deps.

    Uses setdefault so a real engine runtime (dist/server on sys.path in CI) is
    used when present, and the stubs kick in only when it is not.
    """
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    rocketlib.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config'})
    sys.modules.setdefault('rocketlib', rocketlib)

    sys.modules.setdefault('ai', types.ModuleType('ai'))
    sys.modules.setdefault('ai.common', types.ModuleType('ai.common'))
    ai_cfg = types.ModuleType('ai.common.config')
    ai_cfg.Config = type('Config', (), {})
    sys.modules.setdefault('ai.common.config', ai_cfg)

    # Synthetic package so IGlobal's `from . import openai_tts, elevenlabs_tts` resolves.
    pkg = types.ModuleType('cloud_tts')
    pkg.__path__ = [str(_DIR)]
    sys.modules['cloud_tts'] = pkg
    for name in ('openai_tts', 'elevenlabs_tts', 'IGlobal'):
        spec = importlib.util.spec_from_file_location(f'cloud_tts.{name}', _DIR / f'{name}.py')
        module = importlib.util.module_from_spec(spec)
        sys.modules[f'cloud_tts.{name}'] = module
        spec.loader.exec_module(module)
    return sys.modules['cloud_tts.IGlobal']


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
