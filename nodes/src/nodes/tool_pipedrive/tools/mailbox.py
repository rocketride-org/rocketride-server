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

"""Mailbox tools: mail threads and messages synced into Pipedrive."""

from __future__ import annotations

from ..pipedrive_client import clean_mail_message, clean_mail_thread
from ..tool_groups import pipedrive_tool
from ._base import (
    ENUM,
    INT,
    PAGING,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    params_from,
    require_id,
    schema,
)


class MailboxMixin(PipedriveToolsBase):
    """Tools for the ``mailbox`` group."""

    @pipedrive_tool(
        group='mailbox',
        input_schema=schema(
            folder=ENUM('Mailbox folder to read (default inbox).', ['inbox', 'drafts', 'sent', 'archive']),
            **PAGING(),
        ),
        description='List mail threads in a mailbox folder.',
    )
    def mail_thread_list(self, args):
        args = args_of(args)
        return self._list('/mailbox/mailThreads', args, clean_mail_thread, extra=params_from(args, ('folder',)))

    @pipedrive_tool(
        group='mailbox',
        input_schema=schema(required=['thread_id'], thread_id=INT('Mail thread id.')),
        description='Get a single mail thread.',
    )
    def mail_thread_get(self, args):
        args = args_of(args)
        thread_id = require_id(args, 'thread_id', 'mail_thread_get')
        return self._get(f'/mailbox/mailThreads/{thread_id}', clean_mail_thread)

    @pipedrive_tool(
        group='mailbox',
        input_schema=schema(required=['thread_id'], thread_id=INT('Mail thread id.'), **PAGING()),
        description='List the messages in a mail thread.',
    )
    def mail_thread_messages_list(self, args):
        args = args_of(args)
        thread_id = require_id(args, 'thread_id', 'mail_thread_messages_list')
        return self._list(f'/mailbox/mailThreads/{thread_id}/mailMessages', args, clean_mail_message)

    @pipedrive_tool(
        group='mailbox',
        input_schema=schema(
            required=['thread_id'],
            thread_id=INT('Mail thread id to update.'),
            deal_id=INT('Link the thread to this deal.'),
            lead_id=STR('Link the thread to this lead uuid.'),
            shared_flag=INT('1 to share the thread with the whole company, 0 to keep it private.'),
            read_flag=INT('1 to mark the thread as read, 0 as unread.'),
            archived_flag=INT('1 to archive the thread, 0 to unarchive it.'),
        ),
        description='Link a mail thread to a deal or lead, or change its shared, read and archived flags.',
    )
    def mail_thread_update(self, args):
        args = args_of(args)
        thread_id = require_id(args, 'thread_id', 'mail_thread_update')
        body = body_from(args, ('deal_id', 'lead_id', 'shared_flag', 'read_flag', 'archived_flag'))
        return self._write('PUT', f'/mailbox/mailThreads/{thread_id}', clean_mail_thread, body=body)

    @pipedrive_tool(
        group='mailbox',
        input_schema=schema(required=['thread_id'], thread_id=INT('Mail thread id to delete.')),
        description='Delete a mail thread.',
    )
    def mail_thread_delete(self, args):
        args = args_of(args)
        thread_id = require_id(args, 'thread_id', 'mail_thread_delete')
        return self._delete(f'/mailbox/mailThreads/{thread_id}')

    @pipedrive_tool(
        group='mailbox',
        input_schema=schema(
            required=['message_id'],
            message_id=INT('Mail message id.'),
            include_body=INT('Set to 1 to include the full message body.'),
        ),
        description='Get a single mail message, optionally with its body.',
    )
    def mail_message_get(self, args):
        args = args_of(args)
        message_id = require_id(args, 'message_id', 'mail_message_get')
        return self._get(
            f'/mailbox/mailMessages/{message_id}', clean_mail_message, params=params_from(args, ('include_body',))
        )
