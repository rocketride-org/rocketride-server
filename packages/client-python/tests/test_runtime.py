"""
Unit tests for the core.runtime subpackage.

All tests are self-contained — no live server, no network, no disk
writes to the real ~/.rocketride directory.
"""

import io
import os
import sys
import tarfile
import zipfile
from pathlib import Path
from unittest.mock import patch, AsyncMock, MagicMock

import aiohttp
import pytest

from rocketride.core.runtime import paths, platform, ports
from rocketride.core.runtime.state import StateDB, _is_pid_alive
from rocketride.core.runtime.resolver import get_compat_range, resolve_compatible_version, resolve_docker_tag
from rocketride.core.runtime.downloader import download_runtime
from rocketride.core.runtime.process import spawn_runtime, stop_runtime, wait_healthy, wait_ready
from rocketride.core.runtime.manager import RuntimeManager
from rocketride.core.exceptions import (
    UnsupportedPlatformError,
    RuntimeManagementError,
    RuntimeNotFoundError,
)


# ── paths ────────────────────────────────────────────────────────


class TestPaths:
    def test_rocketride_home(self):
        assert paths.rocketride_home() == Path.home() / '.rocketride'

    def test_runtimes_dir(self):
        assert paths.runtimes_dir('3.1.0') == Path.home() / '.rocketride' / 'runtimes' / '3.1.0'

    def test_runtime_binary_unix(self):
        with patch.object(sys, 'platform', 'linux'):
            result = paths.runtime_binary('3.1.0')
            assert result.name == 'engine'

    def test_runtime_binary_windows(self):
        with patch.object(sys, 'platform', 'win32'):
            result = paths.runtime_binary('3.1.0')
            assert result.name == 'engine.exe'

    def test_state_db_path(self):
        assert paths.state_db_path() == Path.home() / '.rocketride' / 'instances' / 'state.db'

    def test_logs_dir(self):
        assert paths.logs_dir('abc123') == Path.home() / '.rocketride' / 'logs' / 'abc123'

    def test_ensure_dirs(self, tmp_path):
        with patch.object(paths, 'rocketride_home', return_value=tmp_path / '.rocketride'):
            paths.ensure_dirs()
            assert (tmp_path / '.rocketride').is_dir()
            assert (tmp_path / '.rocketride' / 'runtimes').is_dir()
            assert (tmp_path / '.rocketride' / 'instances').is_dir()
            assert (tmp_path / '.rocketride' / 'logs').is_dir()


# ── platform ─────────────────────────────────────────────────────


class TestPlatform:
    def test_darwin_arm64(self):
        with patch('rocketride.core.runtime.platform._platform.system', return_value='Darwin'), patch('rocketride.core.runtime.platform._platform.machine', return_value='arm64'), patch.object(sys, 'platform', 'darwin'):
            assert platform.get_platform() == ('darwin', 'arm64')

    def test_linux_x86_64(self):
        with patch('rocketride.core.runtime.platform._platform.system', return_value='Linux'), patch('rocketride.core.runtime.platform._platform.machine', return_value='x86_64'), patch.object(sys, 'platform', 'linux'):
            assert platform.get_platform() == ('linux', 'x64')

    def test_linux_amd64(self):
        with patch('rocketride.core.runtime.platform._platform.system', return_value='Linux'), patch('rocketride.core.runtime.platform._platform.machine', return_value='amd64'), patch.object(sys, 'platform', 'linux'):
            assert platform.get_platform() == ('linux', 'x64')

    def test_windows(self):
        with patch('rocketride.core.runtime.platform._platform.system', return_value='Windows'), patch.object(sys, 'platform', 'win32'):
            assert platform.get_platform() == ('win', '64')

    def test_unsupported_platform_raises(self):
        with patch('rocketride.core.runtime.platform._platform.system', return_value='Darwin'), patch('rocketride.core.runtime.platform._platform.machine', return_value='x86_64'), patch.object(sys, 'platform', 'darwin'):
            with pytest.raises(UnsupportedPlatformError, match='Unsupported platform'):
                platform.get_platform()

    def test_asset_name_darwin_arm64(self):
        with patch('rocketride.core.runtime.platform.get_platform', return_value=('darwin', 'arm64')):
            assert platform.asset_name('3.2.1') == 'rocketride-server-v3.2.1-darwin-arm64.tar.gz'

    def test_asset_name_linux_x64(self):
        with patch('rocketride.core.runtime.platform.get_platform', return_value=('linux', 'x64')):
            assert platform.asset_name('3.2.1') == 'rocketride-server-v3.2.1-linux-x64.tar.gz'

    def test_asset_name_win64(self):
        with patch('rocketride.core.runtime.platform.get_platform', return_value=('win', '64')):
            assert platform.asset_name('3.2.1') == 'rocketride-server-v3.2.1-win64.zip'

    def test_release_tag(self):
        assert platform.release_tag('3.2.1') == 'server-v3.2.1'


# ── ports ────────────────────────────────────────────────────────


class TestPorts:
    def test_find_available_port_returns_int(self):
        # Use the default base port — any free port in the range is fine
        port = ports.find_available_port()
        assert isinstance(port, int)
        assert port >= 5565

    def test_find_available_port_skips_occupied(self):
        import socket

        # Occupy a port and keep it occupied during the check
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        s.bind(('127.0.0.1', 0))
        s.listen(1)
        occupied_port = s.getsockname()[1]
        try:
            # Ask for that port — should get next one
            result = ports.find_available_port(base=occupied_port)
            assert result > occupied_port
        finally:
            s.close()

    def test_find_available_port_raises_when_exhausted(self):
        with patch('rocketride.core.runtime.ports.socket.socket') as mock_sock:
            instance = MagicMock()
            instance.__enter__ = MagicMock(return_value=instance)
            instance.__exit__ = MagicMock(return_value=False)
            instance.bind.side_effect = OSError('in use')
            mock_sock.return_value = instance
            with pytest.raises(OSError, match='No available port'):
                ports.find_available_port(base=5565)


# ── state ────────────────────────────────────────────────────────


class TestStateDB:
    @pytest.fixture
    def tmp_home(self, tmp_path):
        """Redirect ~/.rocketride to a temp directory."""
        home = tmp_path / '.rocketride'
        with patch('rocketride.core.runtime.state.state_db_path', return_value=home / 'instances' / 'state.db'), patch('rocketride.core.runtime.state.ensure_dirs', side_effect=lambda: (home / 'instances').mkdir(parents=True, exist_ok=True)):
            yield home

    @pytest.mark.asyncio
    async def test_register_and_get(self, tmp_home):
        async with StateDB() as db:
            await db.register('test-1', 12345, 5565, '3.1.0', 'user')
            inst = await db.get('test-1')
            assert inst is not None
            assert inst['pid'] == 12345
            assert inst['port'] == 5565
            assert inst['version'] == '3.1.0'
            assert inst['owner'] == 'user'

    @pytest.mark.asyncio
    async def test_unregister(self, tmp_home):
        async with StateDB() as db:
            await db.register('test-2', 99999, 5566, '3.1.0', 'sdk')
            await db.unregister('test-2')
            assert await db.get('test-2') is None

    @pytest.mark.asyncio
    async def test_get_all(self, tmp_home):
        async with StateDB() as db:
            await db.register('a', 1, 5565, '3.0.0', 'user')
            await db.register('b', 2, 5566, '3.1.0', 'sdk')
            all_inst = await db.get_all()
            assert len(all_inst) == 2
            ids = {inst['id'] for inst in all_inst}
            assert ids == {'a', 'b'}

    @pytest.mark.asyncio
    async def test_get_returns_none_for_missing(self, tmp_home):
        async with StateDB() as db:
            assert await db.get('nonexistent') is None

    @pytest.mark.asyncio
    async def test_find_running_returns_alive_instance(self, tmp_home):
        async with StateDB() as db:
            await db.register('live', os.getpid(), 5565, '3.1.0', 'user')
            result = await db.find_running()
            assert result is not None
            assert result['id'] == 'live'

    @pytest.mark.asyncio
    async def test_find_running_cleans_stale(self, tmp_home):
        async with StateDB() as db:
            # Register with a PID that definitely doesn't exist
            await db.register('dead', 999999999, 5565, '3.1.0', 'user')
            result = await db.find_running()
            assert result is None
            # Stale entry should have been marked stopped (pid/port reset to 0)
            inst = await db.get('dead')
            assert inst is not None
            assert inst['pid'] == 0
            assert inst['port'] == 0

    @pytest.mark.asyncio
    async def test_register_replaces_existing(self, tmp_home):
        async with StateDB() as db:
            await db.register('x', 1, 5565, '3.0.0', 'user')
            await db.register('x', 2, 5566, '3.1.0', 'sdk')
            inst = await db.get('x')
            assert inst['pid'] == 2
            assert inst['port'] == 5566


class TestSoftDelete:
    @pytest.fixture
    def tmp_home(self, tmp_path):
        """Redirect ~/.rocketride to a temp directory."""
        home = tmp_path / '.rocketride'
        with patch('rocketride.core.runtime.state.state_db_path', return_value=home / 'instances' / 'state.db'), patch('rocketride.core.runtime.state.ensure_dirs', side_effect=lambda: (home / 'instances').mkdir(parents=True, exist_ok=True)):
            yield home

    @pytest.mark.asyncio
    async def test_soft_delete_hides_from_list(self, tmp_home):
        async with StateDB() as db:
            await db.register('0', 100, 5565, '3.1.0', 'cli')
            await db.soft_delete('0')
            all_inst = await db.get_all()
            assert len(all_inst) == 0

    @pytest.mark.asyncio
    async def test_soft_delete_preserves_row(self, tmp_home):
        async with StateDB() as db:
            await db.register('0', 100, 5565, '3.1.0', 'cli')
            await db.soft_delete('0')
            inst = await db.get('0')
            assert inst is not None
            assert inst['deleted'] == 1
            assert inst['pid'] == 0
            assert inst['port'] == 0
            assert inst['desired_state'] == 'stopped'

    @pytest.mark.asyncio
    async def test_purge_after_soft_delete(self, tmp_home):
        async with StateDB() as db:
            await db.register('0', 100, 5565, '3.1.0', 'cli')
            await db.soft_delete('0')
            await db.unregister('0')
            assert await db.get('0') is None

    @pytest.mark.asyncio
    async def test_next_id_skips_deleted(self, tmp_home):
        """Soft-deleted IDs are not reused — the sequence keeps incrementing."""
        async with StateDB() as db:
            id0 = await db.next_id()
            assert id0 == '0'
            await db.register('0', 100, 5565, '3.1.0', 'cli')
            await db.soft_delete('0')
            id1 = await db.next_id()
            assert id1 == '1'

    @pytest.mark.asyncio
    async def test_next_id_after_purge(self, tmp_home):
        """Even after a hard purge, IDs are never reused thanks to id_sequence."""
        async with StateDB() as db:
            id0 = await db.next_id()
            assert id0 == '0'
            await db.register('0', 100, 5565, '3.1.0', 'cli')
            await db.unregister('0')  # hard delete
            id1 = await db.next_id()
            assert id1 == '1'

    @pytest.mark.asyncio
    async def test_find_by_version_excludes_deleted(self, tmp_home):
        async with StateDB() as db:
            await db.register('0', 100, 5565, '3.1.0', 'cli')
            await db.soft_delete('0')
            result = await db.find_by_version('3.1.0')
            assert result is None

    @pytest.mark.asyncio
    async def test_find_by_version_includes_deleted(self, tmp_home):
        async with StateDB() as db:
            await db.register('0', 100, 5565, '3.1.0', 'cli')
            await db.soft_delete('0')
            result = await db.find_by_version('3.1.0', include_deleted=True)
            assert result is not None
            assert result['id'] == '0'

    @pytest.mark.asyncio
    async def test_find_running_excludes_deleted(self, tmp_home):
        async with StateDB() as db:
            await db.register('0', os.getpid(), 5565, '3.1.0', 'cli')
            await db.soft_delete('0')
            result = await db.find_running()
            assert result is None

    @pytest.mark.asyncio
    async def test_find_desired_running_excludes_deleted(self, tmp_home):
        async with StateDB() as db:
            await db.register('0', 100, 5565, '3.1.0', 'cli', desired_state='running')
            await db.soft_delete('0')
            result = await db.find_desired_running()
            assert result == []


class TestFindByVersionAndType:
    @pytest.fixture
    def tmp_home(self, tmp_path):
        """Redirect ~/.rocketride to a temp directory."""
        home = tmp_path / '.rocketride'
        with patch('rocketride.core.runtime.state.state_db_path', return_value=home / 'instances' / 'state.db'), patch('rocketride.core.runtime.state.ensure_dirs', side_effect=lambda: (home / 'instances').mkdir(parents=True, exist_ok=True)):
            yield home

    @pytest.mark.asyncio
    async def test_find_by_version_and_type_found(self, tmp_home):
        async with StateDB() as db:
            await db.register('0', 100, 5565, '3.1.0', 'cli', instance_type='Service')
            result = await db.find_by_version_and_type('3.1.0', 'Service')
            assert result is not None
            assert result['id'] == '0'

    @pytest.mark.asyncio
    async def test_find_by_version_and_type_wrong_type_returns_none(self, tmp_home):
        async with StateDB() as db:
            await db.register('0', 100, 5565, '3.1.0', 'cli', instance_type='Local')
            result = await db.find_by_version_and_type('3.1.0', 'Service')
            assert result is None

    @pytest.mark.asyncio
    async def test_find_by_version_and_type_excludes_deleted(self, tmp_home):
        async with StateDB() as db:
            await db.register('0', 100, 5565, '3.1.0', 'cli', instance_type='Service')
            await db.soft_delete('0')
            result = await db.find_by_version_and_type('3.1.0', 'Service')
            assert result is None
            result_incl = await db.find_by_version_and_type('3.1.0', 'Service', include_deleted=True)
            assert result_incl is not None


class TestDesiredState:
    @pytest.fixture
    def tmp_home(self, tmp_path):
        """Redirect ~/.rocketride to a temp directory."""
        home = tmp_path / '.rocketride'
        with patch('rocketride.core.runtime.state.state_db_path', return_value=home / 'instances' / 'state.db'), patch('rocketride.core.runtime.state.ensure_dirs', side_effect=lambda: (home / 'instances').mkdir(parents=True, exist_ok=True)):
            yield home

    @pytest.mark.asyncio
    async def test_desired_state_defaults_to_running(self, tmp_home):
        async with StateDB() as db:
            await db.register('ds-1', 123, 5565, '3.1.0', 'cli')
            inst = await db.get('ds-1')
            assert inst['desired_state'] == 'running'

    @pytest.mark.asyncio
    async def test_register_with_desired_state_running(self, tmp_home):
        async with StateDB() as db:
            await db.register('ds-2', 123, 5565, '3.1.0', 'cli', desired_state='running')
            inst = await db.get('ds-2')
            assert inst['desired_state'] == 'running'

    @pytest.mark.asyncio
    async def test_set_desired_state(self, tmp_home):
        async with StateDB() as db:
            await db.register('ds-3', 123, 5565, '3.1.0', 'cli')
            await db.set_desired_state('ds-3', 'running')
            inst = await db.get('ds-3')
            assert inst['desired_state'] == 'running'

            await db.set_desired_state('ds-3', 'stopped')
            inst = await db.get('ds-3')
            assert inst['desired_state'] == 'stopped'

    @pytest.mark.asyncio
    async def test_find_desired_running(self, tmp_home):
        async with StateDB() as db:
            await db.register('a', 1, 5565, '3.0.0', 'cli', desired_state='running')
            await db.register('b', 2, 5566, '3.1.0', 'cli', desired_state='stopped')
            await db.register('c', 3, 5567, '3.2.0', 'cli', desired_state='running')

            result = await db.find_desired_running()
            ids = [r['id'] for r in result]
            assert ids == ['a', 'c']

    @pytest.mark.asyncio
    async def test_find_desired_running_empty(self, tmp_home):
        async with StateDB() as db:
            await db.register('x', 1, 5565, '3.0.0', 'cli', desired_state='stopped')
            result = await db.find_desired_running()
            assert result == []


class TestIsPidAlive:
    def test_current_process_is_alive(self):
        assert _is_pid_alive(os.getpid()) is True

    def test_nonexistent_pid_is_not_alive(self):
        assert _is_pid_alive(999999999) is False


# ── resolver ─────────────────────────────────────────────────────


class TestResolver:
    def test_get_compat_range_reads_pyproject(self):
        result = get_compat_range()
        # Should match what's in pyproject.toml
        assert '>=3.0.0' in result
        assert '<4.0.0' in result

    @pytest.mark.asyncio
    async def test_resolve_compatible_version_picks_latest(self):
        mock_releases = [
            {'tag_name': 'server-v3.2.0'},
            {'tag_name': 'server-v3.1.0'},
            {'tag_name': 'server-v3.0.5'},
            {'tag_name': 'server-v4.0.0'},  # Outside range
            {'tag_name': 'unrelated-tag'},
        ]

        mock_resp = AsyncMock()
        mock_resp.status = 200
        mock_resp.json = AsyncMock(return_value=mock_releases)
        mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_resp.__aexit__ = AsyncMock(return_value=False)

        mock_session = AsyncMock()
        mock_session.get = MagicMock(return_value=mock_resp)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch('rocketride.core.runtime.resolver.aiohttp.ClientSession', return_value=mock_session):
            version = await resolve_compatible_version('>=3.0.0,<4.0.0')
            assert version == '3.2.0'

    @pytest.mark.asyncio
    async def test_resolve_compatible_version_raises_on_no_match(self):
        mock_releases = [
            {'tag_name': 'server-v4.0.0'},
            {'tag_name': 'server-v5.0.0'},
        ]

        mock_resp = AsyncMock()
        mock_resp.status = 200
        mock_resp.json = AsyncMock(return_value=mock_releases)
        mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_resp.__aexit__ = AsyncMock(return_value=False)

        mock_session = AsyncMock()
        mock_session.get = MagicMock(return_value=mock_resp)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch('rocketride.core.runtime.resolver.aiohttp.ClientSession', return_value=mock_session):
            with pytest.raises(RuntimeNotFoundError, match='No runtime release found'):
                await resolve_compatible_version('>=3.0.0,<4.0.0')

    @pytest.mark.asyncio
    async def test_resolve_compatible_version_raises_on_http_error(self):
        mock_resp = AsyncMock()
        mock_resp.status = 403
        mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_resp.__aexit__ = AsyncMock(return_value=False)

        mock_session = AsyncMock()
        mock_session.get = MagicMock(return_value=mock_resp)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch('rocketride.core.runtime.resolver.aiohttp.ClientSession', return_value=mock_session):
            with pytest.raises(RuntimeNotFoundError, match='HTTP 403'):
                await resolve_compatible_version('>=3.0.0,<4.0.0')


# ── downloader ───────────────────────────────────────────────────


class TestDownloader:
    @pytest.mark.asyncio
    async def test_download_skips_if_binary_exists(self, tmp_path):
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        with patch('rocketride.core.runtime.downloader.runtime_binary', return_value=binary):
            result = await download_runtime('3.1.0')
            assert result == binary

    @pytest.mark.asyncio
    async def test_download_raises_on_http_error(self, tmp_path):
        binary = tmp_path / 'engine'

        mock_resp = AsyncMock()
        mock_resp.status = 404
        mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_resp.__aexit__ = AsyncMock(return_value=False)

        mock_session = AsyncMock()
        mock_session.get = MagicMock(return_value=mock_resp)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with (
            patch('rocketride.core.runtime.downloader.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.downloader.ensure_dirs'),
            patch('rocketride.core.runtime.downloader.asset_name', return_value='test.tar.gz'),
            patch('rocketride.core.runtime.downloader.release_tag', return_value='server-v3.1.0'),
            patch('rocketride.core.runtime.downloader.aiohttp.ClientSession', return_value=mock_session),
        ):
            with pytest.raises(RuntimeNotFoundError, match='not found'):
                await download_runtime('3.1.0')


# ── process ──────────────────────────────────────────────────────


class TestWaitHealthy:
    @pytest.mark.asyncio
    async def test_wait_healthy_returns_on_success(self):
        mock_resp = AsyncMock()
        mock_resp.status = 200
        mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_resp.__aexit__ = AsyncMock(return_value=False)

        mock_session = AsyncMock()
        mock_session.get = MagicMock(return_value=mock_resp)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch('rocketride.core.runtime.process.aiohttp.ClientSession', return_value=mock_session):
            await wait_healthy(5565, timeout=2.0)

    @pytest.mark.asyncio
    async def test_wait_healthy_raises_on_timeout(self):
        mock_session = AsyncMock()
        mock_session.get = MagicMock(side_effect=OSError('connection refused'))
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch('rocketride.core.runtime.process.aiohttp.ClientSession', return_value=mock_session):
            with pytest.raises(RuntimeManagementError, match='did not become healthy'):
                await wait_healthy(5565, timeout=1.0)


class TestWaitReady:
    @pytest.mark.asyncio
    async def test_returns_on_ready_pattern(self, tmp_path):
        log_file = tmp_path / 'stderr.log'
        log_file.write_text('INFO:     Started server process [12345]\nINFO:     Waiting for application startup.\nINFO:     Application startup complete.\nINFO:     Uvicorn running on http://0.0.0.0:5565\n')

        captured = []
        await wait_ready(
            pid=os.getpid(),
            log_file=log_file,
            timeout=2.0,
            on_output=captured.append,
        )

        assert any('Uvicorn running on' in line for line in captured)
        assert len(captured) == 4

    @pytest.mark.asyncio
    async def test_streams_lines_to_on_output(self, tmp_path):
        log_file = tmp_path / 'stderr.log'
        log_file.write_text('line one\nline two\nINFO:     Uvicorn running on http://0.0.0.0:5565\n')

        captured = []
        await wait_ready(
            pid=os.getpid(),
            log_file=log_file,
            timeout=2.0,
            on_output=captured.append,
        )

        assert captured == [
            'line one',
            'line two',
            'INFO:     Uvicorn running on http://0.0.0.0:5565',
        ]

    @pytest.mark.asyncio
    async def test_raises_on_timeout(self, tmp_path):
        log_file = tmp_path / 'stderr.log'
        log_file.write_text('INFO:     Started server process [12345]\n')

        with pytest.raises(RuntimeManagementError, match='did not become ready'):
            await wait_ready(
                pid=os.getpid(),
                log_file=log_file,
                timeout=0.2,
            )

    @pytest.mark.asyncio
    async def test_raises_on_dead_pid(self, tmp_path):
        log_file = tmp_path / 'stderr.log'
        log_file.write_text('INFO:     Started server process [12345]\n')

        with pytest.raises(RuntimeManagementError, match='exited before becoming ready'):
            await wait_ready(
                pid=999999999,
                log_file=log_file,
                timeout=2.0,
            )

    @pytest.mark.asyncio
    async def test_matches_https_url(self, tmp_path):
        log_file = tmp_path / 'stderr.log'
        log_file.write_text('INFO:     Uvicorn running on https://0.0.0.0:5565\n')

        await wait_ready(
            pid=os.getpid(),
            log_file=log_file,
            timeout=2.0,
        )

    @pytest.mark.asyncio
    async def test_works_without_on_output(self, tmp_path):
        log_file = tmp_path / 'stderr.log'
        log_file.write_text('INFO:     Uvicorn running on http://0.0.0.0:5565\n')

        await wait_ready(
            pid=os.getpid(),
            log_file=log_file,
            timeout=2.0,
        )


# ── manager ──────────────────────────────────────────────────────


class TestRuntimeManager:
    def test_initial_state(self):
        mgr = RuntimeManager()
        assert mgr.we_started is False
        assert mgr.uri is None

    def test_uri_property(self):
        mgr = RuntimeManager()
        mgr._port = 5565
        assert mgr.uri == 'http://127.0.0.1:5565'

    @pytest.mark.asyncio
    async def test_ensure_running_reuses_existing(self, tmp_path):
        """When state.db has a live instance, reuse it without spawning."""
        existing = {
            'id': 'existing-1',
            'pid': os.getpid(),
            'port': 5565,
            'version': '3.1.0',
            'started_at': '2026-01-01T00:00:00',
            'owner': 'user',
        }

        mock_db = AsyncMock(spec=StateDB)
        mock_db.find_running = AsyncMock(return_value=existing)
        mock_db.__aenter__ = AsyncMock(return_value=mock_db)
        mock_db.__aexit__ = AsyncMock(return_value=False)

        mgr = RuntimeManager()

        with (
            patch('rocketride.core.runtime.manager.StateDB', return_value=mock_db),
            patch.object(RuntimeManager, '_is_runtime_healthy', new_callable=AsyncMock, return_value=True),
        ):
            uri, we_started = await mgr.ensure_running()

        assert we_started is False
        assert uri == 'http://127.0.0.1:5565'
        assert mgr._instance_id == 'existing-1'

    @pytest.mark.asyncio
    async def test_ensure_running_spawns_when_no_existing(self, tmp_path):
        """When no live instance, spawn a new one."""
        mock_db = AsyncMock(spec=StateDB)
        mock_db.find_running = AsyncMock(return_value=None)
        mock_db.register = AsyncMock()
        mock_db.__aenter__ = AsyncMock(return_value=mock_db)
        mock_db.__aexit__ = AsyncMock(return_value=False)

        fake_binary = tmp_path / 'engine'
        fake_binary.write_text('fake')

        mgr = RuntimeManager()

        async def fake_resolve_binary():
            mgr._version = '3.1.0'
            return fake_binary

        with (
            patch('rocketride.core.runtime.manager.StateDB', return_value=mock_db),
            patch.object(mgr, '_resolve_binary', side_effect=fake_resolve_binary),
            patch('rocketride.core.runtime.manager.find_available_port', return_value=5570),
            patch('rocketride.core.runtime.manager.spawn_runtime', new_callable=AsyncMock, return_value=12345),
            patch('rocketride.core.runtime.manager.wait_healthy', new_callable=AsyncMock),
            patch.object(mgr, '_register_signal_handlers'),
        ):
            uri, we_started = await mgr.ensure_running()

        assert we_started is True
        assert uri == 'http://127.0.0.1:5570'
        mock_db.register.assert_called_once()

    @pytest.mark.asyncio
    async def test_teardown_when_we_started(self, tmp_path):
        """Teardown stops the runtime and unregisters when we started it."""
        inst_data = {
            'id': 'spawned-1',
            'pid': 99999,
            'port': 5570,
            'version': '3.1.0',
            'started_at': '2026-01-01T00:00:00',
            'owner': 'sdk',
        }

        mock_db = AsyncMock(spec=StateDB)
        mock_db.get = AsyncMock(return_value=inst_data)
        mock_db.unregister = AsyncMock()
        mock_db.__aenter__ = AsyncMock(return_value=mock_db)
        mock_db.__aexit__ = AsyncMock(return_value=False)

        mgr = RuntimeManager()
        mgr._we_started = True
        mgr._instance_id = 'spawned-1'
        mgr._port = 5570

        with patch('rocketride.core.runtime.manager.StateDB', return_value=mock_db), patch('rocketride.core.runtime.manager.stop_runtime', new_callable=AsyncMock) as mock_stop, patch.object(mgr, '_restore_signal_handlers'):
            await mgr.teardown()

        mock_stop.assert_called_once_with(99999)
        mock_db.mark_stopped.assert_called_once_with('spawned-1')
        assert mgr._we_started is False
        assert mgr._instance_id is None

    @pytest.mark.asyncio
    async def test_teardown_noop_when_not_started(self):
        """Teardown does nothing when we didn't start the runtime."""
        mgr = RuntimeManager()
        mgr._we_started = False
        # Should return immediately without any side effects
        await mgr.teardown()

    @pytest.mark.asyncio
    async def test_resolve_binary_finds_installed(self, tmp_path):
        """_resolve_binary picks the latest installed compatible version."""
        runtimes_root = tmp_path / 'runtimes'
        (runtimes_root / '3.0.0').mkdir(parents=True)
        (runtimes_root / '3.2.0').mkdir(parents=True)
        (runtimes_root / '3.1.0').mkdir(parents=True)

        # Create fake binaries
        for v in ['3.0.0', '3.1.0', '3.2.0']:
            (runtimes_root / v / 'engine').write_text('fake')

        mgr = RuntimeManager()

        with patch('rocketride.core.runtime.manager.get_compat_range', return_value='>=3.0.0,<4.0.0'), patch('rocketride.core.runtime.manager.rocketride_home', return_value=tmp_path), patch('rocketride.core.runtime.manager.runtime_binary', side_effect=lambda v: runtimes_root / v / 'engine'):
            result = await mgr._resolve_binary()

        assert '3.2.0' in str(result)
        assert mgr._version == '3.2.0'


# ── client auto-spawn integration ───────────────────────────────


class TestClientAutoSpawn:
    def test_runtime_manager_created_when_no_uri(self):
        """Client creates RuntimeManager when no uri and no ROCKETRIDE_URI."""
        with patch.dict(os.environ, {}, clear=True), patch('rocketride.client.os.path.exists', return_value=False):
            from rocketride.client import RocketRideClient

            client = RocketRideClient(env={})
            assert client._runtime_manager is not None
            assert client._uri == ''

    def test_no_runtime_manager_when_uri_provided(self):
        """Client does not create RuntimeManager when uri is explicitly given."""
        with patch.dict(os.environ, {}, clear=True):
            from rocketride.client import RocketRideClient

            client = RocketRideClient(uri='http://localhost:5565', env={})
            assert client._runtime_manager is None

    def test_runtime_manager_created_when_env_uri_set(self):
        """Client creates RuntimeManager as fallback even when ROCKETRIDE_URI is in env."""
        with patch.dict(os.environ, {}, clear=True):
            from rocketride.client import RocketRideClient

            client = RocketRideClient(env={'ROCKETRIDE_URI': 'http://localhost:5565'})
            assert client._runtime_manager is not None


# ── exceptions ───────────────────────────────────────────────────


class TestExceptions:
    def test_unsupported_platform_error_is_exception(self):
        assert issubclass(UnsupportedPlatformError, Exception)
        assert not issubclass(UnsupportedPlatformError, RuntimeManagementError)

    def test_runtime_error_hierarchy(self):
        assert issubclass(RuntimeNotFoundError, RuntimeManagementError)
        assert issubclass(RuntimeManagementError, Exception)

    def test_exception_messages(self):
        e = UnsupportedPlatformError('test message')
        assert str(e) == 'test message'

        e = RuntimeNotFoundError('not found')
        assert str(e) == 'not found'


# ── downloader extraction ─────────────────────────────────────


def _make_tar_gz(members: dict[str, bytes]) -> bytes:
    """Build an in-memory tar.gz archive from {path: content} pairs."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tar:
        for name, data in members.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _make_zip(members: dict[str, bytes]) -> bytes:
    """Build an in-memory zip archive from {path: content} pairs."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _mock_chunked_response(data: bytes, *, status: int = 200, content_length: int | None = None):
    """Create a mock aiohttp response that yields data in chunks."""
    chunk_size = 8192
    chunks = [data[i : i + chunk_size] for i in range(0, len(data), chunk_size)]

    async def iter_chunked(size):
        for chunk in chunks:
            yield chunk

    mock_content = MagicMock()
    mock_content.iter_chunked = iter_chunked

    mock_resp = AsyncMock()
    mock_resp.status = status
    mock_resp.content_length = content_length if content_length is not None else len(data)
    mock_resp.content = mock_content
    mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
    mock_resp.__aexit__ = AsyncMock(return_value=False)

    mock_session = AsyncMock()
    mock_session.get = MagicMock(return_value=mock_resp)
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)

    return mock_session, mock_resp


class TestDownloaderExtraction:
    @pytest.mark.asyncio
    async def test_download_extracts_tar_gz(self, tmp_path):
        binary_path = tmp_path / 'runtimes' / '3.1.0' / 'engine'
        archive_data = _make_tar_gz({'engine': b'fake-binary-content'})
        mock_session, _ = _mock_chunked_response(archive_data)

        with (
            patch('rocketride.core.runtime.downloader.runtime_binary', return_value=binary_path),
            patch('rocketride.core.runtime.downloader.runtimes_dir', return_value=tmp_path / 'runtimes' / '3.1.0'),
            patch('rocketride.core.runtime.downloader.ensure_dirs'),
            patch('rocketride.core.runtime.downloader.asset_name', return_value='test.tar.gz'),
            patch('rocketride.core.runtime.downloader.release_tag', return_value='server-v3.1.0'),
            patch('rocketride.core.runtime.downloader.aiohttp.ClientSession', return_value=mock_session),
        ):
            result = await download_runtime('3.1.0')
            assert result == binary_path
            assert binary_path.exists()
            assert binary_path.read_bytes() == b'fake-binary-content'

    @pytest.mark.asyncio
    async def test_download_extracts_zip(self, tmp_path):
        binary_path = tmp_path / 'runtimes' / '3.1.0' / 'engine.exe'
        archive_data = _make_zip({'engine.exe': b'fake-windows-binary'})
        mock_session, _ = _mock_chunked_response(archive_data)

        with (
            patch('rocketride.core.runtime.downloader.runtime_binary', return_value=binary_path),
            patch('rocketride.core.runtime.downloader.runtimes_dir', return_value=tmp_path / 'runtimes' / '3.1.0'),
            patch('rocketride.core.runtime.downloader.ensure_dirs'),
            patch('rocketride.core.runtime.downloader.asset_name', return_value='test.zip'),
            patch('rocketride.core.runtime.downloader.release_tag', return_value='server-v3.1.0'),
            patch('rocketride.core.runtime.downloader.aiohttp.ClientSession', return_value=mock_session),
        ):
            result = await download_runtime('3.1.0')
            assert result == binary_path
            assert binary_path.exists()
            assert binary_path.read_bytes() == b'fake-windows-binary'

    @pytest.mark.asyncio
    async def test_download_calls_on_progress(self, tmp_path):
        binary_path = tmp_path / 'runtimes' / '3.1.0' / 'engine'
        archive_data = _make_tar_gz({'engine': b'x' * 100})
        mock_session, _ = _mock_chunked_response(archive_data, content_length=len(archive_data))

        progress_calls = []

        with (
            patch('rocketride.core.runtime.downloader.runtime_binary', return_value=binary_path),
            patch('rocketride.core.runtime.downloader.runtimes_dir', return_value=tmp_path / 'runtimes' / '3.1.0'),
            patch('rocketride.core.runtime.downloader.ensure_dirs'),
            patch('rocketride.core.runtime.downloader.asset_name', return_value='test.tar.gz'),
            patch('rocketride.core.runtime.downloader.release_tag', return_value='server-v3.1.0'),
            patch('rocketride.core.runtime.downloader.aiohttp.ClientSession', return_value=mock_session),
        ):
            await download_runtime('3.1.0', on_progress=lambda dl, total: progress_calls.append((dl, total)))

        assert len(progress_calls) >= 1
        # Final call should have downloaded == total
        last_dl, last_total = progress_calls[-1]
        assert last_dl == last_total

    @pytest.mark.asyncio
    async def test_download_calls_on_phase(self, tmp_path):
        binary_path = tmp_path / 'runtimes' / '3.1.0' / 'engine'
        archive_data = _make_tar_gz({'engine': b'x'})
        mock_session, _ = _mock_chunked_response(archive_data)

        phases = []

        with (
            patch('rocketride.core.runtime.downloader.runtime_binary', return_value=binary_path),
            patch('rocketride.core.runtime.downloader.runtimes_dir', return_value=tmp_path / 'runtimes' / '3.1.0'),
            patch('rocketride.core.runtime.downloader.ensure_dirs'),
            patch('rocketride.core.runtime.downloader.asset_name', return_value='test.tar.gz'),
            patch('rocketride.core.runtime.downloader.release_tag', return_value='server-v3.1.0'),
            patch('rocketride.core.runtime.downloader.aiohttp.ClientSession', return_value=mock_session),
        ):
            await download_runtime('3.1.0', on_phase=phases.append)

        assert phases == ['downloading', 'extracting', 'done']

    @pytest.mark.asyncio
    async def test_download_cleans_up_temp_on_failure(self, tmp_path):
        binary_path = tmp_path / 'runtimes' / '3.1.0' / 'engine'

        mock_resp = AsyncMock()
        mock_resp.status = 500
        mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_resp.__aexit__ = AsyncMock(return_value=False)

        mock_session = AsyncMock()
        mock_session.get = MagicMock(return_value=mock_resp)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with (
            patch('rocketride.core.runtime.downloader.runtime_binary', return_value=binary_path),
            patch('rocketride.core.runtime.downloader.ensure_dirs'),
            patch('rocketride.core.runtime.downloader.asset_name', return_value='test.tar.gz'),
            patch('rocketride.core.runtime.downloader.release_tag', return_value='server-v3.1.0'),
            patch('rocketride.core.runtime.downloader.aiohttp.ClientSession', return_value=mock_session),
            patch('tempfile.mkstemp', return_value=(os.open(str(tmp_path / 'test.download'), os.O_CREAT | os.O_WRONLY), str(tmp_path / 'test.download'))),
        ):
            with pytest.raises(RuntimeNotFoundError, match='HTTP 500'):
                await download_runtime('3.1.0')

        # Temp file should be cleaned up
        assert not (tmp_path / 'test.download').exists()

    @pytest.mark.asyncio
    async def test_download_raises_binary_not_found_after_extraction(self, tmp_path):
        # Binary path points to a file that won't exist after extraction
        binary_path = tmp_path / 'runtimes' / '3.1.0' / 'engine'
        # Archive contains a differently-named file
        archive_data = _make_tar_gz({'not-the-engine': b'wrong file'})
        mock_session, _ = _mock_chunked_response(archive_data)

        with (
            patch('rocketride.core.runtime.downloader.runtime_binary', return_value=binary_path),
            patch('rocketride.core.runtime.downloader.runtimes_dir', return_value=tmp_path / 'runtimes' / '3.1.0'),
            patch('rocketride.core.runtime.downloader.ensure_dirs'),
            patch('rocketride.core.runtime.downloader.asset_name', return_value='test.tar.gz'),
            patch('rocketride.core.runtime.downloader.release_tag', return_value='server-v3.1.0'),
            patch('rocketride.core.runtime.downloader.aiohttp.ClientSession', return_value=mock_session),
        ):
            with pytest.raises(RuntimeNotFoundError, match='binary not found'):
                await download_runtime('3.1.0')


# ── version resolution ────────────────────────────────────────


def _mock_github_releases(releases):
    """Create a mock aiohttp session that returns GitHub releases JSON."""
    mock_resp = AsyncMock()
    mock_resp.status = 200
    mock_resp.json = AsyncMock(return_value=releases)
    mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
    mock_resp.__aexit__ = AsyncMock(return_value=False)

    mock_session = AsyncMock()
    mock_session.get = MagicMock(return_value=mock_resp)
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)
    return mock_session


class TestVersionResolution:
    @pytest.mark.asyncio
    async def test_resolve_docker_tag_latest(self):
        releases = [
            {'tag_name': 'server-v3.2.0'},
            {'tag_name': 'server-v3.1.0-prerelease'},
            {'tag_name': 'server-v3.0.0'},
        ]
        mock_session = _mock_github_releases(releases)

        with patch('rocketride.core.runtime.resolver.aiohttp.ClientSession', return_value=mock_session):
            tag = await resolve_docker_tag('latest')
            assert tag == '3.2.0'

    @pytest.mark.asyncio
    async def test_resolve_docker_tag_prerelease(self):
        releases = [
            {'tag_name': 'server-v3.2.0'},
            {'tag_name': 'server-v3.3.0-prerelease'},
            {'tag_name': 'server-v3.1.0-prerelease'},
        ]
        mock_session = _mock_github_releases(releases)

        with patch('rocketride.core.runtime.resolver.aiohttp.ClientSession', return_value=mock_session):
            tag = await resolve_docker_tag('prerelease')
            assert tag == '3.3.0-prerelease'

    @pytest.mark.asyncio
    async def test_resolve_docker_tag_explicit_passthrough(self):
        # Explicit version should return as-is without making HTTP calls
        tag = await resolve_docker_tag('3.1.0')
        assert tag == '3.1.0'

    @pytest.mark.asyncio
    async def test_resolve_docker_tag_no_match_raises(self):
        # Only prereleases available but asking for 'latest'
        releases = [
            {'tag_name': 'server-v3.1.0-prerelease'},
        ]
        mock_session = _mock_github_releases(releases)

        with patch('rocketride.core.runtime.resolver.aiohttp.ClientSession', return_value=mock_session):
            with pytest.raises(RuntimeNotFoundError, match='No runtime release found'):
                await resolve_docker_tag('latest')

    @pytest.mark.asyncio
    async def test_resolve_compatible_version_network_error(self):
        mock_session = AsyncMock()
        mock_session.get = MagicMock(side_effect=aiohttp.ClientError('Connection refused'))
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch('rocketride.core.runtime.resolver.aiohttp.ClientSession', return_value=mock_session):
            with pytest.raises((RuntimeNotFoundError, aiohttp.ClientError)):
                await resolve_compatible_version('>=3.0.0,<4.0.0')


# ── spawn runtime ─────────────────────────────────────────────


class TestSpawnRuntime:
    @pytest.mark.asyncio
    async def test_spawn_creates_log_directory(self, tmp_path):
        log_dir = tmp_path / 'logs' / 'test-1'
        binary = tmp_path / 'engine'
        binary.write_text('fake')
        script = binary.parent / 'ai' / 'eaas.py'
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text('pass')

        mock_process = MagicMock()
        mock_process.pid = 12345

        with (
            patch('rocketride.core.runtime.process.logs_dir', return_value=log_dir),
            patch('rocketride.core.runtime.process.subprocess.Popen', return_value=mock_process),
        ):
            pid = await spawn_runtime(binary, 5565, 'test-1')

        assert log_dir.exists()
        assert pid == 12345

    @pytest.mark.asyncio
    async def test_spawn_returns_pid(self, tmp_path):
        log_dir = tmp_path / 'logs' / 'test-2'
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        mock_process = MagicMock()
        mock_process.pid = 99999

        with (
            patch('rocketride.core.runtime.process.logs_dir', return_value=log_dir),
            patch('rocketride.core.runtime.process.subprocess.Popen', return_value=mock_process),
        ):
            pid = await spawn_runtime(binary, 5565, 'test-2')

        assert pid == 99999

    @pytest.mark.asyncio
    async def test_spawn_raises_on_binary_not_found(self, tmp_path):
        log_dir = tmp_path / 'logs' / 'test-3'
        binary = tmp_path / 'nonexistent' / 'engine'

        with (
            patch('rocketride.core.runtime.process.logs_dir', return_value=log_dir),
            patch('rocketride.core.runtime.process.subprocess.Popen', side_effect=FileNotFoundError('No such file')),
        ):
            with pytest.raises(RuntimeManagementError, match='Failed to start runtime'):
                await spawn_runtime(binary, 5565, 'test-3')

    @pytest.mark.asyncio
    async def test_spawn_sets_pythonunbuffered(self, tmp_path):
        log_dir = tmp_path / 'logs' / 'test-4'
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        mock_process = MagicMock()
        mock_process.pid = 11111
        captured_env = {}

        def capture_popen(*args, **kwargs):
            captured_env.update(kwargs.get('env', {}))
            return mock_process

        with (
            patch('rocketride.core.runtime.process.logs_dir', return_value=log_dir),
            patch('rocketride.core.runtime.process.subprocess.Popen', side_effect=capture_popen),
        ):
            await spawn_runtime(binary, 5565, 'test-4')

        assert captured_env.get('PYTHONUNBUFFERED') == '1'

    @pytest.mark.asyncio
    async def test_spawn_closes_file_handles(self, tmp_path):
        log_dir = tmp_path / 'logs' / 'test-5'
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        mock_process = MagicMock()
        mock_process.pid = 22222

        opened_handles = []
        original_open = open

        def tracking_open(*args, **kwargs):
            fh = original_open(*args, **kwargs)
            opened_handles.append(fh)
            return fh

        with (
            patch('rocketride.core.runtime.process.logs_dir', return_value=log_dir),
            patch('rocketride.core.runtime.process.subprocess.Popen', return_value=mock_process),
            patch('builtins.open', side_effect=tracking_open),
        ):
            await spawn_runtime(binary, 5565, 'test-5')

        # All opened file handles should be closed
        for fh in opened_handles:
            assert fh.closed


# ── stop runtime ──────────────────────────────────────────────


class TestStopRuntime:
    @pytest.mark.asyncio
    async def test_stop_already_exited(self):
        """Process already gone — no error raised."""
        with patch('rocketride.core.runtime.process.sys.platform', 'linux'):
            with patch('os.kill', side_effect=ProcessLookupError):
                await stop_runtime(999999999)

    @pytest.mark.asyncio
    async def test_stop_sends_sigterm_unix(self):
        """On Unix, verify SIGTERM is sent first."""
        import signal

        kill_calls = []

        def mock_kill(pid, sig):
            kill_calls.append((pid, sig))
            if sig == signal.SIGTERM:
                return
            # sig == 0 means the process is still alive check
            raise ProcessLookupError

        with (
            patch('rocketride.core.runtime.process.sys.platform', 'linux'),
            patch('os.kill', side_effect=mock_kill),
        ):
            await stop_runtime(42, timeout=0.5)

        # First call should be SIGTERM
        assert kill_calls[0] == (42, signal.SIGTERM)

    @pytest.mark.skipif(sys.platform == 'win32', reason='SIGKILL not available on Windows')
    @pytest.mark.asyncio
    async def test_stop_escalates_to_sigkill(self):
        """Process doesn't exit after SIGTERM — escalates to SIGKILL."""
        import signal

        kill_calls = []

        def mock_kill(pid, sig):
            kill_calls.append((pid, sig))
            # Process never exits (sig 0 check always succeeds)
            if sig == 0:
                return

        with (
            patch('rocketride.core.runtime.process.sys.platform', 'linux'),
            patch('os.kill', side_effect=mock_kill),
        ):
            await stop_runtime(42, timeout=0.3)

        signals_sent = [sig for _, sig in kill_calls if sig != 0]
        assert signal.SIGTERM in signals_sent
        assert signal.SIGKILL in signals_sent


# ── manager auto-spawn ────────────────────────────────────────


class TestManagerAutoSpawn:
    @pytest.mark.asyncio
    async def test_ensure_running_downloads_when_no_binary(self, tmp_path):
        """No binary installed — downloads and spawns."""
        runtimes_root = tmp_path / 'runtimes'
        runtimes_root.mkdir()
        # Empty runtimes dir — nothing installed

        mock_db = AsyncMock(spec=StateDB)
        mock_db.find_running = AsyncMock(return_value=None)
        mock_db.find_by_version = AsyncMock(return_value=None)
        mock_db.next_id = AsyncMock(return_value='0')
        mock_db.register = AsyncMock()
        mock_db.__aenter__ = AsyncMock(return_value=mock_db)
        mock_db.__aexit__ = AsyncMock(return_value=False)

        fake_binary = tmp_path / 'downloaded' / 'engine'
        fake_binary.parent.mkdir(parents=True)
        fake_binary.write_text('fake')

        mgr = RuntimeManager()

        with (
            patch('rocketride.core.runtime.manager.StateDB', return_value=mock_db),
            patch('rocketride.core.runtime.manager.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.manager.rocketride_home', return_value=tmp_path),
            patch('rocketride.core.runtime.manager.resolve_compatible_version', new_callable=AsyncMock, return_value='3.2.0'),
            patch('rocketride.core.runtime.manager.download_runtime', new_callable=AsyncMock, return_value=fake_binary),
            patch('rocketride.core.runtime.manager.find_available_port', return_value=5570),
            patch('rocketride.core.runtime.manager.spawn_runtime', new_callable=AsyncMock, return_value=12345),
            patch('rocketride.core.runtime.manager.wait_healthy', new_callable=AsyncMock),
            patch.object(mgr, '_register_signal_handlers'),
        ):
            uri, we_started = await mgr.ensure_running()

        assert we_started is True
        assert '5570' in uri

    @pytest.mark.asyncio
    async def test_ensure_running_stops_stale_instance(self, tmp_path):
        """Existing instance has alive PID but health check fails — stop and re-spawn."""
        stale = {
            'id': 'stale-1',
            'pid': os.getpid(),
            'port': 5565,
            'version': '3.1.0',
            'started_at': '2026-01-01T00:00:00',
            'owner': 'user',
        }

        mock_db = AsyncMock(spec=StateDB)
        mock_db.find_running = AsyncMock(return_value=stale)
        mock_db.mark_stopped = AsyncMock()
        mock_db.find_by_version = AsyncMock(return_value=None)
        mock_db.next_id = AsyncMock(return_value='1')
        mock_db.register = AsyncMock()
        mock_db.__aenter__ = AsyncMock(return_value=mock_db)
        mock_db.__aexit__ = AsyncMock(return_value=False)

        fake_binary = tmp_path / 'engine'
        fake_binary.write_text('fake')

        mgr = RuntimeManager()

        with (
            patch('rocketride.core.runtime.manager.StateDB', return_value=mock_db),
            patch.object(RuntimeManager, '_is_runtime_healthy', new_callable=AsyncMock, return_value=False),
            patch('rocketride.core.runtime.manager.stop_runtime', new_callable=AsyncMock) as mock_stop,
            patch.object(mgr, '_resolve_binary', side_effect=lambda: setattr(mgr, '_version', '3.1.0') or fake_binary),
            patch('rocketride.core.runtime.manager.find_available_port', return_value=5571),
            patch('rocketride.core.runtime.manager.spawn_runtime', new_callable=AsyncMock, return_value=12345),
            patch('rocketride.core.runtime.manager.wait_healthy', new_callable=AsyncMock),
            patch.object(mgr, '_register_signal_handlers'),
        ):
            uri, we_started = await mgr.ensure_running()

        # Stale instance should have been stopped and marked
        mock_stop.assert_called_once_with(stale['pid'])
        mock_db.mark_stopped.assert_called_once_with('stale-1')
        assert we_started is True

    @pytest.mark.asyncio
    async def test_ensure_running_registers_stopped_on_health_failure(self, tmp_path):
        """Spawn succeeds but health check fails — kills process and registers stopped."""
        mock_db = AsyncMock(spec=StateDB)
        mock_db.find_running = AsyncMock(return_value=None)
        mock_db.find_by_version = AsyncMock(return_value=None)
        mock_db.next_id = AsyncMock(return_value='0')
        mock_db.register = AsyncMock()
        mock_db.__aenter__ = AsyncMock(return_value=mock_db)
        mock_db.__aexit__ = AsyncMock(return_value=False)

        fake_binary = tmp_path / 'engine'
        fake_binary.write_text('fake')

        mgr = RuntimeManager()

        async def fake_resolve():
            mgr._version = '3.1.0'
            return fake_binary

        with (
            patch('rocketride.core.runtime.manager.StateDB', return_value=mock_db),
            patch.object(mgr, '_resolve_binary', side_effect=fake_resolve),
            patch('rocketride.core.runtime.manager.find_available_port', return_value=5572),
            patch('rocketride.core.runtime.manager.spawn_runtime', new_callable=AsyncMock, return_value=12345),
            patch('rocketride.core.runtime.manager.wait_healthy', new_callable=AsyncMock, side_effect=RuntimeManagementError('timeout')),
            patch('rocketride.core.runtime.manager.stop_runtime', new_callable=AsyncMock) as mock_stop,
        ):
            with pytest.raises(RuntimeManagementError, match='timeout'):
                await mgr.ensure_running()

        mock_stop.assert_called_once_with(12345)
        # Should register with pid=0 and desired_state='stopped'
        mock_db.register.assert_called_once()
        call_kwargs = mock_db.register.call_args
        assert call_kwargs[0][1] == 0  # pid=0
        assert call_kwargs[1].get('desired_state') == 'stopped'

    @pytest.mark.asyncio
    async def test_is_runtime_healthy_returns_false_on_connection_error(self):
        mock_session = AsyncMock()
        mock_session.get = MagicMock(side_effect=aiohttp.ClientError('refused'))
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        mock_aiohttp = MagicMock()
        mock_aiohttp.ClientSession = MagicMock(return_value=mock_session)
        mock_aiohttp.ClientError = aiohttp.ClientError
        mock_aiohttp.ClientTimeout = aiohttp.ClientTimeout

        with patch.dict('sys.modules', {'aiohttp': mock_aiohttp}):
            result = await RuntimeManager._is_runtime_healthy(9999)
            assert result is False

    @pytest.mark.asyncio
    async def test_is_runtime_healthy_returns_false_on_4xx(self):
        mock_resp = AsyncMock()
        mock_resp.status = 404
        mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_resp.__aexit__ = AsyncMock(return_value=False)

        mock_session = AsyncMock()
        mock_session.get = MagicMock(return_value=mock_resp)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        mock_aiohttp = MagicMock()
        mock_aiohttp.ClientSession = MagicMock(return_value=mock_session)
        mock_aiohttp.ClientError = aiohttp.ClientError
        mock_aiohttp.ClientTimeout = aiohttp.ClientTimeout

        with patch.dict('sys.modules', {'aiohttp': mock_aiohttp}):
            result = await RuntimeManager._is_runtime_healthy(5565)
            assert result is False


# ── CLI install ───────────────────────────────────────────────


class TestCLIInstall:
    """CLI install tests — mock RuntimeService since CLI is now a thin wrapper."""

    @pytest.mark.asyncio
    async def test_install_specific_version_local(self):
        """--local flag: delegates to service with type=Local."""
        from rocketride.cli.commands.runtime import _cmd_install

        mock_service = MagicMock()
        mock_service.install = AsyncMock(return_value={'id': '0', 'version': '3.1.0', 'pid': 0, 'port': 0})

        args = MagicMock()
        args.version = '3.1.0'
        args.force = False
        args.docker = False
        args.local = True
        args.port = None
        args.new = False

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service), patch('rocketride.cli.commands.runtime._cmd_list', new_callable=AsyncMock, return_value=0):
            result = await _cmd_install(args)

        assert result == 0
        mock_service.install.assert_awaited_once()
        _, kwargs = mock_service.install.call_args
        assert kwargs['type'] == 'Local'

    @pytest.mark.asyncio
    async def test_install_service_default(self):
        """No flag = Service type."""
        from rocketride.cli.commands.runtime import _cmd_install

        mock_service = MagicMock()
        mock_service.install = AsyncMock(return_value={'id': '0', 'version': '3.1.0', 'pid': 12345, 'port': 5570})

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
        _, kwargs = mock_service.install.call_args
        assert kwargs['type'] == 'Service'

    @pytest.mark.asyncio
    async def test_install_service_autostart_failure(self):
        """Auto-start fails: returns 1."""
        from rocketride.cli.commands.runtime import _cmd_install

        mock_service = MagicMock()
        mock_service.install = AsyncMock(side_effect=RuntimeManagementError('Auto-start failed: not ready'))

        args = MagicMock()
        args.version = '3.1.0'
        args.force = False
        args.docker = False
        args.local = False
        args.port = None
        args.new = False

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service):
            result = await _cmd_install(args)

        assert result == 1

    @pytest.mark.asyncio
    async def test_install_already_installed_same_type(self):
        """Service returns existing instance — no error."""
        from rocketride.cli.commands.runtime import _cmd_install

        mock_service = MagicMock()
        mock_service.install = AsyncMock(return_value={'id': '0', 'version': '3.1.0', 'pid': 0, 'port': 0})

        args = MagicMock()
        args.version = '3.1.0'
        args.force = False
        args.docker = False
        args.local = True
        args.port = None
        args.new = False

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service), patch('rocketride.cli.commands.runtime._cmd_list', new_callable=AsyncMock, return_value=0):
            result = await _cmd_install(args)

        assert result == 0

    @pytest.mark.asyncio
    async def test_install_incompatible_version_rejected(self):
        """Service raises for incompatible version — CLI returns 1."""
        from rocketride.cli.commands.runtime import _cmd_install

        mock_service = MagicMock()
        mock_service.install = AsyncMock(side_effect=RuntimeManagementError('not compatible'))

        args = MagicMock()
        args.version = '5.0.0'
        args.force = False
        args.docker = False
        args.local = True
        args.port = None
        args.new = False

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service):
            result = await _cmd_install(args)

        assert result == 1

    @pytest.mark.asyncio
    async def test_install_incompatible_version_forced(self):
        """Force flag passes through to service."""
        from rocketride.cli.commands.runtime import _cmd_install

        mock_service = MagicMock()
        mock_service.install = AsyncMock(return_value={'id': '0', 'version': '5.0.0', 'pid': 0, 'port': 0})

        args = MagicMock()
        args.version = '5.0.0'
        args.force = True
        args.docker = False
        args.local = True
        args.port = None
        args.new = False

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service), patch('rocketride.cli.commands.runtime._cmd_list', new_callable=AsyncMock, return_value=0):
            result = await _cmd_install(args)

        assert result == 0
        _, kwargs = mock_service.install.call_args
        assert kwargs['force'] is True

    @pytest.mark.asyncio
    async def test_install_resolves_latest_when_no_version(self):
        """No version arg passes None to service."""
        from rocketride.cli.commands.runtime import _cmd_install

        mock_service = MagicMock()
        mock_service.install = AsyncMock(return_value={'id': '0', 'version': '3.2.0', 'pid': 0, 'port': 0})

        args = MagicMock()
        args.version = None
        args.force = False
        args.docker = False
        args.local = True
        args.port = None
        args.new = False

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service), patch('rocketride.cli.commands.runtime._cmd_list', new_callable=AsyncMock, return_value=0):
            result = await _cmd_install(args)

        assert result == 0
        _, kwargs = mock_service.install.call_args
        assert kwargs['version'] is None

    @pytest.mark.asyncio
    async def test_install_docker_type(self):
        """Docker flag passes type=Docker to service."""
        from rocketride.cli.commands.runtime import _cmd_install

        mock_service = MagicMock()
        mock_service.install = AsyncMock(return_value={'id': '0', 'version': '3.1.0', 'pid': 0, 'port': 8080})

        args = MagicMock()
        args.version = '3.1.0'
        args.force = False
        args.docker = True
        args.local = False
        args.port = None
        args.new = False

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service), patch('rocketride.cli.commands.runtime._cmd_list', new_callable=AsyncMock, return_value=0):
            result = await _cmd_install(args)

        assert result == 0
        _, kwargs = mock_service.install.call_args
        assert kwargs['type'] == 'Docker'


# ── CLI start ─────────────────────────────────────────────────


class TestCLIStart:
    """CLI start tests — mock RuntimeService since CLI is now a thin wrapper."""

    @pytest.mark.asyncio
    async def test_start_existing_instance(self):
        """Start by ID delegates to service.start()."""
        from rocketride.cli.commands.runtime import _cmd_start

        mock_service = MagicMock()
        mock_service.start = AsyncMock(return_value={'id': '0', 'version': '3.1.0', 'pid': 12345, 'port': 5570})

        args = MagicMock()
        args.id = '0'
        args.port = None
        args.version = None

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service):
            result = await _cmd_start(args)

        assert result == 0

    @pytest.mark.asyncio
    async def test_start_nonexistent_id_fails(self):
        """Service raises — CLI returns 1."""
        from rocketride.cli.commands.runtime import _cmd_start

        mock_service = MagicMock()
        mock_service.start = AsyncMock(side_effect=RuntimeNotFoundError('No instance found'))

        args = MagicMock()
        args.id = 'nonexistent'
        args.port = None
        args.version = None

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service):
            result = await _cmd_start(args)

        assert result == 1

    @pytest.mark.asyncio
    async def test_start_health_check_failure(self):
        """Health check fails — service raises, CLI returns 1."""
        from rocketride.cli.commands.runtime import _cmd_start

        mock_service = MagicMock()
        mock_service.start = AsyncMock(side_effect=RuntimeManagementError('health check failed'))

        args = MagicMock()
        args.id = '0'
        args.port = None
        args.version = None

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service):
            result = await _cmd_start(args)

        assert result == 1

    @pytest.mark.asyncio
    async def test_start_by_version(self):
        """Start by version delegates to service.start(version=...)."""
        from rocketride.cli.commands.runtime import _cmd_start

        mock_service = MagicMock()
        mock_service.start = AsyncMock(return_value={'id': '0', 'version': '3.1.0', 'pid': 12345, 'port': 5570})

        args = MagicMock()
        args.id = None
        args.port = None
        args.version = '3.1.0'

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service):
            result = await _cmd_start(args)

        assert result == 0


# ── CLI stop ──────────────────────────────────────────────────


class TestCLIStop:
    """CLI stop tests — mock RuntimeService."""

    @pytest.mark.asyncio
    async def test_stop_existing_instance(self):
        """Stop delegates to service.stop()."""
        from rocketride.cli.commands.runtime import _cmd_stop

        mock_service = MagicMock()
        mock_service.stop = AsyncMock()

        args = MagicMock()
        args.id = '0'

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service):
            result = await _cmd_stop(args)

        assert result == 0
        mock_service.stop.assert_awaited_once_with('0')

    @pytest.mark.asyncio
    async def test_stop_nonexistent_id_fails(self):
        """Service raises — CLI returns 1."""
        from rocketride.cli.commands.runtime import _cmd_stop

        mock_service = MagicMock()
        mock_service.stop = AsyncMock(side_effect=RuntimeNotFoundError('not found'))

        args = MagicMock()
        args.id = 'nonexistent'

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service):
            result = await _cmd_stop(args)

        assert result == 1


# ── CLI delete ────────────────────────────────────────────────


class TestCLIDelete:
    """CLI delete tests — mock RuntimeService."""

    @pytest.mark.asyncio
    async def test_delete_soft_deletes_instance(self):
        """Delete delegates to service.delete()."""
        from rocketride.cli.commands.runtime import _cmd_delete

        mock_service = MagicMock()
        mock_service.delete = AsyncMock()

        args = MagicMock()
        args.id = '0'
        args.purge = False

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service):
            result = await _cmd_delete(args)

        assert result == 0
        mock_service.delete.assert_awaited_once()
        _, kwargs = mock_service.delete.call_args
        assert kwargs['purge'] is False

    @pytest.mark.asyncio
    async def test_delete_purge_flag(self):
        """Purge flag passed to service."""
        from rocketride.cli.commands.runtime import _cmd_delete

        mock_service = MagicMock()
        mock_service.delete = AsyncMock()

        args = MagicMock()
        args.id = '0'
        args.purge = True

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service):
            result = await _cmd_delete(args)

        assert result == 0
        _, kwargs = mock_service.delete.call_args
        assert kwargs['purge'] is True

    @pytest.mark.asyncio
    async def test_delete_nonexistent_fails(self):
        """Service raises — CLI returns 1."""
        from rocketride.cli.commands.runtime import _cmd_delete

        mock_service = MagicMock()
        mock_service.delete = AsyncMock(side_effect=RuntimeNotFoundError('not found'))

        args = MagicMock()
        args.id = 'nonexistent'
        args.purge = False

        with patch('rocketride.cli.commands.runtime.RuntimeService', return_value=mock_service):
            result = await _cmd_delete(args)

        assert result == 1


# ── command dispatch ──────────────────────────────────────────


class TestCommandDispatch:
    @pytest.mark.asyncio
    async def test_dispatch_no_command_shows_usage(self):
        from rocketride.cli.commands.runtime import handle_runtime_command

        args = MagicMock(spec=[])  # No runtime_command attribute

        result = await handle_runtime_command(args)
        assert result == 1

    @pytest.mark.asyncio
    async def test_dispatch_unknown_command_fails(self):
        from rocketride.cli.commands.runtime import handle_runtime_command

        args = MagicMock()
        args.runtime_command = 'nonexistent'

        result = await handle_runtime_command(args)
        assert result == 1


# ── RuntimeService ────────────────────────────────────────────


from rocketride.core.runtime.service import RuntimeService


def _mock_statedb(instances=None):
    """Create a mock StateDB async context manager.

    *instances* is a dict keyed by instance_id → row dict.
    The mock supports get, get_all, register, next_id, soft_delete,
    unregister, find_by_version, and find_by_version_and_type.
    """
    if instances is None:
        instances = {}

    db = AsyncMock()
    _id_seq = len(instances)

    async def _get(instance_id):
        return instances.get(instance_id)

    async def _get_all():
        return [inst for inst in instances.values() if not inst.get('deleted')]

    async def _register(instance_id, pid, port, version, owner, **kwargs):
        instances[instance_id] = {
            'id': instance_id,
            'pid': pid,
            'port': port,
            'version': version,
            'owner': owner,
            'type': kwargs.get('instance_type', 'Local'),
            'desired_state': kwargs.get('desired_state', 'running'),
            'restart_count': kwargs.get('restart_count', 0),
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }

    async def _next_id():
        nonlocal _id_seq
        result = str(_id_seq)
        _id_seq += 1
        return result

    async def _soft_delete(instance_id):
        if instance_id in instances:
            instances[instance_id]['deleted'] = 1
            instances[instance_id]['pid'] = 0
            instances[instance_id]['port'] = 0
            instances[instance_id]['desired_state'] = 'stopped'

    async def _unregister(instance_id):
        instances.pop(instance_id, None)

    async def _find_by_version(version, include_deleted=False):
        for inst in instances.values():
            if inst['version'] == version:
                if not include_deleted and inst.get('deleted'):
                    continue
                return inst
        return None

    async def _find_by_version_and_type(version, inst_type, include_deleted=False):
        for inst in instances.values():
            if inst['version'] == version and inst.get('type') == inst_type:
                if not include_deleted and inst.get('deleted'):
                    continue
                return inst
        return None

    db.get = AsyncMock(side_effect=_get)
    db.get_all = AsyncMock(side_effect=_get_all)
    db.register = AsyncMock(side_effect=_register)
    db.next_id = AsyncMock(side_effect=_next_id)
    db.soft_delete = AsyncMock(side_effect=_soft_delete)
    db.unregister = AsyncMock(side_effect=_unregister)
    db.find_by_version = AsyncMock(side_effect=_find_by_version)
    db.find_by_version_and_type = AsyncMock(side_effect=_find_by_version_and_type)
    db.__aenter__ = AsyncMock(return_value=db)
    db.__aexit__ = AsyncMock(return_value=False)

    mock_cls = MagicMock(return_value=db)
    return mock_cls, db, instances


class TestRuntimeServiceInstall:
    @pytest.mark.asyncio
    async def test_install_no_version_resolves_latest(self, tmp_path):
        """install() with no version resolves latest compatible version."""
        mock_cls, db, store = _mock_statedb()
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.resolve_compatible_version', new_callable=AsyncMock, return_value='3.2.0'),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.download_runtime', new_callable=AsyncMock),
            patch('rocketride.core.runtime.service.find_available_port', return_value=5570),
            patch('rocketride.core.runtime.service.spawn_runtime', new_callable=AsyncMock, return_value=12345),
            patch('rocketride.core.runtime.service.wait_ready', new_callable=AsyncMock),
            patch('rocketride.core.runtime.service.logs_dir', return_value=tmp_path / 'logs' / '0'),
        ):
            result = await svc.install(type='Local')

        assert result is not None
        assert result['version'] == '3.2.0'

    @pytest.mark.asyncio
    async def test_install_explicit_version_downloads_if_missing(self, tmp_path):
        """install() with explicit version downloads binary when not present."""
        mock_cls, db, store = _mock_statedb()
        binary = tmp_path / 'engine'  # does not exist yet

        svc = RuntimeService()

        mock_dl = AsyncMock(side_effect=lambda *a, **kw: binary.write_text('fake'))

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.download_runtime', mock_dl),
            patch('rocketride.core.runtime.service.find_available_port', return_value=5570),
            patch('rocketride.core.runtime.service.spawn_runtime', new_callable=AsyncMock, return_value=12345),
            patch('rocketride.core.runtime.service.wait_ready', new_callable=AsyncMock),
            patch('rocketride.core.runtime.service.logs_dir', return_value=tmp_path / 'logs' / '0'),
        ):
            result = await svc.install(version='3.1.0', type='Local')

        mock_dl.assert_called_once()
        assert result['version'] == '3.1.0'

    @pytest.mark.asyncio
    async def test_install_skips_download_if_binary_exists(self, tmp_path):
        """install() skips download when the binary already exists."""
        mock_cls, db, store = _mock_statedb()
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.download_runtime', new_callable=AsyncMock) as mock_dl,
            patch('rocketride.core.runtime.service.find_available_port', return_value=5570),
            patch('rocketride.core.runtime.service.spawn_runtime', new_callable=AsyncMock, return_value=12345),
            patch('rocketride.core.runtime.service.wait_ready', new_callable=AsyncMock),
            patch('rocketride.core.runtime.service.logs_dir', return_value=tmp_path / 'logs' / '0'),
        ):
            result = await svc.install(version='3.1.0', type='Local')

        mock_dl.assert_not_called()
        assert result['version'] == '3.1.0'

    @pytest.mark.asyncio
    async def test_install_returns_existing_when_not_allow_duplicate(self, tmp_path):
        """install() returns existing instance when allow_duplicate is False."""
        existing = {
            'id': '0',
            'pid': 12345,
            'port': 5565,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Service',
            'desired_state': 'running',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
        ):
            result = await svc.install(version='3.1.0', type='Service', allow_duplicate=False)

        assert result['id'] == '0'

    @pytest.mark.asyncio
    async def test_install_allow_duplicate_creates_new_id(self, tmp_path):
        """install() with allow_duplicate creates a new instance ID."""
        existing = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.download_runtime', new_callable=AsyncMock),
        ):
            result = await svc.install(version='3.1.0', type='Local', allow_duplicate=True)

        # Should have a new ID different from existing
        assert result['id'] == '1'

    @pytest.mark.asyncio
    async def test_install_service_type_auto_starts(self, tmp_path):
        """install() with type=Service auto-starts and registers as running."""
        mock_cls, db, store = _mock_statedb()
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.download_runtime', new_callable=AsyncMock),
            patch('rocketride.core.runtime.service.find_available_port', return_value=5570),
            patch('rocketride.core.runtime.service.spawn_runtime', new_callable=AsyncMock, return_value=12345) as mock_spawn,
            patch('rocketride.core.runtime.service.wait_ready', new_callable=AsyncMock),
            patch('rocketride.core.runtime.service.logs_dir', return_value=tmp_path / 'logs' / '0'),
        ):
            result = await svc.install(version='3.1.0', type='Service')

        mock_spawn.assert_called_once()
        assert result['desired_state'] == 'running'
        assert result['pid'] == 12345
        assert result['port'] == 5570

    @pytest.mark.asyncio
    async def test_install_local_type_does_not_auto_start(self, tmp_path):
        """install() with type=Local does NOT auto-start."""
        mock_cls, db, store = _mock_statedb()
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.download_runtime', new_callable=AsyncMock),
            patch('rocketride.core.runtime.service.spawn_runtime', new_callable=AsyncMock) as mock_spawn,
        ):
            result = await svc.install(version='3.1.0', type='Local')

        mock_spawn.assert_not_called()
        assert result['desired_state'] == 'stopped'
        assert result['pid'] == 0

    @pytest.mark.asyncio
    async def test_install_auto_start_failure_rolls_back(self, tmp_path):
        """Auto-start failure rolls back to stopped state."""
        mock_cls, db, store = _mock_statedb()
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.download_runtime', new_callable=AsyncMock),
            patch('rocketride.core.runtime.service.find_available_port', return_value=5570),
            patch('rocketride.core.runtime.service.spawn_runtime', new_callable=AsyncMock, return_value=12345),
            patch('rocketride.core.runtime.service.wait_ready', new_callable=AsyncMock, side_effect=RuntimeManagementError('not ready')),
            patch('rocketride.core.runtime.service.stop_runtime', new_callable=AsyncMock) as mock_stop,
            patch('rocketride.core.runtime.service.logs_dir', return_value=tmp_path / 'logs' / '0'),
        ):
            with pytest.raises(RuntimeManagementError, match='Auto-start failed'):
                await svc.install(version='3.1.0', type='Service')

        mock_stop.assert_called_once_with(12345)
        # Instance should be rolled back to stopped
        inst = store.get('0')
        assert inst is not None
        assert inst['desired_state'] == 'stopped'
        assert inst['pid'] == 0

    @pytest.mark.asyncio
    async def test_install_validates_compat_range(self, tmp_path):
        """install() rejects incompatible version when force=False."""
        mock_cls, db, store = _mock_statedb()
        binary = tmp_path / 'engine'

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
        ):
            with pytest.raises(RuntimeManagementError, match='not compatible'):
                await svc.install(version='5.0.0', type='Local', force=False)

    @pytest.mark.asyncio
    async def test_install_force_skips_compat_check(self, tmp_path):
        """install() with force=True skips compat check."""
        mock_cls, db, store = _mock_statedb()
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.download_runtime', new_callable=AsyncMock),
        ):
            result = await svc.install(version='5.0.0', type='Local', force=True)

        assert result['version'] == '5.0.0'

    @pytest.mark.asyncio
    async def test_install_on_progress_callback_fires(self, tmp_path):
        """install() fires on_progress callbacks."""
        mock_cls, db, store = _mock_statedb()
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        progress_msgs = []

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.download_runtime', new_callable=AsyncMock),
        ):
            await svc.install(
                version='3.1.0',
                type='Local',
                on_progress=lambda msg, pct: progress_msgs.append(msg),
            )

        assert len(progress_msgs) >= 1
        assert any('Installed' in msg for msg in progress_msgs)

    @pytest.mark.asyncio
    async def test_install_latest_keyword_resolves_via_docker_tag(self, tmp_path):
        """install() with 'latest' keyword resolves via resolve_docker_tag."""
        mock_cls, db, store = _mock_statedb()
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.resolve_docker_tag', new_callable=AsyncMock, return_value='3.2.0') as mock_tag,
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.download_runtime', new_callable=AsyncMock),
        ):
            result = await svc.install(version='latest', type='Local')

        mock_tag.assert_called_once_with('latest')
        assert result['version'] == '3.2.0'

    @pytest.mark.asyncio
    async def test_install_with_explicit_port(self, tmp_path):
        """install() Service with explicit port passes it to spawn."""
        mock_cls, db, store = _mock_statedb()
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.download_runtime', new_callable=AsyncMock),
            patch('rocketride.core.runtime.service.spawn_runtime', new_callable=AsyncMock, return_value=12345) as mock_spawn,
            patch('rocketride.core.runtime.service.wait_ready', new_callable=AsyncMock),
            patch('rocketride.core.runtime.service.logs_dir', return_value=tmp_path / 'logs' / '0'),
        ):
            result = await svc.install(version='3.1.0', type='Service', port=9090)

        mock_spawn.assert_called_once_with(binary, 9090, '0')
        assert result['port'] == 9090

    @pytest.mark.asyncio
    async def test_install_prerelease_keyword_resolves_via_docker_tag(self, tmp_path):
        """install() with 'prerelease' keyword resolves via resolve_docker_tag."""
        mock_cls, db, store = _mock_statedb()
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.resolve_docker_tag', new_callable=AsyncMock, return_value='3.3.0-prerelease') as mock_tag,
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.download_runtime', new_callable=AsyncMock),
        ):
            result = await svc.install(version='prerelease', type='Local')

        mock_tag.assert_called_once_with('prerelease')
        assert result['version'] == '3.3.0-prerelease'

    @pytest.mark.asyncio
    async def test_install_normalizes_v_prefix(self, tmp_path):
        """install() strips 'v' prefix via normalize_version."""
        mock_cls, db, store = _mock_statedb()
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', return_value='3.1.0'),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.download_runtime', new_callable=AsyncMock),
        ):
            result = await svc.install(version='v3.1.0', type='Local')

        assert result['version'] == '3.1.0'


class TestRuntimeServiceStart:
    @pytest.mark.asyncio
    async def test_start_by_instance_id(self, tmp_path):
        """start() by instance_id starts a stopped instance."""
        existing = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.find_available_port', return_value=5570),
            patch('rocketride.core.runtime.service.spawn_runtime', new_callable=AsyncMock, return_value=12345),
            patch('rocketride.core.runtime.service.wait_ready', new_callable=AsyncMock),
            patch('rocketride.core.runtime.service.logs_dir', return_value=tmp_path / 'logs' / '0'),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=False),
        ):
            result = await svc.start('0')

        assert result['pid'] == 12345
        assert result['desired_state'] == 'running'

    @pytest.mark.asyncio
    async def test_start_by_version(self, tmp_path):
        """start() with version= finds the correct instance."""
        existing = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.find_available_port', return_value=5570),
            patch('rocketride.core.runtime.service.spawn_runtime', new_callable=AsyncMock, return_value=12345),
            patch('rocketride.core.runtime.service.wait_ready', new_callable=AsyncMock),
            patch('rocketride.core.runtime.service.logs_dir', return_value=tmp_path / 'logs' / '0'),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=False),
        ):
            result = await svc.start(version='3.1.0')

        assert result['id'] == '0'
        assert result['pid'] == 12345

    @pytest.mark.asyncio
    async def test_start_no_args_uses_first_instance(self, tmp_path):
        """start() with no args uses the first instance."""
        existing = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.find_available_port', return_value=5570),
            patch('rocketride.core.runtime.service.spawn_runtime', new_callable=AsyncMock, return_value=12345),
            patch('rocketride.core.runtime.service.wait_ready', new_callable=AsyncMock),
            patch('rocketride.core.runtime.service.logs_dir', return_value=tmp_path / 'logs' / '0'),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=False),
        ):
            result = await svc.start()

        assert result['id'] == '0'

    @pytest.mark.asyncio
    async def test_start_raises_when_no_instances(self):
        """start() raises RuntimeNotFoundError if no instances exist."""
        mock_cls, db, store = _mock_statedb()

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
        ):
            with pytest.raises(RuntimeNotFoundError, match='No runtime instances found'):
                await svc.start()

    @pytest.mark.asyncio
    async def test_start_raises_if_already_running(self, tmp_path):
        """start() raises RuntimeManagementError if instance is already running."""
        existing = {
            'id': '0',
            'pid': 12345,
            'port': 5565,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'running',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=True),
        ):
            with pytest.raises(RuntimeManagementError, match='already running'):
                await svc.start('0')

    @pytest.mark.asyncio
    async def test_start_tracks_restart_count(self, tmp_path):
        """start() increments restart_count when instance has run before."""
        existing = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 2,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        # Create a log file so has_run_before is True
        log_dir = tmp_path / 'logs' / '0'
        log_dir.mkdir(parents=True)
        (log_dir / 'stdout.log').write_text('previous run')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.find_available_port', return_value=5570),
            patch('rocketride.core.runtime.service.spawn_runtime', new_callable=AsyncMock, return_value=12345),
            patch('rocketride.core.runtime.service.wait_ready', new_callable=AsyncMock),
            patch('rocketride.core.runtime.service.logs_dir', return_value=log_dir),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=False),
        ):
            result = await svc.start('0')

        assert result['restart_count'] == 3

    @pytest.mark.asyncio
    async def test_start_health_check_failure_kills_process(self, tmp_path):
        """start() health check failure kills process and rolls back."""
        existing = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.find_available_port', return_value=5570),
            patch('rocketride.core.runtime.service.spawn_runtime', new_callable=AsyncMock, return_value=12345),
            patch('rocketride.core.runtime.service.wait_ready', new_callable=AsyncMock, side_effect=RuntimeManagementError('not ready')),
            patch('rocketride.core.runtime.service.stop_runtime', new_callable=AsyncMock) as mock_stop,
            patch('rocketride.core.runtime.service.logs_dir', return_value=tmp_path / 'logs' / '0'),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=False),
        ):
            with pytest.raises(RuntimeManagementError, match='health check failed'):
                await svc.start('0')

        mock_stop.assert_called_once_with(12345)
        inst = store['0']
        assert inst['pid'] == 0
        assert inst['desired_state'] == 'stopped'

    @pytest.mark.asyncio
    async def test_start_binary_not_found_raises(self, tmp_path):
        """start() raises RuntimeNotFoundError when binary does not exist."""
        existing = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})
        binary = tmp_path / 'nonexistent' / 'engine'  # does not exist

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=False),
        ):
            with pytest.raises(RuntimeNotFoundError, match='binary not found'):
                await svc.start('0')

    @pytest.mark.asyncio
    async def test_start_version_not_found_raises(self):
        """start() with version= raises if no instance matches."""
        mock_cls, db, store = _mock_statedb()

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
        ):
            with pytest.raises(RuntimeNotFoundError, match='No instance found for version'):
                await svc.start(version='9.9.9')

    @pytest.mark.asyncio
    async def test_start_on_progress_callback(self, tmp_path):
        """start() fires on_progress callbacks."""
        existing = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})
        binary = tmp_path / 'engine'
        binary.write_text('fake')

        progress_msgs = []

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.normalize_version', side_effect=lambda v: v),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service.find_available_port', return_value=5570),
            patch('rocketride.core.runtime.service.spawn_runtime', new_callable=AsyncMock, return_value=12345),
            patch('rocketride.core.runtime.service.wait_ready', new_callable=AsyncMock),
            patch('rocketride.core.runtime.service.logs_dir', return_value=tmp_path / 'logs' / '0'),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=False),
        ):
            await svc.start('0', on_progress=progress_msgs.append)

        assert len(progress_msgs) >= 1
        assert any('Starting' in msg for msg in progress_msgs)


class TestRuntimeServiceStop:
    @pytest.mark.asyncio
    async def test_stop_calls_stop_runtime_and_updates_db(self):
        """stop() calls stop_runtime and registers as stopped."""
        existing = {
            'id': '0',
            'pid': 12345,
            'port': 5565,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'running',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.stop_runtime', new_callable=AsyncMock) as mock_stop,
        ):
            await svc.stop('0')

        mock_stop.assert_called_once_with(12345)
        inst = store['0']
        assert inst['pid'] == 0
        assert inst['port'] == 0
        assert inst['desired_state'] == 'stopped'

    @pytest.mark.asyncio
    async def test_stop_raises_for_missing_id(self):
        """stop() raises RuntimeNotFoundError for missing instance."""
        mock_cls, db, store = _mock_statedb()

        svc = RuntimeService()

        with patch('rocketride.core.runtime.service.StateDB', mock_cls):
            with pytest.raises(RuntimeNotFoundError, match='No instance found'):
                await svc.stop('nonexistent')

    @pytest.mark.asyncio
    async def test_stop_docker_instance_delegates(self):
        """stop() Docker instance delegates to DockerRuntime.stop()."""
        existing = {
            'id': '0',
            'pid': 0,
            'port': 8080,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Docker',
            'desired_state': 'running',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})

        mock_docker = MagicMock()

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.DockerRuntime', return_value=mock_docker),
        ):
            await svc.stop('0')

        mock_docker.stop.assert_called_once_with('0')
        inst = store['0']
        assert inst['desired_state'] == 'stopped'

    @pytest.mark.asyncio
    async def test_stop_preserves_restart_count(self):
        """stop() preserves the existing restart_count."""
        existing = {
            'id': '0',
            'pid': 12345,
            'port': 5565,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'running',
            'restart_count': 5,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.stop_runtime', new_callable=AsyncMock),
        ):
            await svc.stop('0')

        assert store['0']['restart_count'] == 5

    @pytest.mark.asyncio
    async def test_stop_preserves_instance_type(self):
        """stop() preserves the instance type on re-register."""
        existing = {
            'id': '0',
            'pid': 12345,
            'port': 5565,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Service',
            'desired_state': 'running',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.stop_runtime', new_callable=AsyncMock),
        ):
            await svc.stop('0')

        assert store['0']['type'] == 'Service'


class TestRuntimeServiceDelete:
    @pytest.mark.asyncio
    async def test_delete_soft_deletes(self):
        """delete() without purge soft-deletes the instance."""
        existing = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=False),
            patch('rocketride.core.runtime.service.logs_dir', return_value=Path('/nonexistent/logs/0')),
        ):
            await svc.delete('0')

        db.soft_delete.assert_called_once_with('0')
        assert store['0']['deleted'] == 1

    @pytest.mark.asyncio
    async def test_delete_already_deleted_is_noop(self):
        """delete() on already-deleted instance is a noop."""
        existing = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 1,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=False),
        ):
            await svc.delete('0')

        # soft_delete should NOT be called again
        db.soft_delete.assert_not_called()

    @pytest.mark.asyncio
    async def test_delete_purge_removes_binary_and_hard_deletes(self, tmp_path):
        """delete() with purge removes binary directory and hard-deletes row."""
        existing = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})

        version_dir = tmp_path / 'runtimes' / '3.1.0'
        version_dir.mkdir(parents=True)
        (version_dir / 'engine').write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=False),
            patch('rocketride.core.runtime.service.runtimes_dir', return_value=version_dir),
            patch('rocketride.core.runtime.service.logs_dir', return_value=tmp_path / 'logs' / '0'),
        ):
            await svc.delete('0', purge=True)

        assert not version_dir.exists()
        db.unregister.assert_called_once_with('0')
        assert '0' not in store

    @pytest.mark.asyncio
    async def test_delete_purge_keeps_binary_when_shared(self, tmp_path):
        """CRITICAL: delete() purge keeps binary when another instance uses same version."""
        inst_0 = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        inst_1 = {
            'id': '1',
            'pid': 12345,
            'port': 5565,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Service',
            'desired_state': 'running',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': inst_0, '1': inst_1})

        version_dir = tmp_path / 'runtimes' / '3.1.0'
        version_dir.mkdir(parents=True)
        (version_dir / 'engine').write_text('fake')

        progress_msgs = []

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=False),
            patch('rocketride.core.runtime.service.runtimes_dir', return_value=version_dir),
            patch('rocketride.core.runtime.service.logs_dir', return_value=tmp_path / 'logs' / '0'),
        ):
            await svc.delete('0', purge=True, on_progress=progress_msgs.append)

        # Binary directory must still exist
        assert version_dir.exists()
        assert (version_dir / 'engine').exists()
        # But the DB row should be removed
        assert '0' not in store
        assert any('Keeping' in msg for msg in progress_msgs)

    @pytest.mark.asyncio
    async def test_delete_purge_stops_running_instance(self, tmp_path):
        """delete() purge stops a running instance before removing."""
        existing = {
            'id': '0',
            'pid': 12345,
            'port': 5565,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'running',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})

        version_dir = tmp_path / 'runtimes' / '3.1.0'
        version_dir.mkdir(parents=True)
        (version_dir / 'engine').write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=True),
            patch('rocketride.core.runtime.service.stop_runtime', new_callable=AsyncMock) as mock_stop,
            patch('rocketride.core.runtime.service.runtimes_dir', return_value=version_dir),
            patch('rocketride.core.runtime.service.logs_dir', return_value=tmp_path / 'logs' / '0'),
        ):
            await svc.delete('0', purge=True)

        mock_stop.assert_called_once_with(12345)

    @pytest.mark.asyncio
    async def test_delete_by_version_string(self):
        """delete() can look up instance by version string (not just ID)."""
        existing = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=False),
            patch('rocketride.core.runtime.service.logs_dir', return_value=Path('/nonexistent/logs/0')),
        ):
            # Pass version string '3.1.0' instead of ID '0'
            await svc.delete('3.1.0')

        db.soft_delete.assert_called_once_with('0')

    @pytest.mark.asyncio
    async def test_delete_raises_for_missing_id(self):
        """delete() raises RuntimeNotFoundError for missing instance."""
        mock_cls, db, store = _mock_statedb()

        svc = RuntimeService()

        with patch('rocketride.core.runtime.service.StateDB', mock_cls):
            with pytest.raises(RuntimeNotFoundError, match='No instance found'):
                await svc.delete('nonexistent')

    @pytest.mark.asyncio
    async def test_delete_soft_stops_running_before_soft_delete(self):
        """delete() without purge stops running instance before soft-deleting."""
        existing = {
            'id': '0',
            'pid': 12345,
            'port': 5565,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'running',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=True),
            patch('rocketride.core.runtime.service.stop_runtime', new_callable=AsyncMock) as mock_stop,
            patch('rocketride.core.runtime.service.logs_dir', return_value=Path('/nonexistent/logs/0')),
        ):
            await svc.delete('0')

        mock_stop.assert_called_once_with(12345)
        db.soft_delete.assert_called_once_with('0')

    @pytest.mark.asyncio
    async def test_delete_on_progress_fires(self, tmp_path):
        """delete() fires on_progress callbacks."""
        existing = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})

        progress_msgs = []

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=False),
            patch('rocketride.core.runtime.service.logs_dir', return_value=Path('/nonexistent/logs/0')),
        ):
            await svc.delete('0', on_progress=progress_msgs.append)

        assert len(progress_msgs) >= 1
        assert any('Deleted' in msg for msg in progress_msgs)


class TestRuntimeServiceList:
    @pytest.mark.asyncio
    async def test_list_returns_all_non_deleted(self):
        """list() returns all non-deleted instances."""
        inst_0 = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        inst_1 = {
            'id': '1',
            'pid': 12345,
            'port': 5565,
            'version': '3.2.0',
            'owner': 'cli',
            'type': 'Service',
            'desired_state': 'running',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        inst_deleted = {
            'id': '2',
            'pid': 0,
            'port': 0,
            'version': '3.0.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 1,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': inst_0, '1': inst_1, '2': inst_deleted})

        svc = RuntimeService()

        with patch('rocketride.core.runtime.service.StateDB', mock_cls):
            result = await svc.list()

        assert len(result) == 2
        ids = {r['id'] for r in result}
        assert ids == {'0', '1'}

    @pytest.mark.asyncio
    async def test_list_returns_empty_when_none(self):
        """list() returns empty list when no instances."""
        mock_cls, db, store = _mock_statedb()

        svc = RuntimeService()

        with patch('rocketride.core.runtime.service.StateDB', mock_cls):
            result = await svc.list()

        assert result == []

    @pytest.mark.asyncio
    async def test_list_excludes_deleted(self):
        """list() excludes soft-deleted instances."""
        inst = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 1,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': inst})

        svc = RuntimeService()

        with patch('rocketride.core.runtime.service.StateDB', mock_cls):
            result = await svc.list()

        assert result == []


class TestRuntimeServiceGet:
    @pytest.mark.asyncio
    async def test_get_returns_instance_by_id(self):
        """get() returns instance by ID."""
        existing = {
            'id': '0',
            'pid': 12345,
            'port': 5565,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'running',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})

        svc = RuntimeService()

        with patch('rocketride.core.runtime.service.StateDB', mock_cls):
            result = await svc.get('0')

        assert result is not None
        assert result['id'] == '0'
        assert result['version'] == '3.1.0'

    @pytest.mark.asyncio
    async def test_get_returns_none_for_missing(self):
        """get() returns None for missing ID."""
        mock_cls, db, store = _mock_statedb()

        svc = RuntimeService()

        with patch('rocketride.core.runtime.service.StateDB', mock_cls):
            result = await svc.get('nonexistent')

        assert result is None

    @pytest.mark.asyncio
    async def test_get_returns_deleted_instance(self):
        """get() returns instance even if soft-deleted (DB.get does not filter)."""
        existing = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 1,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': existing})

        svc = RuntimeService()

        with patch('rocketride.core.runtime.service.StateDB', mock_cls):
            result = await svc.get('0')

        assert result is not None
        assert result['deleted'] == 1


class TestRuntimeServiceGetRunning:
    @pytest.mark.asyncio
    async def test_get_running_returns_alive_pids(self):
        """get_running() returns only instances with alive PIDs."""
        inst_alive = {
            'id': '0',
            'pid': 12345,
            'port': 5565,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'running',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        inst_dead = {
            'id': '1',
            'pid': 99999,
            'port': 5566,
            'version': '3.2.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'running',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': inst_alive, '1': inst_dead})

        svc = RuntimeService()

        def mock_pid_alive(pid):
            return pid == 12345

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service._is_pid_alive', side_effect=mock_pid_alive),
        ):
            result = await svc.get_running()

        assert len(result) == 1
        assert result[0]['id'] == '0'

    @pytest.mark.asyncio
    async def test_get_running_skips_pid_zero(self):
        """get_running() skips instances with pid=0."""
        inst = {
            'id': '0',
            'pid': 0,
            'port': 0,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'stopped',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': inst})

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=True),
        ):
            result = await svc.get_running()

        assert result == []

    @pytest.mark.asyncio
    async def test_get_running_returns_empty_when_none(self):
        """get_running() returns empty list when nothing is running."""
        mock_cls, db, store = _mock_statedb()

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=False),
        ):
            result = await svc.get_running()

        assert result == []

    @pytest.mark.asyncio
    async def test_get_running_includes_docker_running(self):
        """get_running() checks Docker container status for Docker instances."""
        inst_docker = {
            'id': '0',
            'pid': 1,
            'port': 8080,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Docker',
            'desired_state': 'running',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': inst_docker})

        mock_docker = MagicMock()
        mock_docker.get_status.return_value = {'state': 'running'}

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.DockerRuntime', return_value=mock_docker),
        ):
            result = await svc.get_running()

        assert len(result) == 1
        assert result[0]['id'] == '0'


class TestRuntimeServiceListVersions:
    @pytest.mark.asyncio
    async def test_list_versions_returns_compatible(self, tmp_path):
        """list_versions() returns compatible versions with install status."""
        versions_data = [
            {'version': '3.2.0', 'prerelease': False, 'published_at': '2026-01-15'},
            {'version': '3.1.0', 'prerelease': False, 'published_at': '2026-01-01'},
        ]
        mock_cls, db, store = _mock_statedb()

        binary_exists = tmp_path / 'engine'
        binary_exists.write_text('fake')
        binary_missing = tmp_path / 'nonexistent' / 'engine'

        call_count = [0]

        def mock_runtime_binary(version):
            call_count[0] += 1
            if version == '3.2.0':
                return binary_exists
            return binary_missing

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.list_compatible_versions', new_callable=AsyncMock, return_value=versions_data),
            patch('rocketride.core.runtime.service.runtime_binary', side_effect=mock_runtime_binary),
        ):
            result = await svc.list_versions()

        assert len(result) == 2
        v320 = next(r for r in result if r['version'] == '3.2.0')
        v310 = next(r for r in result if r['version'] == '3.1.0')
        assert v320['installed'] is True
        assert v310['installed'] is False

    @pytest.mark.asyncio
    async def test_list_versions_cross_references_db(self, tmp_path):
        """list_versions() cross-references installed instances from DB."""
        versions_data = [
            {'version': '3.1.0', 'prerelease': False, 'published_at': '2026-01-01'},
        ]
        inst = {
            'id': '0',
            'pid': 12345,
            'port': 5565,
            'version': '3.1.0',
            'owner': 'cli',
            'type': 'Local',
            'desired_state': 'running',
            'restart_count': 0,
            'deleted': 0,
            'started_at': '2026-01-01T00:00:00',
        }
        mock_cls, db, store = _mock_statedb({'0': inst})

        binary = tmp_path / 'engine'
        binary.write_text('fake')

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.list_compatible_versions', new_callable=AsyncMock, return_value=versions_data),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=binary),
            patch('rocketride.core.runtime.service._is_pid_alive', return_value=True),
        ):
            result = await svc.list_versions()

        assert len(result) == 1
        assert len(result[0]['instances']) == 1
        assert result[0]['instances'][0]['id'] == '0'
        assert result[0]['instances'][0]['running'] is True

    @pytest.mark.asyncio
    async def test_list_versions_excludes_prerelease_by_default(self):
        """list_versions() passes include_prerelease=False by default."""
        mock_cls, db, store = _mock_statedb()

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.list_compatible_versions', new_callable=AsyncMock, return_value=[]) as mock_list,
            patch('rocketride.core.runtime.service.runtime_binary', return_value=Path('/fake')),
        ):
            await svc.list_versions()

        mock_list.assert_called_once_with('>=3.0.0,<4.0.0', False)

    @pytest.mark.asyncio
    async def test_list_versions_includes_prerelease_when_flag_set(self):
        """list_versions() passes include_prerelease=True when requested."""
        mock_cls, db, store = _mock_statedb()

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.list_compatible_versions', new_callable=AsyncMock, return_value=[]) as mock_list,
            patch('rocketride.core.runtime.service.runtime_binary', return_value=Path('/fake')),
        ):
            await svc.list_versions(include_prerelease=True)

        mock_list.assert_called_once_with('>=3.0.0,<4.0.0', True)

    @pytest.mark.asyncio
    async def test_list_versions_includes_prerelease_data(self, tmp_path):
        """list_versions() preserves the prerelease flag in results."""
        versions_data = [
            {'version': '3.2.0', 'prerelease': False, 'published_at': '2026-01-15'},
            {'version': '3.3.0-rc1', 'prerelease': True, 'published_at': '2026-02-01'},
        ]
        mock_cls, db, store = _mock_statedb()

        svc = RuntimeService()

        with (
            patch('rocketride.core.runtime.service.StateDB', mock_cls),
            patch('rocketride.core.runtime.service.get_compat_range', return_value='>=3.0.0,<4.0.0'),
            patch('rocketride.core.runtime.service.list_compatible_versions', new_callable=AsyncMock, return_value=versions_data),
            patch('rocketride.core.runtime.service.runtime_binary', return_value=tmp_path / 'nonexistent'),
        ):
            result = await svc.list_versions(include_prerelease=True)

        assert len(result) == 2
        pre = next(r for r in result if r['version'] == '3.3.0-rc1')
        assert pre['prerelease'] is True
        stable = next(r for r in result if r['version'] == '3.2.0')
        assert stable['prerelease'] is False


pytest_plugins = ['pytest_asyncio']
