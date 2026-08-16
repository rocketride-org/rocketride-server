from typing import List
from .reader import AVIReader


class AudioReader(AVIReader):
    """
    Extract audio data from an audio or video stream using FFmpeg via AVIReader.

    Supports both WAV and PCM formats.
    """

    def onInfo(self, info: List[str]):
        pass

    def __init__(self, name: str, **kwargs):
        """
        Initialize the audio extractor.

        `config` may contain:
            - lock: threading.Lock (optional) — a lock to synchronize access
            - start_time: float (seconds)
            - duration: float (seconds)
            - sample_rate: int (e.g. 44100)
            - channels: int (e.g. 2)
            - format: str ('wav' or 'pcm') — default is 'wav'
        """
        self._start_time = kwargs.get('start_time', 0.0)
        self._duration = kwargs.get('duration', 0.0)
        self._sample_rate = kwargs.get('sample_rate', 44100)
        self._channels = kwargs.get('channels', 2)
        self._format = kwargs.get('format', 'wav').lower()  # Ensure lowercase format

        # Base ffmpeg arguments
        args = [
            '-ss',
            str(self._start_time),
            '-vn',  # Disable video
            '-ar',
            str(self._sample_rate),
            '-ac',
            str(self._channels),
        ]

        if self._format == 'pcm':
            # Use 16-bit PCM signed integer output (pcm_s16le)
            args += [
                '-f',
                's16le',  # 16-bit signed little-endian PCM
                '-acodec',
                'pcm_s16le',
            ]
        else:  # Default to WAV format
            args += [
                '-f',
                'wav',  # WAV container
                '-acodec',
                'pcm_s16le',  # 16-bit PCM data inside the WAV container
            ]

        # If duration is specified, set it
        if self._duration:
            args += ['-t', str(self._duration)]

        # Output to stdout
        args += [
            '-',  # Output to stdout
            '-hide_banner',
            '-loglevel',
            'error',
        ]

        # Call the superclass constructor with the generated args
        super().__init__(args, name, **kwargs)

    def getTimestamp(self) -> float:
        """Stream position, in seconds, of the decoded audio delivered so far.

        Backed by AVIReader's decoded-output byte count, incremented after each
        onData() callback — so from inside onData() this is the position where
        the current chunk starts.
        """
        # Both output modes emit pcm_s16le, so 2 bytes per sample either way.
        # In wav mode the count also includes the container header — a fixed
        # sub-millisecond offset, deliberately not parsed out; the pcm mode
        # used in production is exact.
        samples = self._bytes_read / 2
        frames = samples / self._channels
        return frames / self._sample_rate
