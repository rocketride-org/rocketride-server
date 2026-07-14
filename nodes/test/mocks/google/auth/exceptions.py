# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Minimal stand-in for google.auth.exceptions used in tests.

Only ``RefreshError`` is needed: the Gmail broker-refresh path raises it to
signal a failed token refresh, and the real ``google-auth`` package is not
installed in the node test environment.
"""


class GoogleAuthError(Exception):
    """Base class mirroring google.auth.exceptions.GoogleAuthError."""


class RefreshError(GoogleAuthError):
    """Raised when a credential refresh fails (mirrors the real RefreshError)."""
