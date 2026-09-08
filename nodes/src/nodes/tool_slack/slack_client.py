# =============================================================================
# RocketRide Engine
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
Slack client wrapper for the RocketRide pipeline.

Wraps the official ``slack_sdk`` WebClient (bot-token mode) and WebhookClient
(incoming-webhook mode). Exactly one of the two auth modes must be configured:

* **token mode** — a bot token unlocks every operation (``check_connection``,
  ``message_post``, ``channels_list``, ``channel_history``).
* **webhook mode** — an incoming-webhook URL supports ``message_post`` only;
  the message always goes to the channel the webhook was created for.

Error messages are built exclusively from Slack's structured response fields
(error code, ``needed`` scope, ``Retry-After`` header) — never from raw
exception text — so the configured token can never leak into an error or log.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError
from slack_sdk.webhook import WebhookClient

# Hard caps enforced regardless of what the caller requests.
MAX_CHANNELS = 1000
MAX_HISTORY_MESSAGES = 200
# Slack chat.postMessage / incoming-webhook `text` hard maximum (characters).
# Refuse above this so a single call stays one atomic message and the returned
# `ts` identifies what the caller sent (see #1831).
MAX_MESSAGE_TEXT_CHARS = 40_000

# Per-request page size for cursor pagination (Slack recommends <= 200).
_PAGE_SIZE = 200


# ---------------------------------------------------------------------------
# Custom exception hierarchy for circuit breaker compatibility.
# The class names contain 'RateLimit', 'Authentication', etc. so that
# retry/circuit-breaker heuristics that inspect type(exc).__name__ can
# correctly classify them.
# ---------------------------------------------------------------------------


class SlackError(Exception):
    """Base error for Slack operations."""


class SlackAuthenticationError(SlackError):
    """Non-retryable: invalid, revoked, or expired token."""


class SlackMissingScopeError(SlackError):
    """Non-retryable: the token lacks an OAuth scope; the message names it."""


class SlackRateLimitError(SlackError):
    """Retryable: rate limit exceeded. ``retry_after`` holds the wait in seconds."""

    def __init__(self, message: str, retry_after: Optional[int] = None):
        """Store the parsed ``Retry-After`` value alongside the message."""
        super().__init__(message)
        self.retry_after = retry_after


class SlackBadRequestError(SlackError):
    """Non-retryable: invalid request (e.g. channel_not_found)."""


class SlackServerError(SlackError):
    """Retryable: server-side or unexpected error."""


_AUTH_ERROR_CODES = frozenset({'invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired'})
_SERVER_ERROR_CODES = frozenset({'internal_error', 'service_unavailable', 'fatal_error'})
_BAD_REQUEST_HINTS = {
    'channel_not_found': ' — check the channel ID or name',
    'not_in_channel': ' — invite the bot to the channel first',
    'is_archived': ' — the channel is archived',
}


def _response_data(resp: Any) -> Dict[str, Any]:
    """Return the response payload as a plain dict.

    ``slack_sdk`` responses expose their payload as ``.data``; plain dicts
    (used by tests and mocks) pass through unchanged.
    """
    data = getattr(resp, 'data', resp)
    return data if isinstance(data, dict) else {}


def _parse_retry_after(headers: Any) -> Optional[int]:
    """Extract the ``Retry-After`` header as whole seconds, if present.

    The lookup is case-insensitive: proxies and HTTP/2-normalizing layers
    deliver the header as ``retry-after``, and ``slack_sdk``'s own retry
    handler scans headers the same way.
    """
    try:
        items = list(headers.items())
    except AttributeError:
        return None
    for key, raw in items:
        if str(key).lower() == 'retry-after':
            value = str(raw or '').strip()
            return int(value) if value.isdigit() else None
    return None


def _map_api_error(exc: SlackApiError) -> SlackError:
    """Translate a ``SlackApiError`` into the node's typed hierarchy.

    The message is assembled from structured response fields only (error
    code, ``needed`` scope, ``Retry-After``) — never from ``str(exc)`` — so
    the token cannot appear in any error message.
    """
    data = _response_data(exc.response)
    code = str(data.get('error') or '')
    status = getattr(exc.response, 'status_code', None) or 0

    if code == 'ratelimited' or status == 429:
        retry_after = _parse_retry_after(getattr(exc.response, 'headers', None))
        suffix = f' (retry after {retry_after}s)' if retry_after is not None else ''
        return SlackRateLimitError(f'Slack rate limit exceeded{suffix}', retry_after=retry_after)
    if code == 'missing_scope':
        needed = str(data.get('needed') or 'unknown')
        return SlackMissingScopeError(
            f'Slack token is missing the "{needed}" OAuth scope — add it to the app and reinstall'
        )
    if code in _AUTH_ERROR_CODES:
        return SlackAuthenticationError(f'Slack authentication failed ({code}) — check the configured bot token')
    if code in _SERVER_ERROR_CODES or status >= 500:
        return SlackServerError(f'Slack server error ({code or f"HTTP {status}"})')
    hint = _BAD_REQUEST_HINTS.get(code, '')
    return SlackBadRequestError(f'Slack API error: {code or "unknown_error"}{hint}')


def _coerce_limit(value: Any, *, name: str, cap: int, default: int) -> int:
    """Validate a limit argument and clamp it to ``[1, cap]``.

    This is the single place where limit defaulting, validation, and the
    hard caps live — tool wrappers pass the raw agent-supplied value through
    so the rules cannot drift between layers.

    Accepts int, whole-number float, or numeric string (mirroring the strict
    ``ai.common.utils.require_int`` contract; bool is rejected despite being
    an int subclass). ``None`` yields ``default``. Values above ``cap`` are
    clamped to the hard cap rather than rejected; anything below 1 or
    non-numeric raises a clean ValueError the agent can self-correct from.
    """
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(f'{name} must be an integer >= 1, got {value!r}')
    if isinstance(value, str):
        try:
            value = int(value.strip())
        except ValueError:
            raise ValueError(f'{name} must be an integer >= 1, got {value!r}') from None
    elif isinstance(value, float):
        if not value.is_integer():
            raise ValueError(f'{name} must be an integer >= 1, got {value!r}')
        value = int(value)
    if value < 1:
        raise ValueError(f'{name} must be an integer >= 1, got {value!r}')
    return min(value, cap)


def _clean_channel(ch: Dict[str, Any]) -> Dict[str, Any]:
    """Strip a conversations.list entry down to agent-useful fields."""
    return {k: ch[k] for k in ('id', 'name', 'is_private', 'is_archived', 'num_members') if k in ch}


def _clean_message(msg: Dict[str, Any]) -> Dict[str, Any]:
    """Strip a conversations.history entry down to ts/user/text (+ thread_ts)."""
    cleaned = {'ts': msg.get('ts'), 'user': msg.get('user'), 'text': msg.get('text')}
    if msg.get('thread_ts'):
        cleaned['thread_ts'] = msg['thread_ts']
    return cleaned


class SlackClient:
    """Wraps the Slack Web/Webhook APIs for use in RocketRide pipelines."""

    def __init__(self, logicalType: str, config: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the Slack client in exactly one auth mode.

        Args:
            logicalType: The logical type of the node (``tool_slack``).
            config: Configuration dict with ``token`` and/or ``webhookUrl``.
            bag: Shared bag for cross-node communication.

        Raises:
            ValueError: If both or neither of token/webhook URL are set, or
                a value has the wrong type/format.
        """
        self._logicalType = logicalType

        token = config.get('token', '')
        webhook_url = config.get('webhookUrl', '')
        if token is not None and not isinstance(token, str):
            raise ValueError('Slack bot token must be a string')
        if webhook_url is not None and not isinstance(webhook_url, str):
            raise ValueError('Slack webhook URL must be a string')
        token = (token or '').strip()
        webhook_url = (webhook_url or '').strip()

        if token and webhook_url:
            raise ValueError('Configure either a Slack bot token or a webhook URL, not both')
        if not token and not webhook_url:
            raise ValueError('A Slack bot token or webhook URL is required')
        if webhook_url and not webhook_url.startswith('https://'):
            raise ValueError('Slack webhook URL must start with https://')

        self._web: Optional[WebClient] = WebClient(token=token) if token else None
        self._webhook: Optional[WebhookClient] = WebhookClient(webhook_url) if webhook_url else None

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def _require_web(self, operation: str) -> WebClient:
        """Return the WebClient or raise when running in webhook mode."""
        if self._web is None:
            raise SlackBadRequestError(f'{operation} requires a bot token — webhook mode only supports message_post')
        return self._web

    @staticmethod
    def _call(method: Any, **kwargs: Any) -> Dict[str, Any]:
        """Invoke a WebClient method and map failures to typed errors."""
        try:
            return _response_data(method(**kwargs))
        except SlackApiError as e:
            raise _map_api_error(e) from e
        except SlackError:
            raise
        except Exception as e:
            # Type name only — raw exception text could echo request details.
            raise SlackServerError(f'Unexpected Slack error ({type(e).__name__})') from e

    # -----------------------------------------------------------------------
    # Operations
    # -----------------------------------------------------------------------

    def check_connection(self) -> Dict[str, Any]:
        """Verify credentials via ``auth.test``.

        Returns:
            Dict with workspace (``team``/``team_id``/``url``) and bot
            identity (``user``/``user_id``/``bot_id``).

        Raises:
            SlackError: Typed error on failure (auth, rate limit, server).
        """
        web = self._require_web('check_connection')
        data = self._call(web.auth_test)
        return {
            'ok': True,
            'team': data.get('team'),
            'team_id': data.get('team_id'),
            'url': data.get('url'),
            'user': data.get('user'),
            'user_id': data.get('user_id'),
            'bot_id': data.get('bot_id'),
        }

    def message_post(
        self,
        channel: Optional[str] = None,
        text: str = '',
        thread_ts: Optional[str] = None,
        unfurl_links: bool = True,
    ) -> Dict[str, Any]:
        """Post a message via ``chat.postMessage`` (or the webhook).

        Args:
            channel: Channel ID or name. Required in token mode; ignored in
                webhook mode (the webhook's channel is fixed at creation).
            text: Message text (required, non-empty).
            thread_ts: Parent message ``ts`` to reply in a thread. Ignored in
                webhook mode.
            unfurl_links: Whether Slack should unfurl links (token mode only).

        Returns:
            Token mode: dict with ``channel``/``ts`` (and ``thread_ts`` when
            replying in a thread). Webhook mode: dict with a ``note`` stating
            that channel/thread arguments were ignored.

        Raises:
            ValueError: On missing/empty ``text``, ``text`` longer than
                ``MAX_MESSAGE_TEXT_CHARS``, or missing ``channel`` in token mode.
            SlackError: Typed error on API failure.
        """
        if not isinstance(text, str) or not text.strip():
            raise ValueError('text must not be empty')
        if len(text) > MAX_MESSAGE_TEXT_CHARS:
            raise ValueError(
                f'text exceeds Slack limit of {MAX_MESSAGE_TEXT_CHARS} characters '
                f'({len(text)} given); shorten the message so it posts atomically'
            )

        if self._webhook is not None:
            return self._post_via_webhook(text)

        if not isinstance(channel, str) or not channel.strip():
            raise ValueError('channel is required when using a bot token')
        kwargs: Dict[str, Any] = {'channel': channel.strip(), 'text': text, 'unfurl_links': bool(unfurl_links)}
        if thread_ts is not None and str(thread_ts).strip():
            kwargs['thread_ts'] = str(thread_ts).strip()
        data = self._call(self._web.chat_postMessage, **kwargs)
        result = {'ok': True, 'channel': data.get('channel'), 'ts': data.get('ts')}
        message_thread_ts = (data.get('message') or {}).get('thread_ts') or kwargs.get('thread_ts')
        if message_thread_ts:
            result['thread_ts'] = message_thread_ts
        return result

    def _post_via_webhook(self, text: str) -> Dict[str, Any]:
        """Send ``text`` through the configured incoming webhook."""
        try:
            resp = self._webhook.send(text=text)
        except Exception as e:
            raise SlackServerError(f'Slack webhook request failed ({type(e).__name__})') from e

        status = getattr(resp, 'status_code', 0) or 0
        body = str(getattr(resp, 'body', '') or '')
        if status == 429:
            retry_after = _parse_retry_after(getattr(resp, 'headers', None))
            suffix = f' (retry after {retry_after}s)' if retry_after is not None else ''
            raise SlackRateLimitError(f'Slack rate limit exceeded{suffix}', retry_after=retry_after)
        if status >= 500:
            raise SlackServerError(f'Slack webhook server error (HTTP {status})')
        if status != 200 or body != 'ok':
            if body in ('invalid_token', 'forbidden'):
                raise SlackAuthenticationError(f'Slack webhook rejected the request ({body}) — check the webhook URL')
            raise SlackBadRequestError(f'Slack webhook error: {body or f"HTTP {status}"}')
        return {
            'ok': True,
            'note': (
                'webhook mode: channel and thread_ts are ignored — the message '
                'was posted to the channel the webhook was created for'
            ),
        }

    def channels_list(self, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """List public channels via ``conversations.list``.

        Cursor pagination is handled internally; at most ``MAX_CHANNELS``
        (1000) channels are returned regardless of ``limit``.

        Args:
            limit: Maximum number of channels to return (1-1000; 200 when
                omitted). Accepts int, whole-number float, or numeric string;
                anything else raises ValueError.

        Returns:
            List of dicts with ``id``/``name``/``is_private``/``is_archived``/
            ``num_members``.

        Raises:
            ValueError: On a non-numeric or below-1 ``limit``.
            SlackError: Typed error on API failure or in webhook mode.
        """
        web = self._require_web('channels_list')
        limit = _coerce_limit(limit, name='limit', cap=MAX_CHANNELS, default=200)

        channels: List[Dict[str, Any]] = []
        cursor = ''
        while len(channels) < limit:
            kwargs: Dict[str, Any] = {'types': 'public_channel', 'limit': min(_PAGE_SIZE, limit - len(channels))}
            if cursor:
                kwargs['cursor'] = cursor
            data = self._call(web.conversations_list, **kwargs)
            batch = data.get('channels') or []
            for ch in batch:
                channels.append(_clean_channel(ch))
                if len(channels) >= limit:
                    break
            cursor = str((data.get('response_metadata') or {}).get('next_cursor') or '').strip()
            # An empty page cannot make progress; stop even if a cursor is set.
            if not cursor or not batch:
                break
        return channels

    def channel_history(
        self,
        channel: str,
        limit: Optional[int] = None,
        oldest: Optional[str] = None,
        latest: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Read recent messages via ``conversations.history``.

        Cursor pagination is handled internally; at most
        ``MAX_HISTORY_MESSAGES`` (200) messages are returned regardless of
        ``limit``. Messages are returned newest first, as Slack delivers them.

        Args:
            channel: Channel ID to read (the bot must be a member).
            limit: Maximum number of messages to return (1-200; 50 when
                omitted). Accepts int, whole-number float, or numeric string;
                anything else raises ValueError.
            oldest: Only include messages after this Slack timestamp.
            latest: Only include messages before this Slack timestamp.

        Returns:
            List of dicts with ``ts``/``user``/``text`` (plus ``thread_ts``
            for threaded messages).

        Raises:
            ValueError: On a missing/empty ``channel`` or a non-numeric or
                below-1 ``limit``.
            SlackError: Typed error on API failure or in webhook mode.
        """
        web = self._require_web('channel_history')
        if not isinstance(channel, str) or not channel.strip():
            raise ValueError('channel must not be empty')
        limit = _coerce_limit(limit, name='limit', cap=MAX_HISTORY_MESSAGES, default=50)

        messages: List[Dict[str, Any]] = []
        cursor = ''
        while len(messages) < limit:
            kwargs: Dict[str, Any] = {'channel': channel.strip(), 'limit': limit - len(messages)}
            if oldest is not None:
                kwargs['oldest'] = str(oldest)
            if latest is not None:
                kwargs['latest'] = str(latest)
            if cursor:
                kwargs['cursor'] = cursor
            data = self._call(web.conversations_history, **kwargs)
            batch = data.get('messages') or []
            for msg in batch:
                messages.append(_clean_message(msg))
                if len(messages) >= limit:
                    break
            cursor = str((data.get('response_metadata') or {}).get('next_cursor') or '').strip()
            if not data.get('has_more') or not cursor or not batch:
                break
        return messages
