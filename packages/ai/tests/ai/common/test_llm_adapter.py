# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pins the normalized Adapter interface: Event shape + structural Adapter check."""

from ai.common.llm_adapter import Adapter, Event


def test_event_defaults():
    e = Event('text')
    assert (e.type, e.text, e.items) == ('text', '', [])


def test_event_done_carries_opaque_items():
    e = Event('done', items=[{'role': 'assistant', 'content': 'x'}])
    assert e.type == 'done'
    assert e.items == [{'role': 'assistant', 'content': 'x'}]


def test_adapter_is_structural_protocol():
    class FakeAdapter:
        def __init__(self):
            self.history: list = []

        def stream(self, user_text):
            yield Event('thinking', 'reasoning')
            yield Event('text', 'answer')
            self.history.append('raw-turn')
            yield Event('done', items=['raw-turn'])

    fake = FakeAdapter()
    assert isinstance(fake, Adapter)

    events = list(fake.stream('question'))
    assert events[0] == Event('thinking', 'reasoning')
    assert events[1] == Event('text', 'answer')
    assert events[-1].type == 'done' and events[-1].items == ['raw-turn']
    assert fake.history == ['raw-turn']
