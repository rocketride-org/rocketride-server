# Copyright 2026 Aparavi Software AG. MIT License.
"""Clean credential-shaped text out of the error text a model reads.

Tool errors repeat text from the engine and from the caller. ``clean_text``
turns such a value into a string and replaces each of these with
``[redacted]``:

* what the request log cleaner finds (``ai.web.access_log.redact_text``): the
  ``user:password@`` part of a URL, the token of a ``/task/fetch/<token>``
  path, and the value of a credential-named query parameter or bare
  ``name=value`` word;
* a RocketRide key: ``rr_`` (API keys), ``rrr_`` (MCP refresh tokens) or
  ``rrmg_`` (hosted-model passes) followed by 20 or more URL-safe characters;
* a JWT: three base64url parts, the first starting with ``eyJ``.

Plain text comes back unchanged. Only error text goes through here; a
successful tool result never does.
"""

import re

from ai.web.access_log import REDACTED, redact_text

_KEY = re.compile(r'\b(?:rr|rrr|rrmg)_[A-Za-z0-9_-]{20,}')
_JWT = re.compile(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*')


def clean_text(value: object) -> str:
    """Return ``value`` as a string with credential-shaped text replaced by ``[redacted]``."""
    text = redact_text(str(value))
    text = _KEY.sub(REDACTED, text)
    return _JWT.sub(REDACTED, text)
