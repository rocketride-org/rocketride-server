# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for local_text_output IInstance (no engine server required)."""

import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import Mock

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from local_text_output.IInstance import IInstance  # noqa: E402
from rocketlib import extended_length_path  # noqa: E402


def _make_instance(output_path=None):
    inst = IInstance()
    iglobal = Mock()
    iglobal.output_path = output_path or str(Path(tempfile.gettempdir()) / 'local_text_output_test')
    iglobal.exclude = 'N/A'
    inst.IGlobal = iglobal
    return inst


def _read(path):
    """Read a file back, tolerating Windows paths past the 260-char limit."""
    with open(extended_length_path(path), 'r', encoding='utf-8') as f:
        return f.read()


def test_write_text_before_open_does_not_raise():
    """Regression: writeText used to do None += str when open() had not run."""
    inst = _make_instance()
    inst.writeText('chunk')
    assert inst.target_object_text is None


def test_write_text_after_open_accumulates():
    """open() initializes the buffer; writeText appends in order."""
    inst = _make_instance()
    entry = Mock()
    entry.objectFailed = False
    entry.path = '/data/doc.md'
    inst.open(entry)
    inst.writeText('a')
    inst.writeText('b')
    assert inst.target_object_text == 'ab'


def test_write_text_coerces_none_buffer_when_object_open():
    """If buffer were None while an object is open, += must not crash."""
    inst = _make_instance()
    entry = Mock()
    entry.objectFailed = False
    entry.path = '/data/doc.md'
    inst.open(entry)
    inst.target_object_text = None
    inst.writeText('x')
    assert inst.target_object_text == 'x'


# ---------------------------------------------------------------------------
# close() — writes the accumulated text to the local filesystem. These exercise
# the Windows long-path fix (issue #1415) end to end against a real temp dir.
# ---------------------------------------------------------------------------


def _drive(inst, source_path, text):
    """Run one object through open() -> writeText() -> close()."""
    entry = Mock()
    entry.objectFailed = False
    entry.path = source_path
    inst.open(entry)
    inst.writeText(text)
    inst.close()


def test_close_writes_normal_file(tmp_path):
    """Baseline: a short path writes where expected with the right content."""
    inst = _make_instance(str(tmp_path))
    _drive(inst, '/data/folder/doc.md', 'hello world')

    expected = os.path.realpath(os.path.join(str(tmp_path), 'data', 'folder', 'doc.txt'))
    assert os.path.exists(expected)
    assert _read(expected) == 'hello world'


def test_close_writes_path_exceeding_windows_max_path(tmp_path):
    r"""A derived path well past 260 chars must still be written (\\?\ prefix)."""
    deep = '/'.join('dir_%02d_padded_segment' % i for i in range(25))
    source = f'/{deep}/document.md'

    inst = _make_instance(str(tmp_path))
    _drive(inst, source, 'payload-' * 8)

    name, _ext = os.path.splitext(source)
    rel = (name + '.txt').lstrip('/\\')
    expected = os.path.realpath(os.path.join(os.path.realpath(str(tmp_path)), rel))

    # Guard the guard: on Windows this genuinely exceeds the legacy limit.
    if os.name == 'nt':
        assert len(expected) > 260

    assert os.path.exists(extended_length_path(expected))
    assert _read(expected) == 'payload-' * 8


def test_close_shortens_overlong_filename_component(tmp_path):
    """A single derived component past 255 chars is hash-truncated, not aborted."""
    source = '/data/' + ('z' * 300) + '.md'

    inst = _make_instance(str(tmp_path))
    _drive(inst, source, 'content')

    out_dir = os.path.join(str(tmp_path), 'data')
    written = os.listdir(extended_length_path(out_dir))
    assert len(written) == 1
    name = written[0]
    assert len(name) <= 255
    assert name.endswith('.txt')
    assert _read(os.path.join(out_dir, name)) == 'content'


def test_close_shortens_overlong_intermediate_directory(tmp_path):
    """An overlong intermediate *directory* segment is hash-truncated, not aborted.

    Deep source trees (long directory names) are the scenario most likely to
    trigger issue #1415 in practice, so exercise it end to end.
    """
    source = '/' + ('d' * 300) + '/doc.md'

    inst = _make_instance(str(tmp_path))
    _drive(inst, source, 'content')

    # The 300-char directory is the sole child of the output dir, shortened to
    # <= 255; the file lands inside it with the original (short) filename.
    dirs = os.listdir(extended_length_path(str(tmp_path)))
    assert len(dirs) == 1
    assert len(dirs[0]) <= 255

    sub = os.path.join(str(tmp_path), dirs[0])
    assert os.listdir(extended_length_path(sub)) == ['doc.txt']
    assert _read(os.path.join(sub, 'doc.txt')) == 'content'


def test_close_skips_failed_object(tmp_path):
    """A failed object writes nothing."""
    inst = _make_instance(str(tmp_path))
    entry = Mock()
    entry.objectFailed = True
    entry.path = '/data/doc.md'
    inst.open(entry)
    inst.writeText('should not be written')
    inst.close()

    assert not os.path.exists(os.path.join(str(tmp_path), 'data', 'doc.txt'))
