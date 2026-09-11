# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""MediaPublisher builds the right RTSP push per mime and resolves the WHEP url."""

from ai.account.media_publish import MediaPublisher, sfu_host


def test_video_copies_h264_and_targets_rtsp():
    pub = MediaPublisher('sfu.local', 'clip-abc', 'video/mp4')
    cmd = pub._cmd()
    assert '-c' in cmd and 'copy' in cmd  # H.264 copied, not re-encoded
    assert cmd[-1] == 'rtsp://sfu.local:8554/clip-abc'
    assert pub.whep_url == 'http://sfu.local:8889/clip-abc/whep'


def test_audio_transcodes_to_opus():
    cmd = MediaPublisher('h', 'a1', 'audio/mpeg')._cmd()
    assert 'libopus' in cmd  # WebRTC has no MP3
    assert cmd[-1] == 'rtsp://h:8554/a1'


def test_image_is_not_a_live_stream():
    assert MediaPublisher('h', 'i1', 'image/png')._cmd() is None


def test_whep_url_uses_public_base_over_the_rtsp_host(monkeypatch):
    # In cloud the client pulls WHEP from an https ingress, not the internal RTSP host:
    # the base wins for WHEP while the RTSP push still targets the SFU host.
    monkeypatch.setenv('ROCKETRIDE_MEDIA_WHEP_BASE', 'https://media.example.com/')
    pub = MediaPublisher('sfu.internal', 'clip-abc', 'video/mp4')
    assert pub.whep_url == 'https://media.example.com/clip-abc/whep'  # trailing slash trimmed, https kept
    assert pub._cmd()[-1] == 'rtsp://sfu.internal:8554/clip-abc'  # RTSP unchanged


def test_managed_config_opens_only_rtsp_and_webrtc():
    # The trimmed config must leave RTMP/HLS/SRT/API/metrics off so the host opens no
    # ports the media-plane never uses.
    from ai.account.sfu import _CONFIG

    assert 'rtsp: yes' in _CONFIG and 'webrtc: yes' in _CONFIG
    for off in ('rtmp: no', 'hls: no', 'srt: no', 'api: no', 'metrics: no'):
        assert off in _CONFIG
    # The catch-all path must stay: without it MediaMTX rejects every publish/read with
    # "path is not configured" (400), which silently breaks the whole media-plane.
    assert 'paths:' in _CONFIG and 'all_others:' in _CONFIG
    # RTSP ingest binds loopback: only the engine's own local ffmpeg may publish, so a shared
    # network can't push/overwrite streams on the managed SFU.
    assert 'rtspAddress: 127.0.0.1:' in _CONFIG


def test_managed_pushes_rtsp_to_loopback_but_serves_whep_on_the_lan(monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_MEDIA_SFU', 'managed')
    import ai.account.sfu as sfu
    from ai.account.media_publish import sfu_hosts

    monkeypatch.setattr(sfu, 'ensure_managed_sfu', lambda: '10.0.0.9')
    assert sfu_hosts() == ('10.0.0.9', '127.0.0.1')  # WHEP on the LAN, RTSP push on loopback
    whep_host, rtsp_host = sfu_hosts()
    pub = MediaPublisher(whep_host, 'clip', 'video/mp4', rtsp_host=rtsp_host)
    assert pub._cmd()[-1] == 'rtsp://127.0.0.1:8554/clip'  # only local ffmpeg can publish
    assert pub.whep_url == 'http://10.0.0.9:8889/clip/whep'  # clients still pull from the LAN


def test_sfu_host_uses_an_external_host_verbatim(monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_MEDIA_SFU', 'lab.local')
    assert sfu_host() == 'lab.local'  # external SFU, no managed boot


def test_sfu_host_is_off_unless_set(monkeypatch):
    # The dangerous default: unset must NOT download/run anything (a SaaS pod that never sets
    # the var stays inert instead of pulling MediaMTX onto its disk).
    monkeypatch.delenv('ROCKETRIDE_MEDIA_SFU', raising=False)
    import ai.account.sfu as sfu

    monkeypatch.setattr(sfu, 'ensure_managed_sfu', lambda: (_ for _ in ()).throw(AssertionError('booted')))
    assert sfu_host() is None  # no host, and ensure_managed_sfu was never called


def test_sfu_host_managed_only_when_opted_in(monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_MEDIA_SFU', 'managed')  # explicit opt-in to the local download
    import ai.account.sfu as sfu

    monkeypatch.setattr(sfu, 'ensure_managed_sfu', lambda: '10.0.0.9')
    assert sfu_host() == '10.0.0.9'


def test_feed_never_blocks_and_gives_up_on_a_stalled_encoder():
    # feed() queues for the writer thread; a stalled encoder (queue never drains, fills up)
    # marks the publisher dead and drops instead of blocking the caller on a pipe write.
    import queue as _q

    pub = MediaPublisher('sfu.local', 'clip', 'video/mp4')
    pub._proc = object()  # non-None so feed proceeds; no real writer thread in this unit test
    pub._queue = _q.Queue(maxsize=2)
    pub.feed(b'a')
    pub.feed(b'b')
    assert pub.failed is False  # room in the queue
    pub.feed(b'c')  # queue full -> encoder is not draining -> give up
    assert pub.failed is True
    pub.feed(b'd')  # dead publisher is a silent no-op


def test_pump_marks_dead_when_the_encoder_write_fails():
    # The writer thread (not feed) touches stdin now: a dead stdin marks the publisher dead.
    import queue as _q

    class _DeadStdin:
        closed = False

        def write(self, data):
            raise ValueError('write to closed file')

        def flush(self):
            pass

        def close(self):
            self.closed = True

    pub = MediaPublisher('sfu.local', 'clip', 'video/mp4')
    pub._proc = type('P', (), {'stdin': _DeadStdin()})()
    pub._queue = _q.Queue()
    pub._queue.put(b'frame')
    pub._queue.put(None)  # sentinel so the pump stops if the write somehow succeeds
    pub._pump_stdin()  # runs synchronously here
    assert pub.failed is True
