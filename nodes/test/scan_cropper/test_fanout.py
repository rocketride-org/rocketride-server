# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Node-behavior test: scan_cropper emits one image stream per photo, plus an audit record.

Drives the real ``IInstance`` (image lane BEGIN/WRITE/END) with a fake ``IGlobal.split_scan``,
which is the node's single seam onto cv2 — the same trick ``image_cleanup``'s provenance test
plays with ``IGlobal.process``. That is what lets this run at all: the nodes/test suite uses the
engine's bundled Python, which carries rocketlib and ai.common but neither cv2 nor Pillow, so a
test that reached real detection could not execute. The canned crop bytes are deliberately
opaque for the same reason.

What is actually asserted here is the plumbing the detector cannot check itself: that N photos
become N downstream objects, that their names are dense and unique across a whole object, and
that the text lane can tell "could not read this" apart from "read it, found nothing".
"""

import json
import sys
from pathlib import Path

from rocketlib import APERR, AVI_ACTION, Ec
from ai.common.avi.descriptor import build_stream_descriptor, descriptor_to_payload

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from scan_cropper.IInstance import IInstance  # noqa: E402


def _region(cx, cy, w=400.0, h=520.0):
    """One entry of the regions list, as split_scan builds it — plain builtins only."""
    return {
        'cx': cx,
        'cy': cy,
        'w': w,
        'h': h,
        'angle': 0.0,
        'area_pct': 10.0,
        'ratio_error': 2.0,
        'cropped': False,  # split_scan sets it on every region, crop loop or not
    }


def _crop(region_index, data=b'jpeg-bytes'):
    """One entry of the crops list, pointing back at the region it came from."""
    return {'data': data, 'width': 400, 'height': 520, 'region': region_index}


class _Capture:
    """Stand-in for the engine binding (``self.instance``): records what the node emitted."""

    def __init__(self, listeners=('image', 'text')):
        self.calls = []
        self.texts = []
        self._listeners = set(listeners)

    def hasListener(self, lane):  # noqa: N802 (engine method name)
        return lane in self._listeners

    def writeImage(self, action, mime, buffer=None):  # noqa: N802 (engine method name)
        self.calls.append((action, mime, buffer))

    def writeText(self, text):  # noqa: N802 (engine method name)
        self.texts.append(text)


class _FakeGlobal:
    """Returns canned results, so nothing here needs an imaging library."""

    def __init__(self, result):
        self._result = result
        self.calls = []

    def split_scan(self, image_bytes, want_images):
        self.calls.append((len(image_bytes), want_images))
        return self._result


def _descriptor_payload(parent='/inbox/1.jpg'):
    """An ImageStream descriptor for a scan, serialized for the BEGIN slot."""
    scan = build_stream_descriptor(
        None,
        'image',
        objectId='o1',
        parent=parent,
        permissionId=0,
        signature='s',
        nodeId='n',
        origin='ingested',
        source_mime='image/jpeg',
        size=12345,
        stream_index=0,
    )
    return descriptor_to_payload(scan)


def _send_stream(inst, payload, body=b'scan-bytes'):
    """
    Drive one complete inbound image stream.

    ``writeImage`` ends with ``return self.preventDefault()`` on every action, which raises by
    engine contract; the emit has already happened, so it is swallowed here.
    """
    for action, buffer in (
        (AVI_ACTION.BEGIN, payload),
        (AVI_ACTION.WRITE, body),
        (AVI_ACTION.END, b''),
    ):
        try:
            inst.writeImage(action, 'image/jpeg', buffer)
        except APERR as e:
            # Anything else is a real failure out of _finish, which is where the emitting
            # happens — swallowing it would pass a node that emitted nothing.
            if e.ec != Ec.PreventDefault:
                raise


def _triplets(capture):
    """Group the captured writeImage calls into BEGIN/WRITE/END triplets."""
    assert len(capture.calls) % 3 == 0, f'emissions are not whole triplets: {capture.calls}'
    return [capture.calls[i : i + 3] for i in range(0, len(capture.calls), 3)]


def _make(result, listeners=('image', 'text')):
    """An IInstance wired to a capturing binding and a canned split_scan."""
    inst = IInstance()
    inst.instance = _Capture(listeners)
    inst.IGlobal = _FakeGlobal(result)
    inst.open(None)
    return inst


class TestFanOut:
    """One scan in, one image stream out per photo found."""

    def test_three_photos_emit_three_triplets(self):
        """Three crops means three downstream objects, each a complete BEGIN/WRITE/END."""
        regions = [_region(300, 400), _region(900, 400), _region(600, 1200)]
        crops = [_crop(0), _crop(1), _crop(2)]
        inst = _make((crops, regions))

        _send_stream(inst, _descriptor_payload())

        triplets = _triplets(inst.instance)
        assert len(triplets) == 3
        for begin, write, end in triplets:
            assert begin[0] == AVI_ACTION.BEGIN
            assert write[0] == AVI_ACTION.WRITE
            assert end[0] == AVI_ACTION.END
            assert begin[1] == write[1] == end[1] == 'image/jpeg'

    def test_crops_are_named_in_order_and_carry_dimensions(self):
        """
        Names run crop0, crop1, crop2 off the scan's own stem, and the BEGIN carries the crop's
        own size — never the region's, which differs once deskew is off.
        """
        regions = [_region(300, 400), _region(900, 400), _region(600, 1200)]
        crops = [_crop(0), _crop(1), _crop(2)]
        inst = _make((crops, regions))

        _send_stream(inst, _descriptor_payload('/inbox/1.jpg'))

        names = []
        for begin, _write, _end in _triplets(inst.instance):
            payload = json.loads(begin[2].decode('utf-8'))
            names.append(payload['name'])
            assert payload['width'] == 400
            assert payload['height'] == 520
            assert payload['size'] == len(b'jpeg-bytes')
        assert names == ['1.crop0.jpg', '1.crop1.jpg', '1.crop2.jpg']

    def test_emitted_names_are_stamped_back_onto_their_regions(self):
        """
        The audit record maps each filename to the geometry it came from.

        That pairing is the whole point of reporting regions at all — without it, a crop that
        looks wrong cannot be traced back to what was detected.
        """
        regions = [_region(300, 400), _region(900, 400)]
        inst = _make(([_crop(0), _crop(1)], regions))

        _send_stream(inst, _descriptor_payload('/inbox/1.jpg'))

        report = json.loads(inst.instance.texts[0])
        assert [r['name'] for r in report['regions']] == ['1.crop0.jpg', '1.crop1.jpg']

    def test_index_keeps_counting_across_streams_of_one_object(self):
        """
        Two image streams in one object continue the numbering rather than restarting.

        ``derived_name`` builds every stem from the *source object*, so an index that reset per
        stream would emit ``1.crop0.jpg`` twice for the same object and the second would
        overwrite or collide with the first downstream.
        """
        inst = _make(([_crop(0), _crop(1)], [_region(300, 400), _region(900, 400)]))

        _send_stream(inst, _descriptor_payload('/inbox/1.jpg'))
        _send_stream(inst, _descriptor_payload('/inbox/1.jpg'))

        names = [json.loads(b[2].decode('utf-8'))['name'] for b, _w, _e in _triplets(inst.instance)]
        assert names == ['1.crop0.jpg', '1.crop1.jpg', '1.crop2.jpg', '1.crop3.jpg']
        assert len(set(names)) == len(names)

    def test_index_restarts_for_the_next_object(self):
        """open() resets the counter, so each object's crops start at zero."""
        inst = _make(([_crop(0)], [_region(300, 400)]))

        _send_stream(inst, _descriptor_payload('/inbox/1.jpg'))
        inst.open(None)
        _send_stream(inst, _descriptor_payload('/inbox/2.jpg'))

        names = [json.loads(b[2].decode('utf-8'))['name'] for b, _w, _e in _triplets(inst.instance)]
        assert names == ['1.crop0.jpg', '2.crop0.jpg']


class TestAuditRecord:
    """The text lane has to distinguish the two ways a scan produces no photos."""

    def test_undecodable_input_reports_decoded_false(self):
        """split_scan returning None means the bytes were unreadable, not that nothing was found."""
        inst = _make(None)

        _send_stream(inst, _descriptor_payload())

        report = json.loads(inst.instance.texts[0])
        assert report['decoded'] is False
        assert report['count'] == 0

    def test_decoded_but_empty_reports_decoded_true(self):
        """
        A readable scan with no photos on it reports decoded=True and count=0.

        Collapsing this into the same answer as an unreadable file is exactly what makes a
        folder of scans un-auditable, which is why the flag exists.
        """
        inst = _make(([], []))

        _send_stream(inst, _descriptor_payload())

        report = json.loads(inst.instance.texts[0])
        assert report['decoded'] is True
        assert report['count'] == 0

    def test_report_is_emitted_once_per_stream(self):
        """One record per inbound scan, on every path."""
        inst = _make(([_crop(0)], [_region(300, 400)]))

        _send_stream(inst, _descriptor_payload())
        _send_stream(inst, _descriptor_payload())

        assert len(inst.instance.texts) == 2

    def test_report_carries_the_detected_geometry(self):
        """Regions reach the lane intact, so the record is usable without the images."""
        inst = _make(([_crop(0)], [_region(300.5, 400.5)]))

        _send_stream(inst, _descriptor_payload())

        region = json.loads(inst.instance.texts[0])['regions'][0]
        assert region['cx'] == 300.5
        assert region['cy'] == 400.5
        assert region['ratio_error'] == 2.0


class TestNothingFound:
    """A scan we could not split must not disappear from the pipeline."""

    def test_no_regions_forwards_the_original(self):
        """Zero detections forwards the untouched scan rather than dropping the object."""
        inst = _make(([], []))

        _send_stream(inst, _descriptor_payload(), body=b'original-scan-bytes')

        triplets = _triplets(inst.instance)
        assert len(triplets) == 1
        assert triplets[0][1][2] == b'original-scan-bytes'

    def test_undecodable_forwards_the_original(self):
        """Same for bytes we could not decode: forward them on rather than swallowing them."""
        inst = _make(None)

        _send_stream(inst, _descriptor_payload(), body=b'original-scan-bytes')

        triplets = _triplets(inst.instance)
        assert len(triplets) == 1
        assert triplets[0][1][2] == b'original-scan-bytes'

    def test_regions_but_no_crops_forwards_the_original(self):
        """Photos were found and none survived cutting — the scan still has to come out.

        `split_scan` returns regions with an empty crop list when every one of them is too
        small to cut or fails to encode. Deciding on the regions rather than on what was
        actually emitted leaves the image lane with nothing at all for that scan.
        """
        inst = _make(([], [_region(300, 400)]))

        _send_stream(inst, _descriptor_payload(), body=b'original-scan-bytes')

        triplets = _triplets(inst.instance)
        assert len(triplets) == 1
        assert triplets[0][1][2] == b'original-scan-bytes'

        # The two lanes together still say "a photo was here and you did not get it".
        report = json.loads(inst.instance.texts[0])
        assert report['count'] == 1
        assert report['regions'][0]['cropped'] is False


class TestListenerGating:
    """Work is skipped when nothing downstream would consume it."""

    def test_no_listeners_skips_split_entirely(self):
        """With neither lane wired there is no reason to decode a 143 MP scan."""
        inst = _make(([_crop(0)], [_region(300, 400)]), listeners=())

        _send_stream(inst, _descriptor_payload())

        assert inst.IGlobal.calls == []
        assert inst.instance.calls == []
        assert inst.instance.texts == []

    def test_text_only_listener_asks_for_no_images(self):
        """
        A text-only wiring still detects, but tells split_scan not to encode.

        Encoding crops nobody reads is the single most expensive thing this node can do by
        accident, so the flag is asserted rather than assumed.
        """
        inst = _make(([], [_region(300, 400)]), listeners=('text',))

        _send_stream(inst, _descriptor_payload())

        assert inst.IGlobal.calls == [(len(b'scan-bytes'), False)]
        assert inst.instance.calls == []
        assert json.loads(inst.instance.texts[0])['count'] == 1

    def test_image_only_listener_emits_no_report(self):
        """With no text listener the record is not built."""
        inst = _make(([_crop(0)], [_region(300, 400)]), listeners=('image',))

        _send_stream(inst, _descriptor_payload())

        assert inst.instance.texts == []
        assert len(_triplets(inst.instance)) == 1
