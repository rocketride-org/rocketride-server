"""
Runtime lifecycle orchestrator.

Implements the auto-spawn decision tree:
1. Check state.db for a running instance -> reuse it
2. Compatible binary installed -> spawn it
3. No binary -> download latest compatible -> spawn

Teardown only happens if we started the runtime ourselves.
"""

import logging
import signal
import sys
from pathlib import Path
from typing import Optional, Tuple

from .downloader import download_runtime
from .paths import runtime_binary, rocketride_home
from .ports import find_available_port
from .process import spawn_runtime, stop_runtime, wait_healthy
from .resolver import get_compat_range, resolve_compatible_version
from .state import StateDB


logger = logging.getLogger('rocketride')


class RuntimeManager:
    """High-level runtime lifecycle manager.

    Used by RocketRideClient for auto-spawn.
    """

    def __init__(self):  # noqa: D107
        self._instance_id: Optional[str] = None
        self._port: Optional[int] = None
        self._we_started: bool = False
        self._original_sigterm = None
        self._original_sigint = None

    @property
    def we_started(self) -> bool:
        return self._we_started

    @property
    def uri(self) -> Optional[str]:
        if self._port is None:
            return None
        return f'http://127.0.0.1:{self._port}'

    async def ensure_running(
        self,
        *,
        instance_id: str | None = None,
        port: int | None = None,
    ) -> Tuple[str, bool]:
        """Ensure a runtime instance is running.

        Returns (uri, we_started) where we_started indicates whether
        this manager spawned the instance (and is therefore responsible
        for teardown).

        Targeting options:
        - ``instance_id`` — look up a specific instance, start if stopped
        - ``port`` — reuse a running instance on that port
        - Neither — existing auto-discovery behavior
        """
        async with StateDB() as db:
            # ── Instance targeting ──────────────────────────────────
            if instance_id:
                target = await db.get(instance_id)
                if not target:
                    raise RuntimeError(f'Runtime instance {instance_id} not found')
                # Already running?
                if target['pid'] and target['port'] and await self._is_runtime_healthy(target['port']):
                    self._port = target['port']
                    self._instance_id = target['id']
                    self._we_started = False
                    return (self.uri, False)
                # Need to start it
                binary = runtime_binary(target['version'])
                if not binary.exists():
                    raise RuntimeError(f'Runtime binary not found for v{target["version"]}')
                spawn_port = port or find_available_port()
                pid = await spawn_runtime(binary, spawn_port, target['id'])
                try:
                    await wait_healthy(spawn_port, pid=pid)
                except Exception:
                    await stop_runtime(pid)
                    await db.register(target['id'], 0, 0, target['version'], 'sdk', desired_state='stopped')
                    raise
                await db.register(target['id'], pid, spawn_port, target['version'], 'sdk')

                self._port = spawn_port
                self._instance_id = target['id']
                self._we_started = True
                self._register_signal_handlers()
                return (self.uri, True)

            # ── Port targeting ──────────────────────────────────────
            if port:
                if await self._is_runtime_healthy(port):
                    self._port = port
                    self._we_started = False
                    # Try to find matching instance in DB for bookkeeping
                    all_instances = await db.get_all()
                    for inst in all_instances:
                        if inst['port'] == port:
                            self._instance_id = inst['id']
                            break
                    return (self.uri, False)
                raise RuntimeError(f'No healthy runtime found on port {port}')

            # ── Default auto-discovery ──────────────────────────────
            # 1. Check for an existing live instance
            existing = await db.find_running()
            if existing:
                if await self._is_runtime_healthy(existing['port']):
                    self._port = existing['port']
                    self._instance_id = existing['id']
                    self._we_started = False
                    return (self.uri, False)
                # Runtime port isn't responding — mark stale and spawn fresh
                await stop_runtime(existing['pid'])
                await db.mark_stopped(existing['id'])

            # 2. Find or download a compatible binary
            binary = await self._resolve_binary()

            # 3. Spawn
            logger.info('Auto-spawning a local runtime')
            spawn_port = find_available_port()
            existing_row = await db.find_by_version(self._version)
            new_instance_id = existing_row['id'] if existing_row else await db.next_id()

            pid = await spawn_runtime(binary, spawn_port, new_instance_id)

            # 4. Wait for the runtime to be healthy before registering
            try:
                await wait_healthy(spawn_port, pid=pid)
            except Exception:
                await stop_runtime(pid)
                await db.register(new_instance_id, 0, 0, self._version, 'sdk', desired_state='stopped')
                raise

            await db.register(new_instance_id, pid, spawn_port, self._version, 'sdk')

        self._port = spawn_port
        self._instance_id = new_instance_id
        self._we_started = True

        # Register cleanup handlers
        self._register_signal_handlers()

        return (self.uri, True)

    async def teardown(self) -> None:
        """Stop the runtime if we started it, and unregister from state."""
        if not self._we_started or not self._instance_id:
            return

        logger.info('Tearing down local runtime')
        async with StateDB() as db:
            inst = await db.get(self._instance_id)
            if inst:
                await stop_runtime(inst['pid'])
                await db.mark_stopped(self._instance_id)

        self._restore_signal_handlers()
        self._we_started = False
        self._instance_id = None
        self._port = None

    @staticmethod
    async def _is_runtime_healthy(port: int) -> bool:
        """Quick check whether the runtime HTTP endpoint is responding."""
        return await RuntimeManager._is_runtime_healthy_uri(f'http://127.0.0.1:{port}')

    @staticmethod
    async def _is_runtime_healthy_uri(uri: str) -> bool:
        """Quick check whether a runtime at *uri* is responding."""
        import aiohttp

        # Normalize: ensure the URI has a scheme
        if not uri.startswith(('http://', 'https://')):
            uri = f'http://{uri}'

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    uri,
                    timeout=aiohttp.ClientTimeout(total=2),
                ) as resp:
                    return resp.status == 200
        except (aiohttp.ClientError, OSError):
            return False

    async def _resolve_binary(self) -> Path:
        """Find an installed compatible binary or download one."""
        compat = get_compat_range()

        # Check for any already-installed compatible version
        from packaging.specifiers import SpecifierSet
        from packaging.version import Version

        spec = SpecifierSet(compat)
        runtimes_root = rocketride_home() / 'runtimes'

        if runtimes_root.exists():
            installed = []
            for entry in runtimes_root.iterdir():
                if not entry.is_dir():
                    continue
                try:
                    v = Version(entry.name)
                except Exception:
                    continue
                if v in spec and runtime_binary(entry.name).exists():
                    installed.append((v, entry.name))

            if installed:
                # Use the latest installed compatible version
                installed.sort(key=lambda x: x[0], reverse=True)
                best_version = installed[0][1]
                self._version = best_version
                return runtime_binary(best_version)

        # Nothing installed — download the latest compatible
        version = await resolve_compatible_version(compat)
        self._version = version
        logger.info('Downloading runtime v%s...', version)
        return await download_runtime(version)

    def _register_signal_handlers(self) -> None:
        """Register signal handlers to clean up on Ctrl+C / SIGTERM."""
        if sys.platform == 'win32':
            # On Windows, only SIGINT is supported in Python
            self._original_sigint = signal.getsignal(signal.SIGINT)
            signal.signal(signal.SIGINT, self._signal_handler)
        else:
            self._original_sigterm = signal.getsignal(signal.SIGTERM)
            self._original_sigint = signal.getsignal(signal.SIGINT)
            signal.signal(signal.SIGTERM, self._signal_handler)
            signal.signal(signal.SIGINT, self._signal_handler)

    def _restore_signal_handlers(self) -> None:
        """Restore original signal handlers."""
        if self._original_sigint is not None:
            signal.signal(signal.SIGINT, self._original_sigint)
            self._original_sigint = None
        if sys.platform != 'win32' and self._original_sigterm is not None:
            signal.signal(signal.SIGTERM, self._original_sigterm)
            self._original_sigterm = None

    def _signal_handler(self, signum, frame):
        """Emergency cleanup on signal — run teardown synchronously."""
        import os

        if self._we_started and self._instance_id:
            # Best-effort synchronous cleanup
            try:
                # We can't run async teardown from a signal handler,
                # so do a direct pid kill.
                # Open a synchronous connection to clean up state.
                import sqlite3
                from .paths import state_db_path

                db_path = str(state_db_path())
                if os.path.exists(db_path):
                    conn = sqlite3.connect(db_path)
                    cursor = conn.execute(
                        'SELECT pid FROM instances WHERE id = ?',
                        (self._instance_id,),
                    )
                    row = cursor.fetchone()
                    if row:
                        pid = row[0]
                        if sys.platform == 'win32':
                            import ctypes

                            kernel32 = ctypes.windll.kernel32
                            handle = kernel32.OpenProcess(0x0001, False, pid)
                            if handle:
                                kernel32.TerminateProcess(handle, 1)
                                kernel32.CloseHandle(handle)
                        else:
                            os.kill(pid, signal.SIGTERM)
                    conn.execute(
                        'UPDATE instances SET pid = 0, port = 0 WHERE id = ?',
                        (self._instance_id,),
                    )
                    conn.commit()
                    conn.close()
            except Exception:
                pass

        # Re-raise the signal with the original handler
        original = self._original_sigterm if signum == getattr(signal, 'SIGTERM', None) else self._original_sigint
        if callable(original):
            original(signum, frame)
        elif original == signal.SIG_DFL:
            signal.signal(signum, signal.SIG_DFL)
            os.kill(os.getpid(), signum)
