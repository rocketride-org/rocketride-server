# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Mint short-lived JWTs that authorize a client to read exactly one WHEP stream.

MediaMTX (``authMethod: jwt``) validates the token against the engine's public key, pulled
from the JWKS the operator serves at ``authJWTJWKS``, and enforces the ``mediamtx_permissions``
claim. So a client can only pull the one stream it was granted — not any stream id it guesses —
and the grant expires, which a capability url alone cannot do.

Off unless ``ROCKETRIDE_MEDIA_JWT_KEY`` points at a PEM RSA private key. Then the operator
serves the matching JWKS (``python -m ai.account.media_auth`` prints it) where MediaMTX pulls it.
"""

import base64
import json
import os
import time
from functools import lru_cache
from typing import Optional

_KEY_ENV = 'ROCKETRIDE_MEDIA_JWT_KEY'  # path to a PEM RSA private key; unset => JWT auth off
_TTL_ENV = 'ROCKETRIDE_MEDIA_JWT_TTL'  # grant lifetime in seconds
_DEFAULT_TTL = 3600
_KID = 'rocketride-media'  # key id, matched between the minted token header and the JWKS


@lru_cache(maxsize=1)
def _private_key():
    """Load the RSA private key once. None => no key configured, so JWT auth is off."""
    path = os.environ.get(_KEY_ENV)
    if not path:
        return None
    try:
        from cryptography.hazmat.primitives.serialization import load_pem_private_key

        with open(path, 'rb') as f:
            return load_pem_private_key(f.read(), password=None)
    except Exception:
        return None


def enabled() -> bool:
    """True when a signing key is configured and WHEP urls should carry a JWT."""
    return _private_key() is not None


def _token(stream_id: str, action: str) -> Optional[str]:
    """A JWT granting ``action`` on exactly this stream path, expiring after the TTL. None if off."""
    key = _private_key()
    if key is None:
        return None
    import jwt

    now = int(time.time())
    try:
        ttl = int(os.environ.get(_TTL_ENV) or _DEFAULT_TTL)
    except ValueError:
        ttl = _DEFAULT_TTL
    claims = {
        'iat': now,
        'exp': now + ttl,
        'mediamtx_permissions': [{'action': action, 'path': stream_id}],
    }
    return jwt.encode(claims, key, algorithm='RS256', headers={'kid': _KID})


def read_token(stream_id: str) -> Optional[str]:
    """Token the client uses to pull this stream over WHEP (``read``)."""
    return _token(stream_id, 'read')


def publish_token(stream_id: str) -> Optional[str]:
    """Token the engine uses to push this stream over RTSP (``publish``). A jwt-enforcing SFU
    gates the ingest too, so the RTSP push must carry it, not only the WHEP read.
    """
    return _token(stream_id, 'publish')


def _b64u(n: int) -> str:
    """Base64url of a big-endian unsigned int, unpadded (JWK number encoding)."""
    raw = n.to_bytes((n.bit_length() + 7) // 8 or 1, 'big')
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


@lru_cache(maxsize=1)
def jwks() -> Optional[str]:
    """The public JWKS (JSON string) MediaMTX pulls to validate tokens. None if JWT is off."""
    key = _private_key()
    if key is None:
        return None
    pub = key.public_key().public_numbers()
    return json.dumps(
        {
            'keys': [
                {
                    'kty': 'RSA',
                    'use': 'sig',
                    'alg': 'RS256',
                    'kid': _KID,
                    'n': _b64u(pub.n),
                    'e': _b64u(pub.e),
                }
            ]
        }
    )


if __name__ == '__main__':
    # `engine -m ai.account.media_auth > jwks.json` — dump the JWKS the SFU pulls.
    doc = jwks()
    print(doc if doc else '{"keys": []}')
