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
"""

from __future__ import annotations

from typing import Dict

from rocketlib import IInstanceBase, tool_function
from rocketlib.error import APERR, Ec


class _StubFileStore:
    """Sync stand-in for the per-account FileStore used by the dispatcher."""

    def __init__(self, by_path: Dict[str, bytes]):
        self._by_path = by_path

    def read_bytes(self, path: str) -> bytes:
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
