"""AVIReader keeps a failure in the end-of-stream callback for stop() to re-raise.

_data_process runs on the reader's own thread. A chunk callback that raises is
logged and stored in ``_error``, and stop() re-raises it on the pipe thread at
END. The final ``onData(None)`` call sat outside that capture, so its exception
ended the thread and END returned normally. audio_transcribe transcribes its
last window in that call, which for a recording no longer than
``chunk_duration`` is the whole recording.

No ffmpeg here: _data_process is driven directly with a fake stdout, as in
test_audio_timestamp.py.
"""

import io

import pytest

from ai.common.avi.audio import AudioReader

SAMPLE_RATE = 16000


class _FailsAtEnd(AudioReader):
    """Accepts every chunk, then fails in the end-of-stream callback."""

    def __init__(self):
        super().__init__(name='probe', format='pcm', sample_rate=SAMPLE_RATE, channels=1)
        self.chunks = 0

    def onData(self, data):
        if data is None:
            raise RuntimeError('Whisper inference failed: final window')
        self.chunks += 1


class _ChunkedStdout(io.RawIOBase):
    """Feeds fixed-size chunks regardless of the size _data_process asks for."""

    def __init__(self, chunks):
        self._chunks = list(chunks)

    def read(self, _size=-1):
        return self._chunks.pop(0) if self._chunks else b''


def _drive(reader, chunks):
    reader.start()
    reader.stdout = _ChunkedStdout(chunks)
    reader._data_process()


def test_end_of_stream_failure_is_raised_by_stop():
    """The data thread returns normally and stop() re-raises the failure on the pipe thread."""
    reader = _FailsAtEnd()

    _drive(reader, [b'\x00\x01' * SAMPLE_RATE])

    assert reader.chunks == 1
    assert isinstance(reader._error, RuntimeError)
    with pytest.raises(RuntimeError, match='Whisper inference failed: final window'):
        reader.stop()
