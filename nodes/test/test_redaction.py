# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for sensitive data redaction in debug protocol logging.

Verifies that API keys, auth tokens, and passwords are redacted
before being sent to debug callbacks.
"""

import sys
from pathlib import Path


# Add client source to path
CLIENT_SRC = Path(__file__).parent.parent.parent / 'packages' / 'client-python' / 'src'
sys.path.insert(0, str(CLIENT_SRC))

from rocketride.core.transport import TransportBase


class TestRedactSensitive:
    """Tests for _redact_sensitive static method."""

    def test_redacts_apikey_double_quotes(self):
        msg = '{"arguments": {"apikey": "sk-secret-key-12345"}}'
        result = TransportBase._redact_sensitive(msg)
        assert 'sk-secret-key-12345' not in result
        assert '[REDACTED]' in result

    def test_redacts_auth_double_quotes(self):
        msg = '{"arguments": {"auth": "my-super-secret-token"}}'
        result = TransportBase._redact_sensitive(msg)
        assert 'my-super-secret-token' not in result
        assert '[REDACTED]' in result

    def test_redacts_token_single_quotes(self):
        msg = "{'token': 'abc123secret'}"
        result = TransportBase._redact_sensitive(msg)
        assert 'abc123secret' not in result

    def test_redacts_password(self):
        msg = '{"password": "hunter2"}'
        result = TransportBase._redact_sensitive(msg)
        assert 'hunter2' not in result

    def test_preserves_non_sensitive(self):
        msg = '{"command": "execute", "pipeline": "test"}'
        result = TransportBase._redact_sensitive(msg)
        assert result == msg

    def test_preserves_structure(self):
        msg = '{"arguments": {"apikey": "SECRET", "pipeline": "chat"}}'
        result = TransportBase._redact_sensitive(msg)
        assert '"pipeline": "chat"' in result
        assert 'SECRET' not in result
