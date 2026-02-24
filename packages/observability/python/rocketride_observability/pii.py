# MIT License
#
# Copyright (c) 2026 RocketRide, Inc.
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

"""PII scrubbing processor for structured logging."""

from __future__ import annotations

import re
from typing import Any, Dict

# Email: redact local part, keep domain (non-overlapping groups to avoid ReDoS)
_EMAIL_RE = re.compile(r'[a-zA-Z0-9]+(?:[._%+\-][a-zA-Z0-9]+)*@([a-zA-Z0-9]+(?:[.\-][a-zA-Z0-9]+)*\.[a-zA-Z]{2,})')

# Bearer / OAuth tokens in Authorization headers or inline
_BEARER_RE = re.compile(r'(Bearer\s+)\S+', re.IGNORECASE)

# Generic long token-like strings (hex/base64, 20+ chars)
_TOKEN_RE = re.compile(r'(token[=:\s]+)[A-Za-z0-9_\-/+]{20,}', re.IGNORECASE)

# AWS access key IDs (AKIA...)
_AWS_KEY_RE = re.compile(r'AKIA[0-9A-Z]{16}')

# AWS secret keys (40-char base64 following common prefixes)
_AWS_SECRET_RE = re.compile(r'(aws_secret_access_key[=:\s]+)[A-Za-z0-9/+=]{40}', re.IGNORECASE)

# File paths with /Users/<username>/ or /home/<username>/
_PATH_USERS_RE = re.compile(r'/Users/[^/\s]+/')
_PATH_HOME_RE = re.compile(r'/home/[^/\s]+/')

REDACTED = '***REDACTED***'


def _scrub_value(value: str) -> str:
    """Scrub PII patterns from a single string value."""
    value = _EMAIL_RE.sub(r'***@\1', value)
    value = _BEARER_RE.sub(r'\1' + REDACTED, value)
    value = _TOKEN_RE.sub(r'\1' + REDACTED, value)
    value = _AWS_KEY_RE.sub(REDACTED, value)
    value = _AWS_SECRET_RE.sub(r'\1' + REDACTED, value)
    value = _PATH_USERS_RE.sub('/Users/***/', value)
    value = _PATH_HOME_RE.sub('/home/***/', value)
    return value


def scrub_pii(event_dict: Dict[str, Any]) -> Dict[str, Any]:
    """Redact PII from a dictionary of log fields.

    Returns a new dictionary with string values scrubbed. The original
    dictionary is not modified.
    """
    return {key: _scrub_value(value) if isinstance(value, str) else value for key, value in event_dict.items()}


def scrub_pii_processor(_logger: Any, _method_name: str, event_dict: Dict[str, Any]) -> Dict[str, Any]:
    """Structlog processor that redacts PII from log event dictionaries.

    Mutates event_dict in place (structlog convention) and returns it.

    Use in a structlog processor chain:
        structlog.configure(processors=[..., scrub_pii_processor, ...])
    """
    for key, value in event_dict.items():
        if isinstance(value, str):
            event_dict[key] = _scrub_value(value)
    return event_dict
