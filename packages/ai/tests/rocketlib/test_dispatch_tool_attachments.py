# =============================================================================
# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the 'Software'), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================
"""Dispatcher contract: format: rocketride-attachment resolution.

These tests pin down the engine-side change that lights up multimodal tool
calls: at ``tool.query`` the dispatcher caches @tool_function descriptors,
and at ``tool.invoke`` it walks the cached top-level ``inputSchema.properties``
to swap any string-typed property declared as ``format: 'rocketride-attachment'``
with a ``{path, mime, bytes}`` dict read from the per-account FileStore.

Only the top-level ``properties`` are walked. Nested
objects, arrays of attachments, ``oneOf``/``anyOf``/``$ref`` are silently
not resolved.

Size-gate (C2b): when the file store reports ``stat(path)['size'] > SLURP_CAP``
(100 MB), the slot is set to ``{'path': ..., 'mime': ..., 'bytes': None}`` and
``read_bytes`` is NOT called.  At or below the cap the bytes are read as before.
"""

from __future__ import annotations

from typing import Dict, Optional

from rocketlib import APERR, Ec, IInstanceBase, tool_function

# Mirror the production constant — tests must not import internals.
_SLURP_CAP = 100 * 1024 * 1024  # 100 MB


class _StubFileStore:
    """Sync stand-in for the per-account FileStore used by the dispatcher.

    ``stat_sizes`` maps path → file size in bytes for the size-gate tests.
    If a path is absent from ``stat_sizes``, ``stat`` returns ``{'size': 0}``
    (i.e. always below the cap, keeping existing tests green).

    ``read_bytes_called`` is a spy flag reset to ``False`` on construction so
    tests can assert whether the bytes were actually read.
    """

    def __init__(
        self,
        by_path: Dict[str, bytes],
        *,
        stat_sizes: Optional[Dict[str, int]] = None,
    ):
        self._by_path = by_path
        self._stat_sizes: Dict[str, int] = stat_sizes or {}
        self.read_bytes_called: bool = False

    def stat(self, path: str) -> dict:
        return {'size': self._stat_sizes.get(path, 0)}

    def read_bytes(self, path: str) -> bytes:
        self.read_bytes_called = True
        return self._by_path[path]


class _ToolNode(IInstanceBase):
    """Trivial node with one attachment-typed tool — test fixture."""

    @tool_function(
        description='Hash a file',
        input_schema={
            'type': 'object',
            'properties': {
                'document': {
                    'type': 'string',
                    'format': 'rocketride-attachment',
                    'x-rocketride-mimes': ['*/*'],
                },
            },
            'required': ['document'],
        },
    )
    def hash_file(self, input_obj):
        return {'received_bytes': len(input_obj['document']['bytes'])}


class _PassthroughToolNode(IInstanceBase):
    """Tool that returns the resolved ``document`` slot — for shape assertions."""

    @tool_function(
        description='Pass through',
        input_schema={
            'type': 'object',
            'properties': {
                'document': {
                    'type': 'string',
                    'format': 'rocketride-attachment',
                    'x-rocketride-mimes': ['*/*'],
                },
            },
            'required': ['document'],
        },
    )
    def passthrough(self, input_obj):
        return {'resolved': input_obj['document']}


def _populate_descriptor_cache(node):
    """Run tool.query — descriptors get cached, then PreventDefault fires."""
    try:
        node._dispatch_tool({'op': 'tool.query', 'tools': []}, 'tool.query')
    except APERR as e:
        if e.ec != Ec.PreventDefault:
            raise


def _invoke(node, tool_name, raw_input):
    """Run tool.invoke with a dict-style param envelope."""
    param = {
        'op': 'tool.invoke',
        'tool_name': tool_name,
        'input': raw_input,
    }
    node._dispatch_tool(param, 'tool.invoke')
    return param.get('output')


# ---------------------------------------------------------------------------
# Existing dispatcher contract tests (must stay green)
# ---------------------------------------------------------------------------


def test_tool_query_caches_descriptors_on_instance():
    node = _ToolNode()
    _populate_descriptor_cache(node)
    assert hasattr(node, '_rr_tool_descriptors')
    assert 'hash_file' in node._rr_tool_descriptors
    desc = node._rr_tool_descriptors['hash_file']
    assert desc['inputSchema']['properties']['document']['format'] == 'rocketride-attachment'


def test_tool_invoke_resolves_attachment_path_to_bytes():
    node = _ToolNode()
    node._file_store = _StubFileStore({'.chats/c/a.pdf': b'%PDF-1.7-fake'})
    _populate_descriptor_cache(node)
    out = _invoke(node, 'hash_file', {'document': '.chats/c/a.pdf'})
    assert out == {'received_bytes': len(b'%PDF-1.7-fake')}


def test_dispatcher_only_walks_top_level_properties():
    """Nested format: rocketride-attachment must NOT be resolved."""

    class _Nested(IInstanceBase):
        @tool_function(
            description='Nested',
            input_schema={
                'type': 'object',
                'properties': {
                    'outer': {
                        'type': 'object',
                        'properties': {
                            'document': {'type': 'string', 'format': 'rocketride-attachment'},
                        },
                    },
                },
            },
        )
        def f(self, input_obj):
            return input_obj

    node = _Nested()
    node._file_store = _StubFileStore({'.chats/c/x.pdf': b'X'})
    _populate_descriptor_cache(node)
    out = _invoke(node, 'f', {'outer': {'document': '.chats/c/x.pdf'}})
    assert out == {'outer': {'document': '.chats/c/x.pdf'}}


# ---------------------------------------------------------------------------
# C2b size-gate tests (RED — these fail until filters.py is updated)
# ---------------------------------------------------------------------------


def test_large_file_resolves_to_bytes_none_and_read_bytes_not_called():
    """File with stat size > 100 MB must yield bytes=None, read_bytes skipped."""
    path = '.chats/c/big.pdf'
    store = _StubFileStore(
        {path: b'would-be-huge'},
        stat_sizes={path: _SLURP_CAP + 1},
    )
    node = _PassthroughToolNode()
    node._file_store = store
    _populate_descriptor_cache(node)
    out = _invoke(node, 'passthrough', {'document': path})
    assert out['resolved']['bytes'] is None
    assert out['resolved']['path'] == path
    assert store.read_bytes_called is False


def test_small_file_still_resolves_with_bytes():
    """Files well below 100 MB must still be slurped with real bytes."""
    path = '.chats/c/small.pdf'
    store = _StubFileStore(
        {path: b'small content'},
        stat_sizes={path: 1024},
    )
    node = _PassthroughToolNode()
    node._file_store = store
    _populate_descriptor_cache(node)
    out = _invoke(node, 'passthrough', {'document': path})
    assert out['resolved']['bytes'] == b'small content'
    assert store.read_bytes_called is True


def test_boundary_exactly_100mb_is_slurped():
    """Exactly 100 MB (== SLURP_CAP, not strictly greater) must be slurped."""
    path = '.chats/c/exactly_100mb.bin'
    store = _StubFileStore(
        {path: b'at-boundary'},
        stat_sizes={path: _SLURP_CAP},
    )
    node = _PassthroughToolNode()
    node._file_store = store
    _populate_descriptor_cache(node)
    out = _invoke(node, 'passthrough', {'document': path})
    assert out['resolved']['bytes'] == b'at-boundary'
    assert store.read_bytes_called is True


def test_boundary_100mb_plus_1_resolves_to_bytes_none():
    """100 MB + 1 byte (> SLURP_CAP) must NOT be slurped — bytes=None."""
    path = '.chats/c/over_100mb.bin'
    store = _StubFileStore(
        {path: b'over-boundary'},
        stat_sizes={path: _SLURP_CAP + 1},
    )
    node = _PassthroughToolNode()
    node._file_store = store
    _populate_descriptor_cache(node)
    out = _invoke(node, 'passthrough', {'document': path})
    assert out['resolved']['bytes'] is None
    assert store.read_bytes_called is False
