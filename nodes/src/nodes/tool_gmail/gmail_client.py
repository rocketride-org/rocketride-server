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
import os
import time as _time
from email.message import EmailMessage
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any
from urllib.parse import urlparse

# Gmail's per-call ceiling for batchModify / batchDelete is 1000 ids.
MAX_BATCH = 1000

# Hosts the token-refresh POST may target. The token payload is untrusted (it
# rides in saved pipes and broker responses); a token-supplied refresh URL is
# honored only if it is https and its host is one of these, so a tampered token
# can never redirect the refresh_token to an attacker host. RR_OAUTH_BROKER_URL
# lets self-hosted deployments add their own broker host.
_BROKER_HOSTS = frozenset({'oauth2.rocketride.ai', 'oauth.rocketride.ai'})


def resolve_refresh_url(token_url: object) -> str | None:
    """Validate a token-supplied refresh URL against the trusted broker hosts.

    Returns the URL when it is https and its host is a known broker host
    (built-in or the RR_OAUTH_BROKER_URL host). Returns None when the token
    carries no URL. Raises ValueError for any other value so a tampered token
    fails loud instead of silently posting credentials elsewhere.
    """
    if not token_url:
        return None
    if not isinstance(token_url, str):
        raise ValueError('Gmail token oauth_server_url must be a string')

    allowed = set(_BROKER_HOSTS)
    env_broker = os.environ.get('RR_OAUTH_BROKER_URL', '')
    if env_broker:
        env_host = urlparse(env_broker).hostname
        if env_host:
            allowed.add(env_host.lower())

    parsed = urlparse(token_url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.hostname.lower() not in allowed:
        raise ValueError(
            f'Gmail token refresh URL {token_url!r} is not a trusted OAuth broker '
            '(expected https and one of: ' + ', '.join(sorted(allowed)) + '). '
            'Reconnect your Google account, or set RR_OAUTH_BROKER_URL for a self-hosted broker.'
        )
    return token_url


# HTTP status codes worth retrying (rate-limit + transient server errors).
_RETRY_STATUSES = {429, 500, 502, 503, 504}

# Google's full-access Gmail scope — a superset of all granular Gmail scopes.
_GMAIL_FULL_SCOPE = 'https://mail.google.com/'

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
        import datetime as _dt

        from google.oauth2.credentials import Credentials

        info = json.loads(_decode_blob(cfg.get('userToken') or ''))
        access_token = info.get('access_token') or info.get('token') or ''
        refresh_token = info.get('refresh_token')
        client_id = info.get('client_id')
        client_secret = info.get('client_secret')
        token_uri = info.get('token_uri', 'https://oauth2.googleapis.com/token')
        # Untrusted input: reject any refresh URL not pointing at a known broker.
        oauth_server_url = resolve_refresh_url(info.get('oauth_server_url'))
        expiry_date_ms = info.get('expiry_date')

        expiry: '_dt.datetime | None' = None
        if expiry_date_ms:
            expiry = _dt.datetime.utcfromtimestamp(expiry_date_ms / 1000)

        granted_scopes = set((info.get('scope') or '').split())
        if granted_scopes and _GMAIL_FULL_SCOPE not in granted_scopes:
            missing = [s for s in scopes if s not in granted_scopes]
            if missing:
                raise ValueError(
                    'Gmail: your Google account authorization is missing required scopes '
                    'for the selected access tier. Please disconnect and reconnect your '
                    f'Google account. Missing: {", ".join(missing)}'
                )

        if client_id and client_secret:
            # Standard Google OAuth2 credentials: the library handles refresh automatically.
            creds = Credentials(
                token=access_token,
                refresh_token=refresh_token,
                token_uri=token_uri,
                client_id=client_id,
                client_secret=client_secret,
                scopes=scopes,
            )
            if expiry is not None:
                creds.expiry = expiry
        else:
            # Fail fast: if the token is already expired and there is no refresh path
            # (no broker URL and no client credentials), the first API call would fail
            # with a cryptic RefreshError. Surface a clear message now.
            if expiry is not None and expiry < _dt.datetime.utcnow() and not oauth_server_url:
                raise ValueError(
                    'Gmail access token has expired. Please reconnect your Google account in the node settings.'
                )
            # Broker-issued token: client_id/client_secret belong to the broker's Google app
            # and are never embedded in the token. Override refresh() so that any refresh
            # attempt (proactive or after a 401) goes to the broker instead of Google directly.
            _broker_url = oauth_server_url

            class _BrokerCredentials(Credentials):
                def refresh(self, request: object) -> None:  # type: ignore[override]
                    import urllib.error as _uerr
                    import urllib.request as _req

                    import google.auth.exceptions as _gae

                    if not _broker_url or not self.refresh_token:
                        raise _gae.RefreshError(
                            'Gmail access token has expired. Please reconnect your Google account in the node settings.'
                        )
                    body = json.dumps({'refresh_token': self.refresh_token}).encode()
                    req = _req.Request(
                        _broker_url,
                        data=body,
                        headers={'Content-Type': 'application/json'},
                        method='POST',
                    )
                    try:
                        with _req.urlopen(req, timeout=10) as resp:
                            data = json.loads(resp.read().decode())
                    except _uerr.URLError as exc:
                        raise _gae.RefreshError(
                            f'Gmail token refresh failed (broker unreachable: {exc}). '
                            'Please reconnect your Google account.'
                        ) from exc
                    self.token = data.get('access_token') or self.token
                    ms = data.get('expiry_date')
                    if ms:
                        self.expiry = _dt.datetime.utcfromtimestamp(ms / 1000)

            creds = _BrokerCredentials(
                token=access_token,
                refresh_token=refresh_token,
                token_uri=token_uri,
                client_id=None,
                client_secret=None,
                scopes=scopes,
            )
            if expiry is not None:
                creds.expiry = expiry
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
    """Run a Gmail API request with exponential-backoff retry on 429/5xx."""
    base_delay = 1.0
    for attempt in range(4):
        try:
            return request.execute() or {}
        except Exception as exc:  # googleapiclient.errors.HttpError and transport errors
            status = getattr(getattr(exc, 'resp', None), 'status', None)
            if status and int(status) in _RETRY_STATUSES and attempt < 3:
                _time.sleep(min(base_delay * (2**attempt), 60.0))
                continue
            detail = getattr(exc, 'reason', None) or str(exc)
            if status and int(status) == 403:
                raise ValueError(
                    f'Gmail API 403: {detail}. If this is a scope error, disconnect '
                    'and reconnect your Google account with the required access tier.'
                ) from exc
            prefix = f'Gmail API {status}: ' if status else 'Gmail request failed: '
            raise ValueError(f'{prefix}{detail}') from exc
    raise RuntimeError('execute: retry loop exhausted unexpectedly')  # unreachable


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
