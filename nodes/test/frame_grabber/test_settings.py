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

"""Node-behavior test: frame_grabber reads every key from the call's settings.

Every key of the node, both selectors included, is a per-call parameter: the IGlobal
builds nothing, and the instance turns ``self.settings`` into the extractor's
configuration. Resolved against the engine's own schema, so a services.json edit the
engine rejects or resolves differently fails here. The scene gap and the frame cap the
instance applies itself are driven through ``_frame_callback``, clear of ffmpeg.
"""

import struct
import sys
import zlib
from pathlib import Path
from types import SimpleNamespace

import pytest
import rocketlib
from rocketlib import AVI_ACTION
from rocketlib.config import ConfigError, NodeInfo, resolveConfig

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from frame_grabber.IInstance import IInstance, extractor_config  # noqa: E402

#: The component id the caller's params are keyed by.
_NODE_ID = 'grabber_1'


# =============================================================================
# Helpers
# =============================================================================


def _schema():
    """The engine-resolved schema the node's config and settings resolve against."""
    schema = rocketlib.getServiceSchema('frame_grabber')
    assert schema is not None, 'frame_grabber is not registered with the engine'
    return schema


def _config(stored=None):
    """A control's config as its IGlobal would hold it."""
    node = NodeInfo(
        id=_NODE_ID, name=_NODE_ID, provider='frame_grabber', physicalType='python', capabilities=0, controlId=''
    )
    return resolveConfig(_schema(), stored or {}, node=node)


def _instance(stored=None, params=None):
    """A frame_grabber instance on a control with ``stored`` config, bound to a call sending ``params``."""
    inst = IInstance()
    inst.IGlobal = SimpleNamespace(config=_config(stored))
    inst._caller = {'params': {_NODE_ID: params or {}}}
    return inst


def _png():
    """A structurally valid 1x1 PNG: enough for the documents lane."""

    def chunk(tag, payload):
        """One PNG chunk: length, tag, payload, CRC."""
        body = tag + payload
        return struct.pack('>I', len(payload)) + body + struct.pack('>I', zlib.crc32(body))

    ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', ihdr)
        + chunk(b'IDAT', zlib.compress(b'\x00\x00\x00\x00'))
        + chunk(b'IEND', b'')
    )


class _Capture:
    """Stand-in for the engine binding (``self.instance``): records the documents lane."""

    class _Obj:
        """Minimal currentObject: what DocMetadata reads off the instance context."""

        objectId = 'v1'
        parent = '/inbox/clip.mp4'
        permissionId = 0
        componentId = 'comp-test'
        hasName = False
        name = None
        path = '/inbox/clip.mp4'

    def __init__(self):
        self.docs = []
        self.currentObject = self._Obj()

    def hasListener(self, lane):  # noqa: N802 (engine method name)
        return lane == 'documents'

    def writeDocuments(self, documents):  # noqa: N802 (engine method name)
        self.docs.extend(documents)


class _Reader:
    """Stand-in for the extractor: counts end_decoding, ignores the stream."""

    def __init__(self):
        self.ended = 0

    def writeAVI(self, *_args):  # noqa: N802 (engine method name)
        pass

    def end_decoding(self):
        self.ended += 1


def _wired(min_gap=0.0, max_frames=0):
    """An instance wired to capture documents, with the gap and cap it applies itself."""
    inst = IInstance()
    inst.instance = _Capture()
    inst.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(jobConfig={'nodeId': 'test-node'}))
    inst._reader = _Reader()
    inst._min_gap = min_gap
    inst._max_frames = max_frames
    inst.open(None)
    return inst


def _times(inst):
    """The timestamps of the frames the instance emitted, in order."""
    return [doc.metadata.time_stamp for doc in inst.instance.docs]


# =============================================================================
# The schema: every key a parameter
# =============================================================================


def test_every_key_is_a_parameter_and_only_the_frame_cap_is_hidden_from_an_llm():
    """Both selectors and every leaf of every branch; max_frames is a work cap."""
    params = {descriptor['field']: descriptor for descriptor in _schema()['params']}

    assert set(params) == {
        'profile',
        'start_time',
        'duration',
        'watermark',
        'yes.watermark_location',
        'yes.watermark_filename',
        'yes.watermark_timestamp',
        'interval.interval',
        'transition.percent',
        'transition.min_scene_gap',
        'transition.max_frames',
        'key.max_frames',
        'frames.list',
    }
    assert {field for field, descriptor in params.items() if not descriptor['tool']} == {
        'transition.max_frames',
        'key.max_frames',
    }


def test_the_frame_list_descriptor_carries_its_item():
    """A caller validates a frame list from the descriptor alone."""
    params = {descriptor['field']: descriptor for descriptor in _schema()['params']}

    assert params['frames.list']['type'] == 'array'
    assert params['frames.list']['item']['type'] == 'integer'
    assert params['frames.list']['item']['minimum'] == 0


def test_the_iglobal_config_refuses_a_parameter():
    """A parameter is per call: the control's config never serves one."""
    config = _config().restricted(refuse_params=True)

    with pytest.raises(ConfigError):
        config['start_time']


# =============================================================================
# The extractor's configuration
# =============================================================================


def test_an_untouched_node_extracts_every_five_seconds():
    """The defaults: interval mode, 5 s, the whole video."""
    assert extractor_config(_config()) == {'type': 'interval', 'start_time': 0, 'duration': 0, 'fps': 0.2}


def test_a_frames_control_takes_a_frame_list_per_call():
    """The plan's case: a frames-mode control and a call sending its list."""
    settings = _config({'profile': 'frames'}).overlay({'frames.list': [1, 456, 712]})

    config = extractor_config(settings)

    assert config['type'] == 'frames'
    assert config['frames'] == [1, 456, 712]


def test_an_interval_control_refuses_a_frame_list():
    """The list is under the frames branch, which an interval call does not select."""
    with pytest.raises(ConfigError, match='does not select'):
        _config().overlay({'frames.list': [1, 456, 712]})


def test_a_mode_parameter_moves_the_call_to_its_branch():
    """The mode is a parameter too: the call's value picks the branch its leaves resolve under."""
    settings = _config().overlay({'profile': 'frames', 'frames.list': [5]})

    assert extractor_config(settings) == {'type': 'frames', 'start_time': 0, 'duration': 0, 'frames': [5]}


@pytest.mark.parametrize('frames', [[-1], [1.5], list(range(1001))], ids=['negative', 'fraction', 'too-many'])
def test_a_frame_list_is_checked_item_by_item(frames):
    """Each number is a non-negative integer, and the list is bounded (it becomes one ffmpeg expression)."""
    with pytest.raises(ConfigError):
        _config({'profile': 'frames'}).overlay({'frames.list': frames})


def test_without_a_scene_gap_ffmpeg_applies_the_cap():
    """The cap goes to ffmpeg, which then decodes no further than it must."""
    stored = {'profile': 'transition', 'transition': {'max_frames': 3}}

    assert extractor_config(_config(stored)) == {
        'type': 'transition',
        'start_time': 0,
        'duration': 0,
        'percent': 0.4,
        'max_frames': 3,
    }


def test_with_a_scene_gap_the_node_applies_the_cap():
    """The cap stays with the node: ffmpeg's would count frames before the gap drops any."""
    stored = {'profile': 'transition', 'transition': {'max_frames': 3, 'min_scene_gap': 1.0}}

    assert 'max_frames' not in extractor_config(_config(stored))


# =============================================================================
# The instance reads its call's settings
# =============================================================================


def test_the_instance_reads_its_calls_parameters():
    """One control, one call's watermark and interval: nothing comes from the control alone."""
    inst = _instance(params={'watermark': 'yes', 'yes.watermark_location': 'top_left', 'interval.interval': 2})

    inst.beginInstance()

    assert inst._watermark is True
    assert inst._wm_location == 'top_left'
    assert inst._reader._fps == 0.5


def test_two_calls_on_one_control_read_their_own_values():
    """The control is shared; each binding's settings are its own call's."""
    first = _instance(params={'start_time': 10})
    second = _instance(params={'start_time': 20})

    first.beginInstance()
    second.beginInstance()

    assert (first._reader._start_time, second._reader._start_time) == (10, 20)


def test_a_frames_call_builds_a_frames_extractor():
    """The extractor gets the sorted list and its select filter."""
    inst = _instance(stored={'profile': 'frames'}, params={'frames.list': [712, 1, 456]})

    inst.beginInstance()

    assert inst._reader._frames == [1, 456, 712]


def test_the_instance_takes_the_cap_and_gap_it_applies():
    """With a gap the cap is the instance's, so beginInstance keeps both."""
    stored = {'profile': 'transition', 'transition': {'max_frames': 3, 'min_scene_gap': 2.0}}
    inst = _instance(stored=stored)

    inst.beginInstance()

    assert (inst._min_gap, inst._max_frames) == (2.0, 3)
    assert inst._reader._max_frames is None, 'ffmpeg must not cap before the gap'


# =============================================================================
# The scene gap and the frame cap
# =============================================================================


def test_a_frame_closer_than_the_gap_to_the_last_one_is_dropped():
    """The gap is measured from the last frame emitted, not the last frame seen."""
    inst = _wired(min_gap=1.0)

    for seconds in (0.0, 0.4, 1.0, 1.5, 2.1):
        inst._frame_callback(_png(), 0, seconds)

    assert _times(inst) == [0.0, 1.0, 2.1]


def test_a_dropped_frame_advances_nothing():
    """Chunk ids number the frames the object received, gap or not."""
    inst = _wired(min_gap=1.0)

    for seconds in (0.0, 0.4, 1.0):
        inst._frame_callback(_png(), 0, seconds)

    assert [doc.metadata.chunkId for doc in inst.instance.docs] == [0, 1]


def test_the_cap_counts_the_frames_the_gap_kept():
    """With a gap ffmpeg no longer caps; the instance stops at the cap of emitted frames."""
    inst = _wired(min_gap=1.0, max_frames=2)

    for seconds in (0.0, 0.5, 1.0, 1.5, 2.0, 3.0):
        inst._frame_callback(_png(), 0, seconds)

    assert _times(inst) == [0.0, 1.0]


def test_reaching_the_cap_ends_decoding_once():
    """With a gap ffmpeg runs uncapped; the last frame the cap allows stops it there."""
    inst = _wired(min_gap=1.0, max_frames=2)

    for seconds in (0.0, 0.5, 1.0, 1.5, 2.0, 3.0):
        inst._frame_callback(_png(), 0, seconds)

    assert _times(inst) == [0.0, 1.0]
    assert inst._reader.ended == 1, 'once, at the frame that reached the cap'


def test_without_a_cap_decoding_runs_to_the_end():
    inst = _wired(min_gap=1.0)

    for seconds in (0.0, 1.0, 2.0, 3.0):
        inst._frame_callback(_png(), 0, seconds)

    assert inst._reader.ended == 0


def test_the_gap_and_cap_start_again_with_each_video_stream():
    """The second video's timestamps start at 0 again; neither its gap nor its cap sees the first."""
    inst = _wired(min_gap=1.0, max_frames=2)

    inst.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')
    for seconds in (0.0, 1.0, 2.0):
        inst._frame_callback(_png(), 0, seconds)
    inst.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')
    for seconds in (0.0, 1.0, 2.0):
        inst._frame_callback(_png(), 0, seconds)

    assert _times(inst) == [0.0, 1.0, 0.0, 1.0]
