# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the tool_filesystem ``read_file`` size cap.

Covers the per-call ``maxBytes`` cap added on top of ``FileStore.read``:
* default applied when the field is omitted,
* explicit value forwarded as ``max_size`` to FileStore,
* clamped to ``MAX_READ_LIMIT`` when callers ask for more,
* rejected with ``ValueError`` on non-int / non-positive input.

These are pure-Python unit tests — no server, no engine, no real FileStore.
The node module is imported under a stubbed ``rocketlib`` and a synthetic
``tool_filesystem`` package so the relative ``from .policy import ...``
resolves without dragging in the engine runtime.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest


# ---------------------------------------------------------------------------
# Module-import scaffolding
# ---------------------------------------------------------------------------


_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_filesystem'


def _install_rocketlib_stub() -> None:
    """Install a minimal ``rocketlib`` stub so ``IInstance.py`` can import it.

    The real ``rocketlib`` only exists inside the engine subprocess. We only
    need ``IInstanceBase`` (a bare base class) and ``tool_function`` (a
    decorator that stamps ``__tool_meta__`` on the wrapped method) — both
    are surface used by ``IInstance.py`` at import time.
    """
    stub = types.ModuleType('rocketlib')

    class _IInstanceBase:
        """Stand-in for the real engine base class — empty is enough."""

        pass

    def _tool_function(**meta):
        """Decorator stub mirroring the real ``tool_function``.

        Stamps ``__tool_meta__`` on the function so the production
        ``_collect_tool_methods`` discovery would still recognise it.
        """

        def wrap(fn):
            """Attach ``meta`` to ``fn.__tool_meta__`` and return ``fn``."""
            fn.__tool_meta__ = meta
            return fn

        return wrap

    stub.IInstanceBase = _IInstanceBase
    stub.tool_function = _tool_function
    # Transitively needed: IInstance imports ai.common.utils, whose tool_args
    # does ``from rocketlib import warning`` when the real ai package resolves
    # and is not already cached in this process.
    stub.warning = lambda *a, **k: None
    sys.modules['rocketlib'] = stub


def _install_tool_filesystem_pkg_stub() -> None:
    """Install a synthetic ``tool_filesystem`` package rooted at the real node directory.

    The synthesised package's ``__path__`` points at the real node directory,
    so a subsequent ``import tool_filesystem.IInstance`` finds the production
    ``IInstance.py`` and its ``policy.py`` (stdlib plus ``rocketlib.warning``)
    without executing the package ``__init__``.
    """
    if 'tool_filesystem' in sys.modules:
        return

    pkg = types.ModuleType('tool_filesystem')
    pkg.__path__ = [str(_NODE_DIR)]
    sys.modules['tool_filesystem'] = pkg


# Stub rocketlib only while importing the node, then restore so it never leaks.
_saved_rl = sys.modules.get('rocketlib')
_install_rocketlib_stub()
_install_tool_filesystem_pkg_stub()

try:
    from tool_filesystem.IInstance import (  # noqa: E402  — must follow sys.modules setup
        DEFAULT_READ_LIMIT,
        MAX_READ_LIMIT,
        IInstance,
    )
    from tool_filesystem.policy import CallPolicy  # noqa: E402
finally:
    if _saved_rl is not None:
        sys.modules['rocketlib'] = _saved_rl
    else:
        sys.modules.pop('rocketlib', None)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def file_store():
    """Build a double of the node's ``self.files`` door.

    ``read`` returns empty bytes by default (caller-overridable per-test).

    Returns:
        MagicMock with a pre-configured ``read`` returning ``b''``.
    """
    fs = MagicMock()
    fs.read = MagicMock(return_value=b'')
    return fs


@pytest.fixture
def instance(file_store):
    """Construct an ``IInstance`` wired to a default call policy and the files double.

    The engine normally binds the call's settings (the policy is built from
    them) and the server answers ``self.files``; for unit tests a subclass
    takes the double as its ``files`` door. ``allow_read`` defaults to True.

    Returns:
        IInstance whose ``self.files`` is the double.
    """
    inst = type('IInstanceUnderTest', (IInstance,), {'files': None})()
    inst.files = file_store
    inst._call_policy = CallPolicy()
    return inst


# ---------------------------------------------------------------------------
# Default and explicit maxBytes
# ---------------------------------------------------------------------------


class TestDefaultMaxBytes:
    """``maxBytes`` defaults to ``DEFAULT_READ_LIMIT`` when omitted."""

    def test_default_applied_when_field_missing(self, instance, file_store):
        """No ``maxBytes`` in args → FileStore.read called with the default."""
        instance.read_file({'path': 'notes.txt'})

        file_store.read.assert_called_once()
        _, kwargs = file_store.read.call_args
        assert kwargs['max_size'] == DEFAULT_READ_LIMIT

    def test_default_is_under_one_megabyte(self):
        """Sanity: default sits well below any common LLM context limit."""
        assert DEFAULT_READ_LIMIT <= 1 * 1024 * 1024

    def test_ceiling_is_at_or_below_four_megabytes(self):
        """Sanity: ceiling sits at or below 4 MB to bound worst-case context."""
        assert MAX_READ_LIMIT <= 4 * 1024 * 1024


class TestExplicitMaxBytes:
    """Explicit ``maxBytes`` is forwarded verbatim when below the ceiling."""

    def test_smaller_value_forwarded(self, instance, file_store):
        """A modest explicit value flows through unchanged."""
        instance.read_file({'path': 'a.txt', 'maxBytes': 1024})

        _, kwargs = file_store.read.call_args
        assert kwargs['max_size'] == 1024

    def test_value_just_below_ceiling_forwarded(self, instance, file_store):
        """A value just under the hard ceiling flows through unchanged."""
        target = MAX_READ_LIMIT - 1
        instance.read_file({'path': 'a.txt', 'maxBytes': target})

        _, kwargs = file_store.read.call_args
        assert kwargs['max_size'] == target

    def test_value_equal_to_ceiling_forwarded(self, instance, file_store):
        """Exactly the ceiling is allowed."""
        instance.read_file({'path': 'a.txt', 'maxBytes': MAX_READ_LIMIT})

        _, kwargs = file_store.read.call_args
        assert kwargs['max_size'] == MAX_READ_LIMIT


# ---------------------------------------------------------------------------
# Clamping
# ---------------------------------------------------------------------------


class TestClampToCeiling:
    """Values above ``MAX_READ_LIMIT`` are silently clamped to the ceiling.

    The schema's ``maximum`` keyword is advisory for the LLM; runtime defence
    in IInstance keeps the ceiling enforced even if a caller bypasses the
    schema.
    """

    def test_value_above_ceiling_clamped(self, instance, file_store):
        """A value 10x the ceiling is clamped down to the ceiling."""
        instance.read_file({'path': 'big.bin', 'maxBytes': MAX_READ_LIMIT * 10})

        _, kwargs = file_store.read.call_args
        assert kwargs['max_size'] == MAX_READ_LIMIT

    def test_huge_value_clamped(self, instance, file_store):
        """A nonsense-large value (1 GB) is also clamped to the ceiling."""
        instance.read_file({'path': 'big.bin', 'maxBytes': 1024 * 1024 * 1024})

        _, kwargs = file_store.read.call_args
        assert kwargs['max_size'] == MAX_READ_LIMIT


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class TestMaxBytesValidation:
    """``maxBytes`` rejects non-integer and non-positive inputs."""

    @pytest.mark.parametrize(
        'bad_value',
        [
            '1024',  # numeric string — bool/int isinstance trap
            1024.0,  # float — would otherwise sneak past int comparisons
            None,  # explicit None overrides the default
            [1024],  # list
            {'value': 1024},  # dict
        ],
        ids=['string', 'float', 'none', 'list', 'dict'],
    )
    def test_non_integer_rejected(self, instance, file_store, bad_value):
        """Anything that isn't a strict int raises ``ValueError``."""
        with pytest.raises(ValueError, match='maxBytes must be an integer'):
            instance.read_file({'path': 'a.txt', 'maxBytes': bad_value})
        file_store.read.assert_not_called()

    def test_bool_rejected(self, instance, file_store):
        """``bool`` is an ``int`` subclass in Python — must be rejected too.

        Otherwise ``maxBytes=True`` would silently mean ``max_size=1`` and
        ``maxBytes=False`` would fail the ``< 1`` check with a misleading
        message.
        """
        with pytest.raises(ValueError, match='maxBytes must be an integer'):
            instance.read_file({'path': 'a.txt', 'maxBytes': True})
        file_store.read.assert_not_called()

    @pytest.mark.parametrize('bad_value', [0, -1, -1024], ids=['zero', 'minus_one', 'large_negative'])
    def test_non_positive_rejected(self, instance, file_store, bad_value):
        """``maxBytes`` must be at least 1."""
        with pytest.raises(ValueError, match='maxBytes must be at least 1'):
            instance.read_file({'path': 'a.txt', 'maxBytes': bad_value})
        file_store.read.assert_not_called()


# ---------------------------------------------------------------------------
# Result shape
# ---------------------------------------------------------------------------


class TestReadResult:
    """End-to-end shape of the value returned by ``read_file``."""

    def test_returns_decoded_content_and_size(self, instance, file_store):
        """The returned dict carries decoded ``content`` and pre-decode ``size``."""
        payload = b'hello world'
        file_store.read = MagicMock(return_value=payload)

        result = instance.read_file({'path': 'greeting.txt'})

        assert result == {
            'path': 'greeting.txt',
            'content': 'hello world',
            'size': len(payload),
        }

    def test_decode_error_raises_value_error(self, instance, file_store):
        """A bytes payload that can't decode under the requested encoding fails clearly."""
        # 0xff is invalid in UTF-8 but valid in latin-1.
        file_store.read = MagicMock(return_value=b'\xff\xfe\xfd')

        with pytest.raises(ValueError, match='Failed to decode'):
            instance.read_file({'path': 'binary.bin'})
