"""
High-level runtime lifecycle service.

Exposes install / start / stop / delete / list as a programmatic async API.
All console output replaced by typed callbacks; errors raised as
RuntimeManagementError (or subclasses).

The CLI layer delegates here and maps callbacks to terminal output.
"""

import asyncio
import shutil
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from ..exceptions import RuntimeManagementError, RuntimeNotFoundError
from .docker import DockerRuntime
from .downloader import download_runtime
from .paths import logs_dir, rocketride_home, runtime_binary, runtimes_dir
from .platform import normalize_version
from .ports import find_available_port
from .process import spawn_runtime, stop_runtime, wait_ready
from .resolver import (
    get_compat_range,
    list_compatible_versions,
    resolve_compatible_version,
    resolve_docker_tag,
)
from .state import StateDB, _is_pid_alive


def _format_size(n: int) -> str:
    if n < 1024:
        return f'{n} B'
    if n < 1024 * 1024:
        return f'{n / 1024:.0f} KB'
    if n < 1024 * 1024 * 1024:
        return f'{n / (1024 * 1024):.1f} MB'
    return f'{n / (1024 * 1024 * 1024):.1f} GB'


async def _retry_rmtree(path: Path, max_attempts: int = 5) -> bool:
    for attempt in range(max_attempts):
        try:
            shutil.rmtree(str(path))
            return True
        except PermissionError:
            if attempt < max_attempts - 1:
                await asyncio.sleep(1)
    return False


class RuntimeService:
    """Programmatic API for runtime lifecycle management."""

    async def install(
        self,
        *,
        version: str | None = None,
        type: str = 'Service',
        force: bool = False,
        port: int | None = None,
        allow_duplicate: bool = False,
        on_progress: Callable[[str, Optional[int]], None] | None = None,
    ) -> Dict[str, Any]:
        """Install a runtime binary (or Docker image) and register an instance."""
        if version:
            version = normalize_version(version)

        inst_type = type

        # ── Docker install ───────────────────────────────────────
        if inst_type == 'Docker':
            return await self._install_docker(version, port, allow_duplicate, on_progress)

        # ── Local / Service install ──────────────────────────────

        # Resolve keyword specs
        if version in ('latest', 'prerelease'):
            if on_progress:
                on_progress(f'Resolving {version} version...', None)
            version = await resolve_docker_tag(version)

        if version:
            # Check if already installed (unless allow_duplicate)
            if not allow_duplicate:
                async with StateDB() as db:
                    existing = await db.find_by_version_and_type(version, inst_type)
                    if runtime_binary(version).exists() and existing:
                        return existing

            # Validate compat range (unless force)
            if not force:
                from .platform import _base_version

                compat = get_compat_range()
                try:
                    from packaging.specifiers import SpecifierSet
                    from packaging.version import Version

                    base = _base_version(version)
                    if Version(base) not in SpecifierSet(compat):
                        raise RuntimeManagementError(f'Runtime v{version} is not compatible with this SDK (requires {compat}). Use force option to install anyway.')
                except Exception as e:
                    if isinstance(e, RuntimeManagementError):
                        raise
                    pass  # Non-PEP 440 versions skip validation
        else:
            if on_progress:
                on_progress('Resolving latest compatible version...', None)
            compat = get_compat_range()
            version = await resolve_compatible_version(compat)

        # Download binary if not present
        binary = runtime_binary(version)
        if not binary.exists():

            def _on_phase(phase: str) -> None:
                if phase == 'extracting' and on_progress:
                    on_progress(f'Extracting runtime v{version}...', None)

            def _on_download_progress(downloaded: int, total: int) -> None:
                if not on_progress:
                    return
                dl_str = _format_size(downloaded)
                if total:
                    pct = int(downloaded * 100 / total)
                    on_progress(
                        f'Downloading runtime v{version}... {pct}% ({dl_str}/{_format_size(total)})',
                        pct,
                    )
                else:
                    on_progress(f'Downloading runtime v{version}... {dl_str}', None)

            await download_runtime(version, on_progress=_on_download_progress, on_phase=_on_phase)

        # Register in state DB
        async with StateDB() as db:
            if allow_duplicate:
                instance_id = await db.next_id()
            else:
                existing = await db.find_by_version_and_type(version, inst_type)
                instance_id = existing['id'] if existing else await db.next_id()
            await db.register(instance_id, 0, 0, version, 'cli', desired_state='stopped', instance_type=inst_type)

        if on_progress:
            on_progress(f'Installed runtime v{version} (id: {instance_id})', None)

        # Service type auto-starts
        if inst_type == 'Service':
            svc_port = port or find_available_port()
            if on_progress:
                on_progress(f'Starting service on port {svc_port}...', None)
            pid = await spawn_runtime(binary, svc_port, instance_id)
            try:
                log_file = logs_dir(instance_id) / 'stderr.log'
                await wait_ready(pid, log_file=log_file, on_output=lambda line: on_progress and on_progress(f'  {line}', None))
                if on_progress:
                    on_progress(f'Runtime v{version} is online (port {svc_port}, PID {pid})', None)
                async with StateDB() as db:
                    await db.register(instance_id, pid, svc_port, version, 'cli', desired_state='running', instance_type='Service')
            except Exception as e:
                await stop_runtime(pid)
                async with StateDB() as db:
                    await db.register(instance_id, 0, 0, version, 'cli', desired_state='stopped', instance_type='Service')
                raise RuntimeManagementError(f'Auto-start failed: {e}') from e

        # Return final state
        async with StateDB() as db:
            return await db.get(instance_id)

    async def start(
        self,
        instance_id: str | None = None,
        *,
        port: int | None = None,
        version: str | None = None,
        on_progress: Callable[[str], None] | None = None,
    ) -> Dict[str, Any]:
        """Start a stopped runtime instance."""
        if version:
            version = normalize_version(version)

        async with StateDB() as db:
            # Resolve instance ID
            if not instance_id and version:
                existing = await db.find_by_version(version)
                if existing:
                    instance_id = existing['id']
                else:
                    raise RuntimeNotFoundError(f'No instance found for version {version}. Install one first.')
            elif not instance_id:
                all_instances = await db.get_all()
                if all_instances:
                    instance_id = all_instances[0]['id']
                else:
                    raise RuntimeNotFoundError('No runtime instances found. Install one first.')

            existing = await db.get(instance_id)
            if not existing:
                raise RuntimeNotFoundError(f'No instance found with id: {instance_id}')

            # Refuse to start if already running
            if existing['pid'] and _is_pid_alive(existing['pid']):
                raise RuntimeManagementError(f'Instance {instance_id} is already running (PID {existing["pid"]}, port {existing["port"]})')

            inst_type = existing.get('type', 'Local')

            # Docker start
            if inst_type == 'Docker':
                return await self._start_docker(instance_id, existing, db, on_progress)

            if not version:
                version = existing['version']

            # Resolve version if still unknown
            if not version:
                version = await self._resolve_installed_version(on_progress)

            binary = runtime_binary(version)
            if not binary.exists():
                raise RuntimeNotFoundError(f'Runtime binary not found for v{version}. Install it first.')

            start_port = port or find_available_port()

            # Track restarts
            restart_count = 0
            prev_count = existing.get('restart_count', 0)
            has_run_before = prev_count > 0 or (logs_dir(instance_id) / 'stdout.log').exists()
            restart_count = prev_count + 1 if has_run_before else 0

            if on_progress:
                on_progress(f'Starting runtime v{version} on port {start_port} (id: {instance_id})...')
            pid = await spawn_runtime(binary, start_port, instance_id)

        # DB released before waiting
        try:
            log_file = logs_dir(instance_id) / 'stderr.log'
            await wait_ready(pid, log_file=log_file, on_output=lambda line: on_progress and on_progress(f'  {line}'))
            if on_progress:
                on_progress(f'Runtime v{version} is online (port {start_port}, PID {pid})')
            async with StateDB() as db:
                await db.register(instance_id, pid, start_port, version, 'cli', restart_count=restart_count, desired_state='running')
                return await db.get(instance_id)
        except Exception as e:
            await stop_runtime(pid)
            async with StateDB() as db:
                await db.register(instance_id, 0, 0, version, 'cli', restart_count=restart_count, desired_state='stopped')
            raise RuntimeManagementError(f'Runtime started but health check failed: {e}') from e

    async def stop(self, instance_id: str) -> None:
        """Stop a running runtime instance."""
        async with StateDB() as db:
            inst = await db.get(instance_id)
            if not inst:
                raise RuntimeNotFoundError(f'No instance found with id: {instance_id}')

            inst_type = inst.get('type', 'Local')

            if inst_type == 'Docker':
                docker = DockerRuntime()
                docker.stop(instance_id)
                await db.register(
                    instance_id,
                    0,
                    inst['port'],
                    inst['version'],
                    inst['owner'],
                    restart_count=inst.get('restart_count', 0),
                    desired_state='stopped',
                    instance_type='Docker',
                )
            else:
                await stop_runtime(inst['pid'])
                await db.register(
                    instance_id,
                    0,
                    0,
                    inst['version'],
                    inst['owner'],
                    restart_count=inst.get('restart_count', 0),
                    desired_state='stopped',
                    instance_type=inst_type,
                )

    async def delete(
        self,
        instance_id: str,
        *,
        purge: bool = False,
        on_progress: Callable[[str], None] | None = None,
    ) -> None:
        """Delete (and optionally purge) a runtime instance."""
        async with StateDB() as db:
            inst = await db.get(instance_id)
            # Try as version string
            if not inst:
                inst = await db.find_by_version(instance_id, include_deleted=True)
                if inst:
                    instance_id = inst['id']
            if not inst:
                raise RuntimeNotFoundError(f'No instance found with id or version: {instance_id}')

            pid = inst['pid']
            version = inst['version']
            inst_type = inst.get('type', 'Local')
            already_deleted = bool(inst.get('deleted'))

            async def _remove_log_dir():
                log_dir = logs_dir(instance_id)
                if not log_dir.exists():
                    return
                ok = await _retry_rmtree(log_dir)
                if not ok and on_progress:
                    on_progress(f'Warning: could not remove {log_dir} — files may still be locked.')

            # ── Docker delete ────────────────────────────────────
            if inst_type == 'Docker':
                docker = DockerRuntime()
                if purge:
                    if on_progress:
                        on_progress(f'Purging Docker runtime {instance_id}...')
                    docker.remove(instance_id, remove_image=True)
                    await _remove_log_dir()
                    await db.unregister(instance_id)
                    if on_progress:
                        on_progress(f'Purged Docker instance {instance_id} (container and image removed).')
                else:
                    if already_deleted:
                        return
                    if on_progress:
                        on_progress(f'Removing Docker runtime {instance_id}...')
                    docker.remove(instance_id, remove_image=False)
                    await _remove_log_dir()
                    await db.soft_delete(instance_id)
                    if on_progress:
                        on_progress(f'Deleted Docker instance {instance_id} (container removed, image kept).')
                return

            # ── Local / Service delete ───────────────────────────
            if purge:
                if pid and _is_pid_alive(pid):
                    if on_progress:
                        on_progress(f'Stopping running runtime {instance_id}...')
                    await stop_runtime(pid)

                # Check if other non-deleted instances use same binary
                all_instances = await db.get_all()
                version_in_use = any(other['id'] != instance_id and other['version'] == version for other in all_instances)

                version_dir = runtimes_dir(version)
                if version_in_use:
                    if on_progress:
                        on_progress(f'Keeping runtime v{version} binary (still in use by another instance).')
                elif version_dir.exists():
                    ok = await _retry_rmtree(version_dir)
                    if ok:
                        if on_progress:
                            on_progress(f'Removed runtime v{version} from {version_dir}')
                    else:
                        raise RuntimeManagementError(f'Could not remove {version_dir} — files may still be locked. Try again shortly.')

                await _remove_log_dir()
                await db.unregister(instance_id)
                if on_progress:
                    on_progress(f'Purged instance {instance_id}.')
            else:
                if already_deleted:
                    return
                if pid and _is_pid_alive(pid):
                    if on_progress:
                        on_progress(f'Stopping running runtime {instance_id}...')
                    await stop_runtime(pid)
                await _remove_log_dir()
                await db.soft_delete(instance_id)
                if on_progress:
                    on_progress(f'Deleted instance {instance_id}.')

    async def list(self) -> List[Dict[str, Any]]:
        """List all non-deleted instances."""
        async with StateDB() as db:
            return await db.get_all()

    async def get(self, instance_id: str) -> Dict[str, Any] | None:
        """Get a single instance by ID."""
        async with StateDB() as db:
            return await db.get(instance_id)

    async def get_running(self) -> List[Dict[str, Any]]:
        """Get all currently running instances (verified alive)."""
        async with StateDB() as db:
            all_instances = await db.get_all()
        running = []
        for inst in all_instances:
            if inst['pid'] == 0:
                continue
            if inst.get('type') == 'Docker':
                try:
                    docker = DockerRuntime()
                    status = docker.get_status(inst['id'])
                    if status.get('state') == 'running':
                        running.append(inst)
                except Exception:
                    pass
            elif _is_pid_alive(inst['pid']):
                running.append(inst)
        return running

    async def list_versions(self, *, include_prerelease: bool = False) -> List[Dict[str, Any]]:
        """List available versions cross-referenced with installed instances."""
        compat_range = get_compat_range()
        versions = await list_compatible_versions(compat_range, include_prerelease)

        async with StateDB() as db:
            all_instances = await db.get_all()

        results = []
        for vi in versions:
            binary = runtime_binary(vi['version'])
            installed = binary.exists()

            instances = []
            for inst in all_instances:
                if inst['version'] != vi['version']:
                    continue
                running = False
                if inst['pid'] and inst['pid'] != 0:
                    if inst.get('type') == 'Docker':
                        try:
                            docker = DockerRuntime()
                            running = docker.get_status(inst['id']).get('state') == 'running'
                        except Exception:
                            pass
                    else:
                        running = _is_pid_alive(inst['pid'])
                instances.append({'id': inst['id'], 'port': inst['port'], 'running': running})

            results.append(
                {
                    'version': vi['version'],
                    'prerelease': vi['prerelease'],
                    'published_at': vi['published_at'],
                    'installed': installed,
                    'instances': instances,
                }
            )

        return results

    # ── Private helpers ──────────────────────────────────────────

    async def _install_docker(
        self,
        version: str | None,
        explicit_port: int | None,
        allow_duplicate: bool,
        on_progress: Callable[[str, Optional[int]], None] | None,
    ) -> Dict[str, Any]:
        docker = DockerRuntime()
        docker_err = docker.check_docker_status()
        if docker_err:
            raise RuntimeManagementError(docker_err)

        version_spec = version or 'latest'
        if on_progress:
            on_progress(f'Resolving Docker image tag for "{version_spec}"...', None)
        image_tag = await resolve_docker_tag(version_spec)

        port = explicit_port or find_available_port()

        async with StateDB() as db:
            if not allow_duplicate:
                existing_docker = await db.find_by_version_and_type(image_tag, 'Docker')
                if existing_docker:
                    return existing_docker
            instance_id = await db.next_id()

            if on_progress:
                on_progress(f'Installing Docker runtime (tag: {image_tag}, port: {port}, id: {instance_id})', None)
            docker.install(image_tag, instance_id, port, on_progress=lambda msg: on_progress and on_progress(msg, None))

            await db.register(instance_id, 0, port, image_tag, 'cli', desired_state='running', instance_type='Docker')
            if on_progress:
                on_progress(f'Installed Docker runtime (id: {instance_id})', None)
            return await db.get(instance_id)

    async def _start_docker(
        self,
        instance_id: str,
        existing: Dict[str, Any],
        db: StateDB,
        on_progress: Callable[[str], None] | None,
    ) -> Dict[str, Any]:
        if on_progress:
            on_progress(f'Starting Docker runtime {instance_id}...')
        docker = DockerRuntime()
        docker_port = existing['port']
        try:
            docker.start(instance_id)
        except Exception as e:
            msg = str(e)
            if '404' in msg or 'No such container' in msg:
                if on_progress:
                    on_progress('Container was removed outside the CLI. Re-installing...')
                docker_port = existing['port'] or find_available_port()
                docker.install(existing['version'], instance_id, docker_port)
            else:
                raise RuntimeManagementError(f'Failed to start Docker container: {e}') from e
        await db.register(
            instance_id,
            0,
            docker_port,
            existing['version'],
            existing['owner'],
            restart_count=existing.get('restart_count', 0),
            desired_state='running',
            instance_type='Docker',
        )
        return await db.get(instance_id)

    async def _resolve_installed_version(self, on_progress: Callable[[str], None] | None = None) -> str:
        from packaging.specifiers import SpecifierSet
        from packaging.version import Version

        compat = get_compat_range()
        spec = SpecifierSet(compat)
        runtimes_root = rocketride_home() / 'runtimes'
        installed = []
        if runtimes_root.exists():
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
            installed.sort(key=lambda x: x[0], reverse=True)
            version = installed[0][1]
            if on_progress:
                on_progress(f'Using installed runtime v{version}')
            return version

        if on_progress:
            on_progress('No compatible runtime installed. Downloading...')
        version = await resolve_compatible_version(compat)
        await download_runtime(version)
        if on_progress:
            on_progress(f'Downloaded runtime v{version}')
        return version
