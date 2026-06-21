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
Gmail API v1 client helpers.

Credential construction (service account or user OAuth), the discovery-built
service, MIME assembly for sends, and response cleaners that turn raw Gmail
JSON into compact, agent-friendly shapes. All tool methods in IInstance call
through here.
"""

from __future__ import annotations

import base64
import binascii
import json
from email.message import EmailMessage
from typing import Any

# Gmail's per-call ceiling for batchModify / batchDelete is 1000 ids.
MAX_BATCH = 1000

# Gmail uses the special id 'me' to mean the authorized mailbox.
USER_ID = 'me'

# Headers worth surfacing from a message payload (lower-cased for matching).
_KEEP_HEADERS = ('from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'in-reply-to', 'references')


# ---------------------------------------------------------------------------
# Credentials & service
# ---------------------------------------------------------------------------


def _decode_blob(value: str) -> str:
    """Return text from a raw string or a base64 ``data:`` URL (serviceKey/userToken fields)."""
    if not value:
        raise ValueError('missing credential value')
    if value.startswith('data:'):
        _, _, payload = value.partition(',')
        try:
            return base64.b64decode(payload).decode('utf-8')
        except (binascii.Error, ValueError) as exc:
            raise ValueError(f'could not decode data-url credential: {exc}') from exc
    return value


def build_service(auth_type: str, cfg: dict, scopes: list[str]) -> Any:
    """Build a Gmail v1 service from node config, scoped to ``scopes``.

    ``auth_type`` selects service-account (serviceKey + optional adminEmail for
    domain-wide delegation) or user OAuth (userToken JSON).
    """
    from googleapiclient.discovery import build

    if auth_type == 'user':
        from google.oauth2.credentials import Credentials

        info = json.loads(_decode_blob(cfg.get('userToken') or ''))
        creds = Credentials(
            token=info.get('access_token') or info.get('token'),
            refresh_token=info.get('refresh_token'),
            token_uri=info.get('token_uri', 'https://oauth2.googleapis.com/token'),
            client_id=info.get('client_id'),
            client_secret=info.get('client_secret'),
            scopes=scopes,
        )
    else:
        from google.oauth2 import service_account

        info = json.loads(_decode_blob(cfg.get('serviceKey') or ''))
        creds = service_account.Credentials.from_service_account_info(info, scopes=scopes)
        admin_email = (cfg.get('adminEmail') or '').strip()
        if admin_email:
            # Domain-wide delegation: act as the named user.
            creds = creds.with_subject(admin_email)

    return build('gmail', 'v1', credentials=creds, cache_discovery=False)


def execute(request: Any) -> dict:
    """Run a Gmail API request, converting HttpError into a clean ValueError."""
    try:
        return request.execute() or {}
    except Exception as exc:  # googleapiclient.errors.HttpError and transport errors
        status = getattr(getattr(exc, 'resp', None), 'status', None)
        detail = getattr(exc, 'reason', None) or str(exc)
        prefix = f'Gmail API {status}: ' if status else 'Gmail request failed: '
        raise ValueError(f'{prefix}{detail}') from exc


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
    """Assemble a MIME message and return base64url-encoded raw bytes for send."""
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
    if not isinstance(thread, dict):
        return {}
    return {
        'id': thread.get('id'),
        'historyId': thread.get('historyId'),
        'snippet': thread.get('snippet'),
        'messages': [clean_message(m) for m in (thread.get('messages') or [])],
    }


def clean_label(label: dict | None) -> dict:
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
    if not isinstance(draft, dict):
        return {}
    return {'id': draft.get('id'), 'message': clean_message(draft.get('message'))}


def clean_attachment(att: dict | None) -> dict:
    if not isinstance(att, dict):
        return {}
    return {'attachmentId': att.get('attachmentId'), 'size': att.get('size'), 'data': att.get('data')}


def clean_history(record: dict | None) -> dict:
    if not isinstance(record, dict):
        return {}
    out: dict = {'id': record.get('id')}
    for key in ('messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved'):
        if key in record:
            out[key] = [clean_ref(e.get('message')) for e in record[key]]
    return out
