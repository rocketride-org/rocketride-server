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

"""Jira Cloud REST API v3 client: basic auth, retry, error mapping, the Atlassian
Document Format (ADF) helpers that description and comment bodies need, and the
JQL wrapping that keeps a search inside the node's project allowlist.

VERIFIED SURFACE (developer.atlassian.com/cloud/jira/platform/rest/v3/):
- Auth: HTTP basic with ``email:api_token`` for an unscoped token from
  id.atlassian.com, against ``https://<site>.atlassian.net/rest/api/3``.
  Scoped tokens need the ``api.atlassian.com/ex/jira/{cloudId}`` gateway and are
  not supported here.
- Search: ``POST /search/jql``. The old ``/search`` endpoint is removed from Jira
  Cloud. The new one returns only issue ids unless ``fields`` is passed, has no
  ``total``, pages with ``nextPageToken`` and marks the last page with ``isLast``.
- Description and comment bodies are ADF documents in v3, not plain text.
- A 429 carries ``Retry-After``; Atlassian says to retry only idempotent calls.

No engine imports: the node's IInstance adapts ``JiraAPIError`` into its
``{success, error}`` result envelope.
"""

from __future__ import annotations

import base64
import re
import time
from typing import Any, Dict, Iterable, List, NamedTuple, Optional
from urllib.parse import urlsplit

API_PATH = '/rest/api/3'
DEFAULT_TIMEOUT = 30
MAX_RESULTS_CAP = 100
MAX_BODY_BYTES = 32 * 1024
# a Retry-After longer than this is reported instead of waited out, so one tool call can't stall an agent
MAX_RETRY_AFTER_SECONDS = 30.0
READ_RATE_LIMIT_RETRIES = 2
READ_SERVER_ERROR_RETRIES = 1


class JiraAPIError(ValueError):
    """Raised for every failure: an error response, a connection error or an invalid input."""

    def __init__(self, status_code: int, messages: List[str]):
        self.status_code = status_code
        self.messages = messages
        super().__init__(_describe(status_code, messages))


def _describe(status_code: int, messages: List[str]) -> str:
    detail = '; '.join(m for m in messages if m) or 'no details'
    if status_code == 401:
        return f'Jira API 401: the email or API token was rejected ({detail})'
    if status_code == 403:
        return f'Jira API 403: the account lacks permission for this project or action ({detail})'
    if status_code == 404:
        return f'Jira API 404: not found, or not visible to this account ({detail})'
    if status_code == 429:
        return f'Jira API 429: rate limited ({detail})'
    return f'Jira API {status_code}: {detail}' if status_code else f'Jira: {detail}'


class Auth(NamedTuple):
    """Where and as whom to call the API."""

    site_url: str
    email: str
    api_token: str


def normalize_site_url(site_url: str) -> str:
    """``https://<site>.atlassian.net`` without a trailing slash. Anything else (another scheme, a path,
    a query, credentials in the URL) is refused, so a config value can't point the token somewhere else.
    """
    raw = (site_url or '').strip().rstrip('/')
    parts = urlsplit(raw)
    if parts.scheme != 'https' or not parts.hostname or parts.path or parts.query or parts.fragment or parts.username:
        raise JiraAPIError(0, [f'siteUrl must look like https://<site>.atlassian.net, got {raw!r}'])
    return f'https://{parts.netloc}'


def _auth_header(auth: Auth) -> str:
    pair = f'{auth.email}:{auth.api_token}'.encode()
    return 'Basic ' + base64.b64encode(pair).decode('ascii')


def _error_messages(resp) -> List[str]:
    """Jira's ``errorMessages`` and per-field ``errors``, verbatim, so an agent can fix its own JQL."""
    try:
        body = resp.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        messages = [str(m) for m in body.get('errorMessages') or []]
        messages += [f'{field}: {msg}' for field, msg in (body.get('errors') or {}).items()]
        if messages:
            return messages
    return [resp.text or resp.reason or 'unknown error']


def _retry_after(resp, fallback: float) -> Optional[float]:
    """Seconds to wait before retrying a 429, or None when Jira asked for longer than we will wait."""
    value = resp.headers.get('Retry-After')
    try:
        delay = float(value) if value else fallback
    except ValueError:
        delay = fallback
    return delay if delay <= MAX_RETRY_AFTER_SECONDS else None


def request(
    method: str,
    path: str,
    *,
    auth: Auth,
    json_body: Optional[Dict[str, Any]] = None,
    params: Optional[Dict[str, Any]] = None,
    read: Optional[bool] = None,
    base_delay: float = 1.0,
) -> Dict[str, Any]:
    """Execute one Jira API call and return its JSON body ({} when empty).

    ``read`` marks a call that changes nothing (default: GET only; a search POST passes ``read=True``).
    Reads retry a 429 up to twice, waiting out ``Retry-After``, and retry a 5xx or connection error once.
    Writes never retry: a write of unknown outcome must not be sent twice.
    """
    import requests  # lazy

    is_read = method.upper() == 'GET' if read is None else read
    url = f'{auth.site_url}{API_PATH}{path}'
    headers = {'Authorization': _auth_header(auth), 'Accept': 'application/json'}
    if json_body is not None:
        headers['Content-Type'] = 'application/json'
    rate_retries = server_retries = 0
    while True:
        try:
            resp = requests.request(
                method, url, headers=headers, json=json_body, params=params, timeout=DEFAULT_TIMEOUT
            )
        except requests.exceptions.RequestException as exc:
            if is_read and server_retries < READ_SERVER_ERROR_RETRIES:
                server_retries += 1
                time.sleep(base_delay)
                continue
            raise JiraAPIError(0, [f'connection error: {type(exc).__name__}: {exc}']) from exc

        status = resp.status_code
        if status == 429 and is_read and rate_retries < READ_RATE_LIMIT_RETRIES:
            delay = _retry_after(resp, base_delay * (2**rate_retries))
            if delay is not None:
                rate_retries += 1
                time.sleep(delay)
                continue
        if 500 <= status < 600 and is_read and server_retries < READ_SERVER_ERROR_RETRIES:
            server_retries += 1
            time.sleep(base_delay)
            continue

        if resp.ok:
            if not resp.content:
                return {}
            try:
                return resp.json()
            except ValueError as exc:
                raise JiraAPIError(status, ['expected JSON in a successful response']) from exc
        raise JiraAPIError(status, _error_messages(resp))


# ---------------------------------------------------------------------------
# Project allowlist and JQL
# ---------------------------------------------------------------------------

_PROJECT_KEY = re.compile(r'^[A-Z][A-Z0-9_]+$')


def parse_projects(value: str) -> List[str]:
    """Comma-separated project keys into a list ('' means every project). Keys are upper-cased and checked
    against Jira's key format, so a value can't smuggle JQL into the allowlist clause.
    """
    keys: List[str] = []
    for part in (value or '').split(','):
        key = part.strip().upper()
        if not key:
            continue
        if not _PROJECT_KEY.match(key):
            raise JiraAPIError(0, [f'invalid project key in the allowlist: {part.strip()!r}'])
        if key not in keys:
            keys.append(key)
    return keys


def _order_by_start(jql: str) -> Optional[int]:
    """Index of a trailing ``ORDER BY`` outside quotes and parentheses, or None.

    Raises when quotes or parentheses don't balance: wrapped as ``project in (...) AND (<jql>)``, a JQL with
    an extra ``)`` could close the wrapper and escape the allowlist (``x = 1) OR (project = OTHER``).
    """
    depth, quote, i, found = 0, '', 0, None
    lowered = jql.lower()
    while i < len(jql):
        ch = jql[i]
        if quote:
            if ch == '\\':
                i += 2
                continue
            if ch == quote:
                quote = ''
        elif ch in ('"', "'"):
            quote = ch
        elif ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
            if depth < 0:
                raise JiraAPIError(0, ['JQL has an unmatched ")"'])
        elif (
            depth == 0
            and re.match(r'order\s+by\b', lowered[i:])
            and (i == 0 or not (jql[i - 1].isalnum() or jql[i - 1] == '_'))
        ):
            found = i
        i += 1
    if quote:
        raise JiraAPIError(0, ['JQL has an unterminated quote'])
    if depth:
        raise JiraAPIError(0, ['JQL has an unmatched "("'])
    return found


def wrap_jql(jql: str, projects: Iterable[str]) -> str:
    """Limit ``jql`` to ``projects``: ``project in (...) AND (<jql>) ORDER BY ...``. With no projects the JQL
    is returned as it is.
    """
    keys = list(projects)
    jql = (jql or '').strip()
    if not keys:
        return jql
    start = _order_by_start(jql)
    where, order = (jql, '') if start is None else (jql[:start].strip(), jql[start:].strip())
    clause = 'project in (' + ', '.join(f'"{k}"' for k in keys) + ')'
    if where:
        clause += f' AND ({where})'
    return f'{clause} {order}' if order else clause


# ---------------------------------------------------------------------------
# Atlassian Document Format
# ---------------------------------------------------------------------------

_BULLET = re.compile(r'^\s*[-*]\s+(.*)$')
_FENCE = re.compile(r'^\s*```\s*([\w+-]*)\s*$')


def check_body_size(text: str, what: str = 'body') -> str:
    """Refuse a description or comment over 32 KB before it is sent."""
    if len(text.encode('utf-8')) > MAX_BODY_BYTES:
        raise JiraAPIError(0, [f'the {what} is over {MAX_BODY_BYTES // 1024} KB; shorten it'])
    return text


def _text_nodes(text: str) -> List[Dict[str, Any]]:
    """A paragraph's inline content: text with hard breaks for single newlines. ADF rejects empty text."""
    nodes: List[Dict[str, Any]] = []
    for i, line in enumerate(text.split('\n')):
        if i:
            nodes.append({'type': 'hardBreak'})
        if line:
            nodes.append({'type': 'text', 'text': line})
    return nodes


def text_to_adf(text: str) -> Dict[str, Any]:
    """Plain text or a small markdown subset into an ADF document: blank-line-separated paragraphs,
    ``-``/``*`` bullet lists and fenced code blocks. Anything else stays literal text.
    """
    content: List[Dict[str, Any]] = []
    paragraph: List[str] = []
    bullets: List[str] = []
    lines = (text or '').replace('\r\n', '\n').split('\n')

    def flush() -> None:
        if paragraph:
            nodes = _text_nodes('\n'.join(paragraph))
            if nodes:
                content.append({'type': 'paragraph', 'content': nodes})
            paragraph.clear()
        if bullets:
            items = [
                {'type': 'listItem', 'content': [{'type': 'paragraph', 'content': _text_nodes(b)}]} for b in bullets
            ]
            content.append({'type': 'bulletList', 'content': items})
            bullets.clear()

    i = 0
    while i < len(lines):
        line = lines[i]
        fence = _FENCE.match(line)
        if fence:
            flush()
            code: List[str] = []
            i += 1
            while i < len(lines) and not _FENCE.match(lines[i]):
                code.append(lines[i])
                i += 1
            block: Dict[str, Any] = {'type': 'codeBlock', 'content': []}
            if fence.group(1):
                block['attrs'] = {'language': fence.group(1)}
            if any(code):
                block['content'] = [{'type': 'text', 'text': '\n'.join(code)}]
            content.append(block)
            i += 1  # past the closing fence (or the end of the text)
            continue
        bullet = _BULLET.match(line)
        if bullet and bullet.group(1).strip():
            if paragraph:
                flush()
            bullets.append(bullet.group(1).strip())
        elif not line.strip():
            flush()
        else:
            if bullets:
                flush()
            paragraph.append(line)
        i += 1
    flush()
    return {'type': 'doc', 'version': 1, 'content': content}


def adf_to_text(node: Any) -> str:
    """Flatten an ADF document (or any node) into plain text: one block per paragraph, ``- `` for bullets,
    ``1.`` for numbered items, fenced code blocks. Unknown nodes contribute their children's text.
    """
    if not isinstance(node, dict):
        return ''
    kind = node.get('type')
    attrs = node.get('attrs') or {}
    children = node.get('content') or []
    if kind == 'text':
        return str(node.get('text') or '')
    if kind == 'hardBreak':
        return '\n'
    if kind in ('mention', 'emoji', 'status', 'date'):
        return str(attrs.get('text') or attrs.get('shortName') or attrs.get('timestamp') or '')
    if kind in ('inlineCard', 'blockCard', 'embedCard'):
        return str(attrs.get('url') or '')
    if kind == 'codeBlock':
        return f'```{attrs.get("language") or ""}\n' + ''.join(adf_to_text(c) for c in children) + '\n```'
    if kind in ('bulletList', 'orderedList'):
        start = int(attrs.get('order') or 1)
        items = []
        for n, item in enumerate(children):
            marker = '-' if kind == 'bulletList' else f'{start + n}.'
            items.append(f'{marker} ' + adf_to_text(item).replace('\n', '\n  '))
        return '\n'.join(items)
    if kind in (
        'doc',
        'listItem',
        'blockquote',
        'panel',
        'table',
        'tableRow',
        'expand',
        'layoutSection',
        'layoutColumn',
    ):
        sep = '\n' if kind in ('listItem', 'tableRow') else '\n\n'
        return sep.join(t for t in (adf_to_text(c) for c in children) if t)
    return ''.join(adf_to_text(c) for c in children)
