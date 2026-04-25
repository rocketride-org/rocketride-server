"""
Tests for environment variable exfiltration fix in _resolve_pipeline.

Validates that the allowlist-based restriction on ${VAR} expansion in
pipeline configs prevents sensitive env vars (AWS keys, DB URLs, tokens)
from being resolved, while still allowing approved ROCKETRIDE_ prefixed
variables.
"""

import json
import os
import re
import pytest
from unittest.mock import patch


class _FakeTask:
    """
    Minimal stand-in that carries only _resolve_pipeline and ALLOWED_ENV_PREFIX
    from the real Task class, avoiding heavyweight __init__ dependencies.
    """

    ALLOWED_ENV_PREFIX = 'ROCKETRIDE_'

    def __init__(self):
        self._launch_env = {}

    def _resolve_pipeline(self, pipeline):
        pipeline_str = json.dumps(pipeline)

        def replacer(match):
            env_var = match.group(1)
            if env_var.startswith(self.ALLOWED_ENV_PREFIX):
                # Check JSON injection vulnerability in env var resolution.
                value = self._launch_env.get(env_var, os.environ.get(env_var, match.group(0)))
                if value == match.group(0):
                    return value  # placeholder not found
                return json.dumps(value)[1:-1]  # escape but strip outer quotes
            return '<REDACTED>'

        resolved_str = re.sub(r'\$\{([^}]+)\}', replacer, pipeline_str)
        return json.loads(resolved_str)


@pytest.fixture
def task():
    return _FakeTask()


# ==========================================================================
# Tests that ALLOWED prefixes resolve correctly
# ==========================================================================


class TestAllowedEnvVars:
    """Env vars with the ROCKETRIDE_ prefix should be resolved normally."""

    @pytest.mark.parametrize(
        'var_name,value',
        [
            ('ROCKETRIDE_API_KEY', 'rr-key-123'),
            ('ROCKETRIDE_HOST', 'localhost'),
            ('ROCKETRIDE_DEBUG', 'true'),
        ],
    )
    def test_allowed_prefix_resolves(self, task, var_name, value):
        with patch.dict(os.environ, {var_name: value}):
            pipeline = {'config': f'${{{var_name}}}'}
            result = task._resolve_pipeline(pipeline)
            assert result['config'] == value

    def test_allowed_var_not_set_keeps_placeholder(self, task):
        """If an allowed var is not set in the env, the original ${VAR} is kept."""
        pipeline = {'config': '${ROCKETRIDE_MISSING}'}
        result = task._resolve_pipeline(pipeline)
        assert result['config'] == '${ROCKETRIDE_MISSING}'

    def test_multiple_allowed_vars(self, task):
        env = {
            'ROCKETRIDE_HOST': 'localhost',
            'ROCKETRIDE_PORT': '8080',
        }
        with patch.dict(os.environ, env):
            pipeline = {'url': '${ROCKETRIDE_HOST}:${ROCKETRIDE_PORT}'}
            result = task._resolve_pipeline(pipeline)
            assert result['url'] == 'localhost:8080'

    def test_launch_env_resolves_allowed_var(self, task):
        task._launch_env = {'ROCKETRIDE_HOST': 'from-launch-env'}
        pipeline = {'host': '${ROCKETRIDE_HOST}'}
        result = task._resolve_pipeline(pipeline)
        assert result['host'] == 'from-launch-env'

    def test_launch_env_takes_precedence_over_process_env(self, task):
        task._launch_env = {'ROCKETRIDE_HOST': 'launch'}
        with patch.dict(os.environ, {'ROCKETRIDE_HOST': 'process'}):
            pipeline = {'host': '${ROCKETRIDE_HOST}'}
            result = task._resolve_pipeline(pipeline)
            assert result['host'] == 'launch'


# ==========================================================================
# Tests that BLOCKED (sensitive) vars are redacted
# ==========================================================================


class TestBlockedEnvVars:
    """Env vars outside the allowlist must be redacted."""

    @pytest.mark.parametrize(
        'var_name',
        [
            'AWS_SECRET_ACCESS_KEY',
            'AWS_ACCESS_KEY_ID',
            'DATABASE_URL',
            'PYPI_TOKEN',
            'GITHUB_TOKEN',
            'HOME',
            'PATH',
            'SSH_PRIVATE_KEY',
            'OPENAI_API_KEY',
            'STRIPE_SECRET_KEY',
            'PIPELINE_MODE',
            'NODE_ENV',
            'ROCKET_DEBUG',
        ],
    )
    def test_sensitive_var_redacted(self, task, var_name):
        with patch.dict(os.environ, {var_name: 'super-secret-value'}):
            pipeline = {'leak': f'${{{var_name}}}'}
            result = task._resolve_pipeline(pipeline)
            assert result['leak'] == '<REDACTED>'
            assert 'super-secret-value' not in json.dumps(result)

    def test_unset_sensitive_var_still_redacted(self, task):
        """Even if the var is NOT in os.environ, it must be redacted -- not kept as placeholder."""
        pipeline = {'leak': '${AWS_SECRET_ACCESS_KEY}'}
        result = task._resolve_pipeline(pipeline)
        assert result['leak'] == '<REDACTED>'

    def test_launch_env_cannot_bypass_allowlist(self, task):
        task._launch_env = {'AWS_SECRET_ACCESS_KEY': 'super-secret-value'}
        pipeline = {'leak': '${AWS_SECRET_ACCESS_KEY}'}
        result = task._resolve_pipeline(pipeline)
        assert result['leak'] == '<REDACTED>'
        assert 'super-secret-value' not in json.dumps(result)

    def test_mixed_allowed_and_blocked(self, task):
        env = {
            'ROCKETRIDE_HOST': 'localhost',
            'AWS_SECRET_ACCESS_KEY': 'AKIA...',
        }
        with patch.dict(os.environ, env):
            pipeline = {
                'host': '${ROCKETRIDE_HOST}',
                'secret': '${AWS_SECRET_ACCESS_KEY}',
            }
            result = task._resolve_pipeline(pipeline)
            assert result['host'] == 'localhost'
            assert result['secret'] == '<REDACTED>'

    def test_nested_pipeline_values(self, task):
        """Blocked vars inside nested structures must also be redacted."""
        with patch.dict(os.environ, {'DATABASE_URL': 'postgres://...'}):
            pipeline = {
                'components': [
                    {'config': {'db': '${DATABASE_URL}'}},
                    {'config': {'safe': '${ROCKETRIDE_MODE}'}},
                ],
            }
            result = task._resolve_pipeline(pipeline)
            assert result['components'][0]['config']['db'] == '<REDACTED>'
            # ROCKETRIDE_MODE not in env -> keeps placeholder
            assert result['components'][1]['config']['safe'] == '${ROCKETRIDE_MODE}'

    def test_inline_mixed_text(self, task):
        """Blocked var embedded in a larger string is still redacted."""
        with patch.dict(
            os.environ,
            {
                'ROCKETRIDE_HOST': 'myhost',
                'AWS_SECRET_ACCESS_KEY': 'secret123',
            },
        ):
            pipeline = {'cmd': 'connect ${ROCKETRIDE_HOST} using ${AWS_SECRET_ACCESS_KEY}'}
            result = task._resolve_pipeline(pipeline)
            assert 'myhost' in result['cmd']
            assert 'secret123' not in result['cmd']
            assert '<REDACTED>' in result['cmd']


# ==========================================================================
# Edge-case and regression tests
# ==========================================================================


class TestEdgeCases:
    def test_no_placeholders(self, task):
        pipeline = {'key': 'plain value'}
        result = task._resolve_pipeline(pipeline)
        assert result == pipeline

    def test_empty_pipeline(self, task):
        result = task._resolve_pipeline({})
        assert result == {}

    def test_dollar_without_brace(self, task):
        """A literal dollar sign without brace should be left alone."""
        pipeline = {'key': 'price is $100'}
        result = task._resolve_pipeline(pipeline)
        assert result['key'] == 'price is $100'

    def test_prefix_must_match_start(self, task):
        """A var like MY_ROCKETRIDE_X should NOT be allowed -- prefix must be at start."""
        with patch.dict(os.environ, {'MY_ROCKETRIDE_X': 'value'}):
            pipeline = {'key': '${MY_ROCKETRIDE_X}'}
            result = task._resolve_pipeline(pipeline)
            assert result['key'] == '<REDACTED>'


# ==========================================================================
# JSON injection prevention tests
# ==========================================================================


class TestJsonInjection:
    """
    Env var values containing JSON special characters must be escaped before
    being spliced into the serialised pipeline string, otherwise an attacker
    who controls an allowed env var could inject arbitrary JSON keys/values.
    """

    def test_double_quotes_in_value_are_escaped(self, task):
        """A value with embedded double-quotes must not break out of the JSON string."""
        payload = '"quoted"'
        with patch.dict(os.environ, {'ROCKETRIDE_VAR': payload}):
            pipeline = {'config': '${ROCKETRIDE_VAR}'}
            result = task._resolve_pipeline(pipeline)
            assert result['config'] == payload

    def test_json_structure_injection_via_quotes(self, task):
        """
        Classic JSON injection: value tries to close the string and add a new key.
        Without escaping, `{"config": "<payload>"}` would become a structurally
        different JSON document with an extra key.
        """
        payload = '", "injected": true, "x": "'
        with patch.dict(os.environ, {'ROCKETRIDE_VAR': payload}):
            pipeline = {'config': '${ROCKETRIDE_VAR}'}
            result = task._resolve_pipeline(pipeline)
            # The result must be a dict with exactly one key; no injection occurred.
            assert list(result.keys()) == ['config']
            assert result['config'] == payload

    def test_backslash_in_value_is_escaped(self, task):
        """Backslashes must be doubled so they remain literal in the decoded value."""
        payload = 'C:\\Users\\secret'
        with patch.dict(os.environ, {'ROCKETRIDE_PATH': payload}):
            pipeline = {'path': '${ROCKETRIDE_PATH}'}
            result = task._resolve_pipeline(pipeline)
            assert result['path'] == payload

    def test_newline_in_value_is_escaped(self, task):
        """Literal newlines inside a JSON string are invalid; they must be \\n-escaped."""
        payload = 'line1\nline2'
        with patch.dict(os.environ, {'ROCKETRIDE_MSG': payload}):
            pipeline = {'msg': '${ROCKETRIDE_MSG}'}
            result = task._resolve_pipeline(pipeline)
            assert result['msg'] == payload

    def test_tab_and_control_chars_are_escaped(self, task):
        payload = 'col1\tcol2\x08end'  # tab + backspace; null bytes are rejected by the OS
        with patch.dict(os.environ, {'ROCKETRIDE_DATA': payload}):
            pipeline = {'data': '${ROCKETRIDE_DATA}'}
            result = task._resolve_pipeline(pipeline)
            assert result['data'] == payload

    def test_injection_in_nested_structure(self, task):
        """Injection attempt inside a nested dict value must also be neutralised."""
        payload = '", "admin": true, "x": "'
        with patch.dict(os.environ, {'ROCKETRIDE_VAR': payload}):
            pipeline = {'components': [{'config': {'key': '${ROCKETRIDE_VAR}'}}]}
            result = task._resolve_pipeline(pipeline)
            assert result['components'][0]['config']['key'] == payload
            assert 'admin' not in result['components'][0]['config']
