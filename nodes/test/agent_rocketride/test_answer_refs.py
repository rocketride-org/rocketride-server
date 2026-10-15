# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Filling {{memory.ref}} tags in a final answer: present, missing, and stored-null keys.

A missing key used to render as nothing, a silent gap in the answer. It now renders as
a visible marker. A key that exists but holds null is not missing, and renders as null.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest


class FakeMemory:
    """The memory channel's get call over a dict, with the reply shape the host sends."""

    def __init__(self, data):
        self.data = data

    def get(self, key):
        if key in self.data:
            return {'ok': True, 'value': self.data[key]}
        return {'ok': False, 'error': f'key {key!r} not found'}


@pytest.fixture
def resolve(wave):
    """Resolve an answer's tags against a memory that holds ``stored``."""

    def _resolve(answer, stored=None):
        context = SimpleNamespace(memory=FakeMemory(stored or {}))
        return wave.executor.resolve_answer_refs(answer, agent_base=None, context=context)

    return _resolve


def test_a_present_key_is_filled_in(resolve):
    assert resolve('Total: {{memory.ref:wave-0.r0}}', {'wave-0.r0': 42}) == 'Total: 42'


def test_a_missing_key_is_marked_inside_text(resolve):
    assert resolve('Total: {{memory.ref:wave-0.r0}}') == 'Total: [missing data: wave-0.r0]'


def test_a_missing_key_is_marked_when_it_is_the_whole_answer(resolve):
    assert resolve('{{memory.ref:wave-0.r0}}') == '[missing data: wave-0.r0]'


def test_a_stored_null_is_not_missing(resolve):
    assert resolve('{{memory.ref:wave-0.r0}}', {'wave-0.r0': None}) == 'null'
    assert resolve('Value: {{memory.ref:wave-0.r0}}', {'wave-0.r0': None}) == 'Value: null'


def test_stored_data_as_the_whole_answer_is_returned_as_text(resolve):
    assert resolve('{{memory.ref:wave-0.r0}}', {'wave-0.r0': {'a': [1, 2]}}) == '{"a": [1, 2]}'


def test_data_that_cannot_be_json_is_still_returned_as_text(resolve):
    """Tuple keys or a cycle cannot become JSON; the answer is plain text instead of an error."""
    looped = {'a': 1}
    looped['self'] = looped

    assert resolve('{{memory.ref:wave-0.r0}}', {'wave-0.r0': {(1, 2): 'value'}}) == "{(1, 2): 'value'}"
    assert resolve('{{memory.ref:wave-0.r0}}', {'wave-0.r0': looped}).startswith("{'a': 1, 'self': {...}")
