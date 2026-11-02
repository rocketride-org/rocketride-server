# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Session-scoped test keys for the tool_github GitHub App auth tests."""

import pytest


def _pem(key) -> str:
    from cryptography.hazmat.primitives import serialization

    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode('utf-8')


@pytest.fixture(scope='session')
def rsa_private_key_pem() -> str:
    from cryptography.hazmat.primitives.asymmetric import rsa

    return _pem(rsa.generate_private_key(public_exponent=65537, key_size=2048))


@pytest.fixture(scope='session')
def ec_private_key_pem() -> str:
    from cryptography.hazmat.primitives.asymmetric import ec

    return _pem(ec.generate_private_key(ec.SECP256R1()))
