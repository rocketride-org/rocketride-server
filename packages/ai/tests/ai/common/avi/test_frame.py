# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""``VideoFrameExtractor`` hands each video stream its own frame bookkeeping.

One object can carry several video streams, and a single extractor serves them in turn:
the shared node base stops the reader at the end of one stream and starts it again for
the next. What ``start()`` fails to clear therefore leaks from one video into the next.

Covers the two failure modes behind #1963: showinfo entries surviving a restart, and a
complete frame waiting forever for an entry that never comes. Also covers the start-time
seek, which ffmpeg applies after showinfo (an output seek), and the frames mode, whose
numbers are counted from the start of the video.
"""

import queue
import struct
import subprocess
import zlib
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace

import imageio_ffmpeg
import pytest
from rocketlib import AVI_ACTION
from ai.common.avi import frame as F
from ai.common.avi.frame import VideoFrameExtractor, frames_select

#: The catalog's test video: 25 fps, 74 s, so frame N sits at N / 25 seconds.
_VIDEO = Path(__file__).resolve().parents[6] / 'testdata' / 'video' / 'BBC - Tear down this wall.mp4'


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


def _extractor(calls, **config):
    """An extractor that records what reaches the frame callback; ``config`` overrides interval at 1 fps."""
    return VideoFrameExtractor(
        lambda image, number, ts: calls.append((image, number, ts)),
        name='FrameGrabber',
        config={'type': 'interval', 'fps': 1.0, **config},
    )


def _info(n, seconds):
    """A showinfo line as ffmpeg prints it for the n-th selected frame."""
    return f'[Parsed_showinfo_0 @ 0x0] n: {n:3d} pts: {int(seconds * 25000)} pts_time: {seconds:.6f}'


def _time_base(time_base):
    """The configuration line showinfo prints once, before the first frame."""
    return f'[Parsed_showinfo_0 @ 0x0] config in time_base: {time_base}, frame_rate: 25/1'


def _frame(n, pts, pts_time):
    """A showinfo frame line with an exact pts, as ffmpeg 7 prints it."""
    return f'[Parsed_showinfo_0 @ 0x0] n: {n:3d} pts: {pts:6d} pts_time:{pts_time}     duration:   1000'


def _queued(extractor):
    """Everything onInfo queued, in order."""
    return [extractor._frame_info_queue.get_nowait() for _ in range(extractor._frame_info_queue.qsize())]


def _vf(extractor):
    """The -vf filter chain the extractor hands ffmpeg."""
    return extractor._args[extractor._args.index('-vf') + 1]


def _run(**config):
    """Feed the test video through a real extractor; return each frame's (number, seconds)."""
    calls = []
    extractor = _extractor(calls, **config)
    data = _VIDEO.read_bytes()
    extractor.writeAVI(AVI_ACTION.BEGIN, 'video/mp4', b'')
    for offset in range(0, len(data), 1 << 20):
        extractor.writeAVI(AVI_ACTION.WRITE, 'video/mp4', data[offset : offset + (1 << 20)])
    extractor.writeAVI(AVI_ACTION.END, 'video/mp4', b'')
    return [(number, round(ts, 3)) for image, number, ts in calls if image is not None]


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


def test_start_forgets_the_previous_streams_time_base(monkeypatch):
    """Each stream's showinfo prints its own time base; the last video's must not cut the next."""
    monkeypatch.setattr(F.AVIReader, 'start', lambda self: None)

    extractor = _extractor([], start_time=12)
    extractor.onInfo(_time_base('1/25000'))
    assert extractor._start_pts == 300000, 'precondition: the cut is known'

    extractor.start()

    assert (extractor._time_base, extractor._start_pts) == (None, None)


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
    extractor = _extractor(calls, start_time=2.0)
    extractor.onInfo('[Parsed_showinfo_0 @ 0x0] n:  3 pts: 90000 pts_time: 5.000000')
    png = _png()
    extractor._buffer = bytearray(png)

    extractor._processBuffer()

    assert len(calls) == 1
    image, number, ts = calls[0]
    assert image == png
    assert number == 3
    assert ts == pytest.approx(5.0), 'pts_time already counts from the start of the video'
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


# =============================================================================
# The start-time seek
# =============================================================================


def test_without_a_time_base_entries_before_the_start_time_are_skipped_by_their_time():
    """The fallback for an ffmpeg that printed no time base: the printed time against the start.

    The frames the output seek drops still get showinfo entries; no PNG ever claims them.
    Queued, they would hand the first emitted frame an earlier frame's number and time,
    and shift every frame after it the same way.
    """
    extractor = _extractor([], start_time=12)
    for n, seconds in enumerate((0.0, 5.0, 10.0, 12.0, 15.0)):
        extractor.onInfo(_info(n, seconds))

    queued = [extractor._frame_info_queue.get_nowait() for _ in range(extractor._frame_info_queue.qsize())]

    assert queued == [(3, 12.0), (4, 15.0)]


@pytest.mark.parametrize(
    'start, time_base, expected',
    [
        ('12', Fraction(1, 25000), 300000),
        ('12.04001', Fraction(1, 25000), 301000),
        ('12.04003', Fraction(1, 25000), 301001),
        ('12.0400019', Fraction(1, 25000), 301000),
        ('100.045', Fraction(1, 30), 3001),
        ('100.06', Fraction(1, 30), 3002),
        ('0', Fraction(1, 12800), 0),
        ('not a number', Fraction(1, 25000), None),
    ],
)
def test_start_pts_cuts_where_ffmpeg_cuts(start, time_base, expected):
    """Microseconds (further digits dropped), rescaled to the time base rounding to nearest.

    The cases were checked against ffmpeg 7.1 with the extractor's output options: at
    -ss 12.04001 the 25 fps test video still emits frame 301 (pts 301000, 12.04 s), at
    12.04003 it does not; at -ss 100.045 a 30 fps source with time base 1/30 still
    emits the frame at 100.0333 s, at 100.06 it does not.
    """
    assert F.start_pts(start, time_base) == expected


def test_with_the_time_base_a_frame_the_seek_keeps_just_before_the_start_is_queued():
    """10 microseconds before the start: ffmpeg keeps the frame, so its entry must be queued.

    Compared in seconds the entry was skipped, and every PNG after it took the next
    frame's number and time.
    """
    extractor = _extractor([], start_time=12.04001)
    for line in (
        _time_base('1/25000'),
        _frame(0, 300000, '12'),
        _frame(1, 301000, '12.04'),
        _frame(2, 302000, '12.08'),
    ):
        extractor.onInfo(line)

    assert _queued(extractor) == [(1, 12.04), (2, 12.08)]


def test_with_the_time_base_a_frame_the_seek_drops_is_skipped():
    extractor = _extractor([], start_time=12.04003)
    for line in (
        _time_base('1/25000'),
        _frame(0, 300000, '12'),
        _frame(1, 301000, '12.04'),
        _frame(2, 302000, '12.08'),
    ):
        extractor.onInfo(line)

    assert _queued(extractor) == [(2, 12.08)]


def test_with_the_time_base_the_time_is_exact_not_the_printed_rounding():
    """An older ffmpeg prints six significant digits (100.033); pts and the time base are exact."""
    extractor = _extractor([], start_time=100)
    extractor.onInfo(_time_base('1/30'))
    extractor.onInfo(_frame(0, 3001, '100.033'))

    [(number, seconds)] = _queued(extractor)
    assert number == 0 and seconds == pytest.approx(3001 / 30, abs=1e-12)


# =============================================================================
# The frames mode
# =============================================================================


def test_frames_select_passes_exactly_the_listed_frames():
    """One eq() per frame, quoted so the filtergraph keeps the commas in the expression."""
    assert frames_select([1, 456, 712]) == "select='eq(n,1)+eq(n,456)+eq(n,712)'"


def test_an_empty_frames_list_selects_nothing():
    """An empty expression is an ffmpeg error; select=0 passes no frame instead."""
    assert frames_select([]) == 'select=0'


def test_frames_mode_sorts_the_list_into_the_filter_chain():
    """The list arrives in any order and with repeats; select passes frames in video order."""
    extractor = _extractor([], type='frames', frames=[712, 1, 456, 1])

    assert extractor._frames == [1, 456, 712]
    assert _vf(extractor) == "select='eq(n,1)+eq(n,456)+eq(n,712)',showinfo"


def test_frames_mode_reports_the_listed_number_not_the_ordinal():
    """The n in a showinfo entry counts the frames select passed; the n-th is the n-th listed number."""
    extractor = _extractor([], type='frames', frames=[712, 1, 456])
    for n, seconds in enumerate((0.04, 18.24, 28.48)):
        extractor.onInfo(_info(n, seconds))

    queued = [extractor._frame_info_queue.get_nowait() for _ in range(extractor._frame_info_queue.qsize())]

    assert [number for number, _seconds in queued] == [1, 456, 712]


# =============================================================================
# Through ffmpeg
# =============================================================================


@pytest.mark.skipif(not _VIDEO.exists(), reason='the test video is not checked out')
def test_an_interval_after_a_start_time_carries_its_own_times():
    """5 s interval from 12 s for 10 s: ffmpeg emits the frames at 10 s and 15 s, stamped so.

    The fps filter's time base is 5 s, and ffmpeg cuts in it: 12 s rounds to tick 2
    (10 s), 22 s to tick 4. Checked by PNG checksum against an unseeked run; compared in
    seconds the two images were stamped 15 s and 20 s.
    """
    frames = _run(fps=0.2, start_time=12, duration=10)

    assert [seconds for _number, seconds in frames] == [10.0, 15.0]


@pytest.mark.skipif(not _VIDEO.exists(), reason='the test video is not checked out')
def test_frames_mode_extracts_the_listed_frames_inside_the_window():
    """Frame 0 is before the 12 s start and frame 1000 (40 s) after the 18 s end."""
    frames = _run(type='frames', frames=[1000, 300, 0, 400, 300], start_time=12, duration=6)

    assert frames == [(300, 12.0), (400, 16.0)]


@pytest.mark.skipif(not _VIDEO.exists(), reason='the test video is not checked out')
def test_end_decoding_from_the_frame_callback_stops_ffmpeg_and_the_stream_still_ends():
    """A consumer with all it wants ends ffmpeg early; the stream winds down as after -frames:v."""
    frames = []

    def callback(image, number, seconds):
        frames.append(image)
        if image is not None and len(frames) == 1:
            extractor.end_decoding()  # on the data thread, where stop() would wait on its own join

    extractor = VideoFrameExtractor(callback, name='FrameGrabber', config={'type': 'interval', 'fps': 1.0})
    data = _VIDEO.read_bytes()
    extractor.writeAVI(AVI_ACTION.BEGIN, 'video/mp4', b'')
    for offset in range(0, len(data), 1 << 20):
        extractor.writeAVI(AVI_ACTION.WRITE, 'video/mp4', data[offset : offset + (1 << 20)])
    extractor.writeAVI(AVI_ACTION.END, 'video/mp4', b'')

    count = len([image for image in frames if image is not None])
    assert 1 <= count < 10, f'{count} frames after end_decoding; at 1 fps the whole 74 s video gives 74'
    assert frames[-1] is None, 'the end of the stream is still reported'


def test_writes_after_end_decoding_are_dropped_but_a_failed_decoder_still_raises():
    """end_decoding's kill exits nonzero by design; only an unrequested exit is an error."""
    extractor = _extractor([])
    # A started stream without ffmpeg: write() checks only these, and no real process
    # is involved; _started is cleared after, so __del__'s stop() has nothing to stop
    extractor._started = True
    extractor._ffmpeg_process = SimpleNamespace(poll=lambda: None, kill=lambda: None)
    try:
        extractor.end_decoding()
        extractor._done, extractor._exit_code = True, 1  # what the watcher records next
        extractor.write(b'the rest of the stream')  # dropped, not raised

        extractor._ended_by_consumer = False  # the same exit, not requested
        with pytest.raises(Exception, match='terminated with error 1'):
            extractor.write(b'the rest of the stream')
    finally:
        extractor._started = False


@pytest.mark.skipif(not _VIDEO.exists(), reason='the test video is not checked out')
def test_end_decoding_on_a_piped_stream_drops_the_remaining_writes(tmp_path):
    """MPEG-TS goes to ffmpeg's stdin as it arrives, so writes keep coming after the stop."""
    stream = tmp_path / 'clip.ts'
    subprocess.run(
        [
            imageio_ffmpeg.get_ffmpeg_exe(),
            '-loglevel',
            'error',
            '-i',
            str(_VIDEO),
            '-c',
            'copy',
            '-bsf:v',
            'h264_mp4toannexb',
            '-f',
            'mpegts',
            str(stream),
        ],
        check=True,
    )
    frames = []

    def callback(image, number, seconds):
        frames.append(image)
        if image is not None and len(frames) == 1:
            extractor.end_decoding()

    extractor = VideoFrameExtractor(callback, name='FrameGrabber', config={'type': 'interval', 'fps': 1.0})
    data = stream.read_bytes()
    extractor.writeAVI(AVI_ACTION.BEGIN, 'video/mp2t', b'')
    for offset in range(0, len(data), 1 << 16):
        extractor.writeAVI(AVI_ACTION.WRITE, 'video/mp2t', data[offset : offset + (1 << 16)])
    extractor.writeAVI(AVI_ACTION.END, 'video/mp2t', b'')

    assert extractor._isStdinCompatible, 'precondition: the stream was piped, not cached'
    count = len([image for image in frames if image is not None])
    assert 1 <= count < 10, f'{count} frames after end_decoding'
    assert frames[-1] is None, 'the end of the stream is still reported'


def test_end_decoding_terminates_only_a_running_process():
    """No process yet, or one that already exited: nothing to end."""
    extractor = _extractor([])
    terminated = []
    running = SimpleNamespace(poll=lambda: None, kill=lambda: terminated.append('running'))
    exited = SimpleNamespace(poll=lambda: 0, kill=lambda: terminated.append('exited'))

    extractor.end_decoding()
    extractor._ffmpeg_process = exited
    extractor.end_decoding()
    extractor._ffmpeg_process = running
    extractor.end_decoding()

    assert terminated == ['running']


@pytest.mark.skipif(not _VIDEO.exists(), reason='the test video is not checked out')
def test_a_frame_the_seek_keeps_just_before_the_start_carries_its_own_number():
    """At 12.04001 s ffmpeg still emits frame 301 (12.04 s); every frame keeps its own entry."""
    frames = _run(type='frames', frames=[300, 301, 302], start_time=12.04001, duration=1)

    assert frames == [(301, 12.04), (302, 12.08)]


@pytest.mark.skipif(not _VIDEO.exists(), reason='the test video is not checked out')
def test_frames_mode_numbers_frames_from_the_start_of_the_video():
    """With no start time, frame N is the N-th frame of the video, at N / 25 seconds."""
    frames = _run(type='frames', frames=[50, 5], start_time=0, duration=3)

    assert frames == [(5, 0.2), (50, 2.0)]


@pytest.mark.skipif(not _VIDEO.exists(), reason='the test video is not checked out')
def test_frames_mode_with_an_empty_list_extracts_nothing():
    """select=0 runs ffmpeg to the end of the window and passes no frame."""
    assert _run(type='frames', frames=[], start_time=0, duration=2) == []
