"""
Mock slack_sdk package for tool_slack node integration tests.

When ROCKETRIDE_MOCK is set, this replaces the real slack_sdk so dynamic
node tests do not call the Slack API. Mirrors the pieces tool_slack imports:
``slack_sdk.WebClient``, ``slack_sdk.errors.SlackApiError``, and
``slack_sdk.webhook.WebhookClient``.
"""

from . import errors, webhook
from .webhook import WebhookClient

_MOCK_CHANNELS = [
    {'id': 'C-MOCK-1', 'name': 'general', 'is_private': False, 'is_archived': False, 'num_members': 3},
    {'id': 'C-MOCK-2', 'name': 'random', 'is_private': False, 'is_archived': False, 'num_members': 2},
    {'id': 'C-MOCK-3', 'name': 'dev', 'is_private': False, 'is_archived': False, 'num_members': 1},
]

_MOCK_MESSAGES = [
    {'ts': '12345.0002', 'user': 'U-MOCK', 'text': 'mock message 2'},
    {'ts': '12345.0001', 'user': 'U-MOCK', 'text': 'mock message 1'},
]


class WebClient:
    """Mock Slack WebClient with deterministic responses (plain dicts)."""

    def __init__(self, token=None, **kwargs):
        """Store the configured token for parity with the real client."""
        self.token = token

    def auth_test(self, **kwargs):
        """Mirror auth.test: return workspace and bot identity."""
        return {
            'ok': True,
            'url': 'https://mock.slack.com/',
            'team': 'Mock Workspace',
            'team_id': 'T-MOCK',
            'user': 'mock-bot',
            'user_id': 'U-MOCK',
            'bot_id': 'B-MOCK',
        }

    def chat_postMessage(self, channel=None, text=None, thread_ts=None, unfurl_links=True, **kwargs):
        """Mirror chat.postMessage: echo the channel/text back."""
        message = {'text': text, 'ts': '12345.6789'}
        if thread_ts:
            message['thread_ts'] = thread_ts
        return {'ok': True, 'channel': channel or 'C-MOCK-1', 'ts': '12345.6789', 'message': message}

    def conversations_list(self, types=None, limit=100, cursor=None, **kwargs):
        """Mirror conversations.list: a single page of public channels."""
        count = limit if isinstance(limit, int) and limit > 0 else len(_MOCK_CHANNELS)
        return {
            'ok': True,
            'channels': [dict(ch) for ch in _MOCK_CHANNELS[:count]],
            'response_metadata': {'next_cursor': ''},
        }

    def conversations_history(self, channel=None, limit=100, oldest=None, latest=None, cursor=None, **kwargs):
        """Mirror conversations.history: a fixed page of messages, newest first."""
        count = limit if isinstance(limit, int) and limit > 0 else len(_MOCK_MESSAGES)
        return {
            'ok': True,
            'messages': [dict(msg) for msg in _MOCK_MESSAGES[:count]],
            'has_more': False,
            'response_metadata': {'next_cursor': ''},
        }


__all__ = ['WebClient', 'WebhookClient', 'errors', 'webhook']
