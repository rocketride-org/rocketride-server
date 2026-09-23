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

"""Google Docs-specific service bindings and response cleaners."""

from __future__ import annotations

import functools

from .. import google_client

SERVICE = google_client.GoogleService(
    product='Google Docs',
    api='docs',
    version='v1',
    superset_scopes=frozenset(
        {
            'https://www.googleapis.com/auth/documents',
            'https://www.googleapis.com/auth/drive',
        }
    ),
)

execute = functools.partial(google_client.execute, SERVICE)

# Cap on the body_text returned by document_get. Long documents are truncated to
# keep tool output within an agent-friendly size; a `truncated` flag signals it.
_BODY_TEXT_CAP = 50000


def extract_body_text(doc: dict | None) -> str:
    """Concatenate the plain text of every paragraph text run in a Document body."""
    if not isinstance(doc, dict):
        return ''
    body = doc.get('body') or {}
    parts: list[str] = []
    for element in body.get('content') or []:
        if not isinstance(element, dict):
            continue
        paragraph = element.get('paragraph')
        if not isinstance(paragraph, dict):
            continue
        for pe in paragraph.get('elements') or []:
            if not isinstance(pe, dict):
                continue
            text_run = pe.get('textRun')
            if isinstance(text_run, dict):
                content = text_run.get('content')
                if isinstance(content, str):
                    parts.append(content)
    return ''.join(parts)


def clean_document(doc: dict | None) -> dict:
    """Compact a Document: id, title, revisionId, and capped concatenated body text."""
    if not isinstance(doc, dict):
        return {}
    text = extract_body_text(doc)
    truncated = len(text) > _BODY_TEXT_CAP
    if truncated:
        text = text[:_BODY_TEXT_CAP]
    return {
        'documentId': doc.get('documentId'),
        'title': doc.get('title'),
        'revisionId': doc.get('revisionId'),
        'body_text': text,
        'truncated': truncated,
    }


def clean_batch_update(resp: dict | None) -> dict:
    """Compact a documents.batchUpdate response: id, reply count, and raw replies."""
    if not isinstance(resp, dict):
        return {}
    replies = resp.get('replies') or []
    return {
        'documentId': resp.get('documentId'),
        'replies_count': len(replies),
        'replies': replies,
    }
