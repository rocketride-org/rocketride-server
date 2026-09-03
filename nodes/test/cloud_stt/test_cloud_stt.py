# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Network-free unit tests for cloud_stt: vendor dispatch, the Deepgram HTTPS
call, and the BEGIN/WRITE/END clip-buffering in IInstance.

Bootstrap mirrors test_cloud_tts.py: stub the engine-only modules (rocketlib,
ai.common.*), load the node's submodules standalone via a synthetic package, then
restore sys.modules so the stubs never leak into a shared pytest session.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import Mock

import pytest
import requests

_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'cloud_stt'

# Reuse the contract-test JSONC parser. Imported package-relative: putting
# nodes/test on sys.path would let its node-named subpackages shadow the real
# node packages under src/nodes (see #1687).
from ..test_contracts import parse_service_json

_SERVICE = 'services.stt_deepgram.json'


def _load_modules():
    """Import cloud_stt's submodules standalone, stubbing engine-only deps.

    Stubs are scoped to this import and removed afterward so they never leak
    into sibling tests running under the full engine (where rocketlib/ai.common
    are real and shared across the pytest session).
    """
    _core = ('rocketlib', 'ai', 'ai.common', 'ai.common.config', 'ai.common.avi', 'ai.common.avi.descriptor')
    _saved = {name: sys.modules.get(name) for name in _core}

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    rocketlib.IInstanceBase = type('IInstanceBase', (), {})
    rocketlib.Entry = type('Entry', (), {})
    rocketlib.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config'})
    rocketlib.AVI_ACTION = type('AVI_ACTION', (), {'BEGIN': 0, 'WRITE': 1, 'END': 2})
    rocketlib.warning = Mock()
    sys.modules['rocketlib'] = rocketlib

    sys.modules['ai'] = types.ModuleType('ai')
    sys.modules['ai'].__path__ = []
    sys.modules['ai.common'] = types.ModuleType('ai.common')
    sys.modules['ai.common'].__path__ = []
    ai_cfg = types.ModuleType('ai.common.config')
    ai_cfg.Config = type('Config', (), {})
    sys.modules['ai.common.config'] = ai_cfg

    sys.modules['ai.common.avi'] = types.ModuleType('ai.common.avi')
    sys.modules['ai.common.avi'].__path__ = []
    ai_descriptor = types.ModuleType('ai.common.avi.descriptor')
    ai_descriptor.descriptor_from_payload = Mock(return_value=None)
    sys.modules['ai.common.avi.descriptor'] = ai_descriptor

    # The `from . import ...` / `from .X import Y` statements inside IGlobal.py
    # and IInstance.py resolve their references at exec time, so the returned
    # module objects stay fully usable for the rest of this file even after
    # sys.modules is cleaned up below -- nothing here re-resolves through the
    # cache later.
    submodule_names = ('cloud_stt.deepgram_stt', 'cloud_stt.IGlobal', 'cloud_stt.IInstance')
    pkg = types.ModuleType('cloud_stt')
    pkg.__path__ = [str(_DIR)]
    sys.modules['cloud_stt'] = pkg
    try:
        for name in ('deepgram_stt', 'IGlobal', 'IInstance'):
            spec = importlib.util.spec_from_file_location(f'cloud_stt.{name}', _DIR / f'{name}.py')
            module = importlib.util.module_from_spec(spec)
            sys.modules[f'cloud_stt.{name}'] = module
            spec.loader.exec_module(module)
        return (
            sys.modules['cloud_stt.deepgram_stt'],
            sys.modules['cloud_stt.IGlobal'],
            sys.modules['cloud_stt.IInstance'],
        )
    finally:
        sys.modules.pop('cloud_stt', None)
        for name in submodule_names:
            sys.modules.pop(name, None)
        for name, mod in _saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


_deepgram_stt, _ig, _ii = _load_modules()


# ---------------------------------------------------------------------------
# Vendor dispatch (IGlobal)
# ---------------------------------------------------------------------------


class TestResolveEngine:
    def test_deepgram_logical_type(self):
        assert _ig._resolve_engine('stt_deepgram://node/1') == 'deepgram'

    def test_case_insensitive(self):
        assert _ig._resolve_engine('STT_DEEPGRAM://X') == 'deepgram'

    def test_unknown_logical_type_raises(self):
        with pytest.raises(Exception):
            _ig._resolve_engine('audio_transcribe://whisper')


class TestEngineRegistry:
    def test_deepgram_wired_to_its_own_transcribe(self):
        assert _ig._ENGINES['deepgram']['transcribe'] is _deepgram_stt.transcribe

    def test_entry_has_required_fields(self):
        spec = _ig._ENGINES['deepgram']
        assert callable(spec['transcribe'])
        for key in ('default_model', 'default_language', 'env_key', 'label'):
            assert spec[key], f'deepgram missing {key}'


# ---------------------------------------------------------------------------
# deepgram_stt.transcribe — the actual HTTPS call
# ---------------------------------------------------------------------------


def _resp(status=200, *, json_data=None):
    resp = Mock(spec=requests.Response)
    resp.status_code = status
    resp.ok = 200 <= status < 300
    resp.json.return_value = json_data
    resp.raise_for_status.side_effect = None if resp.ok else requests.HTTPError(response=resp)
    return resp


_TRANSCRIPT_BODY = {'results': {'channels': [{'alternatives': [{'transcript': 'hello world', 'confidence': 0.99}]}]}}


@pytest.fixture
def mock_requests(monkeypatch):
    """Stand in for the real `requests` package.

    deepgram_stt.transcribe does `import requests` *inside* the function (lazy,
    matching elevenlabs_tts.py's pattern), so there is no module-level
    `cloud_stt.deepgram_stt.requests` attribute to @patch -- the import statement
    itself resolves through `sys.modules` at call time, so putting a fake module
    there is what actually intercepts it.
    """
    fake = Mock()
    fake.HTTPError = requests.HTTPError
    monkeypatch.setitem(sys.modules, 'requests', fake)
    return fake


class TestDeepgramTranscribe:
    def test_sends_raw_bytes_with_token_auth_and_query_params(self, mock_requests):
        mock_requests.post.return_value = _resp(200, json_data=_TRANSCRIPT_BODY)

        text = _deepgram_stt.transcribe(
            b'RIFF....audio-bytes',
            'audio/wav',
            model='nova-3',
            language='en',
            smart_format=True,
            punctuate=True,
            api_key='dg-test-key',
        )

        assert text == 'hello world'
        call = mock_requests.post.call_args
        assert call.args[0] == 'https://api.deepgram.com/v1/listen'
        assert call.kwargs['data'] == b'RIFF....audio-bytes'
        assert call.kwargs['headers']['Authorization'] == 'Token dg-test-key'
        assert call.kwargs['headers']['Content-Type'] == 'audio/wav'
        assert call.kwargs['params'] == {
            'model': 'nova-3',
            'language': 'en',
            'smart_format': 'true',
            'punctuate': 'true',
        }

    def test_feature_flags_serialize_as_lowercase_strings(self, mock_requests):
        mock_requests.post.return_value = _resp(200, json_data=_TRANSCRIPT_BODY)

        _deepgram_stt.transcribe(
            b'x', 'audio/wav', model='nova-3', language='en', smart_format=False, punctuate=False, api_key='k'
        )

        params = mock_requests.post.call_args.kwargs['params']
        assert params['smart_format'] == 'false'
        assert params['punctuate'] == 'false'

    def test_missing_transcript_field_raises_a_clear_error(self, mock_requests):
        mock_requests.post.return_value = _resp(200, json_data={'results': {'channels': []}})

        with pytest.raises(ValueError, match='missing the expected transcript field'):
            _deepgram_stt.transcribe(
                b'x', 'audio/wav', model='nova-3', language='en', smart_format=True, punctuate=True, api_key='k'
            )

    def test_non_2xx_response_raises(self, mock_requests):
        mock_requests.post.return_value = _resp(401, json_data={'err': 'unauthorized'})

        with pytest.raises(requests.HTTPError):
            _deepgram_stt.transcribe(
                b'x', 'audio/wav', model='nova-3', language='en', smart_format=True, punctuate=True, api_key='bad'
            )


# ---------------------------------------------------------------------------
# IInstance — BEGIN/WRITE/END clip buffering
# ---------------------------------------------------------------------------


def _instance():
    inst = _ii.IInstance.__new__(_ii.IInstance)
    inst.IGlobal = Mock()
    inst.instance = Mock()
    inst.open(object=None)
    return inst


class TestClipBuffering:
    def test_begin_resets_the_buffer_and_records_the_mime_type(self):
        inst = _instance()
        inst._buffer = bytearray(b'stale-from-a-previous-clip')

        inst.writeAudio(_ii.AVI_ACTION.BEGIN, 'audio/wav', b'{"objectId": "descriptor-json"}')

        assert bytes(inst._buffer) == b''
        assert inst._mime_type == 'audio/wav'

    def test_write_appends_bytes_in_order(self):
        inst = _instance()
        inst.writeAudio(_ii.AVI_ACTION.BEGIN, 'audio/wav', b'')
        inst.writeAudio(_ii.AVI_ACTION.WRITE, 'audio/wav', b'chunk-one-')
        inst.writeAudio(_ii.AVI_ACTION.WRITE, 'audio/wav', b'chunk-two')

        assert bytes(inst._buffer) == b'chunk-one-chunk-two'
        inst.instance.writeText.assert_not_called()

    def test_write_within_the_cap_is_unaffected(self):
        inst = _instance()
        inst.writeAudio(_ii.AVI_ACTION.BEGIN, 'audio/wav', b'')

        inst.writeAudio(_ii.AVI_ACTION.WRITE, 'audio/wav', b'x' * (_ii._MAX_BUFFER_BYTES - 1))

        assert len(inst._buffer) == _ii._MAX_BUFFER_BYTES - 1

    def test_write_exceeding_the_cap_clears_the_buffer_and_raises(self):
        """An unbounded clip must fail loudly, not grow the buffer without limit."""
        inst = _instance()
        inst.writeAudio(_ii.AVI_ACTION.BEGIN, 'audio/wav', b'')
        inst.writeAudio(_ii.AVI_ACTION.WRITE, 'audio/wav', b'x' * (_ii._MAX_BUFFER_BYTES - 10))

        with pytest.raises(ValueError, match='exceeds the .* limit'):
            inst.writeAudio(_ii.AVI_ACTION.WRITE, 'audio/wav', b'y' * 20)

        assert bytes(inst._buffer) == b''
        inst.IGlobal.transcribe.assert_not_called()

    def test_a_single_write_larger_than_the_cap_raises_from_an_empty_buffer(self):
        inst = _instance()
        inst.writeAudio(_ii.AVI_ACTION.BEGIN, 'audio/wav', b'')

        with pytest.raises(ValueError, match='exceeds the .* limit'):
            inst.writeAudio(_ii.AVI_ACTION.WRITE, 'audio/wav', b'z' * (_ii._MAX_BUFFER_BYTES + 1))

    def test_end_transcribes_the_complete_buffer_and_writes_text(self):
        inst = _instance()
        inst.IGlobal.transcribe.return_value = 'the full transcript'

        inst.writeAudio(_ii.AVI_ACTION.BEGIN, 'audio/wav', b'')
        inst.writeAudio(_ii.AVI_ACTION.WRITE, 'audio/wav', b'abc')
        inst.writeAudio(_ii.AVI_ACTION.WRITE, 'audio/wav', b'def')
        inst.writeAudio(_ii.AVI_ACTION.END, 'audio/wav', b'')

        inst.IGlobal.transcribe.assert_called_once_with(b'abcdef', 'audio/wav')
        inst.instance.writeText.assert_called_once_with('the full transcript')
        assert bytes(inst._buffer) == b''  # cleared after sending

    def test_end_with_no_buffered_audio_is_a_no_op(self):
        """A BEGIN immediately followed by END (empty clip) must not call the vendor."""
        inst = _instance()
        inst.writeAudio(_ii.AVI_ACTION.BEGIN, 'audio/wav', b'')
        inst.writeAudio(_ii.AVI_ACTION.END, 'audio/wav', b'')

        inst.IGlobal.transcribe.assert_not_called()
        inst.instance.writeText.assert_not_called()

    def test_transcribe_failure_is_warned_reraised_and_still_clears_the_buffer(self):
        inst = _instance()
        inst.IGlobal.transcribe.side_effect = RuntimeError('vendor 500')

        inst.writeAudio(_ii.AVI_ACTION.BEGIN, 'audio/wav', b'')
        inst.writeAudio(_ii.AVI_ACTION.WRITE, 'audio/wav', b'abc')
        with pytest.raises(RuntimeError, match='vendor 500'):
            inst.writeAudio(_ii.AVI_ACTION.END, 'audio/wav', b'')

        assert bytes(inst._buffer) == b''
        inst.instance.writeText.assert_not_called()

    def test_video_lane_uses_the_same_buffering_path(self):
        inst = _instance()
        inst.IGlobal.transcribe.return_value = 'video transcript'

        inst.writeVideo(_ii.AVI_ACTION.BEGIN, 'video/mp4', b'')
        inst.writeVideo(_ii.AVI_ACTION.WRITE, 'video/mp4', b'frame-bytes')
        inst.writeVideo(_ii.AVI_ACTION.END, 'video/mp4', b'')

        inst.IGlobal.transcribe.assert_called_once_with(b'frame-bytes', 'video/mp4')
        inst.instance.writeText.assert_called_once_with('video transcript')

    def test_a_new_stream_via_open_resets_state_from_a_prior_clip(self):
        inst = _instance()
        inst.writeAudio(_ii.AVI_ACTION.BEGIN, 'audio/wav', b'')
        inst.writeAudio(_ii.AVI_ACTION.WRITE, 'audio/wav', b'leftover')

        inst.open(object=None)

        assert bytes(inst._buffer) == b''
        assert inst._mime_type == ''


# ---------------------------------------------------------------------------
# services.stt_deepgram.json — the no-profile-selector design choice (#2070)
# ---------------------------------------------------------------------------


class TestNoProfileSelector:
    """Guards the design choice documented in services.stt_deepgram.json and the
    README: no `profile` field, so connConfig never carries a `profile` key and
    every field stays on Config.getNodeConfig's no-profile-key branch. Adding a
    profile selector later without also nesting fields under profile objects
    would silently reintroduce the #2070 root-drop bug.
    """

    def test_no_profile_field_is_declared(self):
        data = parse_service_json(_DIR / _SERVICE)
        assert 'stt_deepgram.profile' not in data['fields']

    def test_all_config_fields_are_flat_in_the_pipe_shape(self):
        data = parse_service_json(_DIR / _SERVICE)
        pipe_props = next(s['properties'] for s in data['shape'] if s['section'] == 'Pipe')
        for field in (
            'stt_deepgram.apikey',
            'stt_deepgram.model',
            'stt_deepgram.language',
            'stt_deepgram.smartFormat',
            'stt_deepgram.punctuate',
        ):
            assert field in pipe_props
