# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Node-behavior test: image_cleanup carries nested source provenance across the hop.

Drives the real ``IInstance`` (image lane BEGIN/WRITE/END) with the real descriptor
helpers and a mocked ``IGlobal.process``, asserting the forwarded image ``BEGIN`` carries
the transform's own detail (size + decoded dims), nests the input's source chain, and
keeps its name. Exercises the shared ``forward_enriched_image`` wiring adopted by every
image->image node; image_cleanup is used because its inference is a single mockable call.

Imports the real node and uses Pillow (real PNG + dimension decoding); both ``json5``
(via ``ai.common.config``) and ``Pillow`` are declared in ``nodes/test/requirements.txt``.
"""

import io
import json
import sys
from pathlib import Path

from PIL import Image

from rocketlib import AVI_ACTION
from ai.common.avi.descriptor import build_stream_descriptor, descriptor_to_payload

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))

from image_cleanup.IInstance import IInstance  # noqa: E402


def _png(width, height):
    """A tiny real PNG so best-effort dimension decoding has something to read."""
    buf = io.BytesIO()
    Image.new('RGB', (width, height), (10, 20, 30)).save(buf, format='PNG')
    return buf.getvalue()


class _Capture:
    """Stand-in for the engine binding (``self.instance``): records writeImage calls."""

    def __init__(self):
        self.calls = []

    def writeImage(self, action, mime, buffer=None):  # noqa: N802 (engine method name)
        self.calls.append((action, mime, buffer))


class _FakeGlobal:
    """image_cleanup calls ``IGlobal.process(mime, data) -> (mime, out_bytes)``."""

    def __init__(self, out_bytes):
        self._out = out_bytes

    def process(self, mime, data):
        return mime, self._out


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
    """The output image BEGIN carries dims, nests the input's chain (frame -> video), keeps its name."""
    inst = IInstance()
    capture = _Capture()
    inst.instance = capture
    out_png = _png(64, 48)
    inst.IGlobal = _FakeGlobal(out_png)

    _send(inst, AVI_ACTION.BEGIN, 'image/png', _frame_descriptor_payload())
    _send(inst, AVI_ACTION.WRITE, 'image/png', _png(64, 48))
    _send(inst, AVI_ACTION.END, 'image/png', b'')

    # Exactly the enriched triplet was forwarded.
    assert [a for a, _, _ in capture.calls] == [AVI_ACTION.BEGIN, AVI_ACTION.WRITE, AVI_ACTION.END]
    _, begin_mime, begin_payload = capture.calls[0]
    assert begin_mime == 'image/png'

    payload = json.loads(begin_payload.decode('utf-8'))
    # The transform's own detail at the top; the input's chain nested under `source`.
    assert payload['size'] == len(out_png)
    assert payload['width'] == 64 and payload['height'] == 48
    assert payload['name'] == 'BBC.frame0.png'  # inherited (one-to-one)
    assert payload['source']['source_mime'] == 'image/png'  # the input frame layer
    assert payload['source']['source'] == {'source_mime': 'video/mp4', 'duration': 74.05}  # video, nested deeper
