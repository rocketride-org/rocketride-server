# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.


"""
Redaction of credentials in uvicorn's request log lines.

uvicorn logs every HTTP response start on the ``uvicorn.access`` logger with the
template ``'%s - "%s %s HTTP/%s" %d'`` and five positional args (client, method,
request target, HTTP version, status), and every WebSocket handshake on
``uvicorn.error`` with a template starting ``'%s - "WebSocket %s"'`` and the
target as the second arg. The target holds the full path and raw query string.

Engine routes take credentials in both places: an OAuth callback's ``code`` and
``state``, the ``?auth=`` header fallback, a signed ``/task/fetch?token=``, the
broker's ``?tokens=``, and the signed ``/task/fetch/{token}/{subpath}`` of
directory-capability URLs.

``RequestTargetRedactor`` is a ``logging.Filter`` installed on those two loggers.
For a request-line record, recognised by template and argument count, it redacts
the target, whatever the target's form: ``/path?q`` for an origin-form request
line, ``http%3A//host/path?q`` when the h11 backend receives an absolute-form
one. It replaces the values of credential-like query parameters (see
``is_sensitive_param``), the ``/task/fetch/{token}`` segment and the
``user:password@`` part of an absolute-form target. Any other record on those
loggers fails closed: every word of its message and arguments goes through the
same redaction, so a URL in a template a later uvicorn adds is redacted too.
Numbers keep their type, so ``%d`` still formats.

A logger-level filter runs before any handler, so every handler and formatter,
the stock ``AccessFormatter`` included, sees only the redacted args. The ASGI
scope is untouched: authentication, the OAuth code exchange and file delivery
keep the real values.

The name list is not exhaustive. Not covered: ``;`` as a query separator,
credentials nested inside another parameter's value, names that match neither
the list nor an ending in ``SENSITIVE_PARAM_SUFFIXES``, exception tracebacks, and
uvicorn's TRACE-level ASGI message log, which the engine does not enable.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from typing import Any, FrozenSet, Optional, Tuple
from urllib.parse import unquote_plus

REDACTED = '[redacted]'

# Query parameter names whose values are replaced, in canonical form: lower case,
# letters and digits only, after percent-decoding, so ``api-key``, ``API_KEY`` and
# ``apikey`` are one name. Values are never decoded.
SENSITIVE_QUERY_PARAMS: FrozenSet[str] = frozenset(
    {
        # OAuth / OIDC
        'code',
        'state',
        'idtoken',
        'accesstoken',
        'refreshtoken',
        'clientsecret',
        'codeverifier',
        # Credentials this engine and its clients put in query strings
        'auth',  # AuthMiddleware header fallback; chat/dropper links; MCP upload URLs
        'token',  # /task/fetch signed JWT; task tokens on /task/*
        'tokens',  # OAuth broker result on /auth/vscode/*
        # Other usual credential carriers
        'apikey',
        'apitoken',
        'accesskey',
        'secretkey',
        'privatekey',
        'key',
        'authorization',
        'bearer',
        'jwt',
        'password',
        'passwd',
        'secret',
        'session',
        'sessionid',
        'sig',
        'signature',
    }
)

# Canonical endings that mark a credential, so ``github_token``, ``db-password`` and
# ``X-Amz-Signature`` match without being listed. ``key`` counts only as a whole
# name: as an ending it would also take ``sort_key`` or ``primary_key``.
SENSITIVE_PARAM_SUFFIXES: Tuple[str, ...] = (
    'token',
    'secret',
    'password',
    'passwd',
    'apikey',
    'accesskey',
    'secretkey',
    'privatekey',
    'sessionid',
    'signature',
)

# The token segment of a directory-capability URL (fetch.handle_fetch_dir). Not
# anchored: an absolute-form target has the scheme and host in front of the path.
_FETCH_PATH_TOKEN = re.compile(r'(/task/fetch/)[^/?]+')

# ``user:password@`` after the scheme of an absolute URL, plain or as h11 logs it
# (``http%3A//user%3Apass%40host``). Stops at the first ``/`` so an ``@`` in the
# path is left alone; takes the last ``@`` before it.
_USERINFO = re.compile(r'(?i)\b([a-z][a-z0-9+.-]*(?::|%3a)//)[^/?#\s]*(@|%40)')

# A word of free text, for records of unknown shape. Quotes and brackets end it,
# so a URL inside a quoted or bracketed value is found.
_TEXT_WORD = re.compile(r'[^\s"\'<>()\[\]{},]+')

UVICORN_LOGGERS = ('uvicorn.access', 'uvicorn.error')

# uvicorn's request-line templates. test_access_log.py checks them against the
# source of every HTTP and WebSocket backend in the installed uvicorn.
HTTP_ACCESS_TEMPLATE = '%s - "%s %s HTTP/%s" %d'  # args: client, method, target, http version, status
WEBSOCKET_TEMPLATE_PREFIX = '%s - "WebSocket %s"'  # args: client, target[, status]
_HTTP_TARGET_INDEX = 2
_WEBSOCKET_TARGET_INDEX = 1


def is_sensitive_param(name: str) -> bool:
    """Tell whether a query parameter name, as sent, names a credential."""
    canonical = re.sub(r'[^a-z0-9]', '', unquote_plus(name).lower())
    return canonical in SENSITIVE_QUERY_PARAMS or canonical.endswith(SENSITIVE_PARAM_SUFFIXES)


def redact_query_string(query: str) -> str:
    """Replace the value of every sensitive ``key=value`` pair; keep everything else byte for byte."""
    out = []
    for pair in query.split('&'):
        key, sep, _value = pair.partition('=')
        if sep and is_sensitive_param(key):
            out.append(f'{key}={REDACTED}')
        else:
            out.append(pair)
    return '&'.join(out)


def redact_request_target(target: str) -> str:
    """Redact userinfo, the fetch path token and sensitive query values of a request target of any form."""
    path, sep, query = target.partition('?')
    path = _USERINFO.sub(rf'\g<1>{REDACTED}\g<2>', path)
    path = _FETCH_PATH_TOKEN.sub(rf'\g<1>{REDACTED}', path)
    return f'{path}{sep}{redact_query_string(query)}'


def redact_text(text: str) -> str:
    """Redact every URL-like word of free text: a target, or a bare ``name=value`` list."""

    def word(match: re.Match) -> str:
        found = match.group(0)
        redacted = redact_request_target(found)
        if '?' not in found and '=' in found:
            redacted = redact_query_string(redacted)
        return redacted

    return _TEXT_WORD.sub(word, text)


def request_target_index(record: logging.LogRecord) -> Optional[int]:
    """Index of the request target in ``record.args`` for uvicorn's request-line records, else ``None``."""
    msg, args = record.msg, record.args
    if not isinstance(msg, str) or not isinstance(args, tuple):
        return None
    if msg == HTTP_ACCESS_TEMPLATE and len(args) == 5:
        return _HTTP_TARGET_INDEX
    if msg.startswith(WEBSOCKET_TEMPLATE_PREFIX) and len(args) >= 2:
        return _WEBSOCKET_TARGET_INDEX
    return None


def _redact_arg(value: Any) -> Any:
    """Redact one argument of a record of unknown shape; numbers and ``None`` keep their type."""
    if isinstance(value, str):
        return redact_text(value)
    if value is None or isinstance(value, (int, float)):
        return value
    text = str(value)
    redacted = redact_text(text)
    return value if redacted == text else redacted


class RequestTargetRedactor(logging.Filter):
    """Rewrite the request target in ``record.args`` so no handler can format the original."""

    def filter(self, record: logging.LogRecord) -> bool:
        """Redact the target of a request-line record, or every word of any other record; every record is kept."""
        index = request_target_index(record)
        if index is not None and isinstance(record.args[index], str):
            args = list(record.args)
            args[index] = redact_request_target(args[index])
            record.args = tuple(args)
            return True
        # Fail closed: a record in a shape this module does not know may still carry a URL.
        if isinstance(record.msg, str):
            record.msg = redact_text(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(_redact_arg(arg) for arg in record.args)
        elif isinstance(record.args, Mapping):
            record.args = {key: _redact_arg(value) for key, value in record.args.items()}
        return True


# One instance: Logger.addFilter skips an instance that is already attached, so
# every WebServer construction in a process can call install_access_log_redaction.
_REDACTOR = RequestTargetRedactor()


def install_access_log_redaction() -> None:
    """Attach the redactor to the uvicorn access and error loggers (idempotent)."""
    for name in UVICORN_LOGGERS:
        logging.getLogger(name).addFilter(_REDACTOR)
