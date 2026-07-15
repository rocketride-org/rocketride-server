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

"""Gmail-specific service bindings, MIME builders, and response cleaners."""

from __future__ import annotations

import base64
import functools
from email.message import EmailMessage
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from .. import google_client

SERVICE = google_client.GoogleService(
    product='Gmail',
    api='gmail',
    version='v1',
    superset_scopes=frozenset({'https://mail.google.com/'}),
)

resolve_refresh_url = functools.partial(google_client.resolve_refresh_url, SERVICE)
resolve_token_uri = functools.partial(google_client.resolve_token_uri, SERVICE)
token_scope_report = functools.partial(google_client.token_scope_report, SERVICE)
build_service = functools.partial(google_client.build_service, SERVICE)
execute = functools.partial(google_client.execute, SERVICE)
_decode_blob = google_client._decode_blob
_is_rate_limit_403 = google_client._is_rate_limit_403

# Gmail's per-call ceiling for batchModify / batchDelete is 1000 ids.
MAX_BATCH = 1000

# Gmail uses the special id 'me' to mean the authorized mailbox.
USER_ID = 'me'

# Headers worth surfacing from a message payload (lower-cased for matching).
_KEEP_HEADERS = ('from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'in-reply-to', 'references')


# ---------------------------------------------------------------------------
# MIME assembly
# ---------------------------------------------------------------------------


def build_raw_message(
    *,
    to: str,
    subject: str,
    body: str,
    cc: str | None = None,
    bcc: str | None = None,
    in_reply_to: str | None = None,
    references: str | None = None,
) -> str:
    """Assemble a plain-text MIME message and return base64url-encoded raw bytes."""
    msg = EmailMessage()
    msg['To'] = to
    if cc:
        msg['Cc'] = cc
    if bcc:
        msg['Bcc'] = bcc
    msg['Subject'] = subject
    if in_reply_to:
        msg['In-Reply-To'] = in_reply_to
    if references:
        msg['References'] = references
    msg.set_content(body or '')
    return base64.urlsafe_b64encode(msg.as_bytes()).decode('ascii')


def build_html_message(
    *,
    to: str,
    subject: str,
    html_body: str,
    text_body: str | None = None,
    cc: str | None = None,
    bcc: str | None = None,
    in_reply_to: str | None = None,
    references: str | None = None,
    attachments: list[dict] | None = None,
) -> str:
    """Assemble a multipart MIME message with HTML body and optional attachments.

    Each entry in ``attachments`` must have keys ``filename``, ``content_base64``
    (standard or url-safe base64), and optionally ``mime_type`` (defaults to
    application/octet-stream).

    Returns base64url-encoded raw bytes suitable for the Gmail send/draft APIs.
    """
    alt = MIMEMultipart('alternative')
    alt.attach(MIMEText(text_body or '', 'plain', 'utf-8'))
    alt.attach(MIMEText(html_body, 'html', 'utf-8'))

    if attachments:
        outer = MIMEMultipart('mixed')
        if to:
            outer['To'] = to
        if cc:
            outer['Cc'] = cc
        if bcc:
            outer['Bcc'] = bcc
        outer['Subject'] = subject
        if in_reply_to:
            outer['In-Reply-To'] = in_reply_to
        if references:
            outer['References'] = references
        outer.attach(alt)
        for att in attachments:
            filename = att.get('filename') or 'attachment'
            mime_type = att.get('mime_type') or 'application/octet-stream'
            main_type, _, sub_type = mime_type.partition('/')
            part = MIMEBase(main_type, sub_type or 'octet-stream')
            raw_b64 = att.get('content_base64') or ''
            # Accept either standard (+/) or URL-safe (-_) base64.
            try:
                data = base64.urlsafe_b64decode(raw_b64 + '==')
            except Exception:
                data = base64.b64decode(raw_b64 + '==')
            part.set_payload(data)
            from email import encoders as _enc

            _enc.encode_base64(part)
            part.add_header('Content-Disposition', 'attachment', filename=filename)
            outer.attach(part)
        return base64.urlsafe_b64encode(outer.as_bytes()).decode('ascii')

    # No attachments — plain alternative container.
    alt['To'] = to
    if cc:
        alt['Cc'] = cc
    if bcc:
        alt['Bcc'] = bcc
    alt['Subject'] = subject
    if in_reply_to:
        alt['In-Reply-To'] = in_reply_to
    if references:
        alt['References'] = references
    return base64.urlsafe_b64encode(alt.as_bytes()).decode('ascii')


# ---------------------------------------------------------------------------
# Response cleaners
# ---------------------------------------------------------------------------


def _headers(payload: dict | None) -> dict:
    out: dict = {}
    for h in (payload or {}).get('headers') or []:
        name = (h.get('name') or '').lower()
        if name in _KEEP_HEADERS:
            out[h.get('name')] = h.get('value')
    return out


def clean_message(msg: dict | None) -> dict:
    """Compact a Gmail message: ids, labels, snippet, kept headers, historyId."""
    if not isinstance(msg, dict):
        return {}
    return {
        'id': msg.get('id'),
        'threadId': msg.get('threadId'),
        'labelIds': msg.get('labelIds'),
        'snippet': msg.get('snippet'),
        'historyId': msg.get('historyId'),
        'internalDate': msg.get('internalDate'),
        'sizeEstimate': msg.get('sizeEstimate'),
        'headers': _headers(msg.get('payload')),
    }


def clean_ref(msg: dict | None) -> dict:
    """Minimal {id, threadId} reference, as returned by list endpoints."""
    if not isinstance(msg, dict):
        return {}
    return {'id': msg.get('id'), 'threadId': msg.get('threadId')}


def clean_thread(thread: dict | None) -> dict:
    """Compact a thread: id, historyId, snippet, and cleaned messages."""
    if not isinstance(thread, dict):
        return {}
    return {
        'id': thread.get('id'),
        'historyId': thread.get('historyId'),
        'snippet': thread.get('snippet'),
        'messages': [clean_message(m) for m in (thread.get('messages') or [])],
    }


def clean_label(label: dict | None) -> dict:
    """Compact a label resource: id, name, type, visibility, and counts."""
    if not isinstance(label, dict):
        return {}
    return {
        k: label[k]
        for k in (
            'id',
            'name',
            'type',
            'messageListVisibility',
            'labelListVisibility',
            'messagesTotal',
            'messagesUnread',
            'threadsTotal',
            'threadsUnread',
        )
        if k in label
    }


def clean_draft(draft: dict | None) -> dict:
    """Compact a draft: id plus the cleaned embedded message."""
    if not isinstance(draft, dict):
        return {}
    return {'id': draft.get('id'), 'message': clean_message(draft.get('message'))}


def clean_attachment(att: dict | None) -> dict:
    """Compact an attachment body: attachmentId, size, and base64url data."""
    if not isinstance(att, dict):
        return {}
    return {'attachmentId': att.get('attachmentId'), 'size': att.get('size'), 'data': att.get('data')}


def clean_history(record: dict | None) -> dict:
    """Compact a history record: id plus message refs per change type."""
    if not isinstance(record, dict):
        return {}
    out: dict = {'id': record.get('id')}
    for key in ('messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved'):
        if key in record:
            out[key] = [clean_ref(e.get('message')) for e in record[key]]
    return out


def clean_filter(f: dict | None) -> dict:
    """Compact a filter resource: id, criteria, and action."""
    if not isinstance(f, dict):
        return {}
    return {k: f[k] for k in ('id', 'criteria', 'action') if k in f}


def clean_send_as(s: dict | None) -> dict:
    """Compact a sendAs alias: address, display name, signature, and status fields."""
    if not isinstance(s, dict):
        return {}
    return {
        k: s[k]
        for k in (
            'sendAsEmail',
            'displayName',
            'replyToAddress',
            'signature',
            'isPrimary',
            'isDefault',
            'verificationStatus',
            'treatAsAlias',
        )
        if k in s
    }


def clean_vacation(v: dict | None) -> dict:
    """Compact vacation responder settings to their key fields."""
    if not isinstance(v, dict):
        return {}
    return {
        k: v[k]
        for k in (
            'enableAutoReply',
            'responseSubject',
            'responseBodyPlainText',
            'responseBodyHtml',
            'restrictToContacts',
            'restrictToDomain',
            'startTime',
            'endTime',
        )
        if k in v
    }


def clean_forwarding_address(a: dict | None) -> dict:
    """Compact a forwarding address: email and verification status."""
    if not isinstance(a, dict):
        return {}
    return {k: a[k] for k in ('forwardingEmail', 'verificationStatus') if k in a}


def clean_delegate(d: dict | None) -> dict:
    """Compact a delegate: email and verification status."""
    if not isinstance(d, dict):
        return {}
    return {k: d[k] for k in ('delegateEmail', 'verificationStatus') if k in d}


def clean_imap(i: dict | None) -> dict:
    """Compact IMAP settings to their key fields."""
    if not isinstance(i, dict):
        return {}
    return {k: i[k] for k in ('enabled', 'autoExpunge', 'expungeBehavior', 'maxFolderSize') if k in i}


def clean_pop(p: dict | None) -> dict:
    """Compact POP settings: accessWindow and disposition."""
    if not isinstance(p, dict):
        return {}
    return {k: p[k] for k in ('accessWindow', 'disposition') if k in p}
