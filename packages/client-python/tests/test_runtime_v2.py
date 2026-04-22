"""
Unit tests for runtime management v2 features:
- Instance targeting in RuntimeManager
- Client runtime_id/runtime_port kwargs
- CLI versions command and --new flag
- spawn_runtime cwd fix
"""

import os
import sys
from unittest.mock import patch, AsyncMock, MagicMock

import pytest

from rocketride.core.runtime.state import StateDB
from rocketride.core.runtime.manager import RuntimeManager
from rocketride.core.runtime.process import spawn_runtime


# ── RuntimeManager instance targeting ────────────────────────────


class TestManagerInstanceTargeting:
    """Tests for ensure_running() instance_id and port targeting."""

    @pytest.fixture
    def tmp_home(self, tmp_path):
        home = tmp_path / '.rocketride'
        with patch('rocketride.core.runtime.state.state_db_path', return_value=home / 'instances' / 'state.db'), patch('rocketride.core.runtime.state.ensure_dirs', side_effect=lambda: (home / 'instances').mkdir(parents=True, exist_ok=True)):
            yield home

    @pytest.mark.asyncio
    async def test_instance_id_reuses_running_instance(self, tmp_home):
        """ensure_running(instance_id='0') finds and reuses a healthy running instance."""
        mgr = RuntimeManager()

        with patch.object(RuntimeManager, '_is_runtime_healthy', new_callable=AsyncMock, return_value=True):
            async with StateDB() as db:
                await db.register('0', 12345, 5570, '3.1.0', 'cli')

            uri, we_started = await mgr.ensure_running(instance_id='0')
            assert uri == 'http://127.0.0.1:5570'
            assert we_started is False

    @pytest.mark.asyncio
    async def test_instance_id_starts_stopped_instance(self, tmp_home):
        """ensure_running(instance_id='0') starts a stopped instance."""
        mgr = RuntimeManager()
        fake_binary = tmp_home / 'runtimes' / '3.1.0' / 'engine'
        fake_binary.parent.mkdir(parents=True, exist_ok=True)
        fake_binary.touch()

        async with StateDB() as db:
            await db.register('0', 0, 0, '3.1.0', 'cli', desired_state='stopped')

        with (
            patch.object(RuntimeManager, '_is_runtime_healthy', new_callable=AsyncMock, return_value=False),
            patch('rocketride.core.runtime.manager.runtime_binary', return_value=fake_binary),
            patch('rocketride.core.runtime.manager.find_available_port', return_value=5580),
            patch('rocketride.core.runtime.manager.spawn_runtime', new_callable=AsyncMock, return_value=99999) as mock_spawn,
            patch('rocketride.core.runtime.manager.wait_healthy', new_callable=AsyncMock),
            patch.object(mgr, '_register_signal_handlers'),
        ):
            uri, we_started = await mgr.ensure_running(instance_id='0')
            assert uri == 'http://127.0.0.1:5580'
            assert we_started is True
            mock_spawn.assert_awaited_once_with(fake_binary, 5580, '0')

    @pytest.mark.asyncio
    async def test_instance_id_nonexistent_raises(self, tmp_home):
        """ensure_running(instance_id='nonexistent') raises RuntimeError."""
        mgr = RuntimeManager()

        with pytest.raises(RuntimeError, match='Runtime instance nonexistent not found'):
            await mgr.ensure_running(instance_id='nonexistent')

    @pytest.mark.asyncio
    async def test_port_targeting_finds_running(self, tmp_home):
        """ensure_running(port=5570) finds a running instance on that port."""
        mgr = RuntimeManager()

        async with StateDB() as db:
            await db.register('0', 12345, 5570, '3.1.0', 'cli')

        with patch.object(RuntimeManager, '_is_runtime_healthy', new_callable=AsyncMock, return_value=True):
            uri, we_started = await mgr.ensure_running(port=5570)
            assert uri == 'http://127.0.0.1:5570'
            assert we_started is False
            assert mgr._instance_id == '0'

    @pytest.mark.asyncio
    async def test_port_targeting_raises_if_not_healthy(self, tmp_home):
        """ensure_running(port=5570) raises error if port not healthy."""
        mgr = RuntimeManager()

        with patch.object(RuntimeManager, '_is_runtime_healthy', new_callable=AsyncMock, return_value=False):
            with pytest.raises(RuntimeError, match='No healthy runtime found on port 5570'):
                await mgr.ensure_running(port=5570)

    @pytest.mark.asyncio
    async def test_no_args_uses_auto_discovery(self, tmp_home):
        """ensure_running() with no args uses existing find_running auto-discovery."""
        mgr = RuntimeManager()

        async with StateDB() as db:
            await db.register('0', os.getpid(), 5570, '3.1.0', 'cli')

        with patch.object(RuntimeManager, '_is_runtime_healthy', new_callable=AsyncMock, return_value=True):
            uri, we_started = await mgr.ensure_running()
            assert uri == 'http://127.0.0.1:5570'
            assert we_started is False

    @pytest.mark.asyncio
    async def test_instance_id_binary_not_found_raises(self, tmp_home):
        """ensure_running(instance_id='0') raises when binary is missing for stopped instance."""
        mgr = RuntimeManager()
        missing_binary = tmp_home / 'runtimes' / '3.1.0' / 'engine'

        async with StateDB() as db:
            await db.register('0', 0, 0, '3.1.0', 'cli', desired_state='stopped')

        with patch.object(RuntimeManager, '_is_runtime_healthy', new_callable=AsyncMock, return_value=False), patch('rocketride.core.runtime.manager.runtime_binary', return_value=missing_binary):
            with pytest.raises(RuntimeError, match='Runtime binary not found'):
                await mgr.ensure_running(instance_id='0')

    @pytest.mark.asyncio
    async def test_instance_targeting_returns_tuple(self, tmp_home):
        """Instance targeting returns (uri, we_started) tuple correctly."""
        mgr = RuntimeManager()

        async with StateDB() as db:
            await db.register('0', 12345, 5570, '3.1.0', 'cli')

        with patch.object(RuntimeManager, '_is_runtime_healthy', new_callable=AsyncMock, return_value=True):
            result = await mgr.ensure_running(instance_id='0')
            assert isinstance(result, tuple)
            assert len(result) == 2
            uri, we_started = result
            assert isinstance(uri, str)
            assert isinstance(we_started, bool)


# ── Client runtime_id / runtime_port ─────────────────────────────


class TestClientRuntimeTargeting:
    """Tests for RocketRideClient runtime_id and runtime_port kwargs."""

    def test_client_stores_runtime_id(self):
        """Client stores runtime_id from kwargs."""
        from rocketride.client import RocketRideClient

        client = RocketRideClient(
            uri='http://localhost:5565',
            auth='test-key',
            runtime_id='0',
            env={'ROCKETRIDE_APIKEY': 'test-key'},
        )
        assert client._runtime_id == '0'

    def test_client_stores_runtime_port(self):
        """Client stores runtime_port from kwargs."""
        from rocketride.client import RocketRideClient

        client = RocketRideClient(
            uri='http://localhost:5565',
            auth='test-key',
            runtime_port=5570,
            env={'ROCKETRIDE_APIKEY': 'test-key'},
        )
        assert client._runtime_port == 5570

    @pytest.mark.asyncio
    async def test_client_passes_runtime_id_to_ensure_running(self):
        """Client passes runtime_id to RuntimeManager.ensure_running()."""
        from rocketride.client import RocketRideClient

        client = RocketRideClient(
            uri='',
            auth='test-key',
            runtime_id='42',
            env={'ROCKETRIDE_APIKEY': 'test-key'},
        )
        # The runtime manager should exist since runtime_id was provided
        assert client._runtime_manager is not None

        mock_ensure = AsyncMock(return_value=('http://127.0.0.1:5570', True))
        client._runtime_manager.ensure_running = mock_ensure

        # Mock connect to avoid actual WebSocket connection
        with patch.object(client, 'connect', new_callable=AsyncMock):
            await client.__aenter__()

        mock_ensure.assert_awaited_once_with(instance_id='42', port=None)

    @pytest.mark.asyncio
    async def test_client_passes_runtime_port_to_ensure_running(self):
        """Client passes runtime_port to RuntimeManager.ensure_running()."""
        from rocketride.client import RocketRideClient

        client = RocketRideClient(
            uri='',
            auth='test-key',
            runtime_port=5570,
            env={'ROCKETRIDE_APIKEY': 'test-key'},
        )
        assert client._runtime_manager is not None

        mock_ensure = AsyncMock(return_value=('http://127.0.0.1:5570', False))
        client._runtime_manager.ensure_running = mock_ensure

        with patch.object(client, 'connect', new_callable=AsyncMock):
            await client.__aenter__()

        mock_ensure.assert_awaited_once_with(instance_id=None, port=5570)


# ── CLI versions command ─────────────────────────────────────────


class TestCLIVersions:
    """Tests for the `rocketride runtime versions` CLI command."""

    @pytest.mark.asyncio
    async def test_cmd_versions_returns_0_on_success(self):
        from rocketride.cli.commands.runtime import _cmd_versions

        mock_service = MagicMock()
        mock_service.list_versions = AsyncMock(
            return_value=[
                {
                    'version': '3.1.0',
                    'prerelease': False,
                    'published_at': '2026-01-01',
                    'installed': True,
                    'instances': [{'id': '0', 'port': 5565, 'running': True}],
                },
            ]
        )

        args = MagicMock()
        args.prerelease = False

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service), patch('rocketride.cli.commands.runtime.get_compat_range', return_value='>=3.0.0'), patch('sys.stdout') as mock_stdout:
            mock_stdout.isatty.return_value = False
            result = await _cmd_versions(args)
            assert result == 0

    @pytest.mark.asyncio
    async def test_cmd_versions_prerelease_flag(self):
        from rocketride.cli.commands.runtime import _cmd_versions

        mock_service = MagicMock()
        mock_service.list_versions = AsyncMock(return_value=[])

        args = MagicMock()
        args.prerelease = True

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service), patch('rocketride.cli.commands.runtime.get_compat_range', return_value='>=3.0.0'), patch('sys.stdout') as mock_stdout:
            mock_stdout.isatty.return_value = False
            await _cmd_versions(args)
            mock_service.list_versions.assert_awaited_once_with(include_prerelease=True)

    @pytest.mark.asyncio
    async def test_cmd_versions_returns_1_on_error(self):
        from rocketride.cli.commands.runtime import _cmd_versions

        mock_service = MagicMock()
        mock_service.list_versions = AsyncMock(side_effect=Exception('Network error'))

        args = MagicMock()
        args.prerelease = False

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service):
            result = await _cmd_versions(args)
            assert result == 1

    @pytest.mark.asyncio
    async def test_cmd_versions_calls_service_list_versions(self):
        from rocketride.cli.commands.runtime import _cmd_versions

        mock_service = MagicMock()
        mock_service.list_versions = AsyncMock(return_value=[])

        args = MagicMock()
        args.prerelease = False

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service), patch('rocketride.cli.commands.runtime.get_compat_range', return_value='>=3.0.0'), patch('sys.stdout') as mock_stdout:
            mock_stdout.isatty.return_value = False
            await _cmd_versions(args)
            mock_service.list_versions.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_dispatch_versions_command(self):
        from rocketride.cli.commands.runtime import handle_runtime_command

        mock_service = MagicMock()
        mock_service.list_versions = AsyncMock(return_value=[])

        args = MagicMock()
        args.runtime_command = 'versions'
        args.prerelease = False

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service), patch('rocketride.cli.commands.runtime.get_compat_range', return_value='>=3.0.0'), patch('sys.stdout') as mock_stdout:
            mock_stdout.isatty.return_value = False
            result = await handle_runtime_command(args)
            assert result == 0

    @pytest.mark.asyncio
    async def test_cmd_versions_empty_list(self):
        """Versions command prints 'No compatible versions found.' when list is empty."""
        from rocketride.cli.commands.runtime import _cmd_versions

        mock_service = MagicMock()
        mock_service.list_versions = AsyncMock(return_value=[])

        args = MagicMock()
        args.prerelease = False

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service), patch('rocketride.cli.commands.runtime.get_compat_range', return_value='>=3.0.0'), patch('sys.stdout') as mock_stdout, patch('builtins.print') as mock_print:
            mock_stdout.isatty.return_value = False
            result = await _cmd_versions(args)
            assert result == 0
            # Check that 'No compatible versions found.' was printed
            print_calls = [str(c) for c in mock_print.call_args_list]
            assert any('No compatible versions found' in c for c in print_calls)


# ── CLI --new flag ───────────────────────────────────────────────


class TestCLINewFlag:
    """Tests for the install --new flag."""

    @pytest.mark.asyncio
    async def test_install_new_passes_allow_duplicate_true(self):
        """Install with args.new=True passes allow_duplicate=True to service."""
        from rocketride.cli.commands.runtime import _cmd_install

        mock_service = MagicMock()
        mock_service.install = AsyncMock(
            return_value={
                'id': '1',
                'version': '3.1.0',
                'pid': 0,
                'port': 0,
            }
        )

        args = MagicMock()
        args.version = '3.1.0'
        args.force = False
        args.docker = False
        args.local = False
        args.port = None
        args.new = True

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service), patch('rocketride.cli.commands.runtime._cmd_list', new_callable=AsyncMock, return_value=0):
            result = await _cmd_install(args)
            assert result == 0
            mock_service.install.assert_awaited_once()
            _, kwargs = mock_service.install.call_args
            assert kwargs['allow_duplicate'] is True

    @pytest.mark.asyncio
    async def test_install_default_passes_allow_duplicate_false(self):
        """Install with args.new=False (default) passes allow_duplicate=False."""
        from rocketride.cli.commands.runtime import _cmd_install

        mock_service = MagicMock()
        mock_service.install = AsyncMock(
            return_value={
                'id': '0',
                'version': '3.1.0',
                'pid': 0,
                'port': 0,
            }
        )

        args = MagicMock()
        args.version = '3.1.0'
        args.force = False
        args.docker = False
        args.local = False
        args.port = None
        args.new = False

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service), patch('rocketride.cli.commands.runtime._cmd_list', new_callable=AsyncMock, return_value=0):
            result = await _cmd_install(args)
            assert result == 0
            mock_service.install.assert_awaited_once()
            _, kwargs = mock_service.install.call_args
            assert kwargs['allow_duplicate'] is False

    @pytest.mark.asyncio
    async def test_install_new_creates_second_instance(self):
        """Install --new creates a second instance even if one exists for the same version."""
        from rocketride.core.runtime.service import RuntimeService

        mock_db = AsyncMock(spec=StateDB)
        mock_db.next_id = AsyncMock(return_value='1')
        mock_db.get = AsyncMock(
            return_value={
                'id': '1',
                'version': '3.1.0',
                'pid': 0,
                'port': 0,
                'type': 'Local',
                'desired_state': 'stopped',
            }
        )
        mock_db.register = AsyncMock()
        mock_db.__aenter__ = AsyncMock(return_value=mock_db)
        mock_db.__aexit__ = AsyncMock(return_value=False)

        fake_binary = MagicMock()
        fake_binary.exists.return_value = True

        with patch('rocketride.core.runtime.service.StateDB', return_value=mock_db), patch('rocketride.core.runtime.service.runtime_binary', return_value=fake_binary), patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v):
            service = RuntimeService()
            await service.install(
                version='3.1.0',
                type='Local',
                allow_duplicate=True,
            )
            # When allow_duplicate is True, next_id is called (not find_by_version_and_type)
            mock_db.next_id.assert_awaited()

    @pytest.mark.asyncio
    async def test_install_new_flag_in_argparser(self):
        """Verify --new flag is registered in argparse."""
        from rocketride.cli.commands.runtime import _add_runtime_subcommands
        import argparse

        parser = argparse.ArgumentParser()
        subs = parser.add_subparsers(dest='cmd')
        _add_runtime_subcommands(subs)

        parsed = parser.parse_args(['install', '--new'])
        assert parsed.new is True

        parsed_default = parser.parse_args(['install'])
        assert parsed_default.new is False


# ── spawn_runtime cwd fix ────────────────────────────────────────


class TestSpawnRuntimeCwd:
    """Tests that spawn_runtime passes cwd=binary_path.parent to Popen."""

    @pytest.mark.asyncio
    async def test_spawn_cwd_windows(self, tmp_path):
        """On Windows, Popen receives cwd=binary_path.parent."""
        binary_path = tmp_path / 'runtimes' / '3.1.0' / 'engine.exe'
        binary_path.parent.mkdir(parents=True, exist_ok=True)
        binary_path.touch()

        # Create the expected eaas.py path so the script argument is valid
        ai_dir = binary_path.parent / 'ai'
        ai_dir.mkdir(parents=True, exist_ok=True)
        (ai_dir / 'eaas.py').touch()

        mock_process = MagicMock()
        mock_process.pid = 12345

        log_dir = tmp_path / 'logs' / '0'

        with patch.object(sys, 'platform', 'win32'), patch('rocketride.core.runtime.process.sys') as mock_sys, patch('rocketride.core.runtime.process.subprocess.Popen', return_value=mock_process) as mock_popen, patch('rocketride.core.runtime.process.logs_dir', return_value=log_dir):
            mock_sys.platform = 'win32'
            pid = await spawn_runtime(binary_path, 5565, '0')

            assert pid == 12345
            mock_popen.assert_called_once()
            _, kwargs = mock_popen.call_args
            assert kwargs['cwd'] == str(binary_path.parent)

    @pytest.mark.asyncio
    async def test_spawn_cwd_unix(self, tmp_path):
        """On Unix, Popen receives cwd=binary_path.parent."""
        binary_path = tmp_path / 'runtimes' / '3.1.0' / 'engine'
        binary_path.parent.mkdir(parents=True, exist_ok=True)
        binary_path.touch()

        ai_dir = binary_path.parent / 'ai'
        ai_dir.mkdir(parents=True, exist_ok=True)
        (ai_dir / 'eaas.py').touch()

        mock_process = MagicMock()
        mock_process.pid = 12345

        log_dir = tmp_path / 'logs' / '0'

        with patch('rocketride.core.runtime.process.sys') as mock_sys, patch('rocketride.core.runtime.process.subprocess.Popen', return_value=mock_process) as mock_popen, patch('rocketride.core.runtime.process.logs_dir', return_value=log_dir):
            mock_sys.platform = 'linux'
            pid = await spawn_runtime(binary_path, 5565, '0')

            assert pid == 12345
            mock_popen.assert_called_once()
            _, kwargs = mock_popen.call_args
            assert kwargs['cwd'] == str(binary_path.parent)

    @pytest.mark.asyncio
    async def test_spawn_cwd_matches_binary_parent(self, tmp_path):
        """The cwd value is always binary_path.parent regardless of nesting."""
        nested_path = tmp_path / 'deep' / 'nested' / 'runtimes' / '3.2.0' / 'engine'
        nested_path.parent.mkdir(parents=True, exist_ok=True)
        nested_path.touch()

        ai_dir = nested_path.parent / 'ai'
        ai_dir.mkdir(parents=True, exist_ok=True)
        (ai_dir / 'eaas.py').touch()

        mock_process = MagicMock()
        mock_process.pid = 54321

        log_dir = tmp_path / 'logs' / '0'

        with patch('rocketride.core.runtime.process.sys') as mock_sys, patch('rocketride.core.runtime.process.subprocess.Popen', return_value=mock_process) as mock_popen, patch('rocketride.core.runtime.process.logs_dir', return_value=log_dir):
            mock_sys.platform = 'linux'
            pid = await spawn_runtime(nested_path, 5565, '0')

            assert pid == 54321
            _, kwargs = mock_popen.call_args
            assert kwargs['cwd'] == str(nested_path.parent)
            assert 'deep' in kwargs['cwd']


pytest_plugins = ['pytest_asyncio']
