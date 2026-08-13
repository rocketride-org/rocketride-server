# Copyright 2026 Aparavi Software AG. MIT License.
"""Audience enforcement for OAuth tokens presented to ``/mcp``.

A bearer token is a ticket: whoever holds it can use it. Zitadel stamps every
token it issues with what that token is good for — the ``aud`` claim, which
carries the id of the Zitadel *project* the client belongs to. Without checking
that stamp, a token minted for the VS Code extension would open ``/mcp`` exactly
as readily as one minted for Claude.

This module is that check, and it lives at the ``/mcp`` boundary rather than in
the engine's global authenticator chain on purpose: "was this token issued for
MCP" is a rule about MCP, and must not be imposed on ``/task`` or ``/api/chat``.

Two things it deliberately does not break:

* **Static API keys.** ``rr_``/``tk_``/``pk_`` and bare API keys are opaque
  strings, not JWTs. They keep taking the existing authenticator path with no
  audience check, so Cursor and the CLI are unaffected.
* **Local development.** When no expected audience is configured the check is
  skipped on a loopback bind, but *refused* on a public one — the same
  posture ``MCP_DEV_NO_AUTH`` already takes elsewhere in this module. A
  production deploy that forgets the setting fails loudly instead of silently
  accepting every token.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
from typing import Any, Dict, List, Optional

from ai.web import oauth_resource

logger = logging.getLogger(__name__)

ENV_EXPECTED_AUDIENCE = 'MCP_EXPECTED_AUDIENCE'
ENV_JWKS_URL = 'MCP_JWKS_URL'

# Static credentials the account layer resolves without OAuth: persistent user
# API keys (``rr_``), task-scoped keys (``tk_``/``pk_``), and PKCE code
# exchanges (``cd_``). These are opaque by design and carry no audience.
#
# The list is exhaustive on purpose. Anything that is neither one of these nor
# a verifiable JWT is treated as an unverifiable OAuth token and refused while
# an audience is configured — see :func:`authorize`. Zitadel can be configured
# to issue *opaque* access tokens instead of JWTs, and those would otherwise
# sail past the audience check as if they were API keys.
API_KEY_PREFIXES = ('rr_', 'tk_', 'pk_', 'cd_')

# Same allowlist the dev-auth bypass uses. Literal matches only: a hostname
# that merely *resolves* to loopback does not qualify.
LOOPBACK_HOSTS = ('localhost', '127.0.0.1', '::1')

# Zitadel publishes its signing keys here, relative to the issuer.
DEFAULT_JWKS_PATH = '/oauth/v2/keys'

_ALGORITHMS = ['RS256']

# Tolerance for clock skew between us and the authorization server.
_LEEWAY_SECONDS = 60

_jwk_client: Any = None


def expected_audience() -> Optional[str]:
    """Return the Zitadel project id a token must be stamped with.

    Returns:
        Optional[str]: The configured audience, or None when unset.
    """
    import os

    return os.environ.get(ENV_EXPECTED_AUDIENCE) or None


def jwks_url() -> str:
    """Return the URL of the authorization server's public signing keys.

    Returns:
        str: The JWKS endpoint, derived from the issuer unless overridden.
    """
    import os

    override = os.environ.get(ENV_JWKS_URL)
    if override:
        return override
    return f'{oauth_resource.authorization_servers()[0]}{DEFAULT_JWKS_PATH}'


def is_loopback_bind(bind_host: str) -> bool:
    """Report whether a configured bind host is loopback-only.

    Args:
        bind_host: The configured host, not the resolved address. An empty or
            unset value means bind-all in most ASGI stacks and is never
            treated as loopback.

    Returns:
        bool: True only for the exact literals in :data:`LOOPBACK_HOSTS`.
    """
    return bind_host in LOOPBACK_HOSTS


def looks_like_jwt(credential: str) -> bool:
    """Report whether a credential is a JWT rather than an opaque API key.

    Shape is a more reliable discriminator than a prefix allowlist: it covers
    ``rr_``, ``tk_``, ``pk_`` and bare API keys without having to enumerate
    them, and it will not misclassify a future key format.

    Args:
        credential: The bearer credential, without the ``Bearer`` prefix.

    Returns:
        bool: True when the credential has three segments and a decodable JOSE
            header naming an algorithm.
    """
    parts = credential.split('.')
    if len(parts) != 3:
        return False
    try:
        padded = parts[0] + '=' * (-len(parts[0]) % 4)
        header = json.loads(base64.urlsafe_b64decode(padded))
    except (ValueError, binascii.Error, UnicodeDecodeError):
        return False
    return isinstance(header, dict) and 'alg' in header


def bearer_credential(scope: Dict[str, Any]) -> Optional[str]:
    """Extract the bearer credential from an ASGI scope.

    Args:
        scope: The ASGI connection scope.

    Returns:
        Optional[str]: The credential with any ``Bearer`` prefix stripped, or
            None when no Authorization header is present.
    """
    for name, value in scope.get('headers') or []:
        if name.lower() == b'authorization':
            raw = value.decode('latin-1').strip()
            return raw[7:].strip() if raw[:7].lower() == 'bearer ' else raw
    return None


def _signing_key_for(token: str) -> Any:
    """Fetch the public key that signed a token, via a cached JWKS client.

    Args:
        token: The encoded JWT.

    Returns:
        Any: The public key object for the token's ``kid``.
    """
    global _jwk_client
    if _jwk_client is None:
        from jwt import PyJWKClient

        _jwk_client = PyJWKClient(jwks_url(), cache_keys=True, lifespan=3600)
    return _jwk_client.get_signing_key_from_jwt(token).key


def _audience_values(claims: Dict[str, Any]) -> List[str]:
    """Normalise the ``aud`` claim to a list of strings.

    Args:
        claims: Decoded token claims.

    Returns:
        List[str]: Audience values; Zitadel sends an array, the spec permits
            a bare string.
    """
    raw = claims.get('aud') or []
    return [raw] if isinstance(raw, str) else [str(value) for value in raw]


def authorize(scope: Dict[str, Any], *, bind_host: str) -> Optional[str]:
    """Decide whether a request may reach the MCP session manager.

    On success the verified claims are stored at ``scope['state']['mcp_claims']``
    so downstream handlers can identify the caller without re-verifying.

    Args:
        scope: The ASGI connection scope.
        bind_host: The server's configured bind host, used to decide whether an
            unconfigured audience is tolerable.

    Returns:
        Optional[str]: An error message when the request must be rejected, or
            None to let it proceed.
    """
    credential = bearer_credential(scope)

    # No credential at all: whether one is required is the auth middleware's
    # call, not ours. Under the dev bypass there legitimately isn't one.
    if not credential:
        return None

    # Static API keys keep the existing path untouched — they are opaque by
    # design and there is no audience to check.
    if credential.startswith(API_KEY_PREFIXES):
        return None

    audience = expected_audience()
    if not audience:
        if is_loopback_bind(bind_host):
            return None
        logger.error(
            '%s is not set and the server binds %s (non-loopback); refusing OAuth tokens on /mcp',
            ENV_EXPECTED_AUDIENCE,
            bind_host or '<unset/bind-all>',
        )
        return f'{ENV_EXPECTED_AUDIENCE} is not configured; refusing OAuth tokens on a public bind'

    # Not a known API key and not a JWT: an opaque OAuth token, or something
    # unrecognised. Either way its audience cannot be established, so it must
    # not be trusted while we are enforcing one. Zitadel issues opaque access
    # tokens under some project configurations — the MCP project must be set
    # to issue JWTs, and this is the guard that makes that misconfiguration
    # loud instead of silent.
    if not looks_like_jwt(credential):
        logger.warning('rejected /mcp credential: not a JWT and not a known API key prefix')
        return 'credential is not a verifiable token'

    issuer = oauth_resource.authorization_servers()[0]
    try:
        import jwt

        claims = jwt.decode(
            credential,
            _signing_key_for(credential),
            algorithms=_ALGORITHMS,
            issuer=issuer,
            leeway=_LEEWAY_SECONDS,
            # Audience is verified below against the full list rather than by
            # PyJWT, so the failure can be reported distinctly from a bad
            # signature — the two mean very different things operationally.
            options={'verify_aud': False},
        )
    except Exception as exc:  # noqa: BLE001 - any verification failure is a 401
        logger.warning('rejected /mcp token: %s', exc)
        return f'token verification failed: {exc}'

    if audience not in _audience_values(claims):
        logger.warning('rejected /mcp token: audience %r not present', audience)
        return 'token was not issued for this resource'

    scope.setdefault('state', {})['mcp_claims'] = claims
    return None
