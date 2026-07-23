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

"""Google Drive-specific service bindings, domain helpers, and response cleaners."""

from __future__ import annotations

import functools
import json
from typing import Any

from .. import google_client

_G = 'https://www.googleapis.com/auth'

SERVICE = google_client.GoogleService(
    product='Google Drive',
    api='drive',
    version='v3',
    superset_scopes=frozenset({f'{_G}/drive'}),
)

resolve_refresh_url = functools.partial(google_client.resolve_refresh_url, SERVICE)
resolve_token_uri = functools.partial(google_client.resolve_token_uri, SERVICE)
token_scope_report = functools.partial(google_client.token_scope_report, SERVICE)
build_service = functools.partial(google_client.build_service, SERVICE)
execute = functools.partial(google_client.execute, SERVICE)
_decode_blob = google_client._decode_blob

# The compact file field set requested on every metadata read/write.
_FILE_FIELDS = 'id,name,description,mimeType,parents,webViewLink,modifiedTime,size,trashed,driveId'


def execute_media(request: Any) -> bytes:
    """Run a Drive get_media/export_media request returning raw bytes."""
    return google_client.execute(SERVICE, request, binary=True)


# Consumer domains prove nothing about organisational membership: for a personal
# account the email-derived "own domain" would be gmail.com, and the sharing gate
# would then wave through a grant to ANY @gmail.com address as "same domain".
_CONSUMER_DOMAINS = frozenset({'gmail.com', 'googlemail.com'})


def _domain_or_unknown(raw_email: str) -> str | None:
    """Extract the domain of an email, mapping consumer domains to None (UNKNOWN)."""
    domain = raw_email.rsplit('@', 1)[-1].strip().lower() or None
    return None if domain in _CONSUMER_DOMAINS else domain


def resolve_account_domain(auth_type: str, cfg: dict) -> str | None:
    """Resolve the account's own domain for the sharing gate.

    Service auth: the domain of ``adminEmail`` (the impersonated user). User
    auth: the token's ``hd`` (hosted-domain) claim, else the domain of its
    ``email`` claim. Consumer domains (gmail.com/googlemail.com) resolve to
    UNKNOWN — a personal account is not an organisation, so "same domain" must
    never match another random consumer address. Returns None (UNKNOWN) when the
    domain can't be determined; callers treat UNKNOWN by gating anyone/domain
    grants and allowing user/group.
    """
    if auth_type == 'user':
        token = str(cfg.get('userToken') or '').strip()
        if not token:
            return None
        try:
            info = json.loads(_decode_blob(token))
        except Exception:
            return None
        if not isinstance(info, dict):
            # Valid JSON that isn't an object (array/string/number) must degrade
            # to UNKNOWN, not crash Drive initialization with AttributeError.
            return None
        hd = info.get('hd')
        if isinstance(hd, str) and hd.strip():
            return hd.strip().lower()
        email = info.get('email')
        if isinstance(email, str) and '@' in email:
            return _domain_or_unknown(email)
        return None
    admin = str(cfg.get('adminEmail') or '').strip()
    if admin and '@' in admin:
        return _domain_or_unknown(admin)
    return None


# ---------------------------------------------------------------------------
# Response cleaners
# ---------------------------------------------------------------------------


def clean_file(f: dict | None) -> dict:
    """Compact a Drive file resource to the agent-facing field set."""
    if not isinstance(f, dict):
        return {}
    out = {
        'id': f.get('id'),
        'name': f.get('name'),
        'description': f.get('description'),
        'mimeType': f.get('mimeType'),
        'parents': f.get('parents'),
        'webViewLink': f.get('webViewLink'),
        'modifiedTime': f.get('modifiedTime'),
        'size': f.get('size'),
        'trashed': f.get('trashed'),
        'driveId': f.get('driveId'),
    }
    return {k: v for k, v in out.items() if v is not None}


def clean_file_list(data: dict | None) -> dict:
    """Compact a files.list response: cleaned files + nextPageToken."""
    if not isinstance(data, dict):
        return {'files': []}
    out: dict = {'files': [clean_file(f) for f in data.get('files') or []]}
    if data.get('nextPageToken'):
        out['nextPageToken'] = data['nextPageToken']
    return out


def clean_permission(p: dict | None) -> dict:
    """Compact a permission resource: id, type, role, grantee, discoverability."""
    if not isinstance(p, dict):
        return {}
    out = {
        'id': p.get('id'),
        'type': p.get('type'),
        'role': p.get('role'),
        'emailAddress': p.get('emailAddress'),
        'domain': p.get('domain'),
        'allowFileDiscovery': p.get('allowFileDiscovery'),
    }
    return {k: v for k, v in out.items() if v is not None}


def clean_drive(d: dict | None) -> dict:
    """Compact a shared-drive resource: id + name."""
    if not isinstance(d, dict):
        return {}
    out = {'id': d.get('id'), 'name': d.get('name')}
    return {k: v for k, v in out.items() if v is not None}


def clean_change(c: dict | None) -> dict:
    """Compact a change record: fileId, removed, time, and the cleaned file."""
    if not isinstance(c, dict):
        return {}
    out: dict = {
        'fileId': c.get('fileId'),
        'removed': c.get('removed'),
        'time': c.get('time'),
    }
    if isinstance(c.get('file'), dict):
        out['file'] = clean_file(c['file'])
    return {k: v for k, v in out.items() if v is not None}


def clean_binary(file_id: str, mime_type: str | None, size: int, data_base64: str) -> dict:
    """Shape a downloaded/exported blob for return: id, mimeType, byte size, base64."""
    return {
        'fileId': file_id,
        'mimeType': mime_type,
        'size': size,
        'data_base64': data_base64,
    }
