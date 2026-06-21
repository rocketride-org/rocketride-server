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
Gmail tool node instance.

Exposes the Gmail v1 surface as agent tools: messages, threads, labels, drafts,
attachments, and incremental history. Write operations require a writable tier;
sending requires the send scope; permanent delete is gated behind the
``allowHardDelete`` flag and the ``full`` tier (https://mail.google.com/).

Operational targets (messageId, threadId, labelId, query) are always invoke-time
parameters — never node config.
"""

from __future__ import annotations

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input, require_str
from nodes.core.google_access import GoogleAccessError

from .gmail_client import (
    MAX_BATCH,
    USER_ID,
    build_raw_message,
    clean_attachment,
    clean_draft,
    clean_history,
    clean_label,
    clean_message,
    clean_ref,
    clean_thread,
    execute,
)
from .IGlobal import IGlobal

_GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
_GMAIL_FULL_SCOPE = 'https://mail.google.com/'


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def _svc(self):
        return self.IGlobal.service

    def _access(self):
        return self.IGlobal.access

    def _require_send(self, op: str) -> None:
        scopes = self._access().scopes
        if _GMAIL_FULL_SCOPE not in scopes and _GMAIL_SEND_SCOPE not in scopes:
            raise GoogleAccessError(
                f"{op} needs the send scope. Set access to 'send' or 'full' on this node to enable it."
            )

    def _require_hard_delete(self, op: str) -> None:
        # Explicit opt-in flag first, then the scope that can actually delete.
        self._access().require_flag('allowHardDelete', op)
        if _GMAIL_FULL_SCOPE not in self._access().scopes:
            raise GoogleAccessError(
                f"{op} permanently deletes mail and needs the full mailbox scope. Set access to 'full' on this node."
            )

    @staticmethod
    def _id_list(args: dict, key: str, op: str) -> list[str]:
        ids = args.get(key)
        if not isinstance(ids, list) or not ids:
            raise ValueError(f'{op}: "{key}" must be a non-empty list of message ids')
        if not all(isinstance(i, str) and i.strip() for i in ids):
            raise ValueError(f'{op}: "{key}" must contain only message-id strings')
        if len(ids) > MAX_BATCH:
            raise ValueError(f'{op}: at most {MAX_BATCH} ids per call (got {len(ids)})')
        return ids

    # =======================================================================
    # MESSAGES — read
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': 'Gmail search query, e.g. "from:alice is:unread"'},
                'labelIds': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Restrict to these label ids',
                },
                'maxResults': {'type': 'integer', 'description': 'Max messages to return (1–500, default 25)'},
                'pageToken': {'type': 'string', 'description': 'Page token from a previous call'},
                'includeSpamTrash': {'type': 'boolean', 'description': 'Include SPAM and TRASH (default false)'},
            },
        },
        description='List message ids in the mailbox, optionally filtered by a Gmail query or labels.',
    )
    def message_list(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        params = {
            'userId': USER_ID,
            'q': args.get('query'),
            'labelIds': args.get('labelIds'),
            'maxResults': max(1, min(int(args.get('maxResults') or 25), 500)),
            'pageToken': args.get('pageToken'),
            'includeSpamTrash': bool(args.get('includeSpamTrash', False)),
        }
        data = execute(self._svc().users().messages().list(**{k: v for k, v in params.items() if v is not None}))
        return {
            'messages': [clean_ref(m) for m in (data.get('messages') or [])],
            'nextPageToken': data.get('nextPageToken'),
            'resultSizeEstimate': data.get('resultSizeEstimate'),
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
            'properties': {
                'query': {'type': 'string', 'description': 'Gmail search query syntax'},
                'maxResults': {'type': 'integer', 'description': 'Max messages to return (1–500, default 25)'},
                'pageToken': {'type': 'string', 'description': 'Page token from a previous call'},
            },
        },
        description='Search messages using Gmail query syntax. Returns matching message ids.',
    )
    def message_search(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        require_str(args, 'query', tool_name='message_search')
        return self.message_list(args)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {
                'id': {'type': 'string', 'description': 'Message id'},
                'format': {
                    'type': 'string',
                    'enum': ['full', 'metadata', 'minimal'],
                    'description': 'Detail level (default full)',
                },
            },
        },
        description='Get a single message: ids, labels, snippet, and key headers.',
    )
    def message_get(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        mid = require_str(args, 'id', tool_name='message_get')
        fmt = args.get('format') or 'full'
        data = execute(self._svc().users().messages().get(userId=USER_ID, id=mid, format=fmt))
        return clean_message(data)

    # =======================================================================
    # MESSAGES — organize (write)
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {
                'id': {'type': 'string', 'description': 'Message id'},
                'addLabelIds': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Label ids to add'},
                'removeLabelIds': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Label ids to remove'},
            },
        },
        description='Add or remove labels on a message. Use the UNREAD label to change read state.',
    )
    def message_modify(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('message_modify')
        mid = require_str(args, 'id', tool_name='message_modify')
        body = {k: args[k] for k in ('addLabelIds', 'removeLabelIds') if args.get(k)}
        if not body:
            raise ValueError('message_modify: provide addLabelIds and/or removeLabelIds')
        data = execute(self._svc().users().messages().modify(userId=USER_ID, id=mid, body=body))
        return clean_message(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['ids'],
            'properties': {
                'ids': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Explicit message ids'},
                'addLabelIds': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Label ids to add'},
                'removeLabelIds': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Label ids to remove'},
            },
        },
        description=f'Add or remove labels on up to {MAX_BATCH} messages by explicit id list (never a query).',
    )
    def message_batch_modify(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('message_batch_modify')
        ids = self._id_list(args, 'ids', 'message_batch_modify')
        body: dict = {'ids': ids}
        for k in ('addLabelIds', 'removeLabelIds'):
            if args.get(k):
                body[k] = args[k]
        if 'addLabelIds' not in body and 'removeLabelIds' not in body:
            raise ValueError('message_batch_modify: provide addLabelIds and/or removeLabelIds')
        execute(self._svc().users().messages().batchModify(userId=USER_ID, body=body))
        return {'modified': len(ids)}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['messageId', 'labelIds'],
            'properties': {
                'messageId': {'type': 'string', 'description': 'Message id'},
                'labelIds': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Label ids to apply'},
            },
        },
        description='Apply (add) labels to a message.',
    )
    def label_apply(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('label_apply')
        mid = require_str(args, 'messageId', tool_name='label_apply')
        labels = self._id_list(args, 'labelIds', 'label_apply')
        data = execute(self._svc().users().messages().modify(userId=USER_ID, id=mid, body={'addLabelIds': labels}))
        return clean_message(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['messageId', 'labelIds'],
            'properties': {
                'messageId': {'type': 'string', 'description': 'Message id'},
                'labelIds': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Label ids to remove'},
            },
        },
        description='Remove labels from a message.',
    )
    def label_remove(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('label_remove')
        mid = require_str(args, 'messageId', tool_name='label_remove')
        labels = self._id_list(args, 'labelIds', 'label_remove')
        data = execute(self._svc().users().messages().modify(userId=USER_ID, id=mid, body={'removeLabelIds': labels}))
        return clean_message(data)

    # =======================================================================
    # THREADS
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {
                'id': {'type': 'string', 'description': 'Thread id'},
                'format': {'type': 'string', 'enum': ['full', 'metadata', 'minimal'], 'description': 'Detail level'},
            },
        },
        description='Get a thread and its messages.',
    )
    def thread_get(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        tid = require_str(args, 'id', tool_name='thread_get')
        fmt = args.get('format') or 'full'
        data = execute(self._svc().users().threads().get(userId=USER_ID, id=tid, format=fmt))
        return clean_thread(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': 'Gmail search query'},
                'labelIds': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Restrict to these labels'},
                'maxResults': {'type': 'integer', 'description': 'Max threads (1–500, default 25)'},
                'pageToken': {'type': 'string', 'description': 'Page token from a previous call'},
            },
        },
        description='List threads, optionally filtered by query or labels.',
    )
    def thread_list(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        params = {
            'userId': USER_ID,
            'q': args.get('query'),
            'labelIds': args.get('labelIds'),
            'maxResults': max(1, min(int(args.get('maxResults') or 25), 500)),
            'pageToken': args.get('pageToken'),
        }
        data = execute(self._svc().users().threads().list(**{k: v for k, v in params.items() if v is not None}))
        return {
            'threads': [
                {'id': t.get('id'), 'historyId': t.get('historyId'), 'snippet': t.get('snippet')}
                for t in (data.get('threads') or [])
            ],
            'nextPageToken': data.get('nextPageToken'),
            'resultSizeEstimate': data.get('resultSizeEstimate'),
        }

    # =======================================================================
    # LABELS
    # =======================================================================

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description='List all labels in the mailbox.',
    )
    def label_list(self, args):
        normalize_tool_input(args, tool_name='tool_gmail')
        data = execute(self._svc().users().labels().list(userId=USER_ID))
        return [clean_label(label) for label in (data.get('labels') or [])]

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['name'],
            'properties': {
                'name': {'type': 'string', 'description': 'Label name (e.g. "Team/Invoices")'},
                'labelListVisibility': {
                    'type': 'string',
                    'enum': ['labelShow', 'labelShowIfUnread', 'labelHide'],
                    'description': 'Sidebar visibility',
                },
                'messageListVisibility': {
                    'type': 'string',
                    'enum': ['show', 'hide'],
                    'description': 'Message-list visibility',
                },
            },
        },
        description='Create a new label.',
    )
    def label_create(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('label_create')
        body = {'name': require_str(args, 'name', tool_name='label_create')}
        for k in ('labelListVisibility', 'messageListVisibility'):
            if args.get(k):
                body[k] = args[k]
        return clean_label(execute(self._svc().users().labels().create(userId=USER_ID, body=body)))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {
                'id': {'type': 'string', 'description': 'Label id'},
                'name': {'type': 'string', 'description': 'New label name'},
                'labelListVisibility': {
                    'type': 'string',
                    'enum': ['labelShow', 'labelShowIfUnread', 'labelHide'],
                    'description': 'Sidebar visibility',
                },
                'messageListVisibility': {'type': 'string', 'enum': ['show', 'hide'], 'description': 'List visibility'},
            },
        },
        description='Update an existing label (name and/or visibility).',
    )
    def label_update(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('label_update')
        lid = require_str(args, 'id', tool_name='label_update')
        body = {k: args[k] for k in ('name', 'labelListVisibility', 'messageListVisibility') if args.get(k)}
        if not body:
            raise ValueError('label_update: provide at least one field to update')
        return clean_label(execute(self._svc().users().labels().patch(userId=USER_ID, id=lid, body=body)))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Label id to delete'}},
        },
        description='Delete a label. Messages keep existing; only the label is removed.',
    )
    def label_delete(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('label_delete')
        lid = require_str(args, 'id', tool_name='label_delete')
        execute(self._svc().users().labels().delete(userId=USER_ID, id=lid))
        return {'deleted': True, 'id': lid}

    # =======================================================================
    # DRAFTS
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'maxResults': {'type': 'integer', 'description': 'Max drafts (1–500, default 25)'},
                'pageToken': {'type': 'string', 'description': 'Page token from a previous call'},
            },
        },
        description='List drafts.',
    )
    def draft_list(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        params = {
            'userId': USER_ID,
            'maxResults': max(1, min(int(args.get('maxResults') or 25), 500)),
            'pageToken': args.get('pageToken'),
        }
        data = execute(self._svc().users().drafts().list(**{k: v for k, v in params.items() if v is not None}))
        return {
            'drafts': [{'id': d.get('id'), 'message': clean_ref(d.get('message'))} for d in (data.get('drafts') or [])],
            'nextPageToken': data.get('nextPageToken'),
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {
                'id': {'type': 'string', 'description': 'Draft id'},
                'format': {'type': 'string', 'enum': ['full', 'metadata', 'minimal'], 'description': 'Detail level'},
            },
        },
        description='Get a single draft.',
    )
    def draft_get(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        did = require_str(args, 'id', tool_name='draft_get')
        fmt = args.get('format') or 'full'
        return clean_draft(execute(self._svc().users().drafts().get(userId=USER_ID, id=did, format=fmt)))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['to', 'subject'],
            'properties': {
                'to': {'type': 'string', 'description': 'Recipient(s), comma-separated'},
                'subject': {'type': 'string', 'description': 'Subject line'},
                'body': {'type': 'string', 'description': 'Plain-text body'},
                'cc': {'type': 'string', 'description': 'Cc recipient(s)'},
                'bcc': {'type': 'string', 'description': 'Bcc recipient(s)'},
                'threadId': {'type': 'string', 'description': 'Attach the draft to an existing thread'},
            },
        },
        description='Create a draft message.',
    )
    def draft_create(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('draft_create')
        raw = build_raw_message(
            to=require_str(args, 'to', tool_name='draft_create'),
            subject=require_str(args, 'subject', tool_name='draft_create'),
            body=args.get('body') or '',
            cc=args.get('cc'),
            bcc=args.get('bcc'),
        )
        message: dict = {'raw': raw}
        if args.get('threadId'):
            message['threadId'] = args['threadId']
        return clean_draft(execute(self._svc().users().drafts().create(userId=USER_ID, body={'message': message})))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id', 'to', 'subject'],
            'properties': {
                'id': {'type': 'string', 'description': 'Draft id to update'},
                'to': {'type': 'string', 'description': 'Recipient(s)'},
                'subject': {'type': 'string', 'description': 'Subject line'},
                'body': {'type': 'string', 'description': 'Plain-text body'},
                'cc': {'type': 'string', 'description': 'Cc recipient(s)'},
                'bcc': {'type': 'string', 'description': 'Bcc recipient(s)'},
                'threadId': {'type': 'string', 'description': 'Thread to attach to'},
            },
        },
        description='Replace the contents of an existing draft.',
    )
    def draft_update(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('draft_update')
        did = require_str(args, 'id', tool_name='draft_update')
        raw = build_raw_message(
            to=require_str(args, 'to', tool_name='draft_update'),
            subject=require_str(args, 'subject', tool_name='draft_update'),
            body=args.get('body') or '',
            cc=args.get('cc'),
            bcc=args.get('bcc'),
        )
        message: dict = {'raw': raw}
        if args.get('threadId'):
            message['threadId'] = args['threadId']
        return clean_draft(
            execute(self._svc().users().drafts().update(userId=USER_ID, id=did, body={'message': message}))
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Draft id to send'}},
        },
        description='Send an existing draft.',
    )
    def draft_send(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('draft_send')
        self._require_send('draft_send')
        did = require_str(args, 'id', tool_name='draft_send')
        return clean_message(execute(self._svc().users().drafts().send(userId=USER_ID, body={'id': did})))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Draft id to delete'}},
        },
        description='Delete a draft.',
    )
    def draft_delete(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('draft_delete')
        did = require_str(args, 'id', tool_name='draft_delete')
        execute(self._svc().users().drafts().delete(userId=USER_ID, id=did))
        return {'deleted': True, 'id': did}

    # =======================================================================
    # SEND (write + send scope)
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['to', 'subject'],
            'properties': {
                'to': {'type': 'string', 'description': 'Recipient(s), comma-separated'},
                'subject': {'type': 'string', 'description': 'Subject line'},
                'body': {'type': 'string', 'description': 'Plain-text body'},
                'cc': {'type': 'string', 'description': 'Cc recipient(s)'},
                'bcc': {'type': 'string', 'description': 'Bcc recipient(s)'},
                'threadId': {
                    'type': 'string',
                    'description': 'Reply within this thread (sets In-Reply-To/References so it lands in-thread)',
                },
            },
        },
        description='Send an email. Pass threadId to reply within an existing thread.',
    )
    def message_send(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('message_send')
        self._require_send('message_send')
        to = require_str(args, 'to', tool_name='message_send')
        subject = require_str(args, 'subject', tool_name='message_send')
        thread_id = (args.get('threadId') or '').strip()

        in_reply_to = references = None
        if thread_id:
            in_reply_to, references = self._thread_reply_headers(thread_id)

        raw = build_raw_message(
            to=to,
            subject=subject,
            body=args.get('body') or '',
            cc=args.get('cc'),
            bcc=args.get('bcc'),
            in_reply_to=in_reply_to,
            references=references,
        )
        body: dict = {'raw': raw}
        if thread_id:
            body['threadId'] = thread_id
        return clean_message(execute(self._svc().users().messages().send(userId=USER_ID, body=body)))

    def _thread_reply_headers(self, thread_id: str) -> tuple[str | None, str | None]:
        """Return (In-Reply-To, References) derived from a thread's latest message."""
        thread = execute(self._svc().users().threads().get(userId=USER_ID, id=thread_id, format='metadata'))
        messages = thread.get('messages') or []
        if not messages:
            return None, None
        headers = {
            (h.get('name') or '').lower(): h.get('value')
            for h in (messages[-1].get('payload') or {}).get('headers') or []
        }
        message_id = headers.get('message-id')
        if not message_id:
            return None, None
        prior_refs = headers.get('references')
        references = f'{prior_refs} {message_id}' if prior_refs else message_id
        return message_id, references

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Message id to move to Trash'}},
        },
        description='Move a message to Trash (recoverable).',
    )
    def message_trash(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('message_trash')
        mid = require_str(args, 'id', tool_name='message_trash')
        return clean_message(execute(self._svc().users().messages().trash(userId=USER_ID, id=mid)))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Message id to restore from Trash'}},
        },
        description='Remove a message from Trash.',
    )
    def message_untrash(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('message_untrash')
        mid = require_str(args, 'id', tool_name='message_untrash')
        return clean_message(execute(self._svc().users().messages().untrash(userId=USER_ID, id=mid)))

    # =======================================================================
    # ATTACHMENTS & HISTORY (read)
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['messageId', 'attachmentId'],
            'properties': {
                'messageId': {'type': 'string', 'description': 'Message id the attachment belongs to'},
                'attachmentId': {'type': 'string', 'description': 'Attachment id (from a message payload part)'},
            },
        },
        description='Get an attachment body (base64url data) by message and attachment id.',
    )
    def attachment_get(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        mid = require_str(args, 'messageId', tool_name='attachment_get')
        aid = require_str(args, 'attachmentId', tool_name='attachment_get')
        data = execute(self._svc().users().messages().attachments().get(userId=USER_ID, messageId=mid, id=aid))
        out = clean_attachment(data)
        out['attachmentId'] = out.get('attachmentId') or aid
        return out

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['startHistoryId'],
            'properties': {
                'startHistoryId': {
                    'type': 'string',
                    'description': 'historyId to sync from (from a prior message/thread)',
                },
                'historyTypes': {
                    'type': 'array',
                    'items': {
                        'type': 'string',
                        'enum': ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
                    },
                    'description': 'Filter to these change types',
                },
                'labelId': {'type': 'string', 'description': 'Only changes affecting this label'},
                'maxResults': {'type': 'integer', 'description': 'Max records (1–500, default 100)'},
                'pageToken': {'type': 'string', 'description': 'Page token from a previous call'},
            },
        },
        description='List incremental mailbox changes since a historyId (for sync).',
    )
    def history_list(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        start = require_str(args, 'startHistoryId', tool_name='history_list')
        params = {
            'userId': USER_ID,
            'startHistoryId': start,
            'historyTypes': args.get('historyTypes'),
            'labelId': args.get('labelId'),
            'maxResults': max(1, min(int(args.get('maxResults') or 100), 500)),
            'pageToken': args.get('pageToken'),
        }
        data = execute(self._svc().users().history().list(**{k: v for k, v in params.items() if v is not None}))
        return {
            'history': [clean_history(h) for h in (data.get('history') or [])],
            'historyId': data.get('historyId'),
            'nextPageToken': data.get('nextPageToken'),
        }

    # =======================================================================
    # PERMANENT DELETE (gated: allowHardDelete + full tier)
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Message id to permanently delete'}},
        },
        description='Permanently delete a message (bypasses Trash, irreversible). Gated by allowHardDelete + full access.',
    )
    def message_delete(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_hard_delete('message_delete')
        mid = require_str(args, 'id', tool_name='message_delete')
        execute(self._svc().users().messages().delete(userId=USER_ID, id=mid))
        return {'deleted': True, 'id': mid}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['ids'],
            'properties': {
                'ids': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Explicit message ids to delete'},
            },
        },
        description=f'Permanently delete up to {MAX_BATCH} messages by explicit id list (never a query). '
        'Gated by allowHardDelete + full access.',
    )
    def messages_batchDelete(self, args):
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_hard_delete('messages_batchDelete')
        ids = self._id_list(args, 'ids', 'messages_batchDelete')
        execute(self._svc().users().messages().batchDelete(userId=USER_ID, body={'ids': ids}))
        return {'deleted': len(ids)}
