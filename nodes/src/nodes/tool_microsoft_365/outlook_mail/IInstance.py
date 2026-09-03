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
Outlook Mail tool node instance.

Exposes the Microsoft Graph mail API as agent tools: list/search/read
messages, send mail and replies/forwards, manage drafts, move/organize
messages and folders, manage attachments, and mark read state. Operates on
the acting user's mailbox.

Three access tiers gate the surface (``nodes.core.microsoft_access.OUTLOOK_MAIL``):
``readonly`` (Mail.Read), ``send`` (+ Mail.Send), and ``modify``
(Mail.ReadWrite + Mail.Send, the default). Sending (``send_message``,
``reply``, ``reply_all``, ``forward``) needs the Mail.Send scope — present on
``send`` and ``modify``. Mutating tools (drafts, moves, read/category state,
delete, folders, attachments) need the Mail.ReadWrite scope, which the
``send`` tier does *not* carry despite being nominally "writable" by
``require_write``'s can_write flag — so those tools are additionally guarded
by :func:`_require_modify`. Permanent delete further requires the node's
``allowHardDelete`` flag; without it, delete only moves a message to Deleted
Items.

Operational targets (message id, folder id, attachment id) are always
invoke-time parameters — never node config.
"""

from __future__ import annotations

import base64
import binascii

from rocketlib import tool_function

from ai.common.utils import (
    int_arg,
    normalize_tool_input,
    optional_bool,
    optional_str,
    optional_str_list,
    require_str,
    require_str_list,
)
from nodes.core.microsoft_access import MicrosoftAccessError

from .. import graph_client
from ..IInstance import MicrosoftToolInstanceBase
from .client import (
    ATTACHMENT_SELECT,
    MAX_INLINE_ATTACHMENT_BYTES,
    MAX_TOP,
    MESSAGE_SELECT,
    SERVICE,
    _seg,
    clean_attachment_meta,
    clean_folder,
    clean_message,
    looks_like_odata_filter,
    message_body,
    recipients,
    request,
)
from .IGlobal import IGlobal


def _require_send(access, op: str = 'this operation') -> None:
    """Raise MicrosoftAccessError unless the granted scopes include Mail.Send.

    Guards send-class tools (send_message, reply, reply_all, forward): the
    ``send`` and ``modify`` tiers both grant Mail.Send; ``readonly`` does not.
    """
    if 'Mail.Send' not in access.scopes:
        raise MicrosoftAccessError(
            f"{op} needs the send scope. Raise this node's access to 'send' or 'modify' to enable it."
        )


def _require_modify(access, op: str = 'this operation') -> None:
    """Raise MicrosoftAccessError unless the granted scopes include Mail.ReadWrite.

    Guards modify-class tools (create_draft, move_message, set_read,
    set_categories, delete_message, permanently_delete, create_folder,
    add_attachment). ``require_write`` alone only blocks the ``readonly``
    tier; the ``send`` tier is also nominally writable (``can_write`` is
    False only for ``readonly``) but its scopes (Mail.Read, Mail.Send) lack
    Mail.ReadWrite, so it must be blocked from drafts/moves/etc. here too.
    """
    if 'Mail.ReadWrite' not in access.scopes:
        raise MicrosoftAccessError(f"{op} needs the modify scope. Raise this node's access to 'modify' to enable it.")


class IInstance(MicrosoftToolInstanceBase):
    IGlobal: IGlobal
    SERVICE = SERVICE

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def _base(self) -> str:
        return graph_client.user_base(self.IGlobal.cfg)

    def _msg(self, message_id: str) -> str:
        return f'{self._base()}/messages/{_seg(message_id)}'

    def _folder_path(self, folder_id: str) -> str:
        return f'{self._base()}/mailFolders/{_seg(folder_id)}'

    # =======================================================================
    # DIAGNOSTICS
    # =======================================================================

    @tool_function(
        description=(
            'Check the Outlook Mail/Graph connection and verify that the granted OAuth scopes cover '
            "the node's configured access tier. Call this when an Outlook Mail operation fails with a "
            'scope or permission error. Returns connection_ok: true when the required scopes are present.'
        ),
        input_schema={'type': 'object', 'properties': {}, 'required': []},
    )
    def outlook_mail_check_connection(self, args: dict) -> dict:
        """Check the Outlook Mail connection and whether granted OAuth scopes cover the access tier. Read-only."""
        base = self._base()

        def _probe(auth):
            request(auth, 'GET', f'{base}/mailFolders/inbox')

        return self._check_connection_impl(probe=_probe)

    # =======================================================================
    # MESSAGES — read
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'folder': {
                    'type': 'string',
                    'description': "Mail folder id or well-known name to list, e.g. 'inbox' (default), 'sentitems', 'drafts'",
                },
                'query': {
                    'type': 'string',
                    'description': (
                        'Free-text search (e.g. "invoice from:alice"), or an OData filter expression '
                        '(e.g. "isRead eq false") — detected automatically. Empty lists the most recent messages.'
                    ),
                },
                'top': {'type': 'integer', 'description': f'Max messages to return (1-{MAX_TOP}, default 25)'},
            },
        },
        description='List messages in a mail folder (inbox by default), optionally filtered by search text or an OData filter.',
    )
    def outlook_mail_list_messages(self, args: dict) -> dict:
        """List messages in a mail folder (inbox by default). Read-only."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        folder = optional_str(args, 'folder', default='inbox', tool_name='outlook_mail_list_messages') or 'inbox'
        query = optional_str(args, 'query', default='', tool_name='outlook_mail_list_messages') or ''
        top = int_arg(args, 'top', default=25, lo=1, hi=MAX_TOP, tool_name='outlook_mail_list_messages')
        params: dict = {'$top': top, '$select': MESSAGE_SELECT}
        if query:
            if looks_like_odata_filter(query):
                params['$filter'] = query
            else:
                # Graph's $search is a quoted KQL phrase; a literal double quote
                # inside it must be backslash-escaped or it ends the phrase early.
                params['$search'] = '"{}"'.format(query.replace('"', '\\"'))
        data = request(self.IGlobal.auth, 'GET', f'{self._folder_path(folder)}/messages', params=params)
        return {'messages': [clean_message(m) for m in data.get('value') or []]}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['message_id'],
            'properties': {
                'message_id': {'type': 'string', 'description': 'Message id'},
            },
        },
        description='Get a single message, including its full body (HTML bodies are converted to readable text).',
    )
    def outlook_mail_get_message(self, args: dict) -> dict:
        """Get a single message with its full body. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        message_id = require_str(args, 'message_id', tool_name='outlook_mail_get_message')
        data = request(self.IGlobal.auth, 'GET', self._msg(message_id))
        return clean_message(data, full=True)

    # =======================================================================
    # SEND / DRAFT / REPLY / FORWARD
    # =======================================================================

    _COMPOSE_SCHEMA_PROPERTIES = {
        'to': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Recipient email addresses'},
        'subject': {'type': 'string', 'description': 'Subject line'},
        'body': {'type': 'string', 'description': 'Message body'},
        'cc': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Cc recipient email addresses'},
        'bcc': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Bcc recipient email addresses'},
        'html': {'type': 'boolean', 'description': 'Treat "body" as HTML (default false, plain text)'},
    }

    def _compose_message(self, args: dict, op: str) -> dict:
        """Build a Graph ``message`` body from the shared compose args."""
        to = require_str_list(args, 'to', tool_name=op)
        subject = require_str(args, 'subject', tool_name=op)
        body = require_str(args, 'body', tool_name=op)
        cc = optional_str_list(args, 'cc', default=[], tool_name=op) or []
        bcc = optional_str_list(args, 'bcc', default=[], tool_name=op) or []
        html = optional_bool(args, 'html', default=False, tool_name=op)
        return message_body(subject, body, to, cc, bcc, bool(html))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['to', 'subject', 'body'],
            'properties': _COMPOSE_SCHEMA_PROPERTIES,
        },
        description='Send an email immediately. Requires the send or modify tier (Mail.Send scope).',
    )
    def outlook_mail_send_message(self, args: dict) -> dict:
        """Send an email immediately. Requires the send or modify tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        _require_send(self.IGlobal.access, 'outlook_mail_send_message')
        message = self._compose_message(args, 'outlook_mail_send_message')
        request(
            self.IGlobal.auth,
            'POST',
            f'{self._base()}/sendMail',
            json_body={'message': message, 'saveToSentItems': True},
        )
        return {
            'sent': True,
            'to': [r['emailAddress']['address'] for r in message['toRecipients']],
            'subject': message['subject'],
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['to', 'subject', 'body'],
            'properties': _COMPOSE_SCHEMA_PROPERTIES,
        },
        description='Create a draft message (not sent). Requires the modify tier.',
    )
    def outlook_mail_create_draft(self, args: dict) -> dict:
        """Create a draft message. Requires the modify tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        self.IGlobal.access.require_write('outlook_mail_create_draft')
        _require_modify(self.IGlobal.access, 'outlook_mail_create_draft')
        message = self._compose_message(args, 'outlook_mail_create_draft')
        data = request(self.IGlobal.auth, 'POST', f'{self._base()}/messages', json_body=message)
        return clean_message(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['message_id'],
            'properties': {
                'message_id': {'type': 'string', 'description': 'Message id to reply to'},
                'comment': {'type': 'string', 'description': 'Reply body text'},
            },
        },
        description="Reply to a message's sender only. Requires the send or modify tier.",
    )
    def outlook_mail_reply(self, args: dict) -> dict:
        """Reply to a message's sender only. Requires the send or modify tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        _require_send(self.IGlobal.access, 'outlook_mail_reply')
        message_id = require_str(args, 'message_id', tool_name='outlook_mail_reply')
        comment = optional_str(args, 'comment', default='', tool_name='outlook_mail_reply') or ''
        request(self.IGlobal.auth, 'POST', f'{self._msg(message_id)}/reply', json_body={'comment': comment})
        return {'replied': message_id}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['message_id'],
            'properties': {
                'message_id': {'type': 'string', 'description': 'Message id to reply to'},
                'comment': {'type': 'string', 'description': 'Reply body text'},
            },
        },
        description='Reply to all recipients of a message. Requires the send or modify tier.',
    )
    def outlook_mail_reply_all(self, args: dict) -> dict:
        """Reply to all recipients of a message. Requires the send or modify tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        _require_send(self.IGlobal.access, 'outlook_mail_reply_all')
        message_id = require_str(args, 'message_id', tool_name='outlook_mail_reply_all')
        comment = optional_str(args, 'comment', default='', tool_name='outlook_mail_reply_all') or ''
        request(self.IGlobal.auth, 'POST', f'{self._msg(message_id)}/replyAll', json_body={'comment': comment})
        return {'repliedAll': message_id}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['message_id', 'to'],
            'properties': {
                'message_id': {'type': 'string', 'description': 'Message id to forward'},
                'comment': {'type': 'string', 'description': 'Note to include above the forwarded message'},
                'to': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Recipient email addresses'},
            },
        },
        description='Forward a message to new recipients. Requires the send or modify tier.',
    )
    def outlook_mail_forward(self, args: dict) -> dict:
        """Forward a message to new recipients. Requires the send or modify tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        _require_send(self.IGlobal.access, 'outlook_mail_forward')
        message_id = require_str(args, 'message_id', tool_name='outlook_mail_forward')
        to = require_str_list(args, 'to', tool_name='outlook_mail_forward')
        comment = optional_str(args, 'comment', default='', tool_name='outlook_mail_forward') or ''
        request(
            self.IGlobal.auth,
            'POST',
            f'{self._msg(message_id)}/forward',
            json_body={'comment': comment, 'toRecipients': recipients(to)},
        )
        return {'forwarded': message_id, 'to': to}

    # =======================================================================
    # ORGANIZE — move, read state, categories (modify)
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['message_id', 'folder'],
            'properties': {
                'message_id': {'type': 'string', 'description': 'Message id to move'},
                'folder': {
                    'type': 'string',
                    'description': "Destination mail folder id or well-known name, e.g. 'archive'",
                },
            },
        },
        description='Move a message to another mail folder. Requires the modify tier.',
    )
    def outlook_mail_move_message(self, args: dict) -> dict:
        """Move a message to another mail folder. Requires the modify tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        self.IGlobal.access.require_write('outlook_mail_move_message')
        _require_modify(self.IGlobal.access, 'outlook_mail_move_message')
        message_id = require_str(args, 'message_id', tool_name='outlook_mail_move_message')
        folder = require_str(args, 'folder', tool_name='outlook_mail_move_message')
        data = request(self.IGlobal.auth, 'POST', f'{self._msg(message_id)}/move', json_body={'destinationId': folder})
        return clean_message(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['message_id'],
            'properties': {
                'message_id': {'type': 'string', 'description': 'Message id'},
                'read': {'type': 'boolean', 'description': 'True to mark read (default), false to mark unread'},
            },
        },
        description='Mark a message read or unread. Requires the modify tier.',
    )
    def outlook_mail_set_read(self, args: dict) -> dict:
        """Mark a message read or unread. Requires the modify tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        self.IGlobal.access.require_write('outlook_mail_set_read')
        _require_modify(self.IGlobal.access, 'outlook_mail_set_read')
        message_id = require_str(args, 'message_id', tool_name='outlook_mail_set_read')
        read = optional_bool(args, 'read', default=True, tool_name='outlook_mail_set_read')
        data = request(self.IGlobal.auth, 'PATCH', self._msg(message_id), json_body={'isRead': bool(read)})
        return clean_message(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['message_id', 'categories'],
            'properties': {
                'message_id': {'type': 'string', 'description': 'Message id'},
                'categories': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Category names to set (replaces any existing categories; pass [] to clear)',
                },
            },
        },
        description='Set the category labels on a message, replacing any existing categories. Requires the modify tier.',
    )
    def outlook_mail_set_categories(self, args: dict) -> dict:
        """Set (replace) the category labels on a message. Requires the modify tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        self.IGlobal.access.require_write('outlook_mail_set_categories')
        _require_modify(self.IGlobal.access, 'outlook_mail_set_categories')
        message_id = require_str(args, 'message_id', tool_name='outlook_mail_set_categories')
        categories = args.get('categories')
        if not isinstance(categories, list) or not all(isinstance(c, str) for c in categories):
            raise ValueError('outlook_mail_set_categories: "categories" must be a list of strings')
        data = request(self.IGlobal.auth, 'PATCH', self._msg(message_id), json_body={'categories': categories})
        return clean_message(data)

    # =======================================================================
    # DELETE — soft (modify) / permanent (modify + allowHardDelete)
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['message_id'],
            'properties': {
                'message_id': {'type': 'string', 'description': 'Message id to delete'},
            },
        },
        description=(
            'Move a message to Deleted Items (recoverable). Requires the modify tier. Use '
            'outlook_mail_permanently_delete for an irreversible delete.'
        ),
    )
    def outlook_mail_delete_message(self, args: dict) -> dict:
        """Move a message to Deleted Items (recoverable). Requires the modify tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        self.IGlobal.access.require_write('outlook_mail_delete_message')
        _require_modify(self.IGlobal.access, 'outlook_mail_delete_message')
        message_id = require_str(args, 'message_id', tool_name='outlook_mail_delete_message')
        request(self.IGlobal.auth, 'POST', f'{self._msg(message_id)}/move', json_body={'destinationId': 'deleteditems'})
        return {'deleted': message_id, 'permanently': False}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['message_id'],
            'properties': {
                'message_id': {'type': 'string', 'description': 'Message id to permanently delete'},
            },
        },
        description=(
            'Permanently delete a message, bypassing Deleted Items — irreversible. Requires the modify '
            "tier and the node's allowHardDelete flag; outlook_mail_delete_message is the recoverable alternative."
        ),
    )
    def outlook_mail_permanently_delete(self, args: dict) -> dict:
        """Permanently delete a message, bypassing Deleted Items. Requires modify + allowHardDelete."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        self.IGlobal.access.require_write('outlook_mail_permanently_delete')
        _require_modify(self.IGlobal.access, 'outlook_mail_permanently_delete')
        message_id = require_str(args, 'message_id', tool_name='outlook_mail_permanently_delete')
        self.IGlobal.access.require_flag('allowHardDelete', 'outlook_mail_permanently_delete')
        request(self.IGlobal.auth, 'DELETE', self._msg(message_id))
        return {'permanentlyDeleted': message_id}

    # =======================================================================
    # FOLDERS
    # =======================================================================

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description='List the top-level mail folders in the mailbox (inbox, sent items, drafts, custom folders, etc.).',
    )
    def outlook_mail_list_folders(self, args: dict) -> dict:
        """List the top-level mail folders in the mailbox. Read-only."""
        normalize_tool_input(args, tool_name='tool_outlook_mail')
        data = request(self.IGlobal.auth, 'GET', f'{self._base()}/mailFolders', params={'$top': 100})
        return {'folders': [clean_folder(f) for f in data.get('value') or []]}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['name'],
            'properties': {
                'name': {'type': 'string', 'description': 'Name for the new folder'},
                'parent': {
                    'type': 'string',
                    'description': 'Parent folder id; empty/omitted creates a top-level folder',
                },
            },
        },
        description='Create a new mail folder, optionally nested inside a parent folder. Requires the modify tier.',
    )
    def outlook_mail_create_folder(self, args: dict) -> dict:
        """Create a new mail folder, optionally nested inside a parent. Requires the modify tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        self.IGlobal.access.require_write('outlook_mail_create_folder')
        _require_modify(self.IGlobal.access, 'outlook_mail_create_folder')
        name = require_str(args, 'name', tool_name='outlook_mail_create_folder')
        parent = optional_str(args, 'parent', default='', tool_name='outlook_mail_create_folder') or ''
        path = f'{self._folder_path(parent)}/childFolders' if parent else f'{self._base()}/mailFolders'
        data = request(self.IGlobal.auth, 'POST', path, json_body={'displayName': name})
        return clean_folder(data)

    # =======================================================================
    # ATTACHMENTS
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['message_id'],
            'properties': {
                'message_id': {'type': 'string', 'description': 'Message id'},
            },
        },
        description='List attachment metadata (id, name, contentType, size) on a message. Read-only.',
    )
    def outlook_mail_list_attachments(self, args: dict) -> dict:
        """List attachment metadata on a message. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        message_id = require_str(args, 'message_id', tool_name='outlook_mail_list_attachments')
        data = request(
            self.IGlobal.auth, 'GET', f'{self._msg(message_id)}/attachments', params={'$select': ATTACHMENT_SELECT}
        )
        return {'attachments': [clean_attachment_meta(a) for a in data.get('value') or []]}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['message_id', 'attachment_id'],
            'properties': {
                'message_id': {'type': 'string', 'description': 'Message id the attachment belongs to'},
                'attachment_id': {
                    'type': 'string',
                    'description': 'Attachment id (from outlook_mail_list_attachments)',
                },
            },
        },
        description="Download an attachment's content by message and attachment id. Returns name, contentType, and base64 content.",
    )
    def outlook_mail_get_attachment(self, args: dict) -> dict:
        """Download an attachment's content (base64) by message and attachment id. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        message_id = require_str(args, 'message_id', tool_name='outlook_mail_get_attachment')
        attachment_id = require_str(args, 'attachment_id', tool_name='outlook_mail_get_attachment')
        data = request(self.IGlobal.auth, 'GET', f'{self._msg(message_id)}/attachments/{_seg(attachment_id)}')
        return {
            'name': data.get('name'),
            'contentType': data.get('contentType'),
            'content_base64': data.get('contentBytes'),
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['message_id', 'name', 'content_base64'],
            'properties': {
                'message_id': {'type': 'string', 'description': 'Draft message id to attach the file to'},
                'name': {'type': 'string', 'description': 'File name for the attachment'},
                'content_base64': {'type': 'string', 'description': 'File content, base64-encoded'},
            },
        },
        description=(
            'Add a file attachment to a draft message. Only works on drafts (create one with '
            'outlook_mail_create_draft first). Requires the modify tier.'
        ),
    )
    def outlook_mail_add_attachment(self, args: dict) -> dict:
        """Add a file attachment to a draft message. Requires the modify tier."""
        args = normalize_tool_input(args, tool_name='tool_outlook_mail')
        self.IGlobal.access.require_write('outlook_mail_add_attachment')
        _require_modify(self.IGlobal.access, 'outlook_mail_add_attachment')
        message_id = require_str(args, 'message_id', tool_name='outlook_mail_add_attachment')
        name = require_str(args, 'name', tool_name='outlook_mail_add_attachment')
        content_b64 = require_str(args, 'content_base64', tool_name='outlook_mail_add_attachment')
        try:
            decoded = base64.b64decode(content_b64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError(f'outlook_mail_add_attachment: "content_base64" is not valid base64 ({exc})') from exc
        if len(decoded) >= MAX_INLINE_ATTACHMENT_BYTES:
            raise ValueError(
                f'outlook_mail_add_attachment: attachment is {len(decoded)} bytes; Graph accepts inline '
                f'fileAttachments only below {MAX_INLINE_ATTACHMENT_BYTES} bytes (3 MB). Larger files need '
                'a Graph upload session, which this tool does not support — attach a smaller file.'
            )
        data = request(
            self.IGlobal.auth,
            'POST',
            f'{self._msg(message_id)}/attachments',
            json_body={'@odata.type': '#microsoft.graph.fileAttachment', 'name': name, 'contentBytes': content_b64},
        )
        return clean_attachment_meta(data)
