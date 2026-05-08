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

from shell_executor import build_environment, execute_command, is_destructive_argv  # noqa: E402


# Use the running interpreter so the tests are cross-platform.
PY = sys.executable


class TestExecuteCommandBasics:
    """execute_command happy paths in argv mode (the safer default)."""

    def test_captures_stdout(self):
        """Stdout from the child is captured in the result."""
        result = execute_command(
            [PY, '-c', "print('hello')"],
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
        """Stderr from the child is captured in the result."""
        result = execute_command(
            [PY, '-c', "import sys; sys.stderr.write('oops')"],
            cwd=None,
            env=dict(os.environ),
            timeout=10,
            max_output_bytes=4096,
        )
        assert result['exit_code'] == 0
        assert 'oops' in result['stderr']

    def test_propagates_nonzero_exit_code(self):
        """Non-zero exit codes propagate verbatim."""
        result = execute_command(
            [PY, '-c', 'import sys; sys.exit(2)'],
            cwd=None,
            env=dict(os.environ),
            timeout=10,
            max_output_bytes=4096,
        )
        assert result['exit_code'] == 2
        assert result['timed_out'] is False

    def test_argv_mode_does_not_interpret_shell_metacharacters(self):
        """Pipes/redirects passed as argv tokens reach the child as literals."""
        # In shell mode, '|' and 'evil' would pipe stdout. In argv mode they
        # are positional arguments to python -c, not shell metas.
        result = execute_command(
            [PY, '-c', 'import sys; print(sys.argv[1:])', '|', 'evil'],
            cwd=None,
            env=dict(os.environ),
            timeout=10,
            max_output_bytes=4096,
        )
        assert result['exit_code'] == 0
        assert "'|'" in result['stdout']
        assert "'evil'" in result['stdout']


class TestExecuteCommandShellMode:
    """Opt-in shell mode preserves access to pipes/redirects/globs."""

    def test_shell_mode_interprets_metacharacters(self):
        """With use_shell=True, '&&' chains commands at the shell level."""
        result = execute_command(
            f'"{PY}" -c "print(\'first\')" && "{PY}" -c "print(\'second\')"',
            cwd=None,
            env=dict(os.environ),
            timeout=10,
            max_output_bytes=4096,
            use_shell=True,
        )
        assert result['exit_code'] == 0
        assert 'first' in result['stdout']
        assert 'second' in result['stdout']


class TestExecuteCommandTimeout:
    """Timeout-driven termination."""

    def test_kills_long_running_command(self):
        """Long-running commands are killed and reported as timed_out."""
        import time

        # Track wall time so we can verify the tree-kill returns promptly.
        start = time.monotonic()
        result = execute_command(
            [PY, '-c', 'import time; time.sleep(5)'],
            cwd=None,
            env=dict(os.environ),
            timeout=1,
            max_output_bytes=4096,
        )
        elapsed = time.monotonic() - start
        assert result['timed_out'] is True
        assert result['exit_code'] == -1
        # Without tree-kill the reader threads stay blocked on the orphan's
        # pipes until the child's own sleep finishes (~5s). Tree-kill should
        # bring everything down well under that. Generous bound to absorb
        # CI jitter while still failing if the regression returns.
        assert elapsed < 4.0, f'expected tree-kill to return fast; took {elapsed:.2f}s'


class TestExecuteCommandWorkingDir:
    """Working directory override."""

    def test_runs_in_specified_directory(self, tmp_path):
        """Child runs with the supplied cwd."""
        result = execute_command(
            [PY, '-c', 'import os; print(os.getcwd())'],
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
    """Per-call environment injection."""

    def test_injects_env_var(self):
        """Env values supplied on the call are visible to the child."""
        env = dict(os.environ)
        env['ROCKETRIDE_TEST_VAR'] = 'injected-value'
        result = execute_command(
            [PY, '-c', "import os; print(os.environ.get('ROCKETRIDE_TEST_VAR', 'MISSING'))"],
            cwd=None,
            env=env,
            timeout=10,
            max_output_bytes=4096,
        )
        assert result['exit_code'] == 0
        assert 'injected-value' in result['stdout']
        assert 'MISSING' not in result['stdout']


class TestExecuteCommandTruncation:
    """Output truncation/streaming caps."""

    def test_truncates_oversized_stdout(self):
        """Stdout above the cap is truncated and marked."""
        # Emit ~4 KiB but cap at 1 KiB.
        result = execute_command(
            [PY, '-c', "print('x' * 4096)"],
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

    def test_streaming_buffer_stays_bounded_for_large_output(self):
        """The streaming reader keeps the buffer at the cap regardless of total output."""
        # Emit ~2 MiB but cap at 4 KiB. The streaming reader must keep the
        # captured buffer at the cap regardless of how much the child writes;
        # this guards against the previous capture_output=True behaviour that
        # buffered the whole output in memory before truncating.
        result = execute_command(
            [PY, '-c', "import sys; sys.stdout.write('y' * (2 * 1024 * 1024))"],
            cwd=None,
            env=dict(os.environ),
            timeout=15,
            max_output_bytes=4096,
        )
        assert result['exit_code'] == 0
        assert result['truncated'] is True
        # Captured text is exactly cap bytes of payload + the marker; nothing
        # near 2 MiB ever reaches our buffer.
        marker = '\n...[truncated]'
        assert result['stdout'].endswith(marker)
        payload = result['stdout'][: -len(marker)]
        assert len(payload) == 4096
        assert payload == 'y' * 4096


class TestIsDestructiveArgv:
    """is_destructive_argv detects argv that performs destructive operations."""

    def test_empty_argv_is_not_destructive(self):
        """An empty argv list is reported as non-destructive."""
        ok, label = is_destructive_argv([])
        assert ok is False and label is None

    def test_plain_command_is_not_destructive(self):
        """A normal read-only command is not flagged."""
        ok, _ = is_destructive_argv(['ls', '-la'])
        assert ok is False

    def test_rm_without_recursive_is_not_destructive(self):
        """`rm somefile` (no recursive flag) is not flagged — single-file deletes are routine."""
        ok, _ = is_destructive_argv(['rm', 'somefile'])
        assert ok is False

    def test_rm_recursive_short(self):
        """`rm -r dir` is flagged."""
        ok, label = is_destructive_argv(['rm', '-r', 'dir'])
        assert ok is True and label == 'rm -r'

    def test_rm_recursive_combined_short(self):
        """`rm -rf dir` (combined short flags) is flagged."""
        ok, label = is_destructive_argv(['rm', '-rf', 'dir'])
        assert ok is True and label == 'rm -r'

    def test_rm_recursive_long(self):
        """`rm --recursive dir` is flagged."""
        ok, label = is_destructive_argv(['rm', '--recursive', 'dir'])
        assert ok is True and label == 'rm -r'

    def test_dd_with_of(self):
        """`dd if=... of=...` is flagged."""
        ok, label = is_destructive_argv(['dd', 'if=/dev/zero', 'of=/dev/sda'])
        assert ok is True and label == 'dd of='

    def test_mkfs_variants(self):
        """`mkfs` and `mkfs.ext4` are both flagged."""
        ok1, _ = is_destructive_argv(['mkfs', '/dev/sda1'])
        ok2, _ = is_destructive_argv(['mkfs.ext4', '/dev/sda1'])
        assert ok1 is True and ok2 is True

    def test_find_delete(self):
        """`find . -delete` is flagged."""
        ok, label = is_destructive_argv(['find', '.', '-name', '*.log', '-delete'])
        assert ok is True and label == 'find -delete'

    def test_git_clean_force(self):
        """`git clean -fd` is flagged."""
        ok, label = is_destructive_argv(['git', 'clean', '-fd'])
        assert ok is True and label == 'git clean -f'

    def test_git_clean_dry_run_not_flagged(self):
        """`git clean -n` (dry run, no force) is not flagged — git refuses to delete without -f."""
        ok, _ = is_destructive_argv(['git', 'clean', '-n'])
        assert ok is False

    def test_truncate_to_zero(self):
        """`truncate -s 0 file` is flagged."""
        ok, label = is_destructive_argv(['truncate', '-s', '0', 'file'])
        assert ok is True and label == 'truncate -s 0'

    def test_shred(self):
        """Bare `shred file` is flagged."""
        ok, label = is_destructive_argv(['shred', 'file'])
        assert ok is True and label == 'shred'

    def test_chmod_000(self):
        """`chmod 000 file` (lockout) is flagged."""
        ok, label = is_destructive_argv(['chmod', '000', 'file'])
        assert ok is True and label == 'chmod 000'


class TestBuildEnvironment:
    """Env precedence: config-defined > agent-supplied > base/host env."""

    def test_config_overrides_call_env(self):
        """Config-defined values beat agent-supplied ones."""
        merged = build_environment(
            base_env={},
            config_env={'KEY': 'from-config'},
            call_env={'KEY': 'from-agent'},
            allow_external_env=True,
        )
        assert merged['KEY'] == 'from-config'

    def test_call_env_overrides_base_when_allowed(self):
        """Agent-supplied values beat base/host env when external env is allowed."""
        merged = build_environment(
            base_env={'KEY': 'from-base'},
            config_env={},
            call_env={'KEY': 'from-agent'},
            allow_external_env=True,
        )
        assert merged['KEY'] == 'from-agent'

    def test_call_env_ignored_when_external_disabled(self):
        """Agent env is dropped entirely when allow_external_env is False."""
        merged = build_environment(
            base_env={'KEY': 'from-base'},
            config_env={},
            call_env={'KEY': 'from-agent', 'EXTRA': 'agent-only'},
            allow_external_env=False,
        )
        assert merged['KEY'] == 'from-base'
        assert 'EXTRA' not in merged

    def test_config_env_added_even_when_external_disabled(self):
        """Config env still applies regardless of allow_external_env."""
        merged = build_environment(
            base_env={},
            config_env={'CFG': 'pinned'},
            call_env={'CFG': 'agent'},
            allow_external_env=False,
        )
        assert merged['CFG'] == 'pinned'

    def test_falls_back_to_os_environ_when_base_is_none(self):
        """base_env=None inherits the host process environment."""
        # Pick whatever key happens to be in os.environ at test time so this
        # test stays robust on sanitized shells that may not expose PATH.
        sentinel = next(iter(os.environ), None)
        if sentinel is None:
            return
        merged = build_environment(
            base_env=None,
            config_env={},
            call_env=None,
            allow_external_env=True,
        )
        assert sentinel in merged

    def test_skips_invalid_call_env_entries(self):
        """Empty/non-string keys in call_env are dropped silently."""
        merged = build_environment(
            base_env={},
            config_env={},
            call_env={'': 'no-name', 'GOOD': 'yes'},
            allow_external_env=True,
        )
        assert '' not in merged
        assert merged['GOOD'] == 'yes'

    def test_coerces_none_value_to_empty_string(self):
        """None values in call_env become empty strings."""
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
        """A FileNotFoundError from Popen is mapped to exit_code 127."""
        import subprocess

        def fake_popen(*args, **kwargs):
            """Stand-in Popen that simulates a missing shell binary."""
            raise FileNotFoundError('no shell here')

        monkeypatch.setattr(subprocess, 'Popen', fake_popen)

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
