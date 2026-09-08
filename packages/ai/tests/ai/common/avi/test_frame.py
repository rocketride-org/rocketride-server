# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""``VideoFrameExtractor`` hands each video stream its own frame bookkeeping.

One object can carry several video streams, and a single extractor serves them in turn:
the shared node base stops the reader at the end of one stream and starts it again for
the next. What ``start()`` fails to clear therefore leaks from one video into the next.

Covers the two failure modes behind #1963: showinfo entries surviving a restart, and a
complete frame waiting forever for an entry that never comes.
"""

import queue
import struct
import zlib

import pytest
from ai.common.avi import frame as F
from ai.common.avi.frame import VideoFrameExtractor


def _png(width=1, height=1):
    """A minimal, structurally complete PNG.

    ``extract_complete_png`` scans for the signature and the IEND trailer, so the frame
    only has to be well formed at the chunk level — no encoder needed.
    """

    def chunk(tag, payload):
        body = tag + payload
        return struct.pack('>I', len(payload)) + body + struct.pack('>I', zlib.crc32(body))

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', ihdr)
        + chunk(b'IDAT', zlib.compress(b'\x00' + b'\x00' * 3 * width))
        + chunk(b'IEND', b'')
    )


def _extractor(calls):
    """An extractor that records what reaches the frame callback."""
    return VideoFrameExtractor(
        lambda image, number, ts: calls.append((image, number, ts)),
        name='FrameGrabber',
        config={'type': 'interval', 'fps': 1.0},
    )


def test_start_drops_frame_info_the_previous_stream_left_behind(monkeypatch):
    """The entry that used to be handed to the next video's first frame.

    `onInfo` pushes from the stderr thread independently of PNG extraction, so a stream
    that ends with entries still unread leaves them queued. Without this the next stream
    opens by popping the previous video's frame number and timestamp.
    """
    # The real start() launches ffmpeg; only the reset this class adds is under test.
    monkeypatch.setattr(F.AVIReader, 'start', lambda self: None)

    calls = []
    extractor = _extractor(calls)
    extractor.onInfo('[Parsed_showinfo_0 @ 0x0] n:  7 pts: 90000 pts_time: 7.000000')
    assert extractor._frame_info_queue.qsize() == 1, 'precondition: the entry is queued'

    extractor.start()

    assert extractor._frame_info_queue.empty(), 'the next stream would inherit this entry'


def test_start_also_clears_the_buffer_and_done_flag(monkeypatch):
    """The resets that were already there stay there."""
    monkeypatch.setattr(F.AVIReader, 'start', lambda self: None)

    extractor = _extractor([])
    extractor._buffer = bytearray(b'left over')
    extractor._done = True

    extractor.start()

    assert extractor._buffer == bytearray()
    assert extractor._done is False


def test_a_frame_whose_info_never_arrives_does_not_wedge_the_thread(monkeypatch):
    """A complete PNG with an empty queue used to block the data thread for good.

    `_processBuffer` runs on the data thread, so an open-ended wait there also hangs
    `stop()` on its `join()`. It now gives up, leaves the frame buffered for a later
    chunk, and says so.
    """
    monkeypatch.setattr(F, '_FRAME_INFO_TIMEOUT', 0.01)
    warnings = []
    monkeypatch.setattr(F, 'warning', lambda message: warnings.append(message))

    calls = []
    extractor = _extractor(calls)
    png = _png()
    extractor._buffer = bytearray(png)

    extractor._processBuffer()  # must return rather than block

    assert calls == [], 'no frame may be emitted without its own showinfo entry'
    assert extractor._buffer == bytearray(png), 'the frame stays buffered for a retry'
    assert len(warnings) == 1 and 'showinfo' in warnings[0]


def test_a_frame_is_emitted_with_its_own_info(monkeypatch):
    """The ordinary path: the entry is there and the frame carries its numbers."""
    monkeypatch.setattr(F, '_FRAME_INFO_TIMEOUT', 1.0)

    calls = []
    extractor = _extractor(calls)
    extractor._start_time = 2.0
    extractor.onInfo('[Parsed_showinfo_0 @ 0x0] n:  3 pts: 90000 pts_time: 5.000000')
    png = _png()
    extractor._buffer = bytearray(png)

    extractor._processBuffer()

    assert len(calls) == 1
    image, number, ts = calls[0]
    assert image == png
    assert number == 3
    assert ts == pytest.approx(7.0), 'pts_time is offset by the stream start time'
    assert extractor._buffer == bytearray(), 'the frame is consumed'


def test_frames_keep_their_own_info_across_a_restart(monkeypatch):
    """End to end for #1963: two streams through one extractor.

    Without the reset in `start()`, the second video's frame would be emitted with the
    first video's leftover number.
    """
    monkeypatch.setattr(F.AVIReader, 'start', lambda self: None)
    monkeypatch.setattr(F, '_FRAME_INFO_TIMEOUT', 1.0)

    calls = []
    extractor = _extractor(calls)
    png = _png()

    # Stream A: two entries queued, only one frame ever arrives.
    extractor.start()
    extractor.onInfo('[Parsed_showinfo_0 @ 0x0] n:  0 pts: 0 pts_time: 0.000000')
    extractor.onInfo('[Parsed_showinfo_0 @ 0x0] n: 99 pts: 90000 pts_time: 9.000000')
    extractor._buffer = bytearray(png)
    extractor._processBuffer()

    # Stream B: the reader is restarted, and its first frame is frame 0 of that video.
    extractor.start()
    extractor.onInfo('[Parsed_showinfo_0 @ 0x0] n:  0 pts: 0 pts_time: 0.000000')
    extractor._buffer = bytearray(png)
    extractor._processBuffer()

    assert [number for _image, number, _ts in calls] == [0, 0], (
        "the second stream inherited the first one's leftover frame number"
    )


def test_queue_module_error_is_the_one_being_caught():
    """Guards the import: `queue.Empty` is what `get(timeout=...)` raises."""
    q = queue.Queue()
    with pytest.raises(queue.Empty):
        q.get(timeout=0.01)
