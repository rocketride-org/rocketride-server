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
PKCE sign-in helpers shared by RocketRide client front-ends.

The transport of the redirect differs per consumer (the CLI listens on a
loopback port) — but the verifier/challenge generation, the
authorize-URL construction, and the ``cd_`` credential encoding are
identical, and live here.

Behavioral twin of ``client-common/typescript``'s ``pkce.ts``.
"""

import base64
import hashlib
import json
import secrets
import urllib.parse
from typing import Dict, Tuple

# Scope requested for the PKCE authorization
OAUTH_SCOPE = 'openid profile email phone offline_access urn:zitadel:iam:org:project:id:zitadel:aud'


def generate_pkce() -> Tuple[str, str]:
    """
    Generate a PKCE verifier and its S256 challenge.

    Returns:
        Tuple of (verifier, challenge), both base64url without padding.
    """
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode('ascii').rstrip('=')
    digest = hashlib.sha256(verifier.encode('ascii')).digest()
    challenge = base64.urlsafe_b64encode(digest).decode('ascii').rstrip('=')
    return verifier, challenge


def build_authorize_url(zitadel_url: str, client_id: str, redirect_uri: str, challenge: str) -> str:
    """
    Build the Zitadel authorize URL for a PKCE flow.

    ``prompt=login`` is forced so browser SSO reuse cannot silently pick
    the wrong account when switching users.

    Args:
        zitadel_url: Base URL of the Zitadel instance.
        client_id: OAuth public client id.
        redirect_uri: The consumer's redirect target.
        challenge: The S256 code challenge.

    Returns:
        The full authorize URL to open in a browser.
    """
    params = urllib.parse.urlencode(
        {
            'client_id': client_id,
            'redirect_uri': redirect_uri,
            'response_type': 'code',
            'scope': OAUTH_SCOPE,
            'code_challenge': challenge,
            'code_challenge_method': 'S256',
            'prompt': 'login',
        }
    )
    return f'{zitadel_url.rstrip("/")}/oauth/v2/authorize?{params}'


def encode_cd_credential(grant: Dict[str, str]) -> str:
    """
    Encode the PKCE grant triple as the server's ``cd_`` DAP credential.

    The server decodes this from the ``auth`` field, performs the Zitadel
    token exchange itself, and returns an rr_* session key — no OAuth
    token ever reaches the client.

    Args:
        grant: Dict with ``code``, ``verifier``, and ``redirectUri``.

    Returns:
        The ``cd_``-prefixed credential string.
    """
    payload = json.dumps(grant)
    return 'cd_' + base64.b64encode(payload.encode('utf-8')).decode('ascii')
