# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Engine-glue tests for audio_transcribe's per-request decode parameters (#1809).

Mirrors the direct-instance harness used by schema_validate/test_engine_glue.py and
currency_convert_explicit/test_isjson_gate.py: rocketlib and ai.common.* are stubbed,
IGlobal.py is loaded from source via importlib, the IGlobal is built with
__new__ + beginGlobal(), and ai.common.models.Whisper is a recorder. No server, no
model, no GPU.

Guards the half of #1809 the integration runs cannot see. A misspelled field name or a
stale default falls back silently: the transcript does not move, nodes:test stays green,
and the knob is dead on arrival — which is the very bug #1809 is about.
"""

from __future__ import annotations

import ast
import importlib.util
import os
import sys
import types

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_NODE_DIR = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'audio_transcribe')
_SERVICES_JSON = os.path.join(_NODE_DIR, 'services.json')
_DISCOVERY_PY = os.path.join(_HERE, '..', 'framework', 'discovery.py')

# Exactly what the node sent before #1809, and must keep sending when nothing is set.
_BASELINE_VAD = {'threshold': 0.5, 'min_silence_duration_ms': 500, 'speech_pad_ms': 400}

# services.json field name -> the faster-whisper key it must arrive as.
_VAD_FIELD_TO_DECODE_KEY = {
    'vad_threshold': 'threshold',
    'vad_min_silence_duration_ms': 'min_silence_duration_ms',
    'vad_speech_pad_ms': 'speech_pad_ms',
    'vad_max_speech_duration_s': 'max_speech_duration_s',
}
_NEW_FIELDS = ['beam_size', 'vad_filter', 'chunk_duration', 'max_chunk_duration', *_VAD_FIELD_TO_DECODE_KEY]

# Read by nothing; superseded by the vad_* fields or by fixed buffering constants.
_DEAD_FIELDS = ['silence_threshold', 'min_seconds', 'max_seconds', 'vad_level']


class _FakeWhisper:
    """Stands in for ai.common.models.Whisper, recording the decode kwargs."""

    def __init__(self, model_name, output_fields=None, language=None, compute_type=None, **kwargs):
        self.calls = []

    def transcribe(self, audio, **kw):
        self.calls.append(kw)
        return {'$segments': []}

    def disconnect(self):
        pass


def _load_iglobal():
    """Load IGlobal.py from source behind stubs. Returns (IGlobal, config_holder)."""
    saved = {}
    config_holder = {'raw': {}}

    class FakeIGlobalBase:
        glb = None

    stubs = {
        'rocketlib': types.ModuleType('rocketlib'),
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.config': types.ModuleType('ai.common.config'),
        'ai.common.models': types.ModuleType('ai.common.models'),
    }
    stubs['rocketlib'].IGlobalBase = FakeIGlobalBase
    stubs['rocketlib'].debug = lambda *a, **kw: None
    stubs['ai.common.config'].Config = type(
        'FakeConfig', (), {'getNodeConfig': staticmethod(lambda lt, cc: config_holder['raw'])}
    )
    stubs['ai.common.models'].Whisper = _FakeWhisper

    for name, stub in stubs.items():
        saved[name] = sys.modules.get(name)
        sys.modules[name] = stub

    # Loads standalone — the package __init__ would drag in IInstance.
    mod_name = '_audio_transcribe_iglobal_under_test'
    try:
        spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_NODE_DIR, 'IGlobal.py'))
        mod = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)
        return mod.IGlobal, config_holder
    finally:
        sys.modules.pop(mod_name, None)
        for name in stubs:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]


def _decode_kwargs(raw_config):
    """Build an IGlobal from a node config and return the kwargs it hands Whisper."""
    IGlobal, holder = _load_iglobal()
    holder['raw'] = raw_config

    ig = IGlobal.__new__(IGlobal)
    ig.glb = types.SimpleNamespace(logicalType='audio_transcribe://', connConfig={})
    ig.beginGlobal()
    ig.transcribe(b'\x00\x01' * 2000)

    return ig._whisper.calls[-1]


def _parse_services_json():
    """Parse via the repo's JSONC reader — services.json has comments and trailing commas."""
    spec = importlib.util.spec_from_file_location('_audio_transcribe_discovery', _DISCOVERY_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod._parse_service_json(_SERVICES_JSON)


# -----------------------------------------------------------------------------
# What an unconfigured node sends
# -----------------------------------------------------------------------------


def test_empty_config_reproduces_todays_call():
    """The 'output unchanged' claim, made executable.

    Also the only direct guard on the vad_max_speech_duration_s 20 -> 0 change.
    """
    kw = _decode_kwargs({})

    assert kw['beam_size'] == 5
    assert kw['vad_filter'] is True
    assert kw['vad_parameters'] == _BASELINE_VAD
    assert 'max_speech_duration_s' not in kw['vad_parameters']


# -----------------------------------------------------------------------------
# Config -> decoder wiring
# -----------------------------------------------------------------------------


def test_beam_size_and_vad_filter_come_from_config():
    kw = _decode_kwargs({'beam_size': 1, 'vad_filter': False})

    assert kw['beam_size'] == 1
    assert kw['vad_filter'] is False


@pytest.mark.parametrize(
    'field,value',
    [
        ('vad_threshold', 0.25),
        ('vad_min_silence_duration_ms', 250),
        ('vad_speech_pad_ms', 100),
        ('vad_max_speech_duration_s', 30),
    ],
)
def test_each_vad_field_arrives_under_its_faster_whisper_name(field, value):
    """Fails when the IGlobal side of the name mapping is misspelled."""
    vad = _decode_kwargs({field: value})['vad_parameters']

    assert vad[_VAD_FIELD_TO_DECODE_KEY[field]] == value


def test_several_keys_at_once():
    kw = _decode_kwargs({'beam_size': 3, 'vad_filter': False, 'vad_threshold': 0.7, 'vad_max_speech_duration_s': 15})

    assert kw['beam_size'] == 3
    assert kw['vad_filter'] is False
    assert kw['vad_parameters']['threshold'] == 0.7
    assert kw['vad_parameters']['max_speech_duration_s'] == 15
    assert kw['vad_parameters']['min_silence_duration_ms'] == 500  # untouched default


# -----------------------------------------------------------------------------
# The 0 sentinel, and the keys it must not affect
# -----------------------------------------------------------------------------


def test_max_speech_duration_of_zero_omits_the_key():
    """0 means no limit: faster-whisper's real default is inf, which JSON cannot express."""
    vad = _decode_kwargs({'vad_max_speech_duration_s': 0})['vad_parameters']

    assert 'max_speech_duration_s' not in vad


def test_max_speech_duration_when_set_is_sent():
    vad = _decode_kwargs({'vad_max_speech_duration_s': 20})['vad_parameters']

    assert vad['max_speech_duration_s'] == 20


def test_zero_is_kept_on_every_other_vad_key():
    """The falsy-means-omit rule is for max_speech_duration_s ONLY.

    A `{k: v for k, v in ... if v}` sweep would silently restore 0.5 and 400 here.
    """
    vad = _decode_kwargs({'vad_threshold': 0, 'vad_speech_pad_ms': 0})['vad_parameters']

    assert vad['threshold'] == 0
    assert vad['speech_pad_ms'] == 0


def test_types_match_what_vadoptions_declares():
    """JSON does not distinguish 5 from 5.0, and CTranslate2 wants an int beam size."""
    kw = _decode_kwargs({'beam_size': 5.0, 'vad_min_silence_duration_ms': 500.0})

    assert kw['beam_size'] == 5
    assert isinstance(kw['beam_size'], int)
    assert isinstance(kw['vad_parameters']['min_silence_duration_ms'], int)


# -----------------------------------------------------------------------------
# services.json — the side the tests above bypass
# -----------------------------------------------------------------------------


def test_services_json_declares_every_field_iglobal_reads():
    """Every other test hands IGlobal a config dict, so a typo in the JSON would leave
    the knob unreachable from the UI with the whole file still green.
    """
    service = _parse_services_json()
    fields = service['fields']
    properties = fields['transcribe.default']['properties']

    for name in _NEW_FIELDS:
        assert f'transcribe.{name}' in fields, f'{name} missing from services.json fields'
        assert f'transcribe.{name}' in properties, f'{name} missing from transcribe.default'


def test_services_json_defaults_match_the_python_fallbacks():
    """A UI default that disagrees with the runtime fallback changes behaviour on save."""
    fields = _parse_services_json()['fields']
    expected = {
        'transcribe.chunk_duration': 60,
        'transcribe.max_chunk_duration': 120,
        'transcribe.beam_size': 5,
        'transcribe.vad_filter': True,
        'transcribe.vad_threshold': 0.5,
        'transcribe.vad_min_silence_duration_ms': 500,
        'transcribe.vad_speech_pad_ms': 400,
        'transcribe.vad_max_speech_duration_s': 0,
    }

    for name, default in expected.items():
        assert fields[name]['default'] == default, f'{name} default drifted from IGlobal'


def _class_attrs(path, class_name):
    """Read a class's literal attributes without importing it (relative imports)."""
    tree = ast.parse(open(path, encoding='utf-8').read())
    cls = next(n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == class_name)
    return {
        t.id: n.value.value
        for n in cls.body
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.Constant)
        for t in n.targets
        if isinstance(t, ast.Name)
    }


def test_iglobal_reads_buffering_from_config():
    IGlobal, holder = _load_iglobal()
    holder['raw'] = {'chunk_duration': 30, 'max_chunk_duration': 90}

    ig = IGlobal.__new__(IGlobal)
    ig.glb = types.SimpleNamespace(logicalType='audio_transcribe://', connConfig={})
    ig.beginGlobal()

    assert ig.chunk_duration == 30
    assert ig.max_chunk_duration == 90


def test_buffering_defaults_reproduce_transcribe_constants():
    """The defaults must equal what Transcribe ran unconditionally before it was wired."""
    consts = _class_attrs(os.path.join(_NODE_DIR, 'transcribe.py'), 'Transcribe')
    fields = _parse_services_json()['fields']

    assert fields['transcribe.chunk_duration']['default'] == consts['CHUNK_DURATION']
    assert fields['transcribe.max_chunk_duration']['default'] == consts['MAX_CHUNK_DURATION']


def test_iinstance_passes_buffering_to_transcribe():
    """IInstance built Transcribe() with no kwargs, so the config never reached it.

    Static check: IInstance imports rocketlib and ai.common.avi, so the stub harness
    above cannot load it.
    """
    tree = ast.parse(open(os.path.join(_NODE_DIR, 'IInstance.py'), encoding='utf-8').read())
    call = next(
        n
        for n in ast.walk(tree)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'Transcribe'
    )
    passed = {kw.arg for kw in call.keywords}

    assert {'chunk_duration', 'max_chunk_duration'} <= passed, f'Transcribe() only gets {sorted(passed)}'


def test_dead_fields_are_gone():
    """Nothing reads these, so declaring them offers knobs that silently do nothing."""
    service = _parse_services_json()
    fields = service['fields']
    properties = fields['transcribe.default']['properties']

    for name in _DEAD_FIELDS:
        key = f'transcribe.{name}'
        assert key not in fields, f'{name} is declared again but nothing reads it'
        assert key not in properties, f'{name} is back in transcribe.default'

    for profile, values in service['preconfig']['profiles'].items():
        leftovers = sorted(set(values) & set(_DEAD_FIELDS))
        assert not leftovers, f'profile {profile} still carries {leftovers}'


def test_every_profile_selects_its_own_model():
    """Profiles used to set "mode" while IGlobal reads "model", so all six loaded base."""
    profiles = _parse_services_json()['preconfig']['profiles']

    for name, values in profiles.items():
        assert 'mode' not in values, f'profile {name} still sets "mode", which nothing reads'
        expected = 'base' if name == 'default' else name
        assert values.get('model') == expected, f'profile {name} selects {values.get("model")!r}'
