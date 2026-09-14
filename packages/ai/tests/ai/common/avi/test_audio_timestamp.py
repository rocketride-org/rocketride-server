"""AudioReader.getTimestamp() must track the decoded stream position.

The counter behind it lives in AVIReader._data_process, which nothing
incremented before: getTimestamp() divided a byte count that was only ever
reset, so every caller saw 0.0 and audio_transcribe stamped each 60s buffer
with time 0-60 instead of its stream position.

No ffmpeg here: _data_process is driven directly with a fake stdout, which is
exactly how decoded bytes reach onData() in production.
"""

import io

from ai.common.avi.audio import AudioReader

SAMPLE_RATE = 16000
BYTES_PER_SECOND = SAMPLE_RATE * 2  # int16 mono


class _Probe(AudioReader):
    """Records getTimestamp() as seen from inside each onData() callback."""

    def __init__(self):
        super().__init__(name='probe', format='pcm', sample_rate=SAMPLE_RATE, channels=1)
        self.stamps = []

    def onData(self, data):
        if data is not None:
            self.stamps.append(self.getTimestamp())


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


def test_timestamp_advances_with_decoded_bytes():
    reader = _Probe()
    one_second = b'\x00\x01' * SAMPLE_RATE

    _drive(reader, [one_second, one_second, one_second])

    assert reader.stamps == [0.0, 1.0, 2.0]
    assert reader.getTimestamp() == 3.0


def test_timestamp_inside_ondata_is_the_chunk_start():
    """The transcribe node reads the buffer start time from inside onData();
    counting before the callback would shift every buffer by one chunk.
    """
    reader = _Probe()

    _drive(reader, [b'\x00\x01' * (SAMPLE_RATE // 2)])  # 0.5 s

    assert reader.stamps == [0.0]
    assert reader.getTimestamp() == 0.5


def test_timestamp_resets_per_stream():
    reader = _Probe()
    _drive(reader, [b'\x00\x01' * SAMPLE_RATE])
    assert reader.getTimestamp() == 1.0

    reader._started = False  # writeAVI(END) side effects are not under test here
    reader.start()

    assert reader.getTimestamp() == 0.0


def test_wav_format_also_uses_16bit_samples():
    """Both output modes emit pcm_s16le — the old wav branch divided by 4,
    a sample size the ffmpeg args never produce.
    """

    class _WavProbe(AudioReader):
        def onData(self, data):
            pass

    reader = _WavProbe(name='wav', format='wav', sample_rate=8000, channels=2)
    reader._bytes_read = 8000 * 2 * 2  # one second of stereo pcm_s16le

    assert reader.getTimestamp() == 1.0
