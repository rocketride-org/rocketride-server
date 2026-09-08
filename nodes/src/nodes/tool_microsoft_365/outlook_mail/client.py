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

"""Outlook Mail service bindings, message/recipient builders, and response cleaners."""

from __future__ import annotations

import functools
import html as _html
import re as _re
import urllib.parse

from .. import graph_client

SERVICE = graph_client.GraphService(product='Outlook Mail', superset_scopes=frozenset({'Mail.ReadWrite'}))

token_scope_report = functools.partial(graph_client.token_scope_report, SERVICE)
request = functools.partial(graph_client.request, SERVICE)

# Graph's ceiling this node applies to list_messages' $top.
MAX_TOP = 100
# Graph accepts inline fileAttachment bodies only *below* 3 MB; larger files
# need an upload session (not supported by this tool).
MAX_INLINE_ATTACHMENT_BYTES = 3 * 1024 * 1024

# Odata relational/function hints: a query containing one of these is passed
# through as a raw $filter expression instead of being wrapped as a $search
# term (e.g. "isRead eq false" or "startswith(subject,'Invoice')").
_ODATA_FILTER_HINTS = (' eq ', ' ne ', ' gt ', ' lt ', ' ge ', ' le ', 'startswith(', 'contains(')


def _seg(value: str) -> str:
    """URL-encode a single path segment (message/folder/attachment ids may contain '!' etc.)."""
    return urllib.parse.quote(value, safe='')


def looks_like_odata_filter(query: str) -> bool:
    """True when ``query`` reads as a raw OData filter expression rather than free-text search."""
    q = query.lower()
    return any(hint in q for hint in _ODATA_FILTER_HINTS)


# ---------------------------------------------------------------------------
# Message / recipient builders
# ---------------------------------------------------------------------------


def recipients(emails: list[str]) -> list[dict]:
    """Build a Graph ``recipients`` array: ``[{'emailAddress': {'address': e}}, ...]``."""
    return [{'emailAddress': {'address': e}} for e in emails]


def message_body(
    subject: str,
    body: str,
    to: list[str],
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    html: bool = False,
) -> dict:
    """Build a Graph ``message`` resource body for send/draft/update calls."""
    out: dict = {
        'subject': subject,
        'body': {'contentType': 'HTML' if html else 'Text', 'content': body},
        'toRecipients': recipients(to),
    }
    if cc:
        out['ccRecipients'] = recipients(cc)
    if bcc:
        out['bccRecipients'] = recipients(bcc)
    return out


# ---------------------------------------------------------------------------
# HTML -> text normalization
# ---------------------------------------------------------------------------

_TAG_RE = _re.compile(r'<[^>]+>')
_BLOCK_BREAK_RE = _re.compile(r'</(?:p|div|li|tr|h[1-6])\s*>|<br\s*/?>', _re.IGNORECASE)
# Outlook HTML bodies routinely embed a large <style> block (mso-* CSS) in
# <head>, and occasionally <script>; both must be dropped *with their
# contents* before tag-stripping, or their raw text leaks into the readable
# body (tag-stripping alone only removes the <style>/<script> tags, not what's
# between them).
_STYLE_SCRIPT_RE = _re.compile(r'<(style|script)\b[^>]*>.*?</\1\s*>', _re.IGNORECASE | _re.DOTALL)
# Likewise Outlook's conditional comments (``<!--[if gte mso 9]><xml>...
# <![endif]-->``): _TAG_RE only eats up to the first ``>``, so the comment's
# contents must be dropped as a block too.
_COMMENT_RE = _re.compile(r'<!--.*?-->', _re.DOTALL)


def html_to_text(content: str) -> str:
    """Pragmatically convert an HTML message body to readable plain text.

    Not a full HTML parser (no extra dependency pulled in for it): entire
    ``<style>``/``<script>`` elements and ``<!-- -->`` comments (including
    their contents) are dropped first,
    then block-level closing tags and ``<br>`` become newlines, remaining
    tags are stripped, entities are unescaped, and blank-line runs are
    collapsed. Good enough to surface a readable body from Graph's
    ``body.content`` when ``body.contentType`` is ``html``.
    """
    if not content:
        return ''
    text = _STYLE_SCRIPT_RE.sub('', content)
    text = _COMMENT_RE.sub('', text)
    text = _BLOCK_BREAK_RE.sub('\n', text)
    text = _TAG_RE.sub('', text)
    text = _html.unescape(text)
    out_lines: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line or (out_lines and out_lines[-1]):
            out_lines.append(line)
    return '\n'.join(out_lines).strip()


# ---------------------------------------------------------------------------
# Response cleaners
# ---------------------------------------------------------------------------

_MESSAGE_FIELDS = (
    'id',
    'subject',
    'from',
    'toRecipients',
    'receivedDateTime',
    'bodyPreview',
    'isRead',
    'hasAttachments',
    'parentFolderId',
)

_FOLDER_FIELDS = ('id', 'displayName', 'parentFolderId', 'childFolderCount', 'totalItemCount', 'unreadItemCount')

_ATTACHMENT_META_FIELDS = ('id', 'name', 'contentType', 'size')

# $select strings for list endpoints, built from the cleaner field tuples so
# the wire request and the response cleaner can never drift apart.
MESSAGE_SELECT = ','.join(_MESSAGE_FIELDS)
ATTACHMENT_SELECT = ','.join(_ATTACHMENT_META_FIELDS)


def clean_message(msg: dict | None, *, full: bool = False) -> dict:
    """Compact a Graph message. ``full=True`` (get_message) adds a readable ``body``."""
    if not isinstance(msg, dict):
        return {}
    out = {k: msg.get(k) for k in _MESSAGE_FIELDS if k in msg}
    if full:
        body = msg.get('body') or {}
        content = body.get('content') or ''
        content_type = (body.get('contentType') or 'text').lower()
        out['body'] = html_to_text(content) if content_type == 'html' else content
    return out


def clean_folder(folder: dict | None) -> dict:
    if not isinstance(folder, dict):
        return {}
    return {k: folder.get(k) for k in _FOLDER_FIELDS if k in folder}


def clean_attachment_meta(att: dict | None) -> dict:
    if not isinstance(att, dict):
        return {}
    return {k: att.get(k) for k in _ATTACHMENT_META_FIELDS if k in att}
