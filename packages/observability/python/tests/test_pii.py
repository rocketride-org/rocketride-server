# MIT License
#
# Copyright (c) 2026 RocketRide, Inc.

"""Tests for PII scrubbing."""

from rocketride_observability.pii import scrub_pii


class TestEmailScrubbing:
    """Email addresses should have local part redacted."""

    def test_simple_email(self):
        result = scrub_pii({'event': 'user alice@example.com logged in'})
        assert result['event'] == 'user ***@example.com logged in'

    def test_email_in_value(self):
        result = scrub_pii({'email': 'bob.smith@company.org'})
        assert result['email'] == '***@company.org'

    def test_multiple_emails(self):
        result = scrub_pii({'msg': 'from alice@a.com to bob@b.com'})
        assert 'alice' not in result['msg']
        assert 'bob' not in result['msg']
        assert '***@a.com' in result['msg']
        assert '***@b.com' in result['msg']


class TestTokenScrubbing:
    """Bearer tokens and token-like strings should be redacted."""

    def test_bearer_token(self):
        result = scrub_pii({'auth': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig'})
        assert 'eyJ' not in result['auth']
        assert '***REDACTED***' in result['auth']
        assert result['auth'].startswith('Bearer ')

    def test_generic_token(self):
        result = scrub_pii({'event': 'token=abcdefghijklmnopqrstuvwx'})
        assert 'abcdefghijklmnopqrstuvwx' not in result['event']
        assert '***REDACTED***' in result['event']


class TestAWSKeyScrubbing:
    """AWS access keys and secret keys should be redacted."""

    def test_aws_access_key(self):
        result = scrub_pii({'key': 'AKIAIOSFODNN7EXAMPLE'})
        assert 'AKIA' not in result['key']
        assert result['key'] == '***REDACTED***'

    def test_aws_secret_key(self):
        secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1'
        result = scrub_pii({'config': f'aws_secret_access_key={secret}'})
        assert secret not in result['config']
        assert '***REDACTED***' in result['config']


class TestPathScrubbing:
    """File paths containing usernames should be scrubbed."""

    def test_macos_path(self):
        result = scrub_pii({'path': '/Users/dmitrii/Documents/secret.txt'})
        assert 'dmitrii' not in result['path']
        assert '/Users/***/' in result['path']

    def test_linux_path(self):
        result = scrub_pii({'path': '/home/worker/app/data.csv'})
        assert 'worker' not in result['path']
        assert '/home/***/' in result['path']


class TestNonStringValues:
    """Non-string values should pass through unchanged."""

    def test_integer_preserved(self):
        result = scrub_pii({'count': 42, 'event': 'test'})
        assert result['count'] == 42

    def test_none_preserved(self):
        result = scrub_pii({'value': None, 'event': 'test'})
        assert result['value'] is None

    def test_dict_preserved(self):
        nested = {'inner': 'data'}
        result = scrub_pii({'nested': nested, 'event': 'test'})
        assert result['nested'] is nested
