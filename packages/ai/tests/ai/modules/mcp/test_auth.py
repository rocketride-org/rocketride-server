# Copyright 2026 Aparavi Software AG. MIT License.
"""Audience enforcement for Zitadel tokens presented to /mcp.

A bearer token is a ticket, and Zitadel stamps every ticket with what it is
good for (the ``aud`` claim). Without checking that stamp, a token minted for
the VS Code extension would open /mcp just as readily as one minted for Claude.
These tests pin that check, and pin the two things it must NOT break: static
API keys, and local development.
"""

import time

import pytest

from ai.modules.mcp import auth

RS256 = 'RS256'
ISSUER = 'https://auth.rocketride.ai'
MCP_PROJECT = '999000111222333444'
OTHER_PROJECT = '368800872261525829'


# --- helpers --------------------------------------------------------------


@pytest.fixture(scope='module')
def keypair():
    """An RSA keypair standing in for Zitadel's signing key."""
    from cryptography.hazmat.primitives.asymmetric import rsa

    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private, private.public_key()


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv(auth.ENV_EXPECTED_AUDIENCE, raising=False)
    monkeypatch.delenv(auth.ENV_JWKS_URL, raising=False)


@pytest.fixture(autouse=True)
def _local_jwks(monkeypatch, keypair):
    """Resolve signing keys from the test keypair instead of over the network."""
    _, public = keypair

    class _FakeKey:
        key = public

    monkeypatch.setattr(auth, '_signing_key_for', lambda token: _FakeKey.key)


def make_token(keypair, *, aud=MCP_PROJECT, iss=ISSUER, expires_in=3600, sub='user-123'):
    """Mint a signed JWT shaped like a Zitadel access token."""
    import jwt

    private, _ = keypair
    now = int(time.time())
    return jwt.encode(
        {
            'iss': iss,
            'sub': sub,
            'aud': aud,
            'iat': now,
            'exp': now + expires_in,
            'email': 'someone@example.com',
        },
        private,
        algorithm=RS256,
    )


def scope_with(credential=None):
    """Build a minimal ASGI scope carrying an optional bearer credential."""
    headers = []
    if credential is not None:
        headers.append((b'authorization', f'Bearer {credential}'.encode()))
    return {'type': 'http', 'method': 'POST', 'path': '/mcp', 'headers': headers, 'state': {}}


# --- the API-key path must keep working -----------------------------------


@pytest.mark.parametrize('credential', ['rr_abc123', 'tk_operator_token', 'pk_public_token', 'cd_pkce_code'])
def test_known_api_keys_are_never_audience_checked(monkeypatch, credential):
    """Cursor and the CLI authenticate with static keys; that path is untouched."""
    monkeypatch.setenv(auth.ENV_EXPECTED_AUDIENCE, MCP_PROJECT)

    assert auth.authorize(scope_with(credential), bind_host='0.0.0.0') is None


def test_opaque_unrecognised_credential_is_refused_when_enforcing(monkeypatch):
    """Zitadel can issue OPAQUE access tokens instead of JWTs.

    Such a token has no recognisable prefix and cannot be decoded, so its
    audience cannot be established. Treating it as an API key would let it
    bypass the audience check entirely — the exact fail-open this guard exists
    to prevent. It must be refused while an audience is configured.
    """
    monkeypatch.setenv(auth.ENV_EXPECTED_AUDIENCE, MCP_PROJECT)

    error = auth.authorize(scope_with('K1aQ9zOpaqueZitadelAccessToken'), bind_host='0.0.0.0')
    assert error is not None


def test_opaque_credential_passes_when_not_enforcing(monkeypatch):
    """OSS/local runs with no configured audience keep accepting bare keys."""
    assert auth.authorize(scope_with('plain-api-key'), bind_host='localhost') is None


def test_no_credential_defers_to_the_auth_middleware(monkeypatch):
    """Deciding whether a credential is required is the middleware's job."""
    monkeypatch.setenv(auth.ENV_EXPECTED_AUDIENCE, MCP_PROJECT)

    assert auth.authorize(scope_with(None), bind_host='0.0.0.0') is None


# --- the audience gate ----------------------------------------------------


def test_token_stamped_for_mcp_is_accepted(monkeypatch, keypair):
    monkeypatch.setenv(auth.ENV_EXPECTED_AUDIENCE, MCP_PROJECT)
    scope = scope_with(make_token(keypair))

    assert auth.authorize(scope, bind_host='0.0.0.0') is None
    assert scope['state']['mcp_claims']['sub'] == 'user-123'


def test_token_stamped_for_another_project_is_rejected(monkeypatch, keypair):
    """This is the whole point: a first-party token must not open /mcp."""
    monkeypatch.setenv(auth.ENV_EXPECTED_AUDIENCE, MCP_PROJECT)
    scope = scope_with(make_token(keypair, aud=OTHER_PROJECT))

    error = auth.authorize(scope, bind_host='0.0.0.0')
    assert error is not None
    assert 'mcp_claims' not in scope['state']


def test_audience_list_containing_mcp_is_accepted(monkeypatch, keypair):
    """Zitadel returns aud as an array; membership is what matters."""
    monkeypatch.setenv(auth.ENV_EXPECTED_AUDIENCE, MCP_PROJECT)
    scope = scope_with(make_token(keypair, aud=[OTHER_PROJECT, MCP_PROJECT]))

    assert auth.authorize(scope, bind_host='0.0.0.0') is None


def test_token_from_another_issuer_is_rejected(monkeypatch, keypair):
    monkeypatch.setenv(auth.ENV_EXPECTED_AUDIENCE, MCP_PROJECT)
    scope = scope_with(make_token(keypair, iss='https://evil.example.com'))

    assert auth.authorize(scope, bind_host='0.0.0.0') is not None


def test_expired_token_is_rejected(monkeypatch, keypair):
    monkeypatch.setenv(auth.ENV_EXPECTED_AUDIENCE, MCP_PROJECT)
    scope = scope_with(make_token(keypair, expires_in=-3600))

    assert auth.authorize(scope, bind_host='0.0.0.0') is not None


def test_tampered_token_is_rejected(monkeypatch, keypair):
    monkeypatch.setenv(auth.ENV_EXPECTED_AUDIENCE, MCP_PROJECT)
    token = make_token(keypair)
    head, payload, signature = token.split('.')
    tampered = f'{head}.{payload}.{signature[:-4]}AAAA'
    scope = scope_with(tampered)

    assert auth.authorize(scope, bind_host='0.0.0.0') is not None


# --- unconfigured audience: skip on localhost, refuse in production -------


def test_unconfigured_audience_is_allowed_on_loopback(keypair):
    """Local development must not require a Zitadel project id."""
    for host in ('localhost', '127.0.0.1', '::1'):
        scope = scope_with(make_token(keypair))
        assert auth.authorize(scope, bind_host=host) is None, host


def test_unconfigured_audience_is_refused_on_a_public_bind(keypair):
    """A deploy that forgot the setting must fail loudly, not silently open."""
    scope = scope_with(make_token(keypair))

    error = auth.authorize(scope, bind_host='0.0.0.0')
    assert error is not None
    assert 'MCP_EXPECTED_AUDIENCE' in error


def test_unconfigured_audience_on_public_bind_still_allows_api_keys():
    """The unconfigured refusal is about JWTs; static keys are unaffected."""
    assert auth.authorize(scope_with('rr_abc123'), bind_host='0.0.0.0') is None


# --- credential shape -----------------------------------------------------


@pytest.mark.parametrize(
    'credential,is_jwt',
    [
        ('rr_abc123', False),
        ('tk_abc.def', False),
        ('a.b', False),
        ('', False),
        ('not.a.jwt', False),
    ],
)
def test_looks_like_jwt_discriminates_credential_shapes(credential, is_jwt):
    assert auth.looks_like_jwt(credential) is is_jwt


def test_looks_like_jwt_accepts_a_real_token(keypair):
    assert auth.looks_like_jwt(make_token(keypair)) is True


# --- credential stashing -------------------------------------------------


def test_api_key_credential_is_stashed(monkeypatch):
    """Bearer credential is stashed for API-key paths."""
    monkeypatch.setenv(auth.ENV_EXPECTED_AUDIENCE, MCP_PROJECT)
    scope = scope_with('rr_abc123')

    assert auth.authorize(scope, bind_host='0.0.0.0') is None
    assert scope['state']['mcp_credential'] == 'rr_abc123'


def test_jwt_credential_is_stashed(monkeypatch, keypair):
    """Bearer credential is stashed for verified JWT paths."""
    monkeypatch.setenv(auth.ENV_EXPECTED_AUDIENCE, MCP_PROJECT)
    credential = make_token(keypair)
    scope = scope_with(credential)

    assert auth.authorize(scope, bind_host='0.0.0.0') is None
    assert scope['state']['mcp_credential'] == credential


def test_loopback_oauth_credential_is_stashed(keypair):
    """Bearer credential is stashed for loopback OAuth paths."""
    credential = make_token(keypair)
    scope = scope_with(credential)

    assert auth.authorize(scope, bind_host='localhost') is None
    assert scope['state']['mcp_credential'] == credential


def test_no_credential_does_not_stash(monkeypatch):
    """No credential stash occurs when authorization header is absent."""
    monkeypatch.setenv(auth.ENV_EXPECTED_AUDIENCE, MCP_PROJECT)
    scope = scope_with(None)

    assert auth.authorize(scope, bind_host='0.0.0.0') is None
    assert 'mcp_credential' not in scope['state']
