# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""What the node emits, with the imaging seam stubbed out.

The stub returns canned bytes and a canned record, so none of this needs cv2 — which is what makes
it runnable under the engine's bundled Python at all.
"""

import json
import sys
import unittest
from pathlib import Path

from ai.common.avi.descriptor import build_stream_descriptor, descriptor_to_payload
from rocketlib import AVI_ACTION

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from image_orient.IInstance import IInstance  # noqa: E402

_MIME = 'image/jpeg'


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
    """Returns a canned decision, so nothing here needs an imaging library."""

    def __init__(self, result):
        self._result = result
        self.seen = []

    def orient(self, image_bytes, mime, want_image):
        self.seen.append((image_bytes, mime, want_image))
        return self._result


def _descriptor(width=800, height=600, name='holiday.jpg'):
    """An image stream descriptor for the BEGIN slot, as the engine would deliver it."""
    return build_stream_descriptor(
        None,
        'image',
        objectId='o1',
        parent='/inbox/holiday.jpg',
        permissionId=0,
        signature='s',
        nodeId='n',
        origin='ingested',
        name=name,
        width=width,
        height=height,
    )


def _run(result, listeners=('image', 'text'), source=b'original-bytes'):
    """Drive one BEGIN/WRITE/END stream through the node and return (node, capture, fake)."""
    node = IInstance()
    capture = _Capture(listeners)
    fake = _FakeGlobal(result)
    node.instance = capture
    node.IGlobal = fake
    node.preventDefault = lambda: 'prevented'

    node.open(None)
    node.writeImage(AVI_ACTION.BEGIN, _MIME, descriptor_to_payload(_descriptor()))
    node.writeImage(AVI_ACTION.WRITE, _MIME, source)
    node.writeImage(AVI_ACTION.END, _MIME, b'')
    return node, capture, fake


def _record(**over):
    """A decision record as ``orient`` returns it."""
    base = {'decoded': True, 'rotation': 0, 'confident': True, 'faces': 3, 'reason': None}
    base.update(over)
    return base


class TestRotated(unittest.TestCase):
    """A corrected image replaces the original."""

    def test_one_stream_is_emitted_and_carries_the_rotated_bytes(self):
        rec = _record(rotation=270, width=600, height=800)
        _, capture, _ = _run((b'rotated-bytes', rec))

        actions = [c[0] for c in capture.calls]
        self.assertEqual(actions, [AVI_ACTION.BEGIN, AVI_ACTION.WRITE, AVI_ACTION.END])
        self.assertEqual(capture.calls[1][2], b'rotated-bytes')

    def test_the_descriptor_carries_the_rotated_dimensions(self):
        """A quarter turn swaps them; reusing the source would label a landscape image portrait."""
        rec = _record(rotation=90, width=600, height=800)
        _, capture, _ = _run((b'rotated-bytes', rec))

        payload = json.loads(capture.calls[0][2])
        self.assertEqual(payload.get('width'), 600)
        self.assertEqual(payload.get('height'), 800)

    def test_the_format_is_unchanged(self):
        _, capture, _ = _run((b'rotated-bytes', _record(rotation=180, width=800, height=600)))
        self.assertEqual({c[1] for c in capture.calls}, {_MIME})


class TestUntouched(unittest.TestCase):
    """An image the node declines to turn is forwarded, not dropped and not re-encoded."""

    def test_abstaining_still_emits_the_original(self):
        _, capture, _ = _run((None, _record(confident=False, reason='thin_margin')))
        self.assertTrue(capture.calls, 'an abstained image must still reach the next node')
        written = b''.join(c[2] for c in capture.calls if c[0] == AVI_ACTION.WRITE and c[2])
        self.assertEqual(written, b'original-bytes')

    def test_a_confident_zero_is_reported_as_such(self):
        _, capture, _ = _run((None, _record(rotation=0, confident=True)))
        record = json.loads(capture.texts[0])
        self.assertEqual(record['rotation'], 0)
        self.assertTrue(record['confident'])

    def test_an_abstention_names_its_reason(self):
        _, capture, _ = _run((None, _record(confident=False, reason='few_faces')))
        record = json.loads(capture.texts[0])
        self.assertFalse(record['confident'])
        self.assertEqual(record['reason'], 'few_faces')


class TestDegraded(unittest.TestCase):
    """Failures pass the photo through rather than losing it."""

    def test_undecodable_input_is_forwarded_and_reported(self):
        _, capture, _ = _run(None)
        written = b''.join(c[2] for c in capture.calls if c[0] == AVI_ACTION.WRITE and c[2])
        self.assertEqual(written, b'original-bytes')
        record = json.loads(capture.texts[0])
        self.assertFalse(record['decoded'])

    def test_no_model_forwards_every_image_rather_than_raising(self):
        """A missing model must degrade, not fail the task: un-rotated beats lost."""
        _, capture, _ = _run((None, {'rotation': 0, 'confident': False, 'reason': 'no_model'}))
        written = b''.join(c[2] for c in capture.calls if c[0] == AVI_ACTION.WRITE and c[2])
        self.assertEqual(written, b'original-bytes')
        self.assertEqual(json.loads(capture.texts[0])['reason'], 'no_model')

    def test_decoded_false_is_distinct_from_decoded_true_with_no_rotation(self):
        """Otherwise 'unreadable' and 'read it, left it alone' look identical when auditing."""
        _, unreadable, _ = _run(None)
        _, left_alone, _ = _run((None, _record(confident=False, reason='no_faces')))
        self.assertFalse(json.loads(unreadable.texts[0])['decoded'])
        self.assertTrue(json.loads(left_alone.texts[0])['decoded'])


class TestListenerGating(unittest.TestCase):
    """Work is only done for lanes somebody consumes."""

    def test_no_listeners_at_all_skips_the_seam_entirely(self):
        _, capture, fake = _run((b'rotated', _record(rotation=90)), listeners=())
        self.assertEqual(fake.seen, [], 'nothing consumes either lane, so nothing should be decoded')
        self.assertEqual(capture.calls, [])
        self.assertEqual(capture.texts, [])

    def test_text_only_still_analyses_but_emits_no_image(self):
        _, capture, fake = _run((None, _record(rotation=90, confident=True)), listeners=('text',))
        self.assertEqual(fake.seen[0][2], False, 'want_image must be False so nothing is encoded')
        self.assertEqual(capture.calls, [])
        self.assertEqual(len(capture.texts), 1)

    def test_image_only_emits_no_record(self):
        _, capture, _ = _run((b'rotated', _record(rotation=90, width=600, height=800)), listeners=('image',))
        self.assertEqual(capture.texts, [])
        self.assertTrue(capture.calls)


class TestPreventDefault(unittest.TestCase):
    """The engine must never also forward the original alongside our replacement."""

    def test_every_action_prevents_the_default(self):
        node = IInstance()
        node.instance = _Capture()
        node.IGlobal = _FakeGlobal((None, _record()))
        node.preventDefault = lambda: 'prevented'
        node.open(None)

        for action, payload in (
            (AVI_ACTION.BEGIN, descriptor_to_payload(_descriptor(10, 10, 'a.jpg'))),
            (AVI_ACTION.WRITE, b'x'),
            (AVI_ACTION.END, b''),
        ):
            self.assertEqual(node.writeImage(action, _MIME, payload), 'prevented')

    def test_the_listener_gated_path_prevents_too(self):
        """The easiest one to forget: nothing else about that path is visible."""
        node = IInstance()
        node.instance = _Capture(listeners=())
        node.IGlobal = _FakeGlobal(None)
        node.preventDefault = lambda: 'prevented'
        node.open(None)

        node.writeImage(AVI_ACTION.BEGIN, _MIME, descriptor_to_payload(_descriptor(10, 10, 'a.jpg')))
        self.assertEqual(node.writeImage(AVI_ACTION.END, _MIME, b''), 'prevented')


if __name__ == '__main__':
    unittest.main()
