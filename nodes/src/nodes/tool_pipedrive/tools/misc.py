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

"""Account-level odds and ends: currencies, billing add-ons, meeting links and channels."""

from __future__ import annotations

from ..tool_groups import pipedrive_tool
from ._base import (
    ARR,
    BOOL,
    INT,
    OBJ,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    params_from,
    passthrough,
    path_segment,
    require_text,
    schema,
)


class MiscMixin(PipedriveToolsBase):
    """Tools for the ``misc`` group."""

    @pipedrive_tool(
        group='misc',
        input_schema=schema(term=STR('Only currencies whose code or name matches this text.')),
        description='List the currencies supported by the account, with their ids and decimal precision.',
    )
    def currency_list(self, args):
        args = args_of(args)
        data = self._call('GET', '/currencies', params=params_from(args, ('term',)))
        return {'items': list(data or [])}

    @pipedrive_tool(
        group='misc',
        input_schema=schema(),
        description='List the billing add-ons the company has subscribed to.',
    )
    def billing_addons_list(self, args):
        args_of(args)
        data = self._call('GET', '/billing/subscriptions/addons')
        return {'items': list(data or [])}

    @pipedrive_tool(
        group='misc',
        input_schema=schema(
            required=['user_provider_id', 'user_id', 'company_id', 'marketplace_client_id'],
            user_provider_id=STR('Uuid of the link between the user and the video-call provider.'),
            user_id=INT('Pipedrive user id.'),
            company_id=INT('Pipedrive company id.'),
            marketplace_client_id=STR('Client id issued to the video-call app in the marketplace.'),
        ),
        description='Link a Pipedrive user to a video-calling provider so meeting links can be generated.',
    )
    def meeting_link_create(self, args):
        args = args_of(args)
        for key in ('user_provider_id', 'marketplace_client_id'):
            require_text(args, key, 'meeting_link_create')
        body = body_from(args, ('user_provider_id', 'user_id', 'company_id', 'marketplace_client_id'))
        return self._write('POST', '/meetings/userProviderLinks', passthrough, body=body)

    @pipedrive_tool(
        group='misc',
        input_schema=schema(required=['link_id'], link_id=STR('User provider link uuid to delete.')),
        description='Remove the link between a Pipedrive user and a video-calling provider.',
    )
    def meeting_link_delete(self, args):
        args = args_of(args)
        link_id = require_text(args, 'link_id', 'meeting_link_delete')
        return self._delete(f'/meetings/userProviderLinks/{path_segment(link_id)}')

    @pipedrive_tool(
        group='misc',
        input_schema=schema(
            required=['name', 'provider_channel_id'],
            name=STR('Channel name shown in Pipedrive.'),
            provider_channel_id=STR('Id of the channel in the external messaging provider.'),
            avatar_url=STR('Channel avatar image URL.'),
            template_support=BOOL('Whether the provider supports message templates.'),
            provider_type=STR('Provider type, e.g. "whatsapp" or "other".'),
        ),
        description='Register a messaging channel so an external inbox can appear in Pipedrive.',
    )
    def channel_create(self, args):
        args = args_of(args)
        require_text(args, 'name', 'channel_create')
        require_text(args, 'provider_channel_id', 'channel_create')
        body = body_from(args, ('name', 'provider_channel_id', 'avatar_url', 'template_support', 'provider_type'))
        return self._write('POST', '/channels', passthrough, body=body)

    @pipedrive_tool(
        group='misc',
        input_schema=schema(required=['channel_id'], channel_id=STR('Channel id to delete.')),
        description='Delete a messaging channel.',
    )
    def channel_delete(self, args):
        args = args_of(args)
        channel_id = require_text(args, 'channel_id', 'channel_delete')
        return self._delete(f'/channels/{path_segment(channel_id)}')

    @pipedrive_tool(
        group='misc',
        input_schema=schema(
            required=['id', 'channel_id', 'sender_id', 'conversation_id', 'message', 'status', 'created_at'],
            id=STR('Message id in the provider.'),
            channel_id=STR('Channel the message belongs to.'),
            sender_id=STR('Sender id in the provider.'),
            conversation_id=STR('Conversation the message belongs to.'),
            message=STR('Message body.'),
            status=STR('Message status: sent, delivered, read or failed.'),
            created_at=STR('Message timestamp, RFC3339 UTC.'),
            reply_by=STR('Deadline for a reply, RFC3339 UTC.'),
            conversation_link=STR('Deep link back to the conversation in the provider.'),
            attachments=ARR('Attachments, e.g. [{"id": "1", "type": "image/png", "url": "..."}].', 'object'),
            extra=OBJ('Any additional message fields to send verbatim.'),
        ),
        description='Deliver an inbound message from an external messaging provider into a Pipedrive channel.',
    )
    def channel_message_receive(self, args):
        args = args_of(args)
        for key in ('id', 'channel_id', 'sender_id', 'conversation_id', 'message', 'status', 'created_at'):
            require_text(args, key, 'channel_message_receive')
        body = body_from(
            args,
            (
                'id',
                'channel_id',
                'sender_id',
                'conversation_id',
                'message',
                'status',
                'created_at',
                'reply_by',
                'conversation_link',
                'attachments',
            ),
        )
        return self._write('POST', '/channels/messages/receive', passthrough, body=body)

    @pipedrive_tool(
        group='misc',
        input_schema=schema(
            required=['channel_id', 'conversation_id'],
            channel_id=STR('Channel id.'),
            conversation_id=STR('Conversation id to delete.'),
        ),
        description='Delete a conversation from a messaging channel.',
    )
    def channel_conversation_delete(self, args):
        args = args_of(args)
        channel_id = require_text(args, 'channel_id', 'channel_conversation_delete')
        conversation_id = require_text(args, 'conversation_id', 'channel_conversation_delete')
        return self._delete(f'/channels/{path_segment(channel_id)}/conversations/{path_segment(conversation_id)}')
