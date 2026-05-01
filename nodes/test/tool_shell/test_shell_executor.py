# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
# =============================================================================

"""Unit tests for tool_shell's subprocess executor and env-merging helper."""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Add the node source directory to sys.path so we can import the module
# without triggering the top-level nodes/__init__.py (which requires the
# engine runtime).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_shell'))

from shell_executor import build_environment, execute_command  # noqa: E402


# Use the running interpreter so the tests are cross-platform: shell=True
# resolves the path on both Windows (cmd.exe) and Unix (/bin/sh).
PY = f'"{sys.executable}"'


class TestExecuteCommandBasics:
    def test_captures_stdout(self):
        result = execute_command(
            f'{PY} -c "print(\'hello\')"',
            cwd=None,
            env=dict(os.environ),
            timeout=10,
            max_output_bytes=4096,
        )
        assert result['exit_code'] == 0
        assert 'hello' in result['stdout']
        assert result['timed_out'] is False
        assert result['truncated'] is False

    def test_captures_stderr(self):
        result = execute_command(
            f'{PY} -c "import sys; sys.stderr.write(\'oops\')"',
            cwd=None,
            env=dict(os.environ),
            timeout=10,
            max_output_bytes=4096,
        )
        assert result['exit_code'] == 0
        assert 'oops' in result['stderr']

    def test_propagates_nonzero_exit_code(self):
        result = execute_command(
            f'{PY} -c "import sys; sys.exit(2)"',
            cwd=None,
            env=dict(os.environ),
            timeout=10,
            max_output_bytes=4096,
        )
        assert result['exit_code'] == 2
        assert result['timed_out'] is False


class TestExecuteCommandTimeout:
    def test_kills_long_running_command(self):
        result = execute_command(
            f'{PY} -c "import time; time.sleep(5)"',
            cwd=None,
            env=dict(os.environ),
            timeout=1,
            max_output_bytes=4096,
        )
        assert result['timed_out'] is True
        assert result['exit_code'] == -1


class TestExecuteCommandWorkingDir:
    def test_runs_in_specified_directory(self, tmp_path):
        result = execute_command(
            f'{PY} -c "import os; print(os.getcwd())"',
            cwd=str(tmp_path),
            env=dict(os.environ),
            timeout=10,
            max_output_bytes=4096,
        )
        assert result['exit_code'] == 0
        # tmp_path may be reported with a different case on Windows, so
        # compare via os.path.realpath to normalize.
        assert os.path.realpath(result['stdout'].strip()) == os.path.realpath(str(tmp_path))


class TestExecuteCommandEnvInjection:
    def test_injects_env_var(self):
        env = dict(os.environ)
        env['ROCKETRIDE_TEST_VAR'] = 'injected-value'
        result = execute_command(
            f"{PY} -c \"import os; print(os.environ.get('ROCKETRIDE_TEST_VAR', 'MISSING'))\"",
            cwd=None,
            env=env,
            timeout=10,
            max_output_bytes=4096,
        )
        assert result['exit_code'] == 0
        assert 'injected-value' in result['stdout']
        assert 'MISSING' not in result['stdout']


class TestExecuteCommandTruncation:
    def test_truncates_oversized_stdout(self):
        # Emit ~4 KiB but cap at 1 KiB.
        result = execute_command(
            f'{PY} -c "print(\'x\' * 4096)"',
            cwd=None,
            env=dict(os.environ),
            timeout=10,
            max_output_bytes=1024,
        )
        assert result['exit_code'] == 0
        assert result['truncated'] is True
        # Output is the first 1024 bytes plus the truncation marker.
        assert result['stdout'].startswith('x' * 100)
        assert '[truncated]' in result['stdout']


class TestBuildEnvironment:
    """Env precedence: config-defined > agent-supplied > base/host env."""

    def test_config_overrides_call_env(self):
        merged = build_environment(
            base_env={},
            config_env={'KEY': 'from-config'},
            call_env={'KEY': 'from-agent'},
            allow_external_env=True,
        )
        assert merged['KEY'] == 'from-config'

    def test_call_env_overrides_base_when_allowed(self):
        merged = build_environment(
            base_env={'KEY': 'from-base'},
            config_env={},
            call_env={'KEY': 'from-agent'},
            allow_external_env=True,
        )
        assert merged['KEY'] == 'from-agent'

    def test_call_env_ignored_when_external_disabled(self):
        merged = build_environment(
            base_env={'KEY': 'from-base'},
            config_env={},
            call_env={'KEY': 'from-agent', 'EXTRA': 'agent-only'},
            allow_external_env=False,
        )
        assert merged['KEY'] == 'from-base'
        assert 'EXTRA' not in merged

    def test_config_env_added_even_when_external_disabled(self):
        merged = build_environment(
            base_env={},
            config_env={'CFG': 'pinned'},
            call_env={'CFG': 'agent'},
            allow_external_env=False,
        )
        assert merged['CFG'] == 'pinned'

    def test_falls_back_to_os_environ_when_base_is_none(self):
        # Pick a variable that always exists on Windows and Unix.
        sentinel = 'PATH'
        merged = build_environment(
            base_env=None,
            config_env={},
            call_env=None,
            allow_external_env=True,
        )
        assert sentinel in merged

    def test_skips_invalid_call_env_entries(self):
        merged = build_environment(
            base_env={},
            config_env={},
            call_env={'': 'no-name', 'GOOD': 'yes'},
            allow_external_env=True,
        )
        assert '' not in merged
        assert merged['GOOD'] == 'yes'

    def test_coerces_none_value_to_empty_string(self):
        merged = build_environment(
            base_env={},
            config_env={},
            call_env={'NONE_VAL': None},
            allow_external_env=True,
        )
        assert merged['NONE_VAL'] == ''


class TestShellNotAvailable:
    """If the shell binary cannot be launched, return exit_code 127."""

    def test_returns_127_when_shell_missing(self, monkeypatch):
        import subprocess

        def fake_run(*args, **kwargs):
            raise FileNotFoundError('no shell here')

        monkeypatch.setattr(subprocess, 'run', fake_run)

        result = execute_command(
            'echo hi',
            cwd=None,
            env={},
            timeout=10,
            max_output_bytes=4096,
        )
        assert result['exit_code'] == 127
        assert result['timed_out'] is False
        assert 'no shell here' in result['stderr']
