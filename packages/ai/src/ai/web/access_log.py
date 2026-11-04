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
It recognises the request-line records by template and argument count, then
replaces the path token and the values of sensitive query parameters in the
target, whatever the target's form: ``/path?q`` for an origin-form request line,
``http%3A//host/path?q`` when the h11 backend receives an absolute-form one. A
logger-level filter runs before any handler, so every handler and formatter, the
stock ``AccessFormatter`` included, sees only the redacted args. The ASGI scope
is untouched: authentication, the OAuth code exchange and file delivery keep the
real values.
"""

from __future__ import annotations

import logging
import re
from typing import FrozenSet, Optional
from urllib.parse import unquote_plus

REDACTED = '[redacted]'

# Query parameter names whose values are replaced. Compared case-insensitively
# after percent-decoding the name. Values are never decoded.
SENSITIVE_QUERY_PARAMS: FrozenSet[str] = frozenset(
    {
        # OAuth / OIDC
        'code',
        'state',
        'id_token',
        'access_token',
        'refresh_token',
        'client_secret',
        'code_verifier',
        # Credentials this engine and its clients put in query strings
        'auth',  # AuthMiddleware header fallback; chat/dropper links; MCP upload URLs
        'token',  # /task/fetch signed JWT; task tokens on /task/*
        'tokens',  # OAuth broker result on /auth/vscode/*
        'api_token',
        # Common credential spellings
        'api_key',
        'apikey',
        'password',
        'secret',
    }
)

# The token segment of a directory-capability URL (fetch.handle_fetch_dir). Not
# anchored: an absolute-form target has the scheme and host in front of the path.
_FETCH_PATH_TOKEN = re.compile(r'(/task/fetch/)[^/?]+')

UVICORN_LOGGERS = ('uvicorn.access', 'uvicorn.error')

# uvicorn's request-line templates. test_access_log.py checks them against the
# source of every HTTP and WebSocket backend in the installed uvicorn.
HTTP_ACCESS_TEMPLATE = '%s - "%s %s HTTP/%s" %d'  # args: client, method, target, http version, status
WEBSOCKET_TEMPLATE_PREFIX = '%s - "WebSocket %s"'  # args: client, target[, status]
_HTTP_TARGET_INDEX = 2
_WEBSOCKET_TARGET_INDEX = 1


def redact_query_string(query: str) -> str:
    """Replace the value of every sensitive ``key=value`` pair; keep everything else byte for byte."""
    out = []
    for pair in query.split('&'):
        key, sep, _value = pair.partition('=')
        if sep and unquote_plus(key).strip().lower() in SENSITIVE_QUERY_PARAMS:
            out.append(f'{key}={REDACTED}')
        else:
            out.append(pair)
    return '&'.join(out)


def redact_request_target(target: str) -> str:
    """Redact the fetch path token and the sensitive query values of a request target of any form."""
    path, sep, query = target.partition('?')
    path = _FETCH_PATH_TOKEN.sub(rf'\g<1>{REDACTED}', path)
    return f'{path}{sep}{redact_query_string(query)}'


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


class RequestTargetRedactor(logging.Filter):
    """Rewrite the request target in ``record.args`` so no handler can format the original."""

    def filter(self, record: logging.LogRecord) -> bool:
        """Redact the target of a request-line record; every record is kept."""
        index = request_target_index(record)
        if index is not None and isinstance(record.args[index], str):
            args = list(record.args)
            args[index] = redact_request_target(args[index])
            record.args = tuple(args)
        return True


# One instance: Logger.addFilter skips an instance that is already attached, so
# every WebServer construction in a process can call install_access_log_redaction.
_REDACTOR = RequestTargetRedactor()


def install_access_log_redaction() -> None:
    """Attach the redactor to the uvicorn access and error loggers (idempotent)."""
    for name in UVICORN_LOGGERS:
        logging.getLogger(name).addFilter(_REDACTOR)
