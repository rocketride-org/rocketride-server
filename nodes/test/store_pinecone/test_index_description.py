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

"""
Reading Pinecone index descriptions in the save-time probe.

``list_indexes()`` returns plain dicts on older clients and ``IndexModel``
objects (attributes, no ``.get()``) from v7, and a pod-based ``IndexSpec``
still carries a ``serverless`` key set to None. The validator reads both
shapes and the value, not the key.
"""

from __future__ import annotations

import pytest

from nodes.store_pinecone.IValidator import _index_field, _is_serverless


class _Spec:
    """Stand-in for IndexSpec: unset variants are present and None."""

    def __init__(self, serverless=None, pod=None):
        self.serverless = serverless
        self.pod = pod

    def to_dict(self):
        return {'serverless': self.serverless, 'pod': self.pod, 'byoc': None}


class _IndexModel:
    """Stand-in for a v7+ description object: attributes, and no `.get()`."""

    def __init__(self, name, spec):
        self.name = name
        self.spec = spec


_SERVERLESS_SPEC = {'cloud': 'aws', 'region': 'us-east-1'}
_POD_SPEC = {'environment': 'us-east1-gcp', 'pod_type': 'p1.x1'}


def test_index_model_has_no_get_method():
    """Guards the premise: the old `.get()` call is what fails on v7+ entries."""
    with pytest.raises(AttributeError):
        _IndexModel('idx', _Spec()).get('name')


def test_reads_name_from_a_dict_entry():
    entry = {'name': 'my-index', 'spec': {'serverless': _SERVERLESS_SPEC}}
    assert _index_field(entry, 'name') == 'my-index'


def test_reads_name_from_a_model_entry():
    entry = _IndexModel('my-index', _Spec(serverless=_SERVERLESS_SPEC))
    assert _index_field(entry, 'name') == 'my-index'


def test_missing_field_returns_the_default():
    assert _index_field(_IndexModel('my-index', _Spec()), 'absent', 'fallback') == 'fallback'
    assert _index_field({'name': 'my-index'}, 'absent', 'fallback') == 'fallback'


def test_nested_spec_object_is_converted_to_a_mapping():
    entry = _IndexModel('my-index', _Spec(serverless=_SERVERLESS_SPEC))
    assert _index_field(entry, 'spec') == {'serverless': _SERVERLESS_SPEC, 'pod': None, 'byoc': None}


@pytest.mark.parametrize(
    ('entry_factory', 'expected'),
    [
        # A pod-based spec still carries a 'serverless' key, set to None.
        (lambda: _IndexModel('idx', _Spec(pod=_POD_SPEC)), False),
        (lambda: _IndexModel('idx', _Spec(serverless=_SERVERLESS_SPEC)), True),
        (lambda: {'name': 'idx', 'spec': {'serverless': None, 'pod': _POD_SPEC}}, False),
        (lambda: {'name': 'idx', 'spec': {'serverless': _SERVERLESS_SPEC}}, True),
        # An entry with no spec at all must not be reported as serverless.
        (lambda: {'name': 'idx'}, False),
    ],
    ids=['model-pod', 'model-serverless', 'dict-pod', 'dict-serverless', 'no-spec'],
)
def test_serverless_detection_reads_the_value_not_the_key(entry_factory, expected):
    assert _is_serverless(entry_factory()) is expected
