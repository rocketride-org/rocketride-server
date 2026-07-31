# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Node-behavior test: image_cleanup carries nested source provenance across the hop.

Drives the real ``IInstance`` (image lane BEGIN/WRITE/END) with the real descriptor
helpers and a mocked ``IGlobal.process``, asserting the forwarded image ``BEGIN`` nests
the input's source chain and keeps its name. Exercises the shared
``forward_enriched_image`` wiring adopted by every image->image node; image_cleanup is
used because its inference is a single mockable call.

The nodes/test suite runs under the engine's bundled Python, which carries the engine's
core deps (rocketlib, ai.common, json5) but not node-optional ones like Pillow. So the
processed bytes are opaque here (no image library) and dimension decoding is asserted
separately in the descriptor unit tests, where Pillow is available.
"""

import json
import sys
from pathlib import Path

from rocketlib import AVI_ACTION
from ai.common.avi.descriptor import build_stream_descriptor, descriptor_to_payload

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from image_cleanup.IInstance import IInstance  # noqa: E402

# image_cleanup's IGlobal.process is mocked to return these opaque "cleaned" bytes.
_OUT_BYTES = b'cleaned-image-bytes'


class _Capture:
    """Stand-in for the engine binding (``self.instance``): records writeImage calls."""

    def __init__(self):
        self.calls = []

    def writeImage(self, action, mime, buffer=None):  # noqa: N802 (engine method name)
        self.calls.append((action, mime, buffer))


class _FakeGlobal:
    """image_cleanup calls ``IGlobal.process(mime, data) -> (mime, out_bytes)``."""

    def process(self, mime, data):
        return mime, _OUT_BYTES


def _send(inst, action, mime, buffer):
    """
    Drive one writeImage action. image_cleanup ends with ``return self.preventDefault()``
    on every action (raises by engine contract); the emit already happened, so swallow it.
    """
    try:
        inst.writeImage(action, mime, buffer)
    except Exception:
        pass


def _frame_descriptor_payload():
    """A frame descriptor (image/png with a nested video source), serialized for the BEGIN slot."""
    video = {'source_mime': 'video/mp4', 'duration': 74.05}
    frame = build_stream_descriptor(
        None,
        'image',
        objectId='v1',
        parent='/inbox/BBC.mp4',
        permissionId=0,
        signature='s',
        nodeId='n',
        origin='extracted',
        source_mime='image/png',
        size=40213,
        stream_index=0,
        name='BBC.frame0.png',
        source=video,
    )
    return descriptor_to_payload(frame)


def test_image_cleanup_forwards_nested_source_and_name():
    """The output image BEGIN nests the input's chain (frame -> video) and keeps its name."""
    inst = IInstance()
    capture = _Capture()
    inst.instance = capture
    inst.IGlobal = _FakeGlobal()

    _send(inst, AVI_ACTION.BEGIN, 'image/png', _frame_descriptor_payload())
    _send(inst, AVI_ACTION.WRITE, 'image/png', b'raw-bytes')
    _send(inst, AVI_ACTION.END, 'image/png', b'')

    # Exactly the enriched triplet was forwarded.
    assert [a for a, _, _ in capture.calls] == [AVI_ACTION.BEGIN, AVI_ACTION.WRITE, AVI_ACTION.END]
    _, begin_mime, begin_payload = capture.calls[0]
    assert begin_mime == 'image/png'

    payload = json.loads(begin_payload.decode('utf-8'))
    # The transform's own size at the top; the input's chain nested under `source`.
    assert payload['size'] == len(_OUT_BYTES)
    assert payload['name'] == 'BBC.frame0.png'  # inherited (one-to-one)
    assert payload['source']['source_mime'] == 'image/png'  # the input frame layer
    assert payload['source']['source'] == {'source_mime': 'video/mp4', 'duration': 74.05}  # video, nested deeper
