# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Base-level test: ``IInstanceBase`` hands every media consumer whole streams.

A media lane carries no stream identifier, so a consumer keeps one slot of state per
lane and reads a fresh ``BEGIN`` as proof the previous stream ended. When one object
emits several streams on a lane that assumption fails and a complete stream is thrown
away. ``IInstanceBase`` closes the gap for every node at once by counting bytes and
delivering the ``END`` the producer never sent.

These drive a throwaway subclass and assert on the call sequence it receives, so they
pin the normalization itself rather than any one node's output.
"""

import json
from unittest.mock import MagicMock

import pytest
from rocketlib import AVI_ACTION, IInstanceBase
from rocketlib import engine

IMAGE = 'image/png'


def _descriptor(size, kind='ImageStream'):
    """A media BEGIN payload declaring `size` bytes, shaped as the engine delivers it."""
    return json.dumps({'type': kind, 'metadata': {'objectId': 'o1', 'size': size}}).encode('utf-8')


def _enrichment(size):
    """A producer's raw enrichment: carries a size, but no `type`.

    What a consumer receives with ROCKETRIDE_STREAM_DESCRIPTOR=0, when the engine
    forwards the producer's payload unwrapped.
    """
    return json.dumps({'origin': 'extracted', 'size': size}).encode('utf-8')


class _Obj:
    """Minimal currentObject: the attributes the base reads and nothing else."""

    def __init__(self, name='scan.png', objectId='obj-1', failed=False):
        self.hasName = True
        self.name = name
        self.objectId = objectId
        self.objectFailed = failed


class _Instance:
    def __init__(self, obj):
        self.currentObject = obj


class _Node(IInstanceBase):
    """Records every media call, so a test can assert on the exact sequence."""

    def __init__(self, obj=None):
        self.calls = []
        self.instance = _Instance(obj or _Obj())

    def writeImage(self, action, mimeType, buffer=b''):
        self.calls.append(('image', action, mimeType, bytes(buffer or b'')))

    def writeAudio(self, action, mimeType, buffer=b''):
        self.calls.append(('audio', action, mimeType, bytes(buffer or b'')))

    def actions(self, lane='image'):
        """The action sequence this node saw on one lane."""
        return [action for got_lane, action, _, _ in self.calls if got_lane == lane]

    def mimes(self, action):
        """The MIME types this node saw for one action, in order."""
        return [mime for _, got, mime, _ in self.calls if got == action]


@pytest.fixture
def warnings(monkeypatch):
    """Collect the warnings the base emits.

    Patches ``rocketlib.engine.warning``: the base imports it inside the function that
    uses it (a module-level import would be circular), so the name resolves per call
    and there is no ``rocketlib.filters.warning`` attribute to rebind.
    """
    seen = []
    monkeypatch.setattr(engine, 'warning', lambda message: seen.append(message))
    return seen


def _stream(node, size, payload=None, data=b'', mime=IMAGE):
    """Send BEGIN(size) then, when given, one WRITE."""
    node.writeImage(AVI_ACTION.BEGIN, mime, _descriptor(size) if payload is None else payload)
    if data:
        node.writeImage(AVI_ACTION.WRITE, mime, data)


# ---------------------------------------------------------------------------
# A displaced stream that got everything it declared
# ---------------------------------------------------------------------------


def test_second_begin_ends_the_first_stream_first(warnings):
    """The case that silently lost data: complete buffer, END still outstanding."""
    node = _Node()
    _stream(node, 4, data=b'AAAA')
    _stream(node, 4, data=b'BBBB')
    node.writeImage(AVI_ACTION.END, IMAGE, b'')

    assert node.actions() == [
        AVI_ACTION.BEGIN,
        AVI_ACTION.WRITE,
        AVI_ACTION.END,  # synthesized for the first stream...
        AVI_ACTION.BEGIN,  # ...before the second one begins
        AVI_ACTION.WRITE,
        AVI_ACTION.END,
    ]
    assert warnings == []


def test_the_displaced_streams_own_end_is_swallowed(warnings):
    """Its END arrives after the settle and must not reach the node a second time."""
    node = _Node()
    _stream(node, 4, data=b'AAAA')
    _stream(node, 4, data=b'BBBB')
    node.writeImage(AVI_ACTION.END, IMAGE, b'')  # the second stream's own END
    node.writeImage(AVI_ACTION.END, IMAGE, b'')  # the first stream's late END

    assert node.actions().count(AVI_ACTION.END) == 2
    assert warnings == []


def test_three_streams_in_a_row_all_end(warnings):
    """scan_cropper's real shape: one object fanned out into several images."""
    node = _Node()
    for _ in range(3):
        _stream(node, 4, data=b'ABCD')
    node.writeImage(AVI_ACTION.END, IMAGE, b'')

    assert node.actions().count(AVI_ACTION.END) == 3
    assert warnings == []


def test_the_synthesized_end_carries_the_pending_streams_own_mime(warnings):
    """Not the MIME of the BEGIN that displaced it — a fan-out may change format."""
    node = _Node()
    _stream(node, 4, data=b'AAAA', mime='image/png')
    _stream(node, 4, data=b'BBBB', mime='image/jpeg')

    assert node.mimes(AVI_ACTION.END) == ['image/png']


# ---------------------------------------------------------------------------
# A displaced stream that did not
# ---------------------------------------------------------------------------


def test_truncated_stream_gets_no_end_and_is_reported(warnings):
    """Short of what it declared, so it really was cut off."""
    node = _Node()
    _stream(node, 99, data=b'AA')
    _stream(node, 4, data=b'BBBB')

    assert AVI_ACTION.END not in node.actions()
    assert len(warnings) == 1
    assert 'declared=99' in warnings[0] and 'written=2' in warnings[0]


def test_undeclared_stream_gets_no_end_and_is_reported(warnings):
    """With no declared size there is nothing to check, so nothing is committed."""
    node = _Node()
    _stream(node, 0, payload=b'', data=b'AAAA')
    _stream(node, 4, data=b'BBBB')

    assert AVI_ACTION.END not in node.actions()
    assert len(warnings) == 1
    assert 'declared=None' in warnings[0]


def test_enrichment_without_a_type_marker_is_not_read_as_a_descriptor(warnings):
    """The ROCKETRIDE_STREAM_DESCRIPTOR=0 shape: a real size, but no `type`.

    Reading it would make the kill switch change behaviour rather than disable the
    feature, so the parser requires the marker the C++ builder adds.
    """
    node = _Node()
    _stream(node, 4, payload=_enrichment(4), data=b'AAAA')
    _stream(node, 4, data=b'BBBB')

    assert AVI_ACTION.END not in node.actions()
    assert 'declared=None' in warnings[0]


def test_a_stream_that_promised_bytes_and_sent_none_is_reported(warnings):
    """Nothing arrived, but something was expected, so something was lost."""
    node = _Node()
    _stream(node, 99)
    _stream(node, 4, data=b'BBBB')

    assert len(warnings) == 1
    assert 'declared=99' in warnings[0] and 'written=0' in warnings[0]


def test_an_empty_stream_is_neither_ended_nor_reported(warnings):
    """It promised nothing and delivered nothing, so nothing was lost.

    A log line that fires on ordinary traffic is one nobody reads.
    """
    node = _Node()
    _stream(node, 0)
    _stream(node, 4, data=b'BBBB')
    node.writeImage(AVI_ACTION.END, IMAGE, b'')

    assert node.actions().count(AVI_ACTION.END) == 1  # the second stream's own
    assert warnings == []


def test_the_report_names_the_object_that_owned_the_stream(warnings):
    """Captured at BEGIN, so it survives the object advancing underneath it."""
    node = _Node(_Obj(name='album-page-7.png'))
    _stream(node, 99, data=b'AA')
    _stream(node, 4, data=b'BBBB')

    assert 'album-page-7.png' in warnings[0]


# ---------------------------------------------------------------------------
# Lanes, and streams that were never displaced
# ---------------------------------------------------------------------------


def test_lanes_settle_independently(warnings):
    """A BEGIN on audio must not touch a stream open on image."""
    node = _Node()
    _stream(node, 4, data=b'ABCD')
    node.writeAudio(AVI_ACTION.BEGIN, 'audio/wav', _descriptor(2, kind='AudioStream'))
    node.writeAudio(AVI_ACTION.WRITE, 'audio/wav', b'ZZ')
    node.writeAudio(AVI_ACTION.END, 'audio/wav', b'')

    assert node.actions('image') == [AVI_ACTION.BEGIN, AVI_ACTION.WRITE]
    assert node.actions('audio').count(AVI_ACTION.END) == 1
    assert warnings == []


def test_two_clean_streams_pass_through_untouched(warnings):
    """Nothing is displaced, so no END is synthesized and none is swallowed.

    Guards the debt counter against rising on a BEGIN that displaced nothing — an
    over-counted debt is the one way this design eats a real END.
    """
    node = _Node()
    for _ in range(2):
        _stream(node, 4, data=b'ABCD')
        node.writeImage(AVI_ACTION.END, IMAGE, b'')

    assert node.actions().count(AVI_ACTION.END) == 2
    assert warnings == []


def test_an_end_for_a_lane_that_never_began_is_forwarded(warnings):
    """The base never invents state for a lane it has not seen begin."""
    node = _Node()
    node.writeImage(AVI_ACTION.END, IMAGE, b'')

    assert node.actions() == [AVI_ACTION.END]


# ---------------------------------------------------------------------------
# Object boundaries
# ---------------------------------------------------------------------------


def test_close_ends_a_stream_the_producer_never_did(warnings):
    """close() is the last point at which the stream's own object is still current."""
    node = _Node()
    _stream(node, 4, data=b'ABCD')
    node.close()

    assert node.actions() == [AVI_ACTION.BEGIN, AVI_ACTION.WRITE, AVI_ACTION.END]
    assert warnings == []


def test_close_settles_nothing_for_a_failed_object(warnings):
    """A failed object must not publish output it would never otherwise have produced."""
    node = _Node(_Obj(failed=True))
    _stream(node, 4, data=b'ABCD')
    node.close()

    assert AVI_ACTION.END not in node.actions()


def test_a_failed_objects_stream_is_reported_as_such(warnings):
    """The stream was whole, so the line must not read as a byte count that fell short.

    Every byte arrived; the base held it back because the object failed. Reporting that
    as 'could not be settled' sends the reader hunting for a cut-off that never happened.
    """
    node = _Node(_Obj(failed=True))
    _stream(node, 4, data=b'ABCD')
    node.close()

    assert len(warnings) == 1
    assert 'its object failed' in warnings[0]
    assert 'declared=4' in warnings[0] and 'written=4' in warnings[0]


def test_a_failed_objects_stream_is_reported_once(warnings):
    """close() marks the lane closed, so the next open() finds nothing left to report."""
    node = _Node(_Obj(failed=True))
    _stream(node, 4, data=b'ABCD')
    node.close()
    node.open(None)

    assert len(warnings) == 1


def test_close_settles_when_the_object_is_a_bare_mock(warnings):
    """Every unset attribute of a MagicMock is a truthy Mock.

    A plain truthiness test on the failed flag would read each of them as failed and
    disable the settle everywhere, with the node suites still passing.
    """
    node = _Node()
    node.instance = _Instance(MagicMock())
    _stream(node, 4, data=b'ABCD')
    node.close()

    assert node.actions().count(AVI_ACTION.END) == 1


def test_close_is_inert_when_there_is_no_object(warnings):
    """The engine clears the current object when one fails to open."""
    node = _Node()
    _stream(node, 4, data=b'ABCD')
    node.instance = _Instance(None)
    node.close()

    assert AVI_ACTION.END not in node.actions()


def test_close_is_inert_when_there_is_no_instance(warnings):
    """`instance` defaults to None on the class, which is what a bare subclass has."""
    node = _Node()
    _stream(node, 4, data=b'ABCD')
    node.instance = None
    node.close()

    assert AVI_ACTION.END not in node.actions()


def test_open_reports_a_pending_stream_but_never_settles_it(warnings):
    """By open() the current object is already the next one.

    Settling here would file the previous object's stream under the new one, which is
    worse than the loss it would prevent.
    """
    node = _Node()
    _stream(node, 4, data=b'ABCD')
    node.open(None)

    assert AVI_ACTION.END not in node.actions()
    assert len(warnings) == 1


def test_open_clears_the_outstanding_end_debt(warnings):
    """An object can end still owing swallows; carrying them forward eats real ENDs."""
    node = _Node()
    for _ in range(3):
        _stream(node, 4, data=b'ABCD')  # settles two, so two ENDs are owed
    node.writeImage(AVI_ACTION.END, IMAGE, b'')
    before = node.actions().count(AVI_ACTION.END)

    node.open(None)
    node.writeImage(AVI_ACTION.END, IMAGE, b'')

    assert node.actions().count(AVI_ACTION.END) == before + 1, 'the next object lost an END'


def test_closing_settles_nothing(warnings):
    """It runs after the final close(), when there is no object left to attribute to."""
    node = _Node()
    _stream(node, 4, data=b'ABCD')
    node.closing()

    assert AVI_ACTION.END not in node.actions()


# ---------------------------------------------------------------------------
# What a synthesized call may and may not swallow
# ---------------------------------------------------------------------------


class _PreventDefaultNode(IInstanceBase):
    """Ends its handler the way most media nodes do."""

    def __init__(self):
        self.calls = []
        self.instance = _Instance(_Obj())

    def writeImage(self, action, mimeType, buffer=b''):
        self.calls.append(action)
        return self.preventDefault()


class _RaisingNode(IInstanceBase):
    """Fails the way a decoder reporting off its background thread does."""

    def __init__(self):
        self.instance = _Instance(_Obj())

    def writeImage(self, action, mimeType, buffer=b''):
        if action == AVI_ACTION.END:
            raise RuntimeError('decode failed')


def test_prevent_default_is_swallowed_for_a_synthesized_end(warnings):
    """Nothing is waiting on a synthesized call, so its PreventDefault goes no further.

    Every *real* call into such a node raises too — that is the control signal the
    engine expects, and these stand in for the engine catching it. What is under test
    is the settle inside the second BEGIN: the trailing BEGIN in the recorded sequence
    is only there if the settle's own PreventDefault was swallowed and the wrapper
    carried on to forward it.
    """
    from rocketlib import APERR

    node = _PreventDefaultNode()
    for action, payload in (
        (AVI_ACTION.BEGIN, _descriptor(4)),
        (AVI_ACTION.WRITE, b'ABCD'),
        (AVI_ACTION.BEGIN, _descriptor(4)),
    ):
        with pytest.raises(APERR):
            node.writeImage(action, IMAGE, payload)

    assert node.calls == [AVI_ACTION.BEGIN, AVI_ACTION.WRITE, AVI_ACTION.END, AVI_ACTION.BEGIN]


def test_prevent_default_still_propagates_from_a_real_call(warnings):
    """The engine reads it as a control signal and must keep receiving it."""
    from rocketlib import APERR

    node = _PreventDefaultNode()
    with pytest.raises(APERR):
        node.writeImage(AVI_ACTION.BEGIN, IMAGE, _descriptor(4))


def test_a_real_failure_on_a_synthesized_end_propagates(warnings):
    """Only the PreventDefault signal is swallowed; a genuine error fails the object."""
    node = _RaisingNode()
    node.writeImage(AVI_ACTION.BEGIN, IMAGE, _descriptor(4))
    node.writeImage(AVI_ACTION.WRITE, IMAGE, b'ABCD')

    with pytest.raises(RuntimeError, match='decode failed'):
        node.writeImage(AVI_ACTION.BEGIN, IMAGE, _descriptor(4))


class _SubNode(_Node):
    """A node subclassing another node — both handlers are wrapped."""

    def writeImage(self, action, mimeType, buffer=b''):
        return super().writeImage(action, mimeType, buffer)


def test_bytes_are_counted_once_through_two_live_wrappers(warnings):
    """Double counting would leave written at 8, and the stream would not settle."""
    node = _SubNode()
    _stream(node, 4, data=b'ABCD')
    _stream(node, 4, data=b'BBBB')

    assert node.actions().count(AVI_ACTION.END) == 1
