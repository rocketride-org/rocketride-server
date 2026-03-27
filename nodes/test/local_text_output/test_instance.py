# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for local_text_output IInstance (no engine server required)."""

import sys
import tempfile
from pathlib import Path
from unittest.mock import Mock

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))

from local_text_output.IInstance import IInstance  # noqa: E402


def _make_instance():
    inst = IInstance()
    iglobal = Mock()
    iglobal.output_path = str(Path(tempfile.gettempdir()) / 'local_text_output_test')
    iglobal.exclude = 'N/A'
    inst.IGlobal = iglobal
    return inst


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
