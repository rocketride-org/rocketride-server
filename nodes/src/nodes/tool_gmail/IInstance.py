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
attachments, incremental history, filters, watch/push, sendAs aliases, IMAP/POP,
vacation responder, forwarding, delegation, and S/MIME. Write operations require a
writable tier; sending requires the send scope; permanent delete requires the ``full`` tier (https://mail.google.com/). Settings
tools require the ``settings`` or ``settings_sharing`` tier.

Operational targets (messageId, threadId, labelId, query) are always invoke-time
parameters — never node config.
"""

from __future__ import annotations

import base64

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input, require_str
from nodes.core.google_access import GoogleAccessError

from .gmail_client import (
    MAX_BATCH,
    USER_ID,
    build_html_message,
    build_raw_message,
    clean_attachment,
    clean_delegate,
    clean_draft,
    clean_filter,
    clean_forwarding_address,
    clean_history,
    clean_imap,
    clean_label,
    clean_message,
    clean_pop,
    clean_ref,
    clean_send_as,
    clean_thread,
    clean_vacation,
    execute,
)
from .IGlobal import IGlobal

_GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
_GMAIL_FULL_SCOPE = 'https://mail.google.com/'
_GMAIL_SETTINGS_SCOPE = 'https://www.googleapis.com/auth/gmail.settings.basic'
_GMAIL_SETTINGS_SHARING_SCOPE = 'https://www.googleapis.com/auth/gmail.settings.sharing'


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def _svc(self):
        """Return the shared Gmail service handle."""
        return self.IGlobal.service

    def _access(self):
        """Return the node's access descriptor (tier, scopes, flags)."""
        return self.IGlobal.access

    def _require_send(self, op: str) -> None:
        """Raise GoogleAccessError unless the granted scopes include the send or full scope."""
        scopes = self._access().scopes
        if _GMAIL_FULL_SCOPE not in scopes and _GMAIL_SEND_SCOPE not in scopes:
            raise GoogleAccessError(
                f"{op} needs the send scope. Set access to 'send' or 'full' on this node to enable it."
            )

    def _require_hard_delete(self, op: str) -> None:
        """Gate permanent deletion: needs the full tier AND the allowHardDelete flag."""
        if _GMAIL_FULL_SCOPE not in self._access().scopes:
            raise GoogleAccessError(
                f"{op} permanently deletes mail and needs the full mailbox scope. Set access to 'full' on this node."
            )
        # Scope alone is not consent: the destructive gate must also be enabled
        # explicitly in the node config.
        self._access().require_flag('allowHardDelete', op)

    def _require_settings(self, op: str) -> None:
        """Raise GoogleAccessError unless the granted scopes include the settings or full scope."""
        if _GMAIL_SETTINGS_SCOPE not in self._access().scopes and _GMAIL_FULL_SCOPE not in self._access().scopes:
            raise GoogleAccessError(
                f"{op} needs the settings scope. Set access to 'settings', 'settings_sharing', or 'full'."
            )

    def _require_settings_sharing(self, op: str) -> None:
        """Raise GoogleAccessError unless the granted scopes include the settings sharing or full scope."""
        if (
            _GMAIL_SETTINGS_SHARING_SCOPE not in self._access().scopes
            and _GMAIL_FULL_SCOPE not in self._access().scopes
        ):
            raise GoogleAccessError(
                f"{op} needs the settings sharing scope. Set access to 'settings_sharing' or 'full'."
            )

    @staticmethod
    def _int_arg(args: dict, key: str, default: int, lo: int, hi: int) -> int:
        """Read an integer arg, defaulting only on None and clamping to [lo, hi].

        `args.get(key) or default` silently turns an explicit 0 into the
        default, bypassing the clamp (the antipattern flagged on #1228/#1445).
        """
        value = args.get(key)
        if value is None:
            value = default
        return max(lo, min(int(value), hi))

    @staticmethod
    def _id_list(args: dict, key: str, op: str) -> list[str]:
        """Validate a non-empty list of id strings, capped at MAX_BATCH."""
        ids = args.get(key)
        if not isinstance(ids, list) or not ids:
            raise ValueError(f'{op}: "{key}" must be a non-empty list of message ids')
        if not all(isinstance(i, str) and i.strip() for i in ids):
            raise ValueError(f'{op}: "{key}" must contain only message-id strings')
        if len(ids) > MAX_BATCH:
            raise ValueError(f'{op}: at most {MAX_BATCH} ids per call (got {len(ids)})')
        return ids

    # =======================================================================
    # DIAGNOSTICS
    # =======================================================================

    @tool_function(
        description=(
            "Check the Gmail connection status and verify that the OAuth token's granted scopes "
            "cover the node's configured access tier. Call this when a Gmail operation fails with "
            'a scope or permission error, or before attempting settings-level operations for the '
            'first time. Returns connection_ok: true when all required scopes are present.'
        ),
        input_schema={'type': 'object', 'properties': {}, 'required': []},
    )
    def check_connection(self, args: dict) -> dict:
        """Check Gmail connection status and whether granted OAuth scopes cover the configured access tier. Read-only."""
        glb = self.IGlobal
        access = glb.access
        granted_scopes: set[str] = set()
        scope_available = False
        auth_type = 'unknown'

        try:
            from ai.common.config import Config

            cfg = Config.getNodeConfig(glb.glb.logicalType, glb.glb.connConfig)
            auth_type = (cfg.get('authType') or 'service').strip()
            if auth_type == 'user':
                token_str = str(cfg.get('userToken') or '').strip()
                if token_str:
                    from .gmail_client import _decode_blob
                    import json as _json

                    info = _json.loads(_decode_blob(token_str))
                    raw = (info.get('scope') or '').split()
                    granted_scopes = {s for s in raw if s}
                    scope_available = True
        except Exception:
            pass

        if _GMAIL_FULL_SCOPE in granted_scopes:
            missing: list[str] = []
        elif scope_available:
            missing = [s for s in access.scopes if s not in granted_scopes]
        else:
            missing = []  # service account — scopes come from key, not token

        ok = not missing
        return {
            'auth_type': auth_type,
            'configured_tier': access.tier,
            'required_scopes': access.scopes,
            'granted_scopes': sorted(granted_scopes) if granted_scopes else ['(service account or scope field absent)'],
            'missing_scopes': missing,
            'connection_ok': ok,
            'action': (
                'Disconnect and reconnect your Google account with the current access tier '
                'selected. After reconnecting, call check_connection again to confirm.'
            )
            if not ok
            else None,
        }

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
        """List message ids, optionally filtered by a Gmail query or labels. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        params = {
            'userId': USER_ID,
            'q': args.get('query'),
            'labelIds': args.get('labelIds'),
            'maxResults': self._int_arg(args, 'maxResults', 25, 1, 500),
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
        """Search messages using Gmail query syntax; returns matching message ids. Read-only."""
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
        """Get a single message: ids, labels, snippet, and key headers. Read-only."""
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
        """Add or remove labels on a message. Requires a writable tier."""
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
        """Add or remove labels on a batch of messages by explicit id list. Requires a writable tier."""
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
        """Apply (add) labels to a message. Requires a writable tier."""
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
        """Remove labels from a message. Requires a writable tier."""
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
        """Get a thread and its messages. Read-only."""
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
        """List threads, optionally filtered by query or labels. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        params = {
            'userId': USER_ID,
            'q': args.get('query'),
            'labelIds': args.get('labelIds'),
            'maxResults': self._int_arg(args, 'maxResults', 25, 1, 500),
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
        """List all labels in the mailbox. Read-only."""
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
        """Create a new label. Requires a writable tier."""
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
        """Update a label's name and/or visibility. Requires a writable tier."""
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
        """Delete a label; messages keep existing. Requires a writable tier."""
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
        """List drafts. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        params = {
            'userId': USER_ID,
            'maxResults': self._int_arg(args, 'maxResults', 25, 1, 500),
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
        """Get a single draft. Read-only."""
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
                'body': {'type': 'string', 'description': 'Plain-text body (used when html_body is absent)'},
                'html_body': {
                    'type': 'string',
                    'description': 'HTML body. When set, sends a multipart/alternative message.',
                },
                'cc': {'type': 'string', 'description': 'Cc recipient(s)'},
                'bcc': {'type': 'string', 'description': 'Bcc recipient(s)'},
                'threadId': {'type': 'string', 'description': 'Attach the draft to an existing thread'},
                'attachments': {
                    'type': 'array',
                    'description': 'File attachments',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'filename': {'type': 'string'},
                            'content_base64': {'type': 'string', 'description': 'Base64-encoded file content'},
                            'mime_type': {
                                'type': 'string',
                                'description': 'MIME type (default application/octet-stream)',
                            },
                        },
                        'required': ['filename', 'content_base64'],
                    },
                },
            },
        },
        description='Create a draft message. Pass html_body for rich HTML content; pass attachments for file attachments.',
    )
    def draft_create(self, args):
        """Create a draft message, with optional HTML body and attachments. Requires a writable tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('draft_create')
        to = require_str(args, 'to', tool_name='draft_create')
        subject = require_str(args, 'subject', tool_name='draft_create')
        html_body = (args.get('html_body') or '').strip()
        if html_body:
            raw = build_html_message(
                to=to,
                subject=subject,
                html_body=html_body,
                text_body=args.get('body') or '',
                cc=args.get('cc'),
                bcc=args.get('bcc'),
                attachments=args.get('attachments') or None,
            )
        else:
            raw = build_raw_message(
                to=to,
                subject=subject,
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
                'html_body': {
                    'type': 'string',
                    'description': 'HTML body. When set, sends a multipart/alternative message.',
                },
                'cc': {'type': 'string', 'description': 'Cc recipient(s)'},
                'bcc': {'type': 'string', 'description': 'Bcc recipient(s)'},
                'threadId': {'type': 'string', 'description': 'Thread to attach to'},
                'attachments': {
                    'type': 'array',
                    'description': 'File attachments',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'filename': {'type': 'string'},
                            'content_base64': {'type': 'string'},
                            'mime_type': {'type': 'string'},
                        },
                        'required': ['filename', 'content_base64'],
                    },
                },
            },
        },
        description='Replace the contents of an existing draft. Pass html_body for rich HTML content.',
    )
    def draft_update(self, args):
        """Replace the contents of an existing draft. Requires a writable tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('draft_update')
        did = require_str(args, 'id', tool_name='draft_update')
        to = require_str(args, 'to', tool_name='draft_update')
        subject = require_str(args, 'subject', tool_name='draft_update')
        html_body = (args.get('html_body') or '').strip()
        if html_body:
            raw = build_html_message(
                to=to,
                subject=subject,
                html_body=html_body,
                text_body=args.get('body') or '',
                cc=args.get('cc'),
                bcc=args.get('bcc'),
                attachments=args.get('attachments') or None,
            )
        else:
            raw = build_raw_message(
                to=to,
                subject=subject,
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
        """Send an existing draft. Requires a writable tier and the send scope."""
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
        """Delete a draft. Requires a writable tier."""
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
                'body': {'type': 'string', 'description': 'Plain-text body (used when html_body is absent)'},
                'html_body': {
                    'type': 'string',
                    'description': 'HTML body. When set, sends a multipart/alternative message.',
                },
                'cc': {'type': 'string', 'description': 'Cc recipient(s)'},
                'bcc': {'type': 'string', 'description': 'Bcc recipient(s)'},
                'threadId': {
                    'type': 'string',
                    'description': 'Reply within this thread (sets In-Reply-To/References so it lands in-thread)',
                },
                'attachments': {
                    'type': 'array',
                    'description': 'File attachments',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'filename': {'type': 'string'},
                            'content_base64': {'type': 'string', 'description': 'Base64-encoded file content'},
                            'mime_type': {
                                'type': 'string',
                                'description': 'MIME type (default application/octet-stream)',
                            },
                        },
                        'required': ['filename', 'content_base64'],
                    },
                },
            },
        },
        description='Send an email. Pass threadId to reply in-thread. Pass html_body for rich HTML; pass attachments for files.',
    )
    def message_send(self, args):
        """Send an email, optionally in-thread, with HTML body and attachments. Requires a writable tier and the send scope."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('message_send')
        self._require_send('message_send')
        to = require_str(args, 'to', tool_name='message_send')
        subject = require_str(args, 'subject', tool_name='message_send')
        thread_id = (args.get('threadId') or '').strip()
        html_body = (args.get('html_body') or '').strip()

        in_reply_to = references = None
        if thread_id:
            in_reply_to, references = self._thread_reply_headers(thread_id)

        if html_body:
            raw = build_html_message(
                to=to,
                subject=subject,
                html_body=html_body,
                text_body=args.get('body') or '',
                cc=args.get('cc'),
                bcc=args.get('bcc'),
                in_reply_to=in_reply_to,
                references=references,
                attachments=args.get('attachments') or None,
            )
        else:
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
        """Move a message to Trash (recoverable). Requires a writable tier."""
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
        """Restore a message from Trash. Requires a writable tier."""
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
        """Get an attachment body (base64url data) by message and attachment id. Read-only."""
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
        """List incremental mailbox changes since a historyId (for sync). Read-only."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        start = require_str(args, 'startHistoryId', tool_name='history_list')
        params = {
            'userId': USER_ID,
            'startHistoryId': start,
            'historyTypes': args.get('historyTypes'),
            'labelId': args.get('labelId'),
            'maxResults': self._int_arg(args, 'maxResults', 100, 1, 500),
            'pageToken': args.get('pageToken'),
        }
        data = execute(self._svc().users().history().list(**{k: v for k, v in params.items() if v is not None}))
        return {
            'history': [clean_history(h) for h in (data.get('history') or [])],
            'historyId': data.get('historyId'),
            'nextPageToken': data.get('nextPageToken'),
        }

    # =======================================================================
    # PERMANENT DELETE (requires full tier)
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Message id to permanently delete'}},
        },
        description='Permanently delete a message (bypasses Trash, irreversible). Requires full access.',
    )
    def message_delete(self, args):
        """Permanently delete a message, bypassing Trash (irreversible). Requires the full tier and allowHardDelete."""
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
        description=f'Permanently delete up to {MAX_BATCH} messages by explicit id list (never a query). Requires full access.',
    )
    def messages_batchDelete(self, args):
        """Permanently delete a batch of messages by explicit id list (irreversible). Requires the full tier and allowHardDelete."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_hard_delete('messages_batchDelete')
        ids = self._id_list(args, 'ids', 'messages_batchDelete')
        execute(self._svc().users().messages().batchDelete(userId=USER_ID, body={'ids': ids}))
        return {'deleted': len(ids)}

    # =======================================================================
    # THREADS — write ops
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {
                'id': {'type': 'string', 'description': 'Thread id'},
                'addLabelIds': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Label ids to add'},
                'removeLabelIds': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Label ids to remove'},
            },
        },
        description='Add or remove labels on all messages in a thread.',
    )
    def thread_modify(self, args):
        """Add or remove labels on all messages in a thread. Requires a writable tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('thread_modify')
        tid = require_str(args, 'id', tool_name='thread_modify')
        body = {k: args[k] for k in ('addLabelIds', 'removeLabelIds') if args.get(k)}
        if not body:
            raise ValueError('thread_modify: provide addLabelIds and/or removeLabelIds')
        return clean_thread(execute(self._svc().users().threads().modify(userId=USER_ID, id=tid, body=body)))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Thread id to move to Trash'}},
        },
        description='Move all messages in a thread to Trash (recoverable).',
    )
    def thread_trash(self, args):
        """Move all messages in a thread to Trash (recoverable). Requires a writable tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('thread_trash')
        tid = require_str(args, 'id', tool_name='thread_trash')
        return clean_thread(execute(self._svc().users().threads().trash(userId=USER_ID, id=tid)))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Thread id to restore from Trash'}},
        },
        description='Remove all messages in a thread from Trash.',
    )
    def thread_untrash(self, args):
        """Restore all messages in a thread from Trash. Requires a writable tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('thread_untrash')
        tid = require_str(args, 'id', tool_name='thread_untrash')
        return clean_thread(execute(self._svc().users().threads().untrash(userId=USER_ID, id=tid)))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Thread id to permanently delete'}},
        },
        description='Permanently delete a thread and all its messages (bypasses Trash, irreversible). Requires full access.',
    )
    def thread_delete(self, args):
        """Permanently delete a thread and all its messages, bypassing Trash (irreversible). Requires the full tier and allowHardDelete."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_hard_delete('thread_delete')
        tid = require_str(args, 'id', tool_name='thread_delete')
        execute(self._svc().users().threads().delete(userId=USER_ID, id=tid))
        return {'deleted': True, 'id': tid}

    # =======================================================================
    # MESSAGE CONVENIENCE WRAPPERS (write)
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Message id'}},
        },
        description='Archive a message by removing it from the INBOX label.',
    )
    def message_archive(self, args):
        """Archive a message by removing the INBOX label. Requires a writable tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('message_archive')
        mid = require_str(args, 'id', tool_name='message_archive')
        return clean_message(
            execute(self._svc().users().messages().modify(userId=USER_ID, id=mid, body={'removeLabelIds': ['INBOX']}))
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Message id'}},
        },
        description='Mark a message as read (removes the UNREAD label).',
    )
    def message_mark_read(self, args):
        """Mark a message as read by removing the UNREAD label. Requires a writable tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('message_mark_read')
        mid = require_str(args, 'id', tool_name='message_mark_read')
        return clean_message(
            execute(self._svc().users().messages().modify(userId=USER_ID, id=mid, body={'removeLabelIds': ['UNREAD']}))
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Message id'}},
        },
        description='Mark a message as unread (adds the UNREAD label).',
    )
    def message_mark_unread(self, args):
        """Mark a message as unread by adding the UNREAD label. Requires a writable tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('message_mark_unread')
        mid = require_str(args, 'id', tool_name='message_mark_unread')
        return clean_message(
            execute(self._svc().users().messages().modify(userId=USER_ID, id=mid, body={'addLabelIds': ['UNREAD']}))
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Message id'}},
        },
        description='Star a message (adds the STARRED label).',
    )
    def message_star(self, args):
        """Star a message by adding the STARRED label. Requires a writable tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('message_star')
        mid = require_str(args, 'id', tool_name='message_star')
        return clean_message(
            execute(self._svc().users().messages().modify(userId=USER_ID, id=mid, body={'addLabelIds': ['STARRED']}))
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Message id'}},
        },
        description='Unstar a message (removes the STARRED label).',
    )
    def message_unstar(self, args):
        """Unstar a message by removing the STARRED label. Requires a writable tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('message_unstar')
        mid = require_str(args, 'id', tool_name='message_unstar')
        return clean_message(
            execute(self._svc().users().messages().modify(userId=USER_ID, id=mid, body={'removeLabelIds': ['STARRED']}))
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {
                'id': {'type': 'string', 'description': 'Message id'},
            },
        },
        description='Fetch a message and return its decoded body text and HTML. Walks MIME parts recursively.',
    )
    def message_get_body(self, args):
        """Fetch a message and return its decoded plain-text and HTML bodies. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        mid = require_str(args, 'id', tool_name='message_get_body')
        data = execute(self._svc().users().messages().get(userId=USER_ID, id=mid, format='full'))

        def _collect(part: dict, texts: list, htmls: list) -> None:
            mime = (part.get('mimeType') or '').lower()
            body = part.get('body') or {}
            if mime == 'text/plain' and body.get('data'):
                try:
                    texts.append(base64.urlsafe_b64decode(body['data'] + '==').decode('utf-8', errors='replace'))
                except Exception:
                    pass
            elif mime == 'text/html' and body.get('data'):
                try:
                    htmls.append(base64.urlsafe_b64decode(body['data'] + '==').decode('utf-8', errors='replace'))
                except Exception:
                    pass
            for sub in part.get('parts') or []:
                _collect(sub, texts, htmls)

        texts: list = []
        htmls: list = []
        payload = data.get('payload') or {}
        _collect(payload, texts, htmls)
        return {
            'id': data.get('id'),
            'threadId': data.get('threadId'),
            'snippet': data.get('snippet'),
            'text': '\n'.join(texts) or None,
            'html': '\n'.join(htmls) or None,
        }

    # =======================================================================
    # FILTERS (requires settings scope)
    # =======================================================================

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description="List all filters in the mailbox. Requires 'settings' or higher access tier.",
    )
    def filter_list(self, args):
        """List all filters in the mailbox. Requires the settings tier or higher."""
        normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings('filter_list')
        data = execute(self._svc().users().settings().filters().list(userId=USER_ID))
        return [clean_filter(f) for f in (data.get('filter') or [])]

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['criteria', 'action'],
            'properties': {
                'criteria': {
                    'type': 'object',
                    'description': 'Filter criteria (from, to, subject, query, negatedQuery, hasAttachment, excludeChats, size, sizeComparison)',
                },
                'action': {
                    'type': 'object',
                    'description': 'Filter action (addLabelIds, removeLabelIds, forward)',
                },
            },
        },
        description="Create a new filter. Requires 'settings' or higher access tier.",
    )
    def filter_create(self, args):
        """Create a new filter from criteria and action objects. Requires the settings tier or higher."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings('filter_create')
        criteria = args.get('criteria')
        action = args.get('action')
        if not isinstance(criteria, dict):
            raise ValueError('filter_create: "criteria" must be an object')
        if not isinstance(action, dict):
            raise ValueError('filter_create: "action" must be an object')
        return clean_filter(
            execute(
                self._svc()
                .users()
                .settings()
                .filters()
                .create(userId=USER_ID, body={'criteria': criteria, 'action': action})
            )
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['id'],
            'properties': {'id': {'type': 'string', 'description': 'Filter id to delete'}},
        },
        description="Delete a filter by id. Requires 'settings' or higher access tier.",
    )
    def filter_delete(self, args):
        """Delete a filter by id. Requires the settings tier or higher."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings('filter_delete')
        fid = require_str(args, 'id', tool_name='filter_delete')
        execute(self._svc().users().settings().filters().delete(userId=USER_ID, id=fid))
        return {'deleted': True, 'id': fid}

    # =======================================================================
    # WATCH / PUSH NOTIFICATIONS
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['topic_name'],
            'properties': {
                'topic_name': {
                    'type': 'string',
                    'description': 'Cloud Pub/Sub topic to send notifications to (projects/*/topics/*)',
                },
                'label_ids': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Only watch changes on these labels (default: all)',
                },
                'label_filter_action': {
                    'type': 'string',
                    'enum': ['include', 'exclude'],
                    'description': 'Whether label_ids are an inclusion or exclusion list (default include)',
                },
            },
        },
        description='Start push notifications to a Cloud Pub/Sub topic. Returns historyId and expiration timestamp.',
    )
    def watch_start(self, args):
        """Start push notifications to a Cloud Pub/Sub topic. Requires a writable tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('watch_start')
        topic = require_str(args, 'topic_name', tool_name='watch_start')
        body: dict = {'topicName': topic}
        if args.get('label_ids'):
            body['labelIds'] = args['label_ids']
        if args.get('label_filter_action'):
            body['labelFilterAction'] = args['label_filter_action']
        data = execute(self._svc().users().watch(userId=USER_ID, body=body))
        return {'historyId': data.get('historyId'), 'expiration': data.get('expiration')}

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description='Stop push notifications for this mailbox.',
    )
    def watch_stop(self, args):
        """Stop push notifications for this mailbox. Requires a writable tier."""
        normalize_tool_input(args, tool_name='tool_gmail')
        self._access().require_write('watch_stop')
        execute(self._svc().users().stop(userId=USER_ID))
        return {'stopped': True}

    # =======================================================================
    # SEND-AS ALIASES (read: settings; write: settings_sharing)
    # =======================================================================

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description="List all sendAs aliases. Requires 'settings' or higher access tier.",
    )
    def send_as_list(self, args):
        """List all sendAs aliases. Requires the settings tier or higher."""
        normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings('send_as_list')
        data = execute(self._svc().users().settings().sendAs().list(userId=USER_ID))
        return [clean_send_as(s) for s in (data.get('sendAs') or [])]

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['send_as_email'],
            'properties': {
                'send_as_email': {'type': 'string', 'description': 'The sendAs email address to retrieve'},
            },
        },
        description="Get a single sendAs alias. Requires 'settings' or higher access tier.",
    )
    def send_as_get(self, args):
        """Get a single sendAs alias. Requires the settings tier or higher."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings('send_as_get')
        email = require_str(args, 'send_as_email', tool_name='send_as_get')
        return clean_send_as(execute(self._svc().users().settings().sendAs().get(userId=USER_ID, sendAsEmail=email)))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['send_as_email'],
            'properties': {
                'send_as_email': {'type': 'string', 'description': 'Email address for the alias'},
                'display_name': {'type': 'string', 'description': 'Display name shown to recipients'},
                'reply_to_address': {'type': 'string', 'description': 'Reply-To address'},
                'signature': {'type': 'string', 'description': 'HTML signature'},
                'treat_as_alias': {'type': 'boolean', 'description': 'Treat as alias (default true)'},
            },
        },
        description="Create a sendAs alias. Requires 'settings_sharing' or 'full' access tier.",
    )
    def send_as_create(self, args):
        """Create a sendAs alias. Requires the settings_sharing or full tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings_sharing('send_as_create')
        email = require_str(args, 'send_as_email', tool_name='send_as_create')
        body: dict = {'sendAsEmail': email}
        for src, dst in (
            ('display_name', 'displayName'),
            ('reply_to_address', 'replyToAddress'),
            ('signature', 'signature'),
        ):
            if args.get(src):
                body[dst] = args[src]
        if 'treat_as_alias' in args:
            body['treatAsAlias'] = bool(args['treat_as_alias'])
        return clean_send_as(execute(self._svc().users().settings().sendAs().create(userId=USER_ID, body=body)))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['send_as_email'],
            'properties': {
                'send_as_email': {'type': 'string', 'description': 'Email address of the alias to update'},
                'display_name': {'type': 'string', 'description': 'New display name'},
                'reply_to_address': {'type': 'string', 'description': 'New Reply-To address'},
                'signature': {'type': 'string', 'description': 'New HTML signature'},
                'treat_as_alias': {'type': 'boolean', 'description': 'Treat as alias'},
            },
        },
        description="Update a sendAs alias. Requires 'settings_sharing' or 'full' access tier.",
    )
    def send_as_update(self, args):
        """Update a sendAs alias. Requires the settings_sharing or full tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings_sharing('send_as_update')
        email = require_str(args, 'send_as_email', tool_name='send_as_update')
        body: dict = {}
        for src, dst in (
            ('display_name', 'displayName'),
            ('reply_to_address', 'replyToAddress'),
            ('signature', 'signature'),
        ):
            if args.get(src):
                body[dst] = args[src]
        if 'treat_as_alias' in args:
            body['treatAsAlias'] = bool(args['treat_as_alias'])
        if not body:
            raise ValueError('send_as_update: provide at least one field to update')
        return clean_send_as(
            execute(self._svc().users().settings().sendAs().patch(userId=USER_ID, sendAsEmail=email, body=body))
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['send_as_email'],
            'properties': {
                'send_as_email': {'type': 'string', 'description': 'Email address of the alias to delete'},
            },
        },
        description="Delete a sendAs alias. Requires 'settings_sharing' or 'full' access tier.",
    )
    def send_as_delete(self, args):
        """Delete a sendAs alias. Requires the settings_sharing or full tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings_sharing('send_as_delete')
        email = require_str(args, 'send_as_email', tool_name='send_as_delete')
        execute(self._svc().users().settings().sendAs().delete(userId=USER_ID, sendAsEmail=email))
        return {'deleted': True, 'sendAsEmail': email}

    # =======================================================================
    # IMAP / POP SETTINGS (requires settings scope)
    # =======================================================================

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description="Get IMAP settings. Requires 'settings' or higher access tier.",
    )
    def imap_get(self, args):
        """Get IMAP settings. Requires the settings tier or higher."""
        normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings('imap_get')
        return clean_imap(execute(self._svc().users().settings().getImap(userId=USER_ID)))

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'enabled': {'type': 'boolean', 'description': 'Enable or disable IMAP access'},
                'auto_expunge': {'type': 'boolean', 'description': 'Auto-expunge on deletion'},
                'expunge_behavior': {
                    'type': 'string',
                    'enum': ['archive', 'trash', 'deleteForever'],
                    'description': 'Behavior on expunge',
                },
                'max_folder_size': {'type': 'integer', 'description': 'Max IMAP folder size in bytes (0 = unlimited)'},
            },
        },
        description="Update IMAP settings. Requires 'settings' or higher access tier.",
    )
    def imap_update(self, args):
        """Update IMAP settings. Requires the settings tier or higher."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings('imap_update')
        body: dict = {}
        for src, dst in (
            ('enabled', 'enabled'),
            ('auto_expunge', 'autoExpunge'),
            ('expunge_behavior', 'expungeBehavior'),
            ('max_folder_size', 'maxFolderSize'),
        ):
            if src in args and args[src] is not None:
                body[dst] = args[src]
        if not body:
            raise ValueError('imap_update: provide at least one field to update')
        return clean_imap(execute(self._svc().users().settings().updateImap(userId=USER_ID, body=body)))

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description="Get POP settings. Requires 'settings' or higher access tier.",
    )
    def pop_get(self, args):
        """Get POP settings. Requires the settings tier or higher."""
        normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings('pop_get')
        return clean_pop(execute(self._svc().users().settings().getPop(userId=USER_ID)))

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'access_window': {
                    'type': 'string',
                    'enum': ['allMail', 'fromNowOn', 'disabled'],
                    'description': 'Which messages are accessible via POP',
                },
                'disposition': {
                    'type': 'string',
                    'enum': ['leaveInInbox', 'archive', 'trash', 'markRead'],
                    'description': 'What to do with messages after POP access',
                },
            },
        },
        description="Update POP settings. Requires 'settings' or higher access tier.",
    )
    def pop_update(self, args):
        """Update POP settings. Requires the settings tier or higher."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings('pop_update')
        body: dict = {}
        for src, dst in (('access_window', 'accessWindow'), ('disposition', 'disposition')):
            if args.get(src):
                body[dst] = args[src]
        if not body:
            raise ValueError('pop_update: provide accessWindow and/or disposition')
        return clean_pop(execute(self._svc().users().settings().updatePop(userId=USER_ID, body=body)))

    # =======================================================================
    # VACATION RESPONDER (requires settings scope)
    # =======================================================================

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description="Get vacation auto-reply settings. Requires 'settings' or higher access tier.",
    )
    def vacation_get(self, args):
        """Get vacation auto-reply settings. Requires the settings tier or higher."""
        normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings('vacation_get')
        return clean_vacation(execute(self._svc().users().settings().getVacation(userId=USER_ID)))

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'enable_auto_reply': {'type': 'boolean', 'description': 'Enable the vacation responder'},
                'response_subject': {'type': 'string', 'description': 'Subject of the auto-reply'},
                'response_body_plain_text': {'type': 'string', 'description': 'Plain-text auto-reply body'},
                'response_body_html': {'type': 'string', 'description': 'HTML auto-reply body'},
                'start_time_ms': {'type': 'integer', 'description': 'Start time (ms since epoch). Omit for immediate.'},
                'end_time_ms': {'type': 'integer', 'description': 'End time (ms since epoch). Omit for no end.'},
                'restrict_to_contacts': {'type': 'boolean', 'description': 'Only reply to contacts'},
                'restrict_to_domain': {'type': 'boolean', 'description': 'Only reply to same domain (Workspace)'},
            },
        },
        description="Update vacation auto-reply settings. Requires 'settings' or higher access tier.",
    )
    def vacation_update(self, args):
        """Update vacation auto-reply settings. Requires the settings tier or higher."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings('vacation_update')
        body: dict = {}
        mapping = [
            ('enable_auto_reply', 'enableAutoReply'),
            ('response_subject', 'responseSubject'),
            ('response_body_plain_text', 'responseBodyPlainText'),
            ('response_body_html', 'responseBodyHtml'),
            ('start_time_ms', 'startTime'),
            ('end_time_ms', 'endTime'),
            ('restrict_to_contacts', 'restrictToContacts'),
            ('restrict_to_domain', 'restrictToDomain'),
        ]
        for src, dst in mapping:
            if src in args and args[src] is not None:
                body[dst] = args[src]
        if not body:
            raise ValueError('vacation_update: provide at least one field to update')
        return clean_vacation(execute(self._svc().users().settings().updateVacation(userId=USER_ID, body=body)))

    # =======================================================================
    # FORWARDING ADDRESSES (requires settings scope)
    # =======================================================================

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description="List forwarding addresses. Requires 'settings' or higher access tier.",
    )
    def forwarding_address_list(self, args):
        """List forwarding addresses. Requires the settings tier or higher."""
        normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings('forwarding_address_list')
        data = execute(self._svc().users().settings().forwardingAddresses().list(userId=USER_ID))
        return [clean_forwarding_address(a) for a in (data.get('forwardingAddresses') or [])]

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['forwarding_email'],
            'properties': {
                'forwarding_email': {'type': 'string', 'description': 'Email address to forward to'},
            },
        },
        description="Create a forwarding address (requires the recipient to confirm). Requires 'settings' access tier.",
    )
    def forwarding_address_create(self, args):
        """Create a forwarding address (the recipient must confirm). Requires the settings tier or higher."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings('forwarding_address_create')
        email = require_str(args, 'forwarding_email', tool_name='forwarding_address_create')
        return clean_forwarding_address(
            execute(
                self._svc()
                .users()
                .settings()
                .forwardingAddresses()
                .create(userId=USER_ID, body={'forwardingEmail': email})
            )
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['forwarding_email'],
            'properties': {
                'forwarding_email': {'type': 'string', 'description': 'Forwarding address to delete'},
            },
        },
        description="Delete a forwarding address. Requires 'settings' or higher access tier.",
    )
    def forwarding_address_delete(self, args):
        """Delete a forwarding address. Requires the settings tier or higher."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings('forwarding_address_delete')
        email = require_str(args, 'forwarding_email', tool_name='forwarding_address_delete')
        execute(self._svc().users().settings().forwardingAddresses().delete(userId=USER_ID, forwardingEmail=email))
        return {'deleted': True, 'forwardingEmail': email}

    # =======================================================================
    # DELEGATION (requires settings_sharing scope)
    # =======================================================================

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description="List delegates for this mailbox. Requires 'settings_sharing' or 'full' access tier.",
    )
    def delegate_list(self, args):
        """List delegates for this mailbox. Requires the settings_sharing or full tier."""
        normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings_sharing('delegate_list')
        data = execute(self._svc().users().settings().delegates().list(userId=USER_ID))
        return [clean_delegate(d) for d in (data.get('delegates') or [])]

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['delegate_email'],
            'properties': {
                'delegate_email': {'type': 'string', 'description': 'Email address of the delegate to add'},
            },
        },
        description="Add a delegate to this mailbox. Requires 'settings_sharing' or 'full' access tier.",
    )
    def delegate_create(self, args):
        """Add a delegate to this mailbox. Requires the settings_sharing or full tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings_sharing('delegate_create')
        email = require_str(args, 'delegate_email', tool_name='delegate_create')
        return clean_delegate(
            execute(self._svc().users().settings().delegates().create(userId=USER_ID, body={'delegateEmail': email}))
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['delegate_email'],
            'properties': {
                'delegate_email': {'type': 'string', 'description': 'Email address of the delegate to remove'},
            },
        },
        description="Remove a delegate from this mailbox. Requires 'settings_sharing' or 'full' access tier.",
    )
    def delegate_delete(self, args):
        """Remove a delegate from this mailbox. Requires the settings_sharing or full tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings_sharing('delegate_delete')
        email = require_str(args, 'delegate_email', tool_name='delegate_delete')
        execute(self._svc().users().settings().delegates().delete(userId=USER_ID, delegateEmail=email))
        return {'deleted': True, 'delegateEmail': email}

    # =======================================================================
    # S/MIME (list: settings; write: settings_sharing)
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['send_as_email'],
            'properties': {
                'send_as_email': {'type': 'string', 'description': 'sendAs address to list S/MIME keys for'},
            },
        },
        description="List S/MIME keys for a sendAs address. Requires 'settings' or higher access tier.",
    )
    def smime_list(self, args):
        """List S/MIME keys for a sendAs address. Requires the settings tier or higher."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings('smime_list')
        email = require_str(args, 'send_as_email', tool_name='smime_list')
        data = execute(self._svc().users().settings().sendAs().smimeInfo().list(userId=USER_ID, sendAsEmail=email))
        return data.get('smimeInfo') or []

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['send_as_email', 'id'],
            'properties': {
                'send_as_email': {'type': 'string', 'description': 'sendAs address'},
                'id': {'type': 'string', 'description': 'S/MIME key id to set as default'},
            },
        },
        description="Set the default S/MIME key for a sendAs address. Requires 'settings_sharing' or 'full'.",
    )
    def smime_set_default(self, args):
        """Set the default S/MIME key for a sendAs address. Requires the settings_sharing or full tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings_sharing('smime_set_default')
        email = require_str(args, 'send_as_email', tool_name='smime_set_default')
        kid = require_str(args, 'id', tool_name='smime_set_default')
        execute(
            self._svc().users().settings().sendAs().smimeInfo().setDefault(userId=USER_ID, sendAsEmail=email, id=kid)
        )
        return {'defaultId': kid, 'sendAsEmail': email}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['send_as_email', 'id'],
            'properties': {
                'send_as_email': {'type': 'string', 'description': 'sendAs address'},
                'id': {'type': 'string', 'description': 'S/MIME key id to delete'},
            },
        },
        description="Delete an S/MIME key. Requires 'settings_sharing' or 'full' access tier.",
    )
    def smime_delete(self, args):
        """Delete an S/MIME key. Requires the settings_sharing or full tier."""
        args = normalize_tool_input(args, tool_name='tool_gmail')
        self._require_settings_sharing('smime_delete')
        email = require_str(args, 'send_as_email', tool_name='smime_delete')
        kid = require_str(args, 'id', tool_name='smime_delete')
        execute(self._svc().users().settings().sendAs().smimeInfo().delete(userId=USER_ID, sendAsEmail=email, id=kid))
        return {'deleted': True, 'id': kid, 'sendAsEmail': email}
