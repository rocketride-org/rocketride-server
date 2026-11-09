# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Engine-glue tests for audio_transcribe's per-request decode parameters (#1809).

IGlobal.py is loaded from source via importlib with ai.common.models.Whisper replaced
by a recorder; the IGlobal is built with __new__ + beginGlobal() and reads its config
through the real resolver (the engine's schema for services.json), so a stored config
here is exactly what a pipeline stores. No server, no model, no GPU.

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
from rocketlib.config import ConfigError

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
_NEW_FIELDS = ['beam_size', 'vad_filter', 'chunk_duration', *_VAD_FIELD_TO_DECODE_KEY]

# Read by nothing; superseded by the vad_* fields or by fixed buffering constants.
_DEAD_FIELDS = ['silence_threshold', 'min_seconds', 'max_seconds', 'vad_level']


class _FakeWhisper:
    """Stands in for ai.common.models.Whisper, recording the decode kwargs."""

    def __init__(self, model_name, output_fields=None, language=None, compute_type=None, **kwargs):
        self.model_name = model_name
        self.language = language
        self.compute_type = compute_type
        self.calls = []

    def transcribe(self, audio, **kw):
        self.calls.append(kw)
        return {'$segments': []}

    def disconnect(self):
        pass


def _load_iglobal():
    """Load IGlobal.py from source with Whisper replaced by the recorder and debug captured.

    Returns:
        ``(IGlobal, debug_lines)``: the class, and the list the node's debug() calls land in.
    """
    debug_lines = []

    # Loads standalone, by file path: the engine imports the module the same way.
    mod_name = '_audio_transcribe_iglobal_under_test'
    spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_NODE_DIR, 'IGlobal.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.Whisper = _FakeWhisper
    mod.debug = lambda message='', *a, **kw: debug_lines.append(str(message))
    return mod.IGlobal, debug_lines


def _begin(stored_config):
    """Build an IGlobal on a stored node config through the real resolver and start it."""
    IGlobal, debug_lines = _load_iglobal()

    ig = IGlobal.__new__(IGlobal)
    ig.glb = types.SimpleNamespace(logicalType='audio_transcribe', connConfig=stored_config)
    ig.beginGlobal()
    return ig, debug_lines


def _decode_kwargs(stored_config):
    """Build an IGlobal from a node config and return the kwargs it hands Whisper."""
    ig, _ = _begin(stored_config)
    ig.transcribe(b'\x00\x01' * 2000)

    return ig._whisper.calls[-1]


def _parse_services_json():
    """Parse via the repo's JSONC reader — services.json has comments and trailing commas."""
    spec = importlib.util.spec_from_file_location('_audio_transcribe_discovery', _DISCOVERY_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod._parse_service_json(_SERVICES_JSON)


def _definitions():
    """The node's ``propertyDefinitions``, the one place every knob is declared (#2067)."""
    return _parse_services_json()['propertyDefinitions']


def _panel():
    """The config panel's property list; a knob not listed here is unreachable from the UI."""
    return _parse_services_json()['properties']


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


def _built_whisper(stored_config):
    """Build an IGlobal from a node config and return the _FakeWhisper it constructed."""
    ig, _ = _begin(stored_config)
    return ig._whisper


def test_language_reaches_the_whisper_constructor():
    """IGlobal has read `language` since the initial commit, but services.json never
    declared it, so the UI could not reach it and every profile pinned en.
    """
    assert _built_whisper({'language': 'ru'}).language == 'ru'


def test_language_defaults_to_english():
    assert _built_whisper({}).language == 'en'


def test_language_is_declared_in_services_json():
    definitions = _definitions()

    assert 'transcribe.language' in definitions
    assert definitions['transcribe.language']['default'] == 'en'
    assert 'transcribe.language' in _panel()


def test_compute_type_reaches_the_whisper_constructor():
    """Read by IGlobal since the initial commit, undeclared until #2067."""
    assert _built_whisper({'compute_type': 'int8'}).compute_type == 'int8'


def test_compute_type_defaults_to_float16():
    assert _built_whisper({}).compute_type == 'float16'


def test_compute_type_is_declared_in_services_json():
    assert _definitions()['transcribe.compute_type']['default'] == 'float16'
    assert 'transcribe.compute_type' in _panel()


def _debug_lines(stored_config):
    """Build an IGlobal from a node config and return everything it logged."""
    _, debug_lines = _begin(stored_config)
    return debug_lines


def test_the_startup_log_names_what_was_actually_loaded():
    """The only runtime signal of which model is running.

    Both #1809 and #2067 are bugs where the node loaded a different model than the one on
    screen and said nothing, so the line has to name every value that identifies the model.
    """
    logged = ' '.join(_debug_lines({'model': 'medium', 'language': 'de', 'compute_type': 'int8'}))

    assert 'model=medium' in logged
    assert 'language=de' in logged
    assert 'compute_type=int8' in logged


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
    """CTranslate2 wants an int beam size, so the schema declares integers and the resolver enforces them.

    JSON does not distinguish 5 from 5.0; the node no longer casts, a stored 5.0
    is a config error rather than a silently coerced value.
    """
    definitions = _definitions()
    for name in ('beam_size', 'vad_min_silence_duration_ms', 'vad_speech_pad_ms', 'chunk_duration'):
        assert definitions[f'transcribe.{name}']['type'] == 'integer', f'{name} is not declared an integer'

    kw = _decode_kwargs({'beam_size': 5, 'vad_min_silence_duration_ms': 500})
    assert isinstance(kw['beam_size'], int)
    assert isinstance(kw['vad_parameters']['min_silence_duration_ms'], int)

    with pytest.raises(ConfigError, match='"beam_size" expects integer'):
        _decode_kwargs({'beam_size': 5.0})


# -----------------------------------------------------------------------------
# services.json — the side the tests above bypass
# -----------------------------------------------------------------------------


def test_services_json_declares_every_field_iglobal_reads():
    """The resolver only serves declared keys, so a knob missing here is unreachable from
    the UI AND an AttributeError in beginGlobal; both halves are checked.
    """
    definitions = _definitions()
    panel = _panel()

    for name in _NEW_FIELDS:
        assert f'transcribe.{name}' in definitions, f'{name} missing from services.json propertyDefinitions'
        assert f'transcribe.{name}' in panel, f'{name} missing from the config panel'


def test_services_json_defaults_match_what_the_node_ran_with():
    """A UI default that disagrees with what the node sent before the knobs existed changes behaviour on save."""
    fields = _definitions()
    expected = {
        'transcribe.chunk_duration': 60,
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
    ig, _ = _begin({'chunk_duration': 30})

    assert ig.chunk_duration == 30


def test_buffering_defaults_reproduce_transcribe_constants():
    """The defaults must equal what Transcribe ran unconditionally before it was wired."""
    consts = _class_attrs(os.path.join(_NODE_DIR, 'transcribe.py'), 'Transcribe')

    assert _definitions()['transcribe.chunk_duration']['default'] == consts['CHUNK_DURATION']


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

    assert 'chunk_duration' in passed, f'Transcribe() only gets {sorted(passed)}'


def _load_transcribe():
    """Load transcribe.py behind stubs.

    It does `from .IGlobal import IGlobal`, so the module must be loaded inside a
    package; a synthetic one pointed at the node directory is enough.
    """
    saved = {}
    pkg_name = '_audio_transcribe_pkg'

    class FakeAudioReader:
        def __init__(self, **kwargs):
            pass

        def start(self):
            pass

        def getTimestamp(self):
            return 0.0

    pkg = types.ModuleType(pkg_name)
    pkg.__path__ = [_NODE_DIR]
    iglobal_stub = types.ModuleType(f'{pkg_name}.IGlobal')
    iglobal_stub.IGlobal = object

    stubs = {
        pkg_name: pkg,
        f'{pkg_name}.IGlobal': iglobal_stub,
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.avi': types.ModuleType('ai.common.avi'),
        'ai.common.avi.audio': types.ModuleType('ai.common.avi.audio'),
        'rocketlib': types.ModuleType('rocketlib'),
    }
    stubs['ai.common.avi.audio'].AudioReader = FakeAudioReader
    stubs['rocketlib'].debug = lambda *a, **kw: None

    for name, stub in stubs.items():
        saved[name] = sys.modules.get(name)
        sys.modules[name] = stub

    mod_name = f'{pkg_name}.transcribe'
    try:
        spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_NODE_DIR, 'transcribe.py'))
        mod = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)
        return mod.Transcribe
    finally:
        sys.modules.pop(mod_name, None)
        for name in stubs:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]


def test_audio_is_flushed_once_chunk_duration_is_reached():
    """The behavioural gap the checks above leave open.

    Nothing here used to observe an actual flush, which is how a second, unreachable
    threshold survived: any buffer long enough to hit it has already hit this one, so
    `elif` never ran and its config field was inert. Feeding real bytes catches that.
    """
    Transcribe = _load_transcribe()
    flushed = []

    node = Transcribe(
        segment_callback=lambda segments: None,
        transcribe=lambda audio: flushed.append(len(audio)) or [],
        chunk_duration=2,
    )
    node.start()

    one_second = b'\x00\x01' * Transcribe.SAMPLE_RATE  # int16 mono

    node.onData(one_second)
    assert flushed == [], 'flushed before reaching chunk_duration'

    node.onData(one_second)
    assert len(flushed) == 1, 'no flush at chunk_duration'
    assert flushed[0] == 2 * Transcribe.SAMPLE_RATE * 2  # 2 s of int16

    # _flush_audio() zeroes the counter, so the next second starts a fresh chunk.
    node.onData(one_second)
    assert len(flushed) == 1

    # There is deliberately no higher threshold: without a "cut here, it is quiet"
    # test between the two it can never fire, and this class has no silence detection.
    assert not hasattr(Transcribe, 'MAX_CHUNK_DURATION')


def test_dead_fields_are_gone():
    """Nothing reads these, so declaring them offers knobs that silently do nothing."""
    definitions = _definitions()
    panel = _panel()

    for name in _DEAD_FIELDS:
        key = f'transcribe.{name}'
        assert key not in definitions, f'{name} is declared again but nothing reads it'
        assert key not in panel, f'{name} is back in the config panel'


def test_the_model_selector_offers_every_size_and_selects_it():
    """Profiles used to set "mode" while IGlobal reads "model", so all six loaded base.

    The model is now the selector itself: its branches are the sizes, and the
    stored value is what the node loads.
    """
    sizes = _definitions()['transcribe.model']['enum']

    assert sorted(sizes) == sorted(['tiny', 'base', 'small', 'medium', 'large-v3'])
    assert 'mode' not in _definitions()
    for size in sizes:
        assert _built_whisper({'model': size}).model_name == size
