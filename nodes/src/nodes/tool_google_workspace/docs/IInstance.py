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
Google Docs tool node instance.

Exposes the Docs v1 surface as agent tools: read a document's text, create
documents, and mutate them via batchUpdate — plus typed convenience wrappers
(append text, replace text, insert an image, insert a table) over the same
endpoint. Write operations require the ``write`` tier.

Operational targets (documentId) are always invoke-time parameters — never node
config.
"""

from __future__ import annotations

from rocketlib import tool_function

from ai.common.utils import normalize_tool_input, require_int, require_str

from ..IInstance import GoogleToolInstanceBase
from .client import (
    SERVICE,
    clean_batch_update,
    clean_document,
    execute,
)
from .IGlobal import IGlobal

# insertTable clamps (Docs API caps: 1..1000 rows, 1..25 columns).
_MAX_TABLE_ROWS = 1000
_MAX_TABLE_COLS = 25
_DOCUMENT_FIELDS = 'documentId,title,revisionId,body(content(paragraph(elements(textRun(content)))))'

# The Docs API has no list/about-style endpoint to probe cheaply, so check_connection asks
# for a document that can't exist. Google's front-end enforces API-enablement before it
# resolves the resource, so a 404 here still proves the API itself is reachable; anything
# else (esp. a 403 accessNotConfigured) is a real connectivity problem and must propagate.
_CONNECTION_PROBE_DOCUMENT_ID = 'rocketride-connection-probe-0000000000000000'


def _probe_connection(svc) -> None:
    try:
        execute(svc.documents().get(documentId=_CONNECTION_PROBE_DOCUMENT_ID, fields='documentId'))
    except ValueError as exc:
        if getattr(exc, 'status', None) == 404:
            return
        raise


class IInstance(GoogleToolInstanceBase):
    IGlobal: IGlobal
    SERVICE = SERVICE

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    @staticmethod
    def _opt_number(args: dict, key: str, op: str) -> float | None:
        """Read an optional numeric arg (int/float); reject bools and non-numbers when present."""
        value = args.get(key)
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f'{op}: "{key}" must be a number')
        return value

    @staticmethod
    def _clamp(value: int, low: int, high: int) -> int:
        """Clamp an integer to the inclusive [low, high] range."""
        return max(low, min(high, value))

    # =======================================================================
    # DIAGNOSTICS
    # =======================================================================

    @tool_function(
        description=(
            'Check the Google Docs connection: makes a live probe call against the Docs API and '
            "verifies that the granted OAuth scopes cover the node's configured access tier. Call "
            'this when a Docs operation fails with a scope or permission error. Returns '
            'connection_ok: true only when the live probe succeeds and the required scopes are '
            'present.'
        ),
        input_schema={'type': 'object', 'properties': {}, 'required': []},
    )
    def check_connection(self, args: dict) -> dict:
        """Check Docs connection status: live API probe plus granted-scope coverage. Read-only."""
        return self._check_connection_impl(probe=_probe_connection)

    # =======================================================================
    # READ
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['documentId'],
            'properties': {
                'documentId': {'type': 'string', 'description': 'The document id (from its URL)'},
            },
        },
        description=(
            'Read a document: returns {documentId, title, revisionId, body_text} where body_text is the '
            'concatenated plain text of the paragraph text runs. Long documents are capped and flagged with '
            "truncated: true. Use to fetch a document's current text content."
        ),
    )
    def document_get(self, args: dict) -> dict:
        """Read a document's title, revision, and concatenated body text. Read-only."""
        args = normalize_tool_input(args, tool_name='tool_docs')
        doc_id = require_str(args, 'documentId', tool_name='document_get')
        data = execute(self._svc().documents().get(documentId=doc_id, fields=_DOCUMENT_FIELDS))
        return clean_document(data)

    # =======================================================================
    # WRITE
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['title'],
            'properties': {
                'title': {'type': 'string', 'description': 'Title for the new document'},
                'text': {
                    'type': 'string',
                    'description': 'Optional initial body text, inserted via a follow-up batchUpdate insertText',
                },
            },
        },
        description=(
            'Create a new document with the given title, optionally seeding it with initial body text. '
            'Returns {documentId, title, revisionId, body_text}. Requires the write tier.'
        ),
    )
    def document_create(self, args: dict) -> dict:
        """Create a document, optionally seeding initial text. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_docs')
        self._access().require_write('document_create')
        title = require_str(args, 'title', tool_name='document_create')
        text = args.get('text')
        if text is not None and not isinstance(text, str):
            raise ValueError('document_create: "text" must be a string')
        created = execute(self._svc().documents().create(body={'title': title}))
        if text:
            doc_id = created.get('documentId')
            requests = [{'insertText': {'endOfSegmentLocation': {}, 'text': text}}]
            try:
                execute(self._svc().documents().batchUpdate(documentId=doc_id, body={'requests': requests}))
                created = execute(self._svc().documents().get(documentId=doc_id, fields=_DOCUMENT_FIELDS))
            except ValueError as exc:
                # execute() normalizes API failures to ValueError; programming errors
                # still propagate. The document already exists; surface its id instead
                # of raising so a retrying agent seeds THIS document rather than
                # creating an orphan copy.
                out = clean_document(created)
                out['warning'] = (
                    f'document {doc_id} was created, but seeding or read-back failed: {exc}. '
                    'Retry with batch_update or text_append on this documentId instead of '
                    'calling document_create again.'
                )
                return out
        return clean_document(created)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['documentId', 'requests'],
            'properties': {
                'documentId': {'type': 'string', 'description': 'The document id'},
                'requests': {
                    'type': 'array',
                    'items': {'type': 'object'},
                    'description': 'List of Docs API batchUpdate request objects',
                },
            },
        },
        description=(
            'The catch-all write endpoint: apply a list of Docs batchUpdate requests. Use this for any '
            'structural change not covered by a dedicated wrapper (styling, named ranges, deletes, list '
            'formatting, positioned inserts). Pass the full requests list (e.g. '
            '[{"insertText": {...}}, {"updateParagraphStyle": {...}}]). Returns {documentId, replies_count, '
            'replies}. Requires the write tier.'
        ),
    )
    def batch_update(self, args: dict) -> dict:
        """Apply a list of Docs batchUpdate requests (structure/styling/positioned inserts). Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_docs')
        self._access().require_write('batch_update')
        doc_id = require_str(args, 'documentId', tool_name='batch_update')
        requests = args.get('requests')
        if not isinstance(requests, list) or not requests:
            raise ValueError('batch_update: "requests" must be a non-empty list of Docs batchUpdate request objects')
        if not all(isinstance(r, dict) for r in requests):
            raise ValueError('batch_update: each request must be an object')
        data = execute(self._svc().documents().batchUpdate(documentId=doc_id, body={'requests': requests}))
        return clean_batch_update(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['documentId', 'text'],
            'properties': {
                'documentId': {'type': 'string', 'description': 'The document id'},
                'text': {
                    'type': 'string',
                    'description': (
                        'Text to append verbatim at the end of the document body — whitespace and '
                        'newlines are preserved (start with \\n to begin a new paragraph)'
                    ),
                },
            },
        },
        description=(
            'Convenience wrapper over batch_update: append text at the end of the document body '
            '(insertText at endOfSegmentLocation, no index math). The text is inserted exactly as given — '
            'leading/trailing whitespace and newlines are preserved. Returns {documentId, replies_count, '
            'replies}. Requires the write tier.'
        ),
    )
    def text_append(self, args: dict) -> dict:
        """Append text at the end of the document body. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_docs')
        self._access().require_write('text_append')
        doc_id = require_str(args, 'documentId', tool_name='text_append')
        # NOT require_str: whitespace is significant here (a leading newline is
        # how an agent starts a new paragraph), so the text must not be stripped.
        text = args.get('text')
        if not isinstance(text, str) or not text:
            raise ValueError('text_append: "text" must be a non-empty string (whitespace is preserved verbatim)')
        requests = [{'insertText': {'endOfSegmentLocation': {}, 'text': text}}]
        data = execute(self._svc().documents().batchUpdate(documentId=doc_id, body={'requests': requests}))
        return clean_batch_update(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['documentId', 'containsText', 'text'],
            'properties': {
                'documentId': {'type': 'string', 'description': 'The document id'},
                'containsText': {'type': 'string', 'description': 'The text to find (all occurrences)'},
                'text': {
                    'type': 'string',
                    'description': (
                        'The replacement text, used verbatim (whitespace preserved). May be an empty '
                        'string to delete every occurrence of containsText.'
                    ),
                },
                'matchCase': {
                    'type': 'boolean',
                    'description': 'Whether the search is case-sensitive (default false)',
                },
            },
        },
        description=(
            'Convenience wrapper over batch_update: replace all occurrences of a string throughout the '
            'document (replaceAllText). The replacement is used verbatim (whitespace preserved) and may be '
            'empty to delete occurrences. matchCase defaults to false. Returns {documentId, occurrencesChanged}. '
            'Requires the write tier.'
        ),
    )
    def text_replace(self, args: dict) -> dict:
        """Replace all occurrences of a string in the document. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_docs')
        self._access().require_write('text_replace')
        doc_id = require_str(args, 'documentId', tool_name='text_replace')
        contains = require_str(args, 'containsText', tool_name='text_replace')
        # NOT require_str: '' is the Docs way to delete occurrences, and trailing
        # whitespace in the replacement is significant — no strip, no non-empty rule.
        replacement = args.get('text')
        if not isinstance(replacement, str):
            raise ValueError('text_replace: "text" must be a string (may be empty to delete occurrences)')
        match_case = args.get('matchCase')
        if match_case is None:
            match_case = False
        elif not isinstance(match_case, bool):
            raise ValueError('text_replace: "matchCase" must be a boolean')
        # Always send matchCase explicitly rather than relying on the API's implicit default.
        requests = [
            {
                'replaceAllText': {
                    'containsText': {'text': contains, 'matchCase': match_case},
                    'replaceText': replacement,
                }
            }
        ]
        data = execute(self._svc().documents().batchUpdate(documentId=doc_id, body={'requests': requests}))
        replies = data.get('replies') or []
        occurrences = ((replies[0] if replies else {}) or {}).get('replaceAllText', {}).get('occurrencesChanged', 0)
        return {'documentId': data.get('documentId') or doc_id, 'occurrencesChanged': occurrences}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['documentId', 'uri'],
            'properties': {
                'documentId': {'type': 'string', 'description': 'The document id'},
                'uri': {'type': 'string', 'description': 'Publicly reachable https:// image URL'},
                'width': {'type': 'number', 'description': 'Optional image width in points (PT)'},
                'height': {'type': 'number', 'description': 'Optional image height in points (PT)'},
            },
        },
        description=(
            'Convenience wrapper over batch_update: insert an inline image at the end of the document body '
            '(insertInlineImage at endOfSegmentLocation). The uri must be a publicly reachable https:// URL. '
            'width/height are optional and in points (PT). Returns {documentId, replies_count, replies}. '
            'Requires the write tier.'
        ),
    )
    def image_insert(self, args: dict) -> dict:
        """Insert an inline image at the end of the document body. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_docs')
        self._access().require_write('image_insert')
        doc_id = require_str(args, 'documentId', tool_name='image_insert')
        uri = require_str(args, 'uri', tool_name='image_insert')
        if not uri.startswith('https://'):
            raise ValueError('image_insert: "uri" must be a publicly reachable https:// URL')
        insert: dict = {'endOfSegmentLocation': {}, 'uri': uri}
        width = self._opt_number(args, 'width', 'image_insert')
        height = self._opt_number(args, 'height', 'image_insert')
        object_size: dict = {}
        if width is not None:
            object_size['width'] = {'magnitude': width, 'unit': 'PT'}
        if height is not None:
            object_size['height'] = {'magnitude': height, 'unit': 'PT'}
        if object_size:
            insert['objectSize'] = object_size
        requests = [{'insertInlineImage': insert}]
        data = execute(self._svc().documents().batchUpdate(documentId=doc_id, body={'requests': requests}))
        return clean_batch_update(data)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['documentId', 'rows', 'columns'],
            'properties': {
                'documentId': {'type': 'string', 'description': 'The document id'},
                'rows': {'type': 'integer', 'description': 'Number of rows (clamped to 1..1000)'},
                'columns': {'type': 'integer', 'description': 'Number of columns (clamped to 1..25)'},
            },
        },
        description=(
            'Convenience wrapper over batch_update: insert an empty table at the end of the document body '
            '(insertTable at endOfSegmentLocation). rows is clamped to 1..1000 and columns to 1..25. '
            'Returns {documentId, replies_count, replies}. Requires the write tier.'
        ),
    )
    def table_insert(self, args: dict) -> dict:
        """Insert an empty rows×columns table at the end of the document body. Requires the write tier."""
        args = normalize_tool_input(args, tool_name='tool_docs')
        self._access().require_write('table_insert')
        doc_id = require_str(args, 'documentId', tool_name='table_insert')
        rows = self._clamp(require_int(args, 'rows', tool_name='table_insert'), 1, _MAX_TABLE_ROWS)
        cols = self._clamp(require_int(args, 'columns', tool_name='table_insert'), 1, _MAX_TABLE_COLS)
        requests = [{'insertTable': {'endOfSegmentLocation': {}, 'rows': rows, 'columns': cols}}]
        data = execute(self._svc().documents().batchUpdate(documentId=doc_id, body={'requests': requests}))
        return clean_batch_update(data)
