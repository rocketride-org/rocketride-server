# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Push a produced media lane to an SFU so the client pulls it live over WHEP.

The bundled ffmpeg has no WHIP muxer but does have RTSP; MediaMTX ingests the RTSP
and re-exposes it as WHEP — one ffmpeg per stream, bytes in on stdin, RTSP out.
"""

import os
import queue
import subprocess
import threading

from ai.common.utils.subprocess_utils import close_stdin

# Host of the SFU (MediaMTX). The media-plane is OFF unless this is set explicitly:
#   unset            -> no SFU; media falls back to the spool/persisted delivery
#   'managed'/'local'-> the engine downloads and runs its own MediaMTX (OSS/local dev)
#   <host>           -> an external SFU at that host (SaaS points here)
# Off-by-default is deliberate: a deploy that never sets this (e.g. a SaaS pod) must never
# download a binary onto its disk or open ports on its own — it opts in, or stays inert.
_SFU_ENV = 'ROCKETRIDE_MEDIA_SFU'
# Values of _SFU_ENV that opt into the bundled download-and-run instead of an external host.
_MANAGED_VALUES = {'managed', 'local'}
# Public base URL clients pull WHEP from (e.g. an https ingress in front of the SFU).
# Unset => the LAN default http://<sfu-host>:8889. Lets the client-facing WHEP host and
# scheme differ from the internal RTSP host, so a cloud SFU takes RTSP over a private link
# and serves WHEP over https (a browser on an https page rejects an http WHEP url).
_WHEP_BASE_ENV = 'ROCKETRIDE_MEDIA_WHEP_BASE'
_RTSP_PORT = 8554
_WHEP_PORT = 8889
_STDERR_TAIL = 4096
_FINISH_TIMEOUT = 30
# Chunks buffered for the writer thread before a non-draining (stalled) encoder is given up on.
_FEED_QUEUE_MAX = 512


def sfu_hosts():
    """``(whep_host, rtsp_push_host)`` resolved from ROCKETRIDE_MEDIA_SFU, or None (off):

    - unset             -> None; no live media-plane, the caller falls back to the spool
    - 'managed'/'local' -> ``(LAN host, '127.0.0.1')`` — the bundled MediaMTX binds RTSP to
                           loopback, so only the engine's own ffmpeg can publish, while WHEP
                           still serves on the LAN for remote clients to pull
    - <host>            -> ``(host, host)`` — an external SFU (SaaS points here)

    Nothing is downloaded or started unless the value explicitly asks for the managed mode,
    so a pod that never sets this stays inert instead of pulling a binary onto its disk.
    """
    value = os.environ.get(_SFU_ENV)
    if not value:
        return None
    if value.strip().lower() in _MANAGED_VALUES:
        from ai.account.sfu import ensure_managed_sfu

        host = ensure_managed_sfu()
        return (host, '127.0.0.1') if host else None
    return (value, value)


def sfu_host():
    """The client-facing (WHEP) SFU host, or None. See :func:`sfu_hosts` for the push host."""
    hosts = sfu_hosts()
    return hosts[0] if hosts else None


def _ffmpeg_exe():
    """The bundled ffmpeg (same one video_composer uses), or PATH's as a fallback."""
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, AttributeError):
        return 'ffmpeg'


class MediaPublisher:
    """One ffmpeg pushing a lane's bytes to the SFU over RTSP; WHEP url for the client."""

    def __init__(self, host: str, stream_id: str, mime: str, rtsp_host: str = None):
        self._host = host  # client-facing (WHEP) host
        self._rtsp_host = rtsp_host or host  # where ffmpeg pushes RTSP (loopback for managed)
        self._id = stream_id
        self._mime = mime or ''
        self._proc = None
        self._stderr_tail = b''
        self._stderr_thread = None
        self._dead = False
        self._whep = None
        self._queue = None
        self._writer_thread = None

    @property
    def whep_url(self) -> str:
        """Where the client pulls this stream (MediaMTX re-exposes the RTSP as WHEP).

        A public ROCKETRIDE_MEDIA_WHEP_BASE (e.g. an https ingress) wins so the browser
        gets a same-scheme url; otherwise the LAN default on the SFU host. When JWT auth is
        configured the url carries a token scoped to this stream, computed once so the trace
        and the announcement match.
        """
        if self._whep is None:
            base = os.environ.get(_WHEP_BASE_ENV)
            if base:
                url = f'{base.rstrip("/")}/{self._id}/whep'
            else:
                url = f'http://{self._host}:{_WHEP_PORT}/{self._id}/whep'
            from ai.account import media_auth

            token = media_auth.read_token(self._id)
            self._whep = f'{url}?jwt={token}' if token else url
        return self._whep

    @property
    def failed(self) -> bool:
        """True once the encoder died mid-stream; diagnose the cause via stderr_tail."""
        return self._dead

    @property
    def stderr_tail(self) -> str:
        """The tail of ffmpeg's diagnostics (e.g. 'Connection refused'), decoded lossily."""
        return self._stderr_tail.decode('utf-8', 'replace').strip()

    def _cmd(self):
        """Ffmpeg argv: copy H.264 video as-is; transcode audio to Opus (WebRTC needs it)."""
        if self._mime.startswith('video/'):
            codec = ['-c', 'copy']
        elif self._mime.startswith('audio/'):
            codec = ['-c:a', 'libopus', '-b:a', '128k']
        else:
            return None  # a single image is not a live stream
        url = f'rtsp://{self._rtsp_host}:{_RTSP_PORT}/{self._id}'
        from ai.account import media_auth

        token = media_auth.publish_token(self._id)
        if token:  # a jwt-enforcing SFU gates the RTSP ingest too
            url = f'{url}?jwt={token}'
        return [
            _ffmpeg_exe(),
            '-hide_banner',
            '-loglevel',
            'error',
            # Start on the first bytes instead of probing a long header.
            '-probesize',
            '32',
            '-analyzeduration',
            '0',
            '-fflags',
            '+nobuffer+genpts',
            '-i',
            'pipe:0',
            *codec,
            '-f',
            'rtsp',
            '-rtsp_transport',
            'tcp',
            url,
        ]

    def begin(self) -> bool:
        """Launch the RTSP push. Returns False if the mime isn't streamable or ffmpeg won't start."""
        cmd = self._cmd()
        if cmd is None:
            return False
        try:
            self._proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        except (OSError, subprocess.SubprocessError):
            self._proc = None
            return False
        self._queue = queue.Queue(maxsize=_FEED_QUEUE_MAX)
        self._writer_thread = threading.Thread(target=self._pump_stdin, daemon=True)
        self._writer_thread.start()
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()
        return True

    def feed(self, data: bytes) -> None:
        """Queue one chunk for the writer thread — never blocks the caller. If the encoder has
        stalled (queue full), the publisher is marked dead and the chunk dropped, so a stuck
        ffmpeg can't wedge the engine callback thread on a blocking pipe write.
        """
        if self._proc is None or self._dead or not data:
            return
        try:
            self._queue.put_nowait(data)
        except queue.Full:
            self._dead = True

    def _pump_stdin(self) -> None:
        """Drain the queue into ffmpeg's stdin on a dedicated thread, so a blocking write stalls
        only here, never the producer. A ``None`` sentinel (from finish) flushes then EOFs.
        """
        while True:
            data = self._queue.get()
            if data is None:  # sentinel: all data written, close stdin so ffmpeg finalizes
                self._close_stdin()
                return
            try:
                self._proc.stdin.write(data)
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError, ValueError):
                self._dead = True
                self._close_stdin()
                return

    def finish(self) -> None:
        """Stop the writer, close the input, and reap ffmpeg; kill it if it overruns the timeout."""
        if self._writer_thread is not None:
            try:
                self._queue.put_nowait(None)  # drain the queue, then EOF
            except queue.Full:
                # Stalled: the pump is blocked in a write. Break it so it can exit.
                self._dead = True
                self._close_stdin()
            self._writer_thread.join(timeout=_FINISH_TIMEOUT)
        else:
            self._close_stdin()
        if self._proc is None:
            return
        try:
            self._proc.wait(timeout=_FINISH_TIMEOUT)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait()
        # An encoder can die (RTSP refused, codec rejected) before any write fails — a short clip
        # fits the OS pipe buffer, so every write "succeeds". Catch it on the exit code so the
        # caller's fallback fires instead of announcing a dead stream.
        if self._proc.returncode:
            self._dead = True
        if self._stderr_thread is not None:
            self._stderr_thread.join(timeout=1)  # let the drain finish so stderr_tail is populated

    def _close_stdin(self) -> None:
        close_stdin(self._proc)

    def _drain_stderr(self) -> None:
        """Keep the tail of ffmpeg's diagnostics and stop its stderr pipe from filling."""
        try:
            self._stderr_tail = self._proc.stderr.read()[-_STDERR_TAIL:]
        except (OSError, ValueError):
            pass
