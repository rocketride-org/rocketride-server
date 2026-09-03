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

import pytest

from nodes.slack.slack_events import RoutedEvent, classify_event


@pytest.mark.parametrize(
    ('inner', 'expected_type'),
    [
        ({'type': 'app_mention', 'text': '<@A1> hello'}, 'app_mention'),
        ({'type': 'message', 'channel_type': 'channel', 'text': 'public'}, 'message.channels'),
        (
            {
                'type': 'message',
                'channel_type': 'channel',
                'subtype': 'thread_broadcast',
                'user': 'U1',
                'text': 'public thread',
            },
            'message.channels',
        ),
        ({'type': 'message', 'channel_type': 'group', 'text': 'private'}, 'message.groups'),
        ({'type': 'message', 'channel_type': 'im', 'text': 'direct'}, 'message.im'),
    ],
)
def test_routes_supported_text_without_normalizing(inner, expected_type):
    envelope = {'type': 'event_callback', 'event_id': 'Ev1', 'event': inner}
    routed = classify_event(envelope)
    assert routed == RoutedEvent(expected_type, 'text', inner['text'], envelope)


@pytest.mark.parametrize(
    'inner',
    [
        {'type': 'app_mention', 'text': '<@A1> bot', 'bot_id': 'B1'},
        {'type': 'app_mention', 'text': '<@A1> app', 'app_id': 'A1'},
        {'type': 'app_mention', 'text': '<@A1> subtype', 'subtype': 'bot_message'},
        {'type': 'message', 'channel_type': 'channel', 'text': 'bot', 'bot_id': 'B1'},
        {'type': 'message', 'channel_type': 'channel', 'text': 'app', 'app_id': 'A1'},
        {
            'type': 'message',
            'channel_type': 'channel',
            'text': 'subtype',
            'subtype': 'bot_message',
        },
    ],
)
def test_ignores_slack_marked_bot_or_app_text_events(inner):
    envelope = {'type': 'event_callback', 'event_id': 'EvBot', 'event': inner}
    assert classify_event(envelope) is None


def test_routes_reaction_as_exact_json():
    inner = {'type': 'reaction_added', 'reaction': 'eyes', 'item': {'type': 'message'}}
    envelope = {'type': 'event_callback', 'event_id': 'Ev2', 'event': inner}
    assert classify_event(envelope) == RoutedEvent('reaction_added', 'json', inner, envelope)


@pytest.mark.parametrize(
    'envelope',
    [
        {},
        {'type': 'url_verification', 'challenge': 'x'},
        {
            'type': 'event_callback',
            'event_id': 'Ev3',
            'event': {'type': 'message', 'channel_type': 'mpim', 'text': 'x'},
        },
        {
            'type': 'event_callback',
            'event_id': 'Ev4',
            'event': {'type': 'message', 'channel_type': 'channel'},
        },
        {'type': 'event_callback', 'event_id': 'Ev5', 'event': {'type': 'reaction_removed'}},
        {'type': 'event_callback', 'event_id': 'Ev6', 'event': {'type': [], 'text': 'x'}},
        {
            'type': 'event_callback',
            'event_id': 'Ev7',
            'event': {'type': 'message', 'channel_type': {}, 'text': 'x'},
        },
    ],
)
def test_ignores_unapproved_or_incomplete_events(envelope):
    assert classify_event(envelope) is None
