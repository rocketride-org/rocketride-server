# =============================================================================
# MIT License
#
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

"""``getServiceDefinitions(custom, internal)``: the engine's listing, with a caller's own services.

EaaS serves the nodes of the node archive from this listing: the resolved
schema of a node that is not on the engine's disk has no other source. These
run inside the engine (``engine.exe -m pytest``), against the real registry.
"""

from __future__ import annotations

import pytest

pytest.importorskip('engLib')

from rocketlib import PROTOCOL_CAPS, IJson, getServiceDefinitions  # noqa: E402


def _custom(name: str, capabilities: tuple = ()) -> dict:
    """A service definition in the property model, as a node package's index entry carries it."""
    return {
        'title': name,
        'protocol': f'{name}://',
        'path': f'nodes.{name}',
        'prefix': name,
        'register': 'filter',
        'node': 'python',
        'classType': ['text'],
        'capabilities': list(capabilities),
        'lanes': {'text': ['text']},
        'propertyDefinitions': {},
        'properties': [],
        'icon': 'data:image/svg+xml;base64,PHN2Zy8+',
    }


def _listed(custom: list, internal: bool = False) -> dict:
    return IJson.toDict(getServiceDefinitions(custom, internal))['services']


def test_a_custom_service_is_listed_with_its_resolved_schema():
    shown = _listed([_custom('listing_shown')])['listing_shown']
    assert isinstance(shown['properties'], list) and isinstance(shown['params'], list)
    assert isinstance(shown['capabilities'], int)


def test_an_internal_custom_service_is_listed_only_when_asked_for():
    """A pipeline names an internal node like any other (`response`), so its server needs the schema."""
    custom = [_custom('listing_shown'), _custom('listing_internal', ('internal',))]

    shown = _listed(custom)
    assert 'listing_shown' in shown and 'listing_internal' not in shown

    every = _listed(custom, True)
    assert 'listing_shown' in every
    internal = every['listing_internal']
    assert isinstance(internal['properties'], list) and isinstance(internal['params'], list)
    assert internal['capabilities'] & PROTOCOL_CAPS.INTERNAL


def test_a_custom_service_is_seen_by_its_own_call_only():
    _listed([_custom('listing_internal', ('internal',))], True)
    assert 'listing_internal' not in _listed([], True)
