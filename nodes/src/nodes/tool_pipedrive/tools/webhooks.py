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

"""Webhook tools: subscribe an external URL to Pipedrive change events."""

from __future__ import annotations

from ..pipedrive_client import clean_webhook
from ..tool_groups import pipedrive_tool
from ._base import (
    ENUM,
    INT,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    require_id,
    require_text,
    schema,
)


class WebhooksMixin(PipedriveToolsBase):
    """Tools for the ``webhooks`` group."""

    @pipedrive_tool(
        group='webhooks',
        input_schema=schema(),
        description='List the webhooks registered by this API token.',
    )
    def webhook_list(self, args):
        args_of(args)
        data = self._call('GET', '/webhooks')
        return {'items': [clean_webhook(w) for w in (data or [])]}

    @pipedrive_tool(
        group='webhooks',
        input_schema=schema(
            required=['subscription_url', 'event_action', 'event_object'],
            subscription_url=STR('HTTPS endpoint Pipedrive will POST events to. Must answer 2xx within 10 seconds.'),
            event_action=ENUM(
                'Which action to subscribe to. Use "*" for all.', ['added', 'updated', 'merged', 'deleted', '*']
            ),
            event_object=ENUM(
                'Which object to subscribe to. Use "*" for all.',
                [
                    'activity',
                    'activityType',
                    'deal',
                    'note',
                    'organization',
                    'person',
                    'pipeline',
                    'product',
                    'stage',
                    'user',
                    '*',
                ],
            ),
            user_id=INT('Run the webhook as this user (defaults to the token owner).'),
            http_auth_user=STR('Basic-auth username for the subscription URL.'),
            http_auth_password=STR('Basic-auth password for the subscription URL.'),
            version=ENUM('Webhook payload version (default 1.0).', ['1.0', '2.0']),
        ),
        description='Create a webhook subscription.',
    )
    def webhook_create(self, args):
        args = args_of(args)
        require_text(args, 'subscription_url', 'webhook_create')
        require_text(args, 'event_action', 'webhook_create')
        require_text(args, 'event_object', 'webhook_create')
        body = body_from(
            args,
            (
                'subscription_url',
                'event_action',
                'event_object',
                'user_id',
                'http_auth_user',
                'http_auth_password',
                'version',
            ),
        )
        return self._write('POST', '/webhooks', clean_webhook, body=body)

    @pipedrive_tool(
        group='webhooks',
        input_schema=schema(required=['webhook_id'], webhook_id=INT('Webhook id to delete.')),
        description='Delete a webhook subscription.',
    )
    def webhook_delete(self, args):
        args = args_of(args)
        return self._delete(f'/webhooks/{require_id(args, "webhook_id", "webhook_delete")}')
