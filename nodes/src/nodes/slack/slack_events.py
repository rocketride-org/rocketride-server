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

import hashlib
import hmac
import os
import time
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


class TtlDedupCache:
    """Maintain a bounded time-to-live cache of Slack event IDs."""

    TTL_SECONDS = 600
    MAX_ENTRIES = 10_000

    def __init__(self, *, ttl_seconds: int = TTL_SECONDS, clock: Any = time.time):
        """Initialize the cache with its expiry period and clock."""
        self.ttl_seconds = ttl_seconds
        self._clock = clock
        self._entries: OrderedDict[str, float] = OrderedDict()

    def contains(self, event_id: str) -> bool:
        """Return whether an event ID is currently cached."""
        self._prune()
        return event_id in self._entries

    def add(self, event_id: str) -> None:
        """Record an event ID and enforce the cache size limit."""
        self._prune()
        self._entries.pop(event_id, None)
        self._entries[event_id] = self._clock()
        while len(self._entries) > self.MAX_ENTRIES:
            self._entries.popitem(last=False)

    def _prune(self) -> None:
        """Remove expired event IDs from the cache."""
        expired_before = self._clock() - self.ttl_seconds
        while self._entries:
            _event_id, added_at = next(iter(self._entries.items()))
            if added_at > expired_before:
                break
            self._entries.popitem(last=False)


def resolve_signing_secret(config: Mapping, environ: Mapping | None = None) -> str:
    """Resolve the Slack signing secret from configuration or the environment."""
    env = os.environ if environ is None else environ
    configured = config.get('signingSecret', '') if hasattr(config, 'get') else ''
    return str(configured or env.get('SLACK_SIGNING_SECRET', '') or '').strip()


def verify_slack_signature(
    signing_secret: str,
    timestamp: str,
    provided_signature: str,
    raw_body: bytes,
    *,
    now: float | None = None,
) -> bool:
    """Return whether a Slack request signature is valid and timely."""
    if not signing_secret or not timestamp or not provided_signature:
        return False
    if not timestamp.isascii() or not timestamp.isdecimal():
        return False
    request_time = int(timestamp)
    current = time.time() if now is None else now
    if abs(current - request_time) > 300:
        return False
    base = b'v0:' + timestamp.encode('ascii') + b':' + raw_body
    expected = 'v0=' + hmac.new(signing_secret.encode(), base, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, provided_signature)


@dataclass(frozen=True)
class RoutedEvent:
    """Represent a classified Slack event routed to an output lane."""

    event_type: str
    lane: str
    payload: Any
    envelope: dict


_MESSAGE_TYPES = {
    'channel': 'message.channels',
    'group': 'message.groups',
    'im': 'message.im',
}


def classify_event(envelope: dict) -> RoutedEvent | None:
    """Classify a Slack event envelope or return none when unsupported."""
    if envelope.get('type') != 'event_callback' or not isinstance(envelope.get('event_id'), str):
        return None
    inner = envelope.get('event')
    if not isinstance(inner, dict):
        return None
    inner_type = inner.get('type')
    if not isinstance(inner_type, str):
        return None
    is_bot_or_app_text = (
        (isinstance(inner.get('bot_id'), str) and bool(inner['bot_id']))
        or (isinstance(inner.get('app_id'), str) and bool(inner['app_id']))
        or inner.get('subtype') == 'bot_message'
    )
    if inner_type in {'app_mention', 'message'} and is_bot_or_app_text:
        return None
    if inner_type == 'app_mention' and isinstance(inner.get('text'), str) and inner['text']:
        return RoutedEvent('app_mention', 'text', inner['text'], envelope)
    if inner_type == 'message':
        channel_type = inner.get('channel_type')
        logical = _MESSAGE_TYPES.get(channel_type) if isinstance(channel_type, str) else None
        if logical and isinstance(inner.get('text'), str) and inner['text']:
            return RoutedEvent(logical, 'text', inner['text'], envelope)
    if inner_type == 'reaction_added':
        return RoutedEvent('reaction_added', 'json', inner, envelope)
    return None
