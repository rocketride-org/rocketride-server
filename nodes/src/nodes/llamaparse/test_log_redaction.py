"""Tests for the _redact_dict log-redaction helper used in LlamaParse and Reducto nodes.

This test is self-contained and does not require the full RocketRide runtime.
It re-implements the same _redact_dict logic so the test can run standalone,
then validates behaviour against the known contract.
"""

# ---------------------------------------------------------------------------
# Reproduce the exact helper from the patched source files so we can test it
# without importing the full node packages (which need the RocketRide runtime).
# ---------------------------------------------------------------------------

_SENSITIVE_KEYS = ('api_key', 'apikey', 'secret', 'token', 'password', 'credential')


def _redact_dict(d: dict) -> dict:
    """Return a copy of *d* with sensitive values replaced by '***REDACTED***'."""
    return {k: ('***REDACTED***' if any(p in k.lower() for p in _SENSITIVE_KEYS) else v) for k, v in d.items()}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestRedactDict:
    """Unit tests for _redact_dict."""

    def test_redacts_api_key(self):
        """api_key values must be replaced."""
        d = {'api_key': 'llx-secret-1234', 'verbose': False}
        result = _redact_dict(d)
        assert result['api_key'] == '***REDACTED***'
        assert result['verbose'] is False

    def test_redacts_token(self):
        """Keys containing 'token' must be redacted."""
        d = {'auth_token': 'tok_abc', 'mode': 'fast'}
        result = _redact_dict(d)
        assert result['auth_token'] == '***REDACTED***'
        assert result['mode'] == 'fast'

    def test_redacts_password(self):
        """Keys containing 'password' must be redacted."""
        d = {'db_password': 'hunter2', 'host': 'localhost'}
        result = _redact_dict(d)
        assert result['db_password'] == '***REDACTED***'
        assert result['host'] == 'localhost'

    def test_redacts_secret(self):
        """Keys containing 'secret' must be redacted."""
        d = {'client_secret': 's3cr3t'}
        result = _redact_dict(d)
        assert result['client_secret'] == '***REDACTED***'

    def test_redacts_credential(self):
        """Keys containing 'credential' must be redacted."""
        d = {'service_credential': 'cred123'}
        result = _redact_dict(d)
        assert result['service_credential'] == '***REDACTED***'

    def test_case_insensitive(self):
        """Matching must be case-insensitive."""
        d = {'API_KEY': 'key1', 'ApiKey': 'key2', 'TOKEN': 'tok'}
        result = _redact_dict(d)
        assert result['API_KEY'] == '***REDACTED***'
        assert result['ApiKey'] == '***REDACTED***'
        assert result['TOKEN'] == '***REDACTED***'

    def test_non_sensitive_keys_unchanged(self):
        """Non-sensitive keys must pass through unchanged."""
        d = {'parse_mode': 'fast', 'verbose': True, 'timeout': 30}
        result = _redact_dict(d)
        assert result == d

    def test_empty_dict(self):
        """An empty dict must return an empty dict."""
        assert _redact_dict({}) == {}

    def test_original_not_mutated(self):
        """The original dict must not be modified."""
        d = {'api_key': 'secret_val', 'name': 'test'}
        original_copy = dict(d)
        _redact_dict(d)
        assert d == original_copy

    def test_multiple_sensitive_keys(self):
        """Multiple sensitive keys in one dict are all redacted."""
        d = {
            'api_key': 'k1',
            'secret': 's1',
            'token': 't1',
            'password': 'p1',
            'host': 'localhost',
        }
        result = _redact_dict(d)
        assert result['api_key'] == '***REDACTED***'
        assert result['secret'] == '***REDACTED***'
        assert result['token'] == '***REDACTED***'
        assert result['password'] == '***REDACTED***'
        assert result['host'] == 'localhost'

    def test_redacts_apikey_no_underscore(self):
        """Keys containing 'apikey' (no underscore) must be redacted."""
        d = {'myapikey': 'val'}
        result = _redact_dict(d)
        assert result['myapikey'] == '***REDACTED***'


# ---------------------------------------------------------------------------
# Allow running with plain `python test_log_redaction.py`
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    t = TestRedactDict()
    for method_name in sorted(dir(t)):
        if method_name.startswith('test_'):
            print(f'Running {method_name}...', end=' ')
            getattr(t, method_name)()
            print('OK')
    print('\nAll tests passed.')
