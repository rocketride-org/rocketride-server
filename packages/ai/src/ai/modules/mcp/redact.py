# Copyright 2026 Aparavi Software AG. MIT License.
"""Clean credential-shaped text out of the error text a model reads.

Tool errors repeat text from the engine and from the caller. ``clean_text``
turns such a value into a string and replaces each of these with
``[redacted]``:

* what the request log cleaner finds (``ai.web.access_log.redact_text``): the
  ``user:password@`` part of a URL, the token of a ``/task/fetch/<token>``
  path, and the value of a credential-named query parameter or bare
  ``name=value`` word, quoted values (``password="..."``) included;
* a RocketRide key: ``rr_`` (API keys), ``rrr_`` (MCP refresh tokens) or
  ``rrmg_`` (hosted-model passes) followed by 20 or more URL-safe characters;
* a JWT: three base64url parts, the first starting with ``eyJ``.

Plain text comes back unchanged. Only error text goes through here; a
successful tool result never does.
"""

import re

from ai.web.access_log import REDACTED, is_sensitive_param, redact_text

# A quoted value after a name. redact_text splits words at quotes, so it would
# redact only the empty ``name=`` and keep the value after it. ``before`` and
# ``after`` are the characters around the match. When ``name=`` sits inside a
# quote of the same kind as the value's, the value must end right before that
# outer quote closes (``'password='x''``). Otherwise the quote after ``name=``
# closes the outer quote, and what follows is prose, not a value.
_QUOTED = re.compile(r'(?P<before>^|[^\w.-])(?P<name>[\w.-]+)=(?P<value>"[^"]*"|\'[^\']*\')(?=(?P<after>.?))')
_KEY = re.compile(r'\b(?:rr|rrr|rrmg)_[A-Za-z0-9_-]{20,}')
_JWT = re.compile(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*')


def _drop_quoted_credential(match: re.Match) -> str:
    """Leave ``name=`` for a credential name, so redact_text redacts it whole; keep anything else."""
    quote = match['value'][0]
    if match['before'] == quote and match['after'] != quote:
        return match.group(0)
    if not is_sensitive_param(match['name']):
        return match.group(0)
    return match['before'] + match['name'] + '='


def clean_text(value: object) -> str:
    """Return ``value`` as a string with credential-shaped text replaced by ``[redacted]``."""
    text = _QUOTED.sub(_drop_quoted_credential, str(value))
    text = redact_text(text)
    text = _KEY.sub(REDACTED, text)
    return _JWT.sub(REDACTED, text)
