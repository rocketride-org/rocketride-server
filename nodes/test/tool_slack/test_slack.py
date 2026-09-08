# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for the tool_slack node (no network, no engine runtime).

Bootstrap mirrors test_gmail.py: inject lightweight stubs for the engine
runtime modules ONLY if absent, import the modules under test, then drop the
stubs so they never leak into a shared pytest session. The Slack SDK is never
installed — the canonical mock package under nodes/test/mocks/slack_sdk is
put on sys.path for the import, which also validates that the mock exposes
exactly what the node imports.
"""

from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

import pytest

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

_MOCKS_DIR = Path(__file__).resolve().parents[1] / 'mocks'

# Obviously fake credentials — never use realistic Slack token shapes (gitleaks).
TEST_TOKEN = 'xoxb-test-not-a-real-token'
TEST_WEBHOOK = 'https://hooks.slack.example/services/T-MOCK/B-MOCK/mock-webhook-path'


def _require_str(args, key, *, tool_name=''):
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{tool_name or key}: "{key}" is required')
    return value.strip()


def _build_import_stubs():
    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda **kwargs: lambda f: f
    rocketlib.OPEN_MODE = MagicMock()
    rocketlib.warning = lambda *a, **kw: None

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    ai_common_utils = MagicMock()
    ai_common_utils.normalize_tool_input = lambda args, **kw: args if isinstance(args, dict) else {}
    ai_common_utils.require_str = _require_str

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.utils': ai_common_utils,
        'ai.common.config': MagicMock(),
    }


_added_stubs = []
for _name, _stub in _build_import_stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added_stubs.append(_name)

# Make the canonical slack_sdk mock importable, saving whatever was there before.
_saved_sdk_modules = {n: sys.modules.pop(n, None) for n in ('slack_sdk', 'slack_sdk.errors', 'slack_sdk.webhook')}
sys.path.insert(0, str(_MOCKS_DIR))
try:
    slack_client = importlib.import_module('nodes.tool_slack.slack_client')
    iglobal_mod = importlib.import_module('nodes.tool_slack.IGlobal')
    iinstance_mod = importlib.import_module('nodes.tool_slack.IInstance')
finally:
    sys.path.remove(str(_MOCKS_DIR))
    for _name in ('slack_sdk', 'slack_sdk.errors', 'slack_sdk.webhook'):
        sys.modules.pop(_name, None)
    for _name, _mod in _saved_sdk_modules.items():
        if _mod is not None:
            sys.modules[_name] = _mod
    for _name in _added_stubs:
        sys.modules.pop(_name, None)

SlackClient = slack_client.SlackClient
SlackError = slack_client.SlackError
SlackAuthenticationError = slack_client.SlackAuthenticationError
SlackMissingScopeError = slack_client.SlackMissingScopeError
SlackRateLimitError = slack_client.SlackRateLimitError
SlackBadRequestError = slack_client.SlackBadRequestError
SlackServerError = slack_client.SlackServerError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _api_error(payload=None, status=200, headers=None, message='mock slack api failure'):
    """Build a SlackApiError the way slack_sdk raises it (with .response)."""
    response = SimpleNamespace(data=dict(payload or {}), status_code=status, headers=dict(headers or {}))
    return slack_client.SlackApiError(message, response)


def _make_token_client():
    """Return (SlackClient in token mode, Mock standing in for WebClient)."""
    client = SlackClient('tool_slack', {'token': TEST_TOKEN}, {})
    web = Mock()
    client._web = web
    return client, web


def _make_webhook_client(send_response=None):
    """Return (SlackClient in webhook mode, Mock standing in for WebhookClient)."""
    client = SlackClient('tool_slack', {'webhookUrl': TEST_WEBHOOK}, {})
    hook = Mock()
    if send_response is not None:
        hook.send.return_value = send_response
    client._webhook = hook
    return client, hook


def _webhook_response(status_code=200, body='ok', headers=None):
    return SimpleNamespace(status_code=status_code, body=body, headers=dict(headers or {}))


def _channels_page(channels, next_cursor=''):
    return {'ok': True, 'channels': channels, 'response_metadata': {'next_cursor': next_cursor}}


def _history_page(messages, has_more=False, next_cursor=''):
    return {
        'ok': True,
        'messages': messages,
        'has_more': has_more,
        'response_metadata': {'next_cursor': next_cursor},
    }


def _channel(i):
    return {
        'id': f'C-MOCK-{i}',
        'name': f'chan-{i}',
        'is_private': False,
        'is_archived': False,
        'num_members': i,
        'topic': {'value': 'noise that must be stripped'},
    }


# ===========================================================================
# SlackClient — auth mode selection and config validation
# ===========================================================================


class TestSlackClientConfig:
    def test_token_mode_selected(self):
        client = SlackClient('tool_slack', {'token': TEST_TOKEN}, {})
        assert client._web is not None
        assert client._webhook is None

    def test_webhook_mode_selected(self):
        client = SlackClient('tool_slack', {'webhookUrl': TEST_WEBHOOK}, {})
        assert client._web is None
        assert client._webhook is not None

    def test_token_is_stripped_before_client_creation(self):
        client = SlackClient('tool_slack', {'token': f'  {TEST_TOKEN}  '}, {})
        # The mock WebClient stores the token it was constructed with.
        assert client._web.token == TEST_TOKEN

    def test_both_configured_raises(self):
        with pytest.raises(ValueError, match='not both'):
            SlackClient('tool_slack', {'token': TEST_TOKEN, 'webhookUrl': TEST_WEBHOOK}, {})

    def test_neither_configured_raises(self):
        with pytest.raises(ValueError, match='required'):
            SlackClient('tool_slack', {'token': '', 'webhookUrl': ''}, {})

    def test_whitespace_only_values_count_as_missing(self):
        with pytest.raises(ValueError, match='required'):
            SlackClient('tool_slack', {'token': '   ', 'webhookUrl': '  '}, {})

    def test_non_string_token_raises(self):
        with pytest.raises(ValueError, match='must be a string'):
            SlackClient('tool_slack', {'token': 12345}, {})

    def test_non_string_webhook_raises(self):
        with pytest.raises(ValueError, match='must be a string'):
            SlackClient('tool_slack', {'webhookUrl': ['not', 'a', 'string']}, {})

    def test_webhook_must_be_https(self):
        with pytest.raises(ValueError, match='https'):
            SlackClient('tool_slack', {'webhookUrl': 'http://hooks.slack.example/services/x'}, {})


# ===========================================================================
# check_connection
# ===========================================================================


class TestCheckConnection:
    def test_happy_path(self):
        client, web = _make_token_client()
        web.auth_test.return_value = {
            'ok': True,
            'url': 'https://acme.slack.example/',
            'team': 'Acme',
            'team_id': 'T-ACME',
            'user': 'pipeline-bot',
            'user_id': 'U-BOT',
            'bot_id': 'B-BOT',
        }
        result = client.check_connection()
        assert result == {
            'ok': True,
            'team': 'Acme',
            'team_id': 'T-ACME',
            'url': 'https://acme.slack.example/',
            'user': 'pipeline-bot',
            'user_id': 'U-BOT',
            'bot_id': 'B-BOT',
        }

    def test_happy_path_against_canonical_mock(self):
        """End-to-end against nodes/test/mocks/slack_sdk (no Mock patching)."""
        client = SlackClient('tool_slack', {'token': TEST_TOKEN}, {})
        result = client.check_connection()
        assert result['ok'] is True
        assert result['team'] == 'Mock Workspace'
        assert result['user_id'] == 'U-MOCK'

    def test_webhook_mode_rejected(self):
        client, _ = _make_webhook_client()
        with pytest.raises(SlackBadRequestError, match='message_post'):
            client.check_connection()

    def test_invalid_auth_maps_to_authentication_error(self):
        client, web = _make_token_client()
        web.auth_test.side_effect = _api_error({'ok': False, 'error': 'invalid_auth'})
        with pytest.raises(SlackAuthenticationError, match='invalid_auth'):
            client.check_connection()


# ===========================================================================
# message_post
# ===========================================================================


class TestMessagePost:
    def test_happy_path(self):
        client, web = _make_token_client()
        web.chat_postMessage.return_value = {
            'ok': True,
            'channel': 'C-GENERAL',
            'ts': '12345.6789',
            'message': {'text': 'hello', 'ts': '12345.6789'},
        }
        result = client.message_post(channel='#general', text='hello')
        web.chat_postMessage.assert_called_once_with(channel='#general', text='hello', unfurl_links=True)
        assert result == {'ok': True, 'channel': 'C-GENERAL', 'ts': '12345.6789'}

    def test_thread_ts_passthrough(self):
        client, web = _make_token_client()
        web.chat_postMessage.return_value = {
            'ok': True,
            'channel': 'C-GENERAL',
            'ts': '12345.6790',
            'message': {'text': 'reply', 'ts': '12345.6790', 'thread_ts': '12345.6789'},
        }
        result = client.message_post(channel='C-GENERAL', text='reply', thread_ts='12345.6789')
        assert web.chat_postMessage.call_args.kwargs['thread_ts'] == '12345.6789'
        assert result['thread_ts'] == '12345.6789'

    def test_unfurl_links_false_passthrough(self):
        client, web = _make_token_client()
        web.chat_postMessage.return_value = {'ok': True, 'channel': 'C-1', 'ts': '1.2', 'message': {}}
        client.message_post(channel='C-1', text='hi', unfurl_links=False)
        assert web.chat_postMessage.call_args.kwargs['unfurl_links'] is False

    def test_empty_text_raises(self):
        client, web = _make_token_client()
        with pytest.raises(ValueError, match='text must not be empty'):
            client.message_post(channel='C-1', text='   ')
        web.chat_postMessage.assert_not_called()

    def test_text_over_limit_raises_token_mode(self):
        client, web = _make_token_client()
        too_long = 'x' * (slack_client.MAX_MESSAGE_TEXT_CHARS + 1)
        with pytest.raises(ValueError, match='exceeds Slack limit'):
            client.message_post(channel='C-1', text=too_long)
        web.chat_postMessage.assert_not_called()

    def test_text_at_limit_posts_token_mode(self):
        client, web = _make_token_client()
        web.chat_postMessage.return_value = {'ok': True, 'channel': 'C-1', 'ts': '1.2', 'message': {}}
        text = 'y' * slack_client.MAX_MESSAGE_TEXT_CHARS
        result = client.message_post(channel='C-1', text=text)
        web.chat_postMessage.assert_called_once()
        assert result['ok'] is True

    def test_text_over_limit_raises_webhook_mode(self):
        client, hook = _make_webhook_client()
        too_long = 'z' * (slack_client.MAX_MESSAGE_TEXT_CHARS + 1)
        with pytest.raises(ValueError, match='exceeds Slack limit'):
            client.message_post(text=too_long)
        hook.send.assert_not_called()

    def test_missing_channel_in_token_mode_raises(self):
        client, web = _make_token_client()
        with pytest.raises(ValueError, match='channel is required'):
            client.message_post(text='hi')
        web.chat_postMessage.assert_not_called()

    def test_channel_not_found_maps_to_bad_request(self):
        client, web = _make_token_client()
        web.chat_postMessage.side_effect = _api_error({'ok': False, 'error': 'channel_not_found'})
        with pytest.raises(SlackBadRequestError, match='channel_not_found'):
            client.message_post(channel='C-NOPE', text='hi')

    def test_webhook_mode_posts_and_ignores_channel_and_thread(self):
        client, hook = _make_webhook_client(_webhook_response())
        result = client.message_post(channel='#ignored', text='hi', thread_ts='12345.6789')
        hook.send.assert_called_once_with(text='hi')
        assert result['ok'] is True
        assert 'ignored' in result['note']

    def test_webhook_mode_against_canonical_mock(self):
        """End-to-end against nodes/test/mocks/slack_sdk (no Mock patching)."""
        client = SlackClient('tool_slack', {'webhookUrl': TEST_WEBHOOK}, {})
        result = client.message_post(text='hi')
        assert result['ok'] is True

    def test_webhook_empty_text_raises(self):
        client, hook = _make_webhook_client()
        with pytest.raises(ValueError, match='text must not be empty'):
            client.message_post(text='')
        hook.send.assert_not_called()

    def test_webhook_error_body_maps_to_bad_request(self):
        client, _ = _make_webhook_client(_webhook_response(status_code=404, body='no_service'))
        with pytest.raises(SlackBadRequestError, match='no_service'):
            client.message_post(text='hi')

    def test_webhook_invalid_token_maps_to_authentication_error(self):
        client, _ = _make_webhook_client(_webhook_response(status_code=403, body='invalid_token'))
        with pytest.raises(SlackAuthenticationError, match='invalid_token'):
            client.message_post(text='hi')

    def test_webhook_rate_limit_surfaces_retry_after(self):
        client, _ = _make_webhook_client(
            _webhook_response(status_code=429, body='rate_limited', headers={'Retry-After': '7'})
        )
        with pytest.raises(SlackRateLimitError, match='7') as exc_info:
            client.message_post(text='hi')
        assert exc_info.value.retry_after == 7

    def test_webhook_lowercase_retry_after_header_still_surfaces(self):
        client, _ = _make_webhook_client(
            _webhook_response(status_code=429, body='rate_limited', headers={'retry-after': '4'})
        )
        with pytest.raises(SlackRateLimitError) as exc_info:
            client.message_post(text='hi')
        assert exc_info.value.retry_after == 4

    def test_webhook_server_error(self):
        client, _ = _make_webhook_client(_webhook_response(status_code=503, body=''))
        with pytest.raises(SlackServerError, match='503'):
            client.message_post(text='hi')

    def test_webhook_transport_failure_maps_to_server_error(self):
        client, hook = _make_webhook_client()
        hook.send.side_effect = ConnectionError(f'refused for {TEST_WEBHOOK}')
        with pytest.raises(SlackServerError, match='ConnectionError') as exc_info:
            client.message_post(text='hi')
        assert TEST_WEBHOOK not in str(exc_info.value)


# ===========================================================================
# channels_list
# ===========================================================================


class TestChannelsList:
    def test_single_page(self):
        client, web = _make_token_client()
        web.conversations_list.return_value = _channels_page([_channel(1), _channel(2)])
        result = client.channels_list()
        web.conversations_list.assert_called_once_with(types='public_channel', limit=200)
        assert result == [
            {'id': 'C-MOCK-1', 'name': 'chan-1', 'is_private': False, 'is_archived': False, 'num_members': 1},
            {'id': 'C-MOCK-2', 'name': 'chan-2', 'is_private': False, 'is_archived': False, 'num_members': 2},
        ]

    def test_pagination_follows_cursors(self):
        client, web = _make_token_client()
        web.conversations_list.side_effect = [
            _channels_page([_channel(i) for i in range(1, 201)], next_cursor='cursor-page-2'),
            _channels_page([_channel(i) for i in range(201, 251)]),
        ]
        result = client.channels_list(limit=300)
        assert len(result) == 250
        assert web.conversations_list.call_count == 2
        assert web.conversations_list.call_args_list[1].kwargs['cursor'] == 'cursor-page-2'

    def test_limit_truncates_mid_page(self):
        client, web = _make_token_client()
        web.conversations_list.return_value = _channels_page([_channel(1), _channel(2), _channel(3)])
        result = client.channels_list(limit=2)
        assert [ch['id'] for ch in result] == ['C-MOCK-1', 'C-MOCK-2']

    def test_hard_cap_at_1000_channels(self):
        client, web = _make_token_client()
        web.conversations_list.side_effect = lambda **kwargs: _channels_page(
            [_channel(i) for i in range(kwargs['limit'])], next_cursor='more'
        )
        result = client.channels_list(limit=5000)
        assert len(result) == 1000
        assert web.conversations_list.call_count == 5

    def test_empty_page_with_cursor_does_not_loop_forever(self):
        client, web = _make_token_client()
        web.conversations_list.return_value = _channels_page([], next_cursor='stuck-cursor')
        assert client.channels_list() == []
        assert web.conversations_list.call_count == 1

    def test_invalid_limit_raises(self):
        client, web = _make_token_client()
        for bad in (0, -5, 2.5, 'ten', '2.5', True, [10]):
            with pytest.raises(ValueError, match='limit must be an integer'):
                client.channels_list(limit=bad)
        web.conversations_list.assert_not_called()

    def test_numeric_string_limit_accepted(self):
        """LLMs often send integers as strings; mirror require_int's leniency."""
        client, web = _make_token_client()
        web.conversations_list.return_value = _channels_page([_channel(1), _channel(2), _channel(3)])
        result = client.channels_list(limit=' 2 ')
        assert [ch['id'] for ch in result] == ['C-MOCK-1', 'C-MOCK-2']

    def test_none_limit_uses_default(self):
        client, web = _make_token_client()
        web.conversations_list.return_value = _channels_page([_channel(1)])
        client.channels_list(limit=None)
        assert web.conversations_list.call_args.kwargs['limit'] == 200

    def test_webhook_mode_rejected(self):
        client, _ = _make_webhook_client()
        with pytest.raises(SlackBadRequestError, match='bot token'):
            client.channels_list()


# ===========================================================================
# channel_history
# ===========================================================================


class TestChannelHistory:
    def test_happy_path(self):
        client, web = _make_token_client()
        web.conversations_history.return_value = _history_page(
            [
                {'ts': '12345.0002', 'user': 'U-A', 'text': 'newest', 'team': 'noise'},
                {'ts': '12345.0001', 'user': 'U-B', 'text': 'older'},
            ]
        )
        result = client.channel_history(channel='C-GENERAL')
        web.conversations_history.assert_called_once_with(channel='C-GENERAL', limit=50)
        assert result == [
            {'ts': '12345.0002', 'user': 'U-A', 'text': 'newest'},
            {'ts': '12345.0001', 'user': 'U-B', 'text': 'older'},
        ]

    def test_thread_ts_included_when_present(self):
        client, web = _make_token_client()
        web.conversations_history.return_value = _history_page(
            [{'ts': '12345.0002', 'user': 'U-A', 'text': 'reply', 'thread_ts': '12345.0001'}]
        )
        result = client.channel_history(channel='C-1')
        assert result[0]['thread_ts'] == '12345.0001'

    def test_oldest_and_latest_passthrough(self):
        client, web = _make_token_client()
        web.conversations_history.return_value = _history_page([])
        client.channel_history(channel='C-1', oldest='12345.0001', latest='12345.0009')
        kwargs = web.conversations_history.call_args.kwargs
        assert kwargs['oldest'] == '12345.0001'
        assert kwargs['latest'] == '12345.0009'

    def test_limit_hard_capped_at_200(self):
        client, web = _make_token_client()
        web.conversations_history.return_value = _history_page([])
        client.channel_history(channel='C-1', limit=999)
        assert web.conversations_history.call_args.kwargs['limit'] == 200

    def test_pagination_follows_cursor_until_limit(self):
        client, web = _make_token_client()
        page_1 = [{'ts': f'1.{i:04d}', 'user': 'U-A', 'text': f'm{i}'} for i in range(50)]
        page_2 = [{'ts': f'2.{i:04d}', 'user': 'U-A', 'text': f'm{i}'} for i in range(50)]
        web.conversations_history.side_effect = [
            _history_page(page_1, has_more=True, next_cursor='cursor-2'),
            _history_page(page_2, has_more=True, next_cursor='cursor-3'),
        ]
        result = client.channel_history(channel='C-1', limit=80)
        assert len(result) == 80
        assert web.conversations_history.call_count == 2
        assert web.conversations_history.call_args_list[1].kwargs['cursor'] == 'cursor-2'

    def test_stops_when_has_more_is_false(self):
        client, web = _make_token_client()
        web.conversations_history.return_value = _history_page(
            [{'ts': '1.0001', 'user': 'U-A', 'text': 'only'}], has_more=False
        )
        result = client.channel_history(channel='C-1', limit=100)
        assert len(result) == 1
        assert web.conversations_history.call_count == 1

    def test_empty_channel_raises(self):
        client, web = _make_token_client()
        with pytest.raises(ValueError, match='channel must not be empty'):
            client.channel_history(channel='  ')
        web.conversations_history.assert_not_called()

    def test_not_in_channel_maps_to_bad_request_with_hint(self):
        client, web = _make_token_client()
        web.conversations_history.side_effect = _api_error({'ok': False, 'error': 'not_in_channel'})
        with pytest.raises(SlackBadRequestError, match='invite the bot'):
            client.channel_history(channel='C-1')

    def test_webhook_mode_rejected(self):
        client, _ = _make_webhook_client()
        with pytest.raises(SlackBadRequestError, match='bot token'):
            client.channel_history(channel='C-1')


# ===========================================================================
# Error mapping
# ===========================================================================


class TestErrorMapping:
    @pytest.mark.parametrize('code', ['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked'])
    def test_auth_errors(self, code):
        client, web = _make_token_client()
        web.auth_test.side_effect = _api_error({'ok': False, 'error': code})
        with pytest.raises(SlackAuthenticationError, match=code):
            client.check_connection()

    def test_missing_scope_names_the_needed_scope(self):
        client, web = _make_token_client()
        web.conversations_list.side_effect = _api_error(
            {'ok': False, 'error': 'missing_scope', 'needed': 'channels:read', 'provided': 'chat:write'}
        )
        with pytest.raises(SlackMissingScopeError, match='channels:read'):
            client.channels_list()

    def test_rate_limit_surfaces_retry_after(self):
        client, web = _make_token_client()
        web.auth_test.side_effect = _api_error(
            {'ok': False, 'error': 'ratelimited'}, status=429, headers={'Retry-After': '30'}
        )
        with pytest.raises(SlackRateLimitError, match='30') as exc_info:
            client.check_connection()
        assert exc_info.value.retry_after == 30

    def test_retry_after_header_lookup_is_case_insensitive(self):
        """Proxies/HTTP2 layers lowercase headers; the wait hint must survive."""
        client, web = _make_token_client()
        web.auth_test.side_effect = _api_error(
            {'ok': False, 'error': 'ratelimited'}, status=429, headers={'retry-after': '9'}
        )
        with pytest.raises(SlackRateLimitError, match='9') as exc_info:
            client.check_connection()
        assert exc_info.value.retry_after == 9

    def test_http_429_without_error_code_is_rate_limit(self):
        client, web = _make_token_client()
        web.auth_test.side_effect = _api_error({'ok': False}, status=429)
        with pytest.raises(SlackRateLimitError):
            client.check_connection()
        assert web.auth_test.call_count == 1

    def test_channel_not_found_is_bad_request(self):
        client, web = _make_token_client()
        web.auth_test.side_effect = _api_error({'ok': False, 'error': 'channel_not_found'})
        with pytest.raises(SlackBadRequestError, match='channel_not_found'):
            client.check_connection()

    @pytest.mark.parametrize('code', ['internal_error', 'service_unavailable', 'fatal_error'])
    def test_server_error_codes(self, code):
        client, web = _make_token_client()
        web.auth_test.side_effect = _api_error({'ok': False, 'error': code})
        with pytest.raises(SlackServerError, match=code):
            client.check_connection()

    def test_http_5xx_without_error_code_is_server_error(self):
        client, web = _make_token_client()
        web.auth_test.side_effect = _api_error({'ok': False}, status=503)
        with pytest.raises(SlackServerError, match='503'):
            client.check_connection()

    def test_unexpected_exception_maps_to_server_error(self):
        client, web = _make_token_client()
        web.auth_test.side_effect = RuntimeError(f'socket blew up for token {TEST_TOKEN}')
        with pytest.raises(SlackServerError, match='RuntimeError') as exc_info:
            client.check_connection()
        assert TEST_TOKEN not in str(exc_info.value)

    @pytest.mark.parametrize(
        'payload,status',
        [
            ({'ok': False, 'error': 'invalid_auth'}, 200),
            ({'ok': False, 'error': 'missing_scope', 'needed': 'chat:write'}, 200),
            ({'ok': False, 'error': 'ratelimited'}, 429),
            ({'ok': False, 'error': 'channel_not_found'}, 200),
            ({'ok': False, 'error': 'internal_error'}, 500),
        ],
    )
    def test_token_never_appears_in_mapped_errors(self, payload, status):
        """Even when the SDK exception text contains the token, ours must not."""
        client, web = _make_token_client()
        web.auth_test.side_effect = _api_error(payload, status=status, message=f'request with token {TEST_TOKEN}')
        with pytest.raises(SlackError) as exc_info:
            client.check_connection()
        assert TEST_TOKEN not in str(exc_info.value)

    def test_original_cause_is_preserved(self):
        client, web = _make_token_client()
        original = _api_error({'ok': False, 'error': 'invalid_auth'})
        web.auth_test.side_effect = original
        with pytest.raises(SlackAuthenticationError) as exc_info:
            client.check_connection()
        assert exc_info.value.__cause__ is original


# ===========================================================================
# Exception hierarchy
# ===========================================================================


class TestExceptionHierarchy:
    def test_all_errors_inherit_from_slack_error(self):
        assert issubclass(SlackAuthenticationError, SlackError)
        assert issubclass(SlackMissingScopeError, SlackError)
        assert issubclass(SlackRateLimitError, SlackError)
        assert issubclass(SlackBadRequestError, SlackError)
        assert issubclass(SlackServerError, SlackError)

    def test_slack_error_inherits_from_exception(self):
        assert issubclass(SlackError, Exception)
        assert not issubclass(SlackError, ValueError)

    def test_class_names_carry_circuit_breaker_hints(self):
        assert 'Authentication' in SlackAuthenticationError.__name__
        assert 'RateLimit' in SlackRateLimitError.__name__
        assert 'BadRequest' in SlackBadRequestError.__name__
        assert 'ServerError' in SlackServerError.__name__


# ===========================================================================
# IGlobal
# ===========================================================================


def _make_iglobal(open_mode='SOURCE', conn_config=None):
    iglobal = iglobal_mod.IGlobal()

    mock_endpoint = Mock()
    mock_endpoint.endpoint = Mock()
    mock_endpoint.endpoint.openMode = getattr(iglobal_mod.OPEN_MODE, open_mode)
    mock_endpoint.endpoint.bag = {}
    iglobal.IEndpoint = mock_endpoint

    mock_glb = Mock()
    mock_glb.logicalType = 'tool_slack'
    mock_glb.connConfig = conn_config or {}
    iglobal.glb = mock_glb
    return iglobal


_NO_SLACK_ENV = {
    'ROCKETRIDE_MOCK': 'nodes/test/mocks',
    iglobal_mod.SLACK_TOKEN_ENV: '',
    iglobal_mod.SLACK_WEBHOOK_URL_ENV: '',
}


class TestIGlobal:
    def _begin(self, iglobal, config, env=None):
        with patch.dict(os.environ, {**_NO_SLACK_ENV, **(env or {})}, clear=False):
            with patch.object(iglobal_mod, 'Config') as mock_config_cls:
                mock_config_cls.getNodeConfig.return_value = config
                iglobal.beginGlobal()

    def test_begin_global_config_mode_skips_client(self):
        iglobal = _make_iglobal(open_mode='CONFIG')
        iglobal.beginGlobal()
        assert iglobal._slack is None

    def test_begin_global_token_mode(self):
        iglobal = _make_iglobal()
        self._begin(iglobal, {'token': TEST_TOKEN, 'webhookUrl': ''})
        assert iglobal._slack is not None
        assert iglobal._slack._web is not None

    def test_begin_global_webhook_mode(self):
        iglobal = _make_iglobal()
        self._begin(iglobal, {'token': '', 'webhookUrl': TEST_WEBHOOK})
        assert iglobal._slack is not None
        assert iglobal._slack._webhook is not None

    def test_begin_global_both_raises_prefixed_error(self):
        iglobal = _make_iglobal()
        with pytest.raises(ValueError, match='tool_slack: .*not both'):
            self._begin(iglobal, {'token': TEST_TOKEN, 'webhookUrl': TEST_WEBHOOK})

    def test_begin_global_neither_raises_prefixed_error(self):
        iglobal = _make_iglobal()
        with pytest.raises(ValueError, match='tool_slack: .*required'):
            self._begin(iglobal, {'token': '', 'webhookUrl': ''})

    def test_env_fallback_when_config_empty(self):
        iglobal = _make_iglobal()
        self._begin(iglobal, {'token': '', 'webhookUrl': ''}, env={iglobal_mod.SLACK_TOKEN_ENV: TEST_TOKEN})
        assert iglobal._slack._web is not None

    def test_explicit_config_wins_over_env(self):
        """A stray env var must not conflict with an explicitly configured mode."""
        iglobal = _make_iglobal()
        self._begin(
            iglobal,
            {'token': '', 'webhookUrl': TEST_WEBHOOK},
            env={iglobal_mod.SLACK_TOKEN_ENV: TEST_TOKEN},
        )
        assert iglobal._slack._webhook is not None
        assert iglobal._slack._web is None

    def test_mock_mode_skips_dependency_install(self):
        iglobal = _make_iglobal()
        with patch.dict(os.environ, {'ROCKETRIDE_MOCK': 'nodes/test/mocks'}, clear=False):
            saved_depends = sys.modules.pop('depends', None)
            try:
                iglobal._ensure_dependencies()  # should not raise
            finally:
                if saved_depends is not None:
                    sys.modules['depends'] = saved_depends

    def test_end_global_clears_client(self):
        iglobal = _make_iglobal()
        iglobal._slack = Mock()
        iglobal.endGlobal()
        assert iglobal._slack is None

    def _validate(self, config, env=None):
        with patch.dict(os.environ, {**_NO_SLACK_ENV, **(env or {})}, clear=False):
            with patch.object(iglobal_mod, 'Config') as mock_config_cls:
                mock_config_cls.getNodeConfig.return_value = config
                with patch.object(iglobal_mod, 'warning') as mock_warning:
                    _make_iglobal().validateConfig()
        return mock_warning

    def test_validate_config_neither_warns(self):
        assert self._validate({'token': '', 'webhookUrl': ''}).call_count == 1

    def test_validate_config_both_warns(self):
        assert self._validate({'token': TEST_TOKEN, 'webhookUrl': TEST_WEBHOOK}).call_count == 1

    def test_validate_config_token_only_is_clean(self):
        self._validate({'token': TEST_TOKEN, 'webhookUrl': ''}).assert_not_called()

    def test_validate_config_webhook_only_is_clean(self):
        self._validate({'token': '', 'webhookUrl': TEST_WEBHOOK}).assert_not_called()

    def test_validate_config_env_fallback_is_clean(self):
        warning = self._validate({'token': '', 'webhookUrl': ''}, env={iglobal_mod.SLACK_TOKEN_ENV: TEST_TOKEN})
        warning.assert_not_called()

    def test_validate_config_lookup_failure_warns(self):
        with patch.object(iglobal_mod, 'Config') as mock_config_cls:
            mock_config_cls.getNodeConfig.side_effect = Exception('boom')
            with patch.object(iglobal_mod, 'warning') as mock_warning:
                _make_iglobal().validateConfig()
        mock_warning.assert_called_once()


# ===========================================================================
# IInstance tool wrappers
# ===========================================================================


def _make_instance(client=None):
    inst = iinstance_mod.IInstance()
    inst.IGlobal = Mock()
    inst.IGlobal._slack = client if client is not None else Mock()
    return inst


class TestIInstance:
    def test_check_connection_delegates(self):
        inst = _make_instance()
        inst.IGlobal._slack.check_connection.return_value = {'ok': True}
        assert inst.check_connection({}) == {'ok': True}

    def test_client_not_initialized_raises(self):
        inst = _make_instance()
        inst.IGlobal._slack = None
        with pytest.raises(RuntimeError, match='not initialized'):
            inst.check_connection({})

    def test_message_post_defaults(self):
        inst = _make_instance()
        inst.message_post({'channel': '#general', 'text': 'hi'})
        inst.IGlobal._slack.message_post.assert_called_once_with(
            channel='#general', text='hi', thread_ts=None, unfurl_links=True
        )

    def test_message_post_thread_and_unfurl_passthrough(self):
        inst = _make_instance()
        inst.message_post({'channel': 'C-1', 'text': 'hi', 'thread_ts': '12345.6789', 'unfurl_links': False})
        kwargs = inst.IGlobal._slack.message_post.call_args.kwargs
        assert kwargs['thread_ts'] == '12345.6789'
        assert kwargs['unfurl_links'] is False

    def test_message_post_requires_text(self):
        inst = _make_instance()
        with pytest.raises(ValueError, match='text'):
            inst.message_post({'channel': 'C-1'})
        inst.IGlobal._slack.message_post.assert_not_called()

    def test_channels_list_absent_limit_passes_none(self):
        """Defaulting happens in SlackClient._coerce_limit, not the wrapper."""
        inst = _make_instance()
        inst.channels_list({})
        inst.IGlobal._slack.channels_list.assert_called_once_with(limit=None)

    def test_channels_list_passes_limit_through_raw(self):
        """Capping happens in SlackClient._coerce_limit, not the wrapper."""
        inst = _make_instance()
        inst.channels_list({'limit': 99999})
        inst.IGlobal._slack.channels_list.assert_called_once_with(limit=99999)

    def test_channels_list_invalid_limit_gets_clean_error(self):
        """End-to-end through a real SlackClient: no bare int() traceback."""
        inst = _make_instance(SlackClient('tool_slack', {'token': TEST_TOKEN}, {}))
        with pytest.raises(ValueError, match='limit must be an integer'):
            inst.channels_list({'limit': 'ten'})

    def test_channel_history_defaults(self):
        inst = _make_instance()
        inst.channel_history({'channel': 'C-1'})
        inst.IGlobal._slack.channel_history.assert_called_once_with(channel='C-1', limit=None, oldest=None, latest=None)

    def test_channel_history_passes_limit_through_and_coerces_ts(self):
        inst = _make_instance()
        inst.channel_history({'channel': 'C-1', 'limit': 999, 'oldest': 12345.0001, 'latest': '12345.0009'})
        kwargs = inst.IGlobal._slack.channel_history.call_args.kwargs
        assert kwargs['limit'] == 999
        assert kwargs['oldest'] == '12345.0001'
        assert kwargs['latest'] == '12345.0009'

    def test_channel_history_fractional_limit_gets_clean_error(self):
        """End-to-end through a real SlackClient: 2.5 is rejected, not truncated."""
        inst = _make_instance(SlackClient('tool_slack', {'token': TEST_TOKEN}, {}))
        with pytest.raises(ValueError, match='limit must be an integer'):
            inst.channel_history({'channel': 'C-1', 'limit': 2.5})

    def test_channel_history_requires_channel(self):
        inst = _make_instance()
        with pytest.raises(ValueError, match='channel'):
            inst.channel_history({})
        inst.IGlobal._slack.channel_history.assert_not_called()
