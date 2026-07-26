# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pins drive_adapter: Event stream → callbacks + (answer_text, opaque done.items)."""

from ai.common.llm_adapter import Event, drive_adapter


class _FakeAdapter:
    def __init__(self, events):
        self._events = events
        self.history: list = []

    def stream(self, user_text):
        yield from self._events


def test_fans_deltas_and_returns_text_and_items():
    events = [
        Event('thinking', 'reasoning'),
        Event('text', 'Hel'),
        Event('text', 'lo'),
        Event('done', items=[{'role': 'assistant', 'content': 'Hello'}]),
    ]
    texts, thinks = [], []
    answer, items = drive_adapter(_FakeAdapter(events), 'q', texts.append, thinks.append)

    assert answer == 'Hello'
    assert items == [{'role': 'assistant', 'content': 'Hello'}]
    assert texts == ['Hel', 'lo']
    assert thinks == ['reasoning']


def test_sinks_optional():
    events = [Event('text', 'x'), Event('done', items=[])]
    answer, items = drive_adapter(_FakeAdapter(events), 'q')
    assert answer == 'x'
    assert items == []
