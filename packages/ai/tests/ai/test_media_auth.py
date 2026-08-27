# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""media_auth mints a read-scoped JWT per stream and publishes the matching JWKS.

Off unless ROCKETRIDE_MEDIA_JWT_KEY is set; when it is, the token must validate against the
public key and grant read on exactly the one stream path.
"""

import json

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from ai.account import media_auth
from ai.account.media_publish import MediaPublisher


@pytest.fixture(autouse=True)
def _clear_key_cache():
    # The key and JWKS are lru_cached; drop them so each test sees its own env.
    media_auth._private_key.cache_clear()
    media_auth.jwks.cache_clear()
    yield
    media_auth._private_key.cache_clear()
    media_auth.jwks.cache_clear()


@pytest.fixture
def rsa_key(tmp_path, monkeypatch):
    """Write a fresh RSA private key to disk and point the engine at it. Returns the public key."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    path = tmp_path / 'media_jwt.key'
    path.write_bytes(pem)
    monkeypatch.setenv('ROCKETRIDE_MEDIA_JWT_KEY', str(path))
    return key.public_key()


def test_off_without_a_key(monkeypatch):
    monkeypatch.delenv('ROCKETRIDE_MEDIA_JWT_KEY', raising=False)
    assert media_auth.enabled() is False
    assert media_auth.read_token('user1-abc') is None
    assert media_auth.jwks() is None


def test_token_grants_read_on_exactly_this_stream(rsa_key):
    assert media_auth.enabled() is True
    token = media_auth.read_token('user1-deadbeef')
    pub_pem = rsa_key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    claims = jwt.decode(token, pub_pem, algorithms=['RS256'])  # signature must verify
    assert claims['mediamtx_permissions'] == [{'action': 'read', 'path': 'user1-deadbeef'}]
    assert claims['exp'] > claims['iat']  # the grant expires


def test_token_ttl_is_configurable(rsa_key, monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_MEDIA_JWT_TTL', '30')
    token = media_auth.read_token('s1')
    pub_pem = rsa_key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    claims = jwt.decode(token, pub_pem, algorithms=['RS256'])
    assert claims['exp'] - claims['iat'] == 30


def test_jwks_carries_the_public_key(rsa_key):
    doc = json.loads(media_auth.jwks())
    key = doc['keys'][0]
    assert key['kty'] == 'RSA' and key['alg'] == 'RS256' and key['kid'] == 'rocketride-media'
    assert key['n'] and key['e']  # modulus + exponent present for MediaMTX to validate with


def test_publish_token_grants_publish_on_this_stream(rsa_key):
    token = media_auth.publish_token('user1-deadbeef')
    pub_pem = rsa_key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    claims = jwt.decode(token, pub_pem, algorithms=['RS256'])
    assert claims['mediamtx_permissions'] == [{'action': 'publish', 'path': 'user1-deadbeef'}]


def test_whep_url_carries_the_jwt_when_configured(rsa_key):
    url = MediaPublisher('sfu.internal', 'user1-cafe', 'video/mp4').whep_url
    assert '/user1-cafe/whep?jwt=' in url


def test_rtsp_push_carries_the_jwt_when_configured(rsa_key):
    # A jwt-enforcing SFU gates the ingest, so the RTSP push url must carry a publish token.
    cmd = MediaPublisher('sfu.internal', 'user1-cafe', 'video/mp4')._cmd()
    assert cmd[-1].startswith('rtsp://sfu.internal:8554/user1-cafe?jwt=')


def test_whep_url_has_no_jwt_when_off(monkeypatch):
    monkeypatch.delenv('ROCKETRIDE_MEDIA_JWT_KEY', raising=False)
    url = MediaPublisher('sfu.internal', 'user1-cafe', 'video/mp4').whep_url
    assert url == 'http://sfu.internal:8889/user1-cafe/whep'  # unchanged, no token
