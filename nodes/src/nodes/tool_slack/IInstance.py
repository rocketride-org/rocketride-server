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
Slack tool node instance.

Exposes Slack workspace operations as agent tools: connection check, message
posting (channel or thread), public channel listing, and channel history.
All Slack access goes through the shared SlackClient built by IGlobal.
"""

from __future__ import annotations

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input, require_str

from .IGlobal import IGlobal

# ---------------------------------------------------------------------------
# Shared parameter descriptions
# ---------------------------------------------------------------------------
_CHANNEL_DESC = 'Channel ID (e.g. "C0123ABCDEF") or name (e.g. "#general").'
_TS_DESC = 'Slack message timestamp string, e.g. "1712345678.000200".'


def _opt_str(args: dict, key: str) -> str | None:
    """Return ``args[key]`` as a stripped string, or None when absent/empty."""
    value = args.get(key)
    if value is None:
        return None
    value = str(value).strip()
    return value or None


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def _client(self):
        """Return the shared SlackClient or raise when not initialized."""
        client = self.IGlobal._slack
        if client is None:
            raise RuntimeError('tool_slack: Slack client not initialized')
        return client

    # -----------------------------------------------------------------------
    # Tools
    # -----------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {},
        },
        description=(
            'Verify the configured Slack credentials. Returns the workspace name/URL and the '
            'bot identity. Requires a bot token (not available in webhook mode).'
        ),
    )
    def check_connection(self, args):
        normalize_tool_input(args, tool_name='tool_slack')
        return self._client().check_connection()

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['text'],
            'properties': {
                'channel': {
                    'type': 'string',
                    'description': _CHANNEL_DESC + ' Required with a bot token; ignored in webhook mode.',
                },
                'text': {'type': 'string', 'description': 'Message text (Slack mrkdwn is supported).'},
                'thread_ts': {
                    'type': 'string',
                    'description': f'Reply in the thread of this parent message. {_TS_DESC}',
                },
                'unfurl_links': {
                    'type': 'boolean',
                    'description': 'Whether Slack should unfurl links in the message (default: true).',
                },
            },
        },
        description='Post a message to a Slack channel, or reply in a thread via thread_ts.',
    )
    def message_post(self, args):
        args = normalize_tool_input(args, tool_name='tool_slack')
        text = require_str(args, 'text', tool_name='message_post')
        unfurl_links = args.get('unfurl_links')
        return self._client().message_post(
            channel=_opt_str(args, 'channel'),
            text=text,
            thread_ts=_opt_str(args, 'thread_ts'),
            unfurl_links=True if unfurl_links is None else bool(unfurl_links),
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'limit': {
                    'type': 'integer',
                    'description': 'Maximum number of channels to return (1-1000, default 200).',
                },
            },
        },
        description=(
            'List the public channels in the Slack workspace. Pagination is handled '
            'automatically (at most 1000 channels). Requires a bot token.'
        ),
    )
    def channels_list(self, args):
        args = normalize_tool_input(args, tool_name='tool_slack')
        # Defaulting, validation, and the hard cap live in SlackClient so the
        # rules cannot drift between layers; a bad value raises a clean
        # ValueError the agent can self-correct from.
        return self._client().channels_list(limit=args.get('limit'))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['channel'],
            'properties': {
                'channel': {'type': 'string', 'description': _CHANNEL_DESC + ' The bot must be a member.'},
                'limit': {
                    'type': 'integer',
                    'description': 'Maximum number of messages to return (1-200, default 50).',
                },
                'oldest': {'type': 'string', 'description': f'Only messages after this timestamp. {_TS_DESC}'},
                'latest': {'type': 'string', 'description': f'Only messages before this timestamp. {_TS_DESC}'},
            },
        },
        description=(
            'Read recent messages from a Slack channel (newest first, at most 200). '
            'Returns ts, user, and text per message. Requires a bot token.'
        ),
    )
    def channel_history(self, args):
        args = normalize_tool_input(args, tool_name='tool_slack')
        channel = require_str(args, 'channel', tool_name='channel_history')
        # limit is validated/defaulted/capped in SlackClient (see channels_list).
        return self._client().channel_history(
            channel=channel,
            limit=args.get('limit'),
            oldest=_opt_str(args, 'oldest'),
            latest=_opt_str(args, 'latest'),
        )
