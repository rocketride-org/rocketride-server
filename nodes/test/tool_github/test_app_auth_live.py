# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Live integration tests for tool_github GitHub App installation-token auth.

Mints a real installation token and makes one real API call through it.
Requires a GitHub App with an installation on a test repo.

    export GITHUB_APP_ID=<app id>
    export GITHUB_APP_PRIVATE_KEY=<PEM contents, or a path to the .pem file>
    export GITHUB_APP_INSTALLATION_ID=<installation id>
    export GITHUB_TEST_REPO=owner/repo
    pytest nodes/test/tool_github/test_app_auth_live.py -v
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from ._stubs import scoped_stubs

# Imported through the package, inside scoped_stubs like every test file here, so the
# tool_github.* modules another file keeps in sys.modules are left as they were.
with scoped_stubs():
    from tool_github.github_client import call, mint_installation_token

APP_ID = os.getenv('GITHUB_APP_ID', '')
INSTALLATION_ID = os.getenv('GITHUB_APP_INSTALLATION_ID', '')
REPO = os.getenv('GITHUB_TEST_REPO', '')

_private_key_env = os.getenv('GITHUB_APP_PRIVATE_KEY', '')
if _private_key_env and '-----BEGIN' not in _private_key_env and Path(_private_key_env).is_file():
    PRIVATE_KEY = Path(_private_key_env).read_text()
else:
    PRIVATE_KEY = _private_key_env

pytestmark = pytest.mark.skipif(
    not APP_ID or not PRIVATE_KEY or not INSTALLATION_ID or not REPO,
    reason='GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID, and GITHUB_TEST_REPO must all be set',
)


def test_mint_installation_token_and_call_api():
    token, expiry = mint_installation_token(APP_ID, PRIVATE_KEY, INSTALLATION_ID)
    assert token
    assert expiry > 0

    data = call(token, 'GET', f'/repos/{REPO}')
    assert data['full_name'] == REPO
