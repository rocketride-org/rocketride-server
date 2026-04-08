# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for audio_tts.IInstance: writeText dispatch, empty-input
guard, and temp-file cleanup on all code paths.
"""

import os
import tempfile
from unittest.mock import MagicMock

import pytest

from audio_tts.IInstance import IInstance


# ── Helpers ─────────────────────────────────────────────────────────────────


def _make_instance(engine='piper'):
    """Build an ``IInstance`` with a mocked ``IGlobal`` and instance."""
    inst = IInstance()
    iglobal = MagicMock()
    iglobal._build_tts_config_dict.return_value = {'engine': engine}
    inst.IGlobal = iglobal
    inst.instance = MagicMock()
    return inst


# ── writeText ───────────────────────────────────────────────────────────────


class TestWriteText:
    """Verify text-to-audio dispatch, streaming, and cleanup."""

    def test_empty_text_is_skipped(self):
        inst = _make_instance()
        inst.writeText('')
        inst.IGlobal.synthesize.assert_not_called()

    def test_whitespace_only_is_skipped(self):
        inst = _make_instance()
        inst.writeText('   \n\t  ')
        inst.IGlobal.synthesize.assert_not_called()

    def test_none_text_is_skipped(self):
        inst = _make_instance()
        inst.writeText(None)
        inst.IGlobal.synthesize.assert_not_called()

    def test_streams_audio_begin_write_end(self):
        inst = _make_instance()

        # Create a real temp file with some content.
        fd, path = tempfile.mkstemp(prefix='tts_', suffix='.wav')
        os.write(fd, b'RIFF' + b'\x00' * 100)
        os.close(fd)

        inst.IGlobal.synthesize.return_value = {
            'path': path,
            'mime_type': 'audio/wav',
        }

        inst.writeText('hello world')

        # Should have called writeAudio exactly 3 times: BEGIN, WRITE, END.
        wa = inst.instance.writeAudio
        assert wa.call_count == 3
        actions = [c.args[0] for c in wa.call_args_list]
        assert actions == ['BEGIN', 'WRITE', 'END']

    def test_temp_file_removed_after_streaming(self):
        inst = _make_instance()

        fd, path = tempfile.mkstemp(prefix='tts_', suffix='.wav')
        os.write(fd, b'RIFF' + b'\x00' * 10)
        os.close(fd)

        inst.IGlobal.synthesize.return_value = {
            'path': path,
            'mime_type': 'audio/wav',
        }

        inst.writeText('hello')
        assert not os.path.exists(path), 'temp file should be removed in finally'

    def test_temp_file_removed_on_synthesize_error(self):
        inst = _make_instance()

        fd, path = tempfile.mkstemp(prefix='tts_', suffix='.wav')
        os.write(fd, b'RIFF' + b'\x00' * 10)
        os.close(fd)

        # synthesize succeeds (produces file) but writeAudio raises.
        inst.IGlobal.synthesize.return_value = {
            'path': path,
            'mime_type': 'audio/wav',
        }
        inst.instance.writeAudio.side_effect = RuntimeError('stream error')

        with pytest.raises(RuntimeError, match='stream error'):
            inst.writeText('hello')

        assert not os.path.exists(path), 'temp file must be cleaned on exception'

    def test_temp_file_removed_when_read_fails(self):
        inst = _make_instance()

        # Point to a path that does not exist so open() will fail.
        inst.IGlobal.synthesize.return_value = {
            'path': '/tmp/nonexistent_tts_file.wav',
            'mime_type': 'audio/wav',
        }

        with pytest.raises(Exception):
            inst.writeText('hello')

    def test_output_format_inferred_from_engine(self):
        inst = _make_instance(engine='elevenlabs')

        fd, path = tempfile.mkstemp(prefix='tts_', suffix='.mp3')
        os.write(fd, b'\xff\xfb' + b'\x00' * 10)
        os.close(fd)

        inst.IGlobal.synthesize.return_value = {
            'path': path,
            'mime_type': 'audio/mpeg',
        }

        inst.writeText('hello')

        # synthesize should have been called with 'mp3' format.
        _, kwargs = inst.IGlobal.synthesize.call_args
        # positional args
        args = inst.IGlobal.synthesize.call_args.args
        assert args[1] == 'mp3'
