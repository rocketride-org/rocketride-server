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

import re
import time
from typing import Any, Dict, Iterable, List, NamedTuple, Optional, Tuple
from urllib.parse import urlsplit

API_PATH = '/rest/api/3'
DEFAULT_TIMEOUT = 30
MAX_RESULTS_CAP = 100
MAX_BODY_BYTES = 32 * 1024 - 1  # Jira refuses a text field of 32,768 characters or more
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
    if status_code:
        return f'Jira API {status_code}: {detail}'
    return f'Jira: {detail}'


class Auth(NamedTuple):
    """Where and as whom to call the API."""

    site_url: str
    email: str
    api_token: str


_ATLASSIAN_HOST = re.compile(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net')


def normalize_site_url(site_url: str) -> str:
    """Check a Jira Cloud site URL and return it as ``https://<site>.atlassian.net``.

    Anything else (another scheme, a path, a query, credentials in the URL) is refused, so a config value
    can't point the token somewhere else.

    Args:
        site_url: The configured site URL.

    Returns:
        The URL with its host lower-cased and no trailing slash.

    Raises:
        JiraAPIError: The URL is not exactly an ``https://<site>.atlassian.net`` host.
    """
    raw = (site_url or '').strip().rstrip('/')
    parts = urlsplit(raw)
    host = (parts.hostname or '').lower()
    if (
        parts.scheme != 'https'
        # the whole host, exactly: a suffix test passes evil.example.com\.atlassian.net, which requests sends
        # to evil.example.com
        or not _ATLASSIAN_HOST.fullmatch(host)
        or parts.netloc.lower() != host
        or parts.path
        or parts.query
        or parts.fragment
        or parts.username
    ):
        raise JiraAPIError(0, [f'siteUrl must look like https://<site>.atlassian.net, got {raw!r}'])
    return f'https://{host}'


def _error_messages(resp) -> List[str]:
    """Jira's ``errorMessages`` and per-field ``errors``, verbatim, so an agent can fix its own JQL."""
    try:
        body = resp.json()
    except ValueError:
        body = None
    # any other shape falls back to the response text instead of raising past the tools' error envelope
    if not isinstance(body, dict):
        body = {}
    listed = body.get('errorMessages')
    fields = body.get('errors')
    messages: List[str] = []
    if isinstance(listed, list):
        messages = [str(m) for m in listed]
    if isinstance(fields, dict):
        for field, msg in fields.items():
            messages.append(f'{field}: {msg}')
    return messages or [resp.text or resp.reason or 'unknown error']


def _retry_after(resp, fallback: float) -> Optional[float]:
    """Seconds to wait before retrying a 429, or None when Jira asked for longer than we will wait."""
    delay = fallback
    value = resp.headers.get('Retry-After')
    if value:
        try:
            delay = float(value)
        except ValueError:
            pass  # an HTTP date or junk: keep the fallback
    delay = max(0.0, delay)
    if delay > MAX_RETRY_AFTER_SECONDS:
        return None
    return delay


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
    """Execute one Jira API call and return its JSON body.

    Reads retry a 429 up to twice, waiting out ``Retry-After``, and retry a 5xx or connection error once.
    Writes never retry: a write of unknown outcome must not be sent twice.

    Args:
        method: The HTTP method.
        path: The path under ``/rest/api/3``, e.g. ``/issue/PROJ-1``.
        auth: The site and the account to call it as.
        json_body: The JSON request body, if any.
        params: The query parameters, if any.
        read: Whether the call changes nothing. Default: GET only; a search POST passes ``read=True``.
        base_delay: Seconds to wait before a retry; a 429 without a usable ``Retry-After`` doubles it each time.

    Returns:
        The response's JSON object, or ``{}`` when the body is empty.

    Raises:
        JiraAPIError: An error response, a connection error, or a successful response that is not a JSON object.
    """
    import requests  # lazy

    if read is None:
        is_read = method.upper() == 'GET'
    else:
        is_read = read
    url = f'{auth.site_url}{API_PATH}{path}'
    headers = {'Accept': 'application/json'}
    if json_body is not None:
        headers['Content-Type'] = 'application/json'
    rate_retries = 0
    server_retries = 0
    while True:
        try:
            # auth=, not an Authorization header: requests lets a ~/.netrc entry for the host replace the header
            resp = requests.request(
                method,
                url,
                auth=(auth.email.encode(), auth.api_token.encode()),
                headers=headers,
                json=json_body,
                params=params,
                timeout=DEFAULT_TIMEOUT,
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
                body = resp.json()
            except ValueError as exc:
                raise JiraAPIError(status, ['expected JSON in a successful response']) from exc
            # Every caller reads the body with .get(), so a list or a bare value must
            # surface as a JiraAPIError, which the tools turn into their error envelope.
            if not isinstance(body, dict):
                raise JiraAPIError(status, ['expected a JSON object in a successful response'])
            return body
        raise JiraAPIError(status, _error_messages(resp))


# ---------------------------------------------------------------------------
# Project allowlist and JQL
# ---------------------------------------------------------------------------

_PROJECT_KEY = re.compile(r'^[A-Z][A-Z0-9_]+$')


def parse_projects(value: str) -> List[str]:
    """Split a comma-separated list of project keys into the allowlist.

    Keys are upper-cased and checked against Jira's key format, so a value can't smuggle JQL into the
    allowlist clause.

    Args:
        value: The configured keys, e.g. ``'PROJ, ops'``. Empty means every project.

    Returns:
        The keys, upper-cased, each once, in the order given.

    Raises:
        JiraAPIError: A key is not in Jira's key format.
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
    depth = 0
    quote = ''
    i = 0
    found = None
    while i < len(jql):
        ch = jql[i]
        if ch == '\\':  # JQL escapes the next character inside and outside quotes alike
            i += 2
            continue
        if quote:
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
            # matched on the original text: lower() can change its length (İ) and shift the offsets
            and re.match(r'order\s+by\b', jql[i:], re.IGNORECASE)
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
    """Limit a JQL query to the allowlist: ``project in (...) AND (<jql>) ORDER BY ...``.

    Args:
        jql: The JQL query.
        projects: The allowlist keys. With none, the JQL is returned as it is.

    Returns:
        The wrapped JQL, with any trailing ``ORDER BY`` kept last.

    Raises:
        JiraAPIError: The JQL's quotes or parentheses don't balance, so wrapping it could let it escape
            the allowlist.
    """
    keys = list(projects)
    jql = (jql or '').strip()
    if not keys:
        return jql
    start = _order_by_start(jql)
    if start is None:
        where = jql
        order = ''
    else:
        where = jql[:start].strip()
        order = jql[start:].strip()
    clause = 'project in (' + ', '.join(f'"{k}"' for k in keys) + ')'
    if where:
        clause += f' AND ({where})'
    if order:
        return f'{clause} {order}'
    return clause


# ---------------------------------------------------------------------------
# Atlassian Document Format
# ---------------------------------------------------------------------------

_BULLET = re.compile(r'^\s*[-*]\s+(.*)$')
_FENCE = re.compile(r'^\s*```\s*([\w+-]*)\s*$')


def check_body_size(text: str, what: str = 'body') -> str:
    """Refuse a description or comment over 32,767 bytes (Jira's limit is 32,767 characters) before it is sent.

    Args:
        text: The description or comment.
        what: What the text is, for the error message.

    Returns:
        ``text``, unchanged.

    Raises:
        JiraAPIError: The text is over the limit.
    """
    if len(text.encode('utf-8')) > MAX_BODY_BYTES:
        raise JiraAPIError(0, [f'the {what} is over {MAX_BODY_BYTES:,} bytes; shorten it'])
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


def _bullet_item(line: str) -> Optional[str]:
    """The text of a ``- item`` or ``* item`` line, or None when the line is not a bullet with text."""
    match = _BULLET.match(line)
    if match and match.group(1).strip():
        return match.group(1).strip()
    return None


def _is_paragraph_line(line: str) -> bool:
    """A line of paragraph text: not blank, not a code fence and not a bullet."""
    return bool(line.strip()) and not _FENCE.match(line) and _bullet_item(line) is None


def _read_code_block(lines: List[str], i: int) -> Tuple[Dict[str, Any], int]:
    """The code block whose opening fence is ``lines[i]``, and the index of the line after its closing fence.

    A fence that is never closed runs to the end of the text.
    """
    language = _FENCE.match(lines[i]).group(1)
    end = i + 1
    while end < len(lines) and not _FENCE.match(lines[end]):
        end += 1
    code = lines[i + 1 : end]
    block: Dict[str, Any] = {'type': 'codeBlock', 'content': []}
    if language:
        block['attrs'] = {'language': language}
    if any(code):
        block['content'] = [{'type': 'text', 'text': '\n'.join(code)}]
    return block, end + 1


def _read_bullet_list(lines: List[str], i: int) -> Tuple[Dict[str, Any], int]:
    """The bullet list starting at ``lines[i]``, and the index of the first line after it."""
    items: List[Dict[str, Any]] = []
    end = i
    while end < len(lines) and _bullet_item(lines[end]) is not None:
        paragraph = {'type': 'paragraph', 'content': _text_nodes(_bullet_item(lines[end]))}
        items.append({'type': 'listItem', 'content': [paragraph]})
        end += 1
    return {'type': 'bulletList', 'content': items}, end


def _read_paragraph(lines: List[str], i: int) -> Tuple[Dict[str, Any], int]:
    """The paragraph starting at ``lines[i]``, and the index of the first line after it."""
    end = i
    while end < len(lines) and _is_paragraph_line(lines[end]):
        end += 1
    return {'type': 'paragraph', 'content': _text_nodes('\n'.join(lines[i:end]))}, end


def text_to_adf(text: str) -> Dict[str, Any]:
    """Turn plain text or a small markdown subset into an ADF document.

    Blank lines separate paragraphs, ``-`` and ``*`` lines become bullet lists and fenced code becomes code
    blocks. Anything else stays literal text, with a single newline kept as a hard break.

    Args:
        text: The description or comment.

    Returns:
        An ADF ``doc`` node.
    """
    lines = (text or '').replace('\r\n', '\n').split('\n')
    content: List[Dict[str, Any]] = []
    i = 0
    while i < len(lines):
        if _FENCE.match(lines[i]):
            block, i = _read_code_block(lines, i)
        elif _bullet_item(lines[i]) is not None:
            block, i = _read_bullet_list(lines, i)
        elif lines[i].strip():
            block, i = _read_paragraph(lines, i)
        else:
            i += 1
            continue
        content.append(block)
    return {'type': 'doc', 'version': 1, 'content': content}


def _list_start(order: Any) -> int:
    """The first number of an ordered list: its ``order`` attribute, or 1 when that is missing or not a number."""
    try:
        return int(order or 1)
    except (TypeError, ValueError, OverflowError):  # OverflowError: Python's JSON parser accepts Infinity
        return 1


def adf_to_text(node: Any) -> str:
    """Flatten an ADF document, or any ADF node, into plain text.

    Blocks are separated by a blank line, bullets start with ``- ``, numbered items with ``1.`` and code
    blocks are fenced. Unknown nodes contribute their children's text.

    Args:
        node: An ADF node. Anything that is not a dict gives ``''``.

    Returns:
        The text.
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
    if kind in ('bulletList', 'orderedList', 'taskList', 'decisionList'):
        start = _list_start(attrs.get('order'))
        items = []
        for n, item in enumerate(children):
            if not isinstance(item, dict):
                continue
            if item.get('type') == kind:  # a nested list sits directly in its parent: indent it, no marker
                items.append('  ' + adf_to_text(item).replace('\n', '\n  '))
                continue
            if kind == 'orderedList':
                marker = f'{start + n}.'
            elif kind == 'taskList' and (item.get('attrs') or {}).get('state') == 'DONE':
                marker = '- [x]'
            elif kind == 'taskList':
                marker = '- [ ]'
            else:
                marker = '-'
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
        'nestedExpand',
        'tableCell',
        'tableHeader',
        'layoutSection',
        'layoutColumn',
    ):
        sep = '\n\n'
        if kind in ('listItem', 'tableRow'):
            sep = '\n'
        return sep.join(t for t in (adf_to_text(c) for c in children) if t)
    return ''.join(adf_to_text(c) for c in children)
