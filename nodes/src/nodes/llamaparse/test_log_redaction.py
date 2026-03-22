"""Tests for the redact_dict log-redaction helper used in LlamaParse and Reducto nodes."""

import importlib.util
import os

# Direct-load the module to avoid pulling in the full RocketRide runtime.
_spec = importlib.util.spec_from_file_location(
    'redact',
    os.path.join(os.path.dirname(__file__), '..', 'library', 'helpers', 'redact.py'),
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
_redact_dict = _mod.redact_dict


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestRedactDict:
    """Unit tests for redact_dict."""

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

    def test_redacts_nested_dicts(self):
        """Sensitive keys inside nested dicts must be redacted."""
        d = {'outer': {'api_key': 'secret', 'name': 'safe'}, 'model': 'gpt-4'}
        result = _redact_dict(d)
        assert result['outer']['api_key'] == '***REDACTED***'
        assert result['outer']['name'] == 'safe'
        assert result['model'] == 'gpt-4'

    def test_redacts_list_of_dicts(self):
        """Sensitive keys inside lists of dicts must be redacted."""
        d = {'items': [{'token': 'abc'}, {'name': 'ok'}]}
        result = _redact_dict(d)
        assert result['items'][0]['token'] == '***REDACTED***'
        assert result['items'][1]['name'] == 'ok'


# ---------------------------------------------------------------------------
# Allow running with plain `python test_log_redaction.py`
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    t = TestRedactDict()
    failed = 0
    for method_name in sorted(dir(t)):
        if method_name.startswith('test_'):
            print(f'Running {method_name}...', end=' ')
            try:
                getattr(t, method_name)()
                print('OK')
            except Exception as exc:
                failed += 1
                print(f'FAILED: {exc}')
    if failed:
        print(f'\n{failed} test(s) failed.')
        raise SystemExit(1)
    print('\nAll tests passed.')
