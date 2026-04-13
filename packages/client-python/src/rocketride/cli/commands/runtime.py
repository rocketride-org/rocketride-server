"""
CLI commands for runtime management.

Registered as ``rocketride runtime <command>`` (alias ``rocketride r <command>``).

Commands:
    list                    List tracked runtime instances
    start [id]              Start a runtime instance
    stop [id]               Stop a running runtime instance
    install [version]       Download a runtime binary
    delete [id]             Stop and deregister a runtime instance (--purge to remove binary)
    logs [id]               Tail runtime log output
"""

import asyncio
import shutil
import sys

from ...core.runtime.downloader import download_runtime
from ...core.runtime.paths import runtimes_dir, runtime_binary, logs_dir, rocketride_home
from ...core.runtime.ports import find_available_port
from ...core.runtime.process import spawn_runtime, stop_runtime, wait_ready
from ...core.runtime.resolver import get_compat_range, resolve_compatible_version, resolve_docker_tag
from ...core.runtime.state import StateDB
from ...core.runtime.docker import DockerRuntime


def _print_progress(msg: str) -> None:
    """Overwrite the current line with a status message."""
    sys.stdout.write(f'\r\033[K{msg}')
    sys.stdout.flush()


def _end_progress(msg: str) -> None:
    """Finish an in-place progress line with a final message."""
    sys.stdout.write(f'\r\033[K{msg}\n')
    sys.stdout.flush()


def register_runtime_commands(subparsers) -> None:
    """Register the ``runtime`` (and ``r``) subcommand group."""

    def _add_runtime_subparser(name, **kwargs):
        parser = subparsers.add_parser(name, **kwargs)
        runtime_subs = parser.add_subparsers(dest='runtime_command', metavar='COMMAND')
        _add_runtime_subcommands(runtime_subs)
        return parser

    _add_runtime_subparser('runtime', help='Manage runtime instances')
    _add_runtime_subparser('r', help='Manage runtime instances (shorthand)')


def _add_runtime_subcommands(subparsers) -> None:
    """Add all runtime subcommands to the given subparser group."""
    # list
    subparsers.add_parser('list', help='List tracked runtime instances')

    # start
    start_p = subparsers.add_parser('start', help='Start a runtime instance')
    start_p.add_argument('id', nargs='?', default=None, help='Instance id (auto-generated if omitted)')
    start_p.add_argument('--port', type=int, default=None, help='Explicit port (default: auto)')
    start_p.add_argument('--version', default=None, help='Runtime version to use')

    # stop
    stop_p = subparsers.add_parser('stop', help='Stop a running runtime instance')
    stop_p.add_argument('id', help='Instance id to stop')

    # install
    install_p = subparsers.add_parser('install', help='Download a runtime binary')
    install_p.add_argument('version', nargs='?', default=None, help='Version to install (default: latest compatible)')
    install_p.add_argument('--force', action='store_true', help='Skip compatibility check and install any available version')
    install_type = install_p.add_mutually_exclusive_group()
    install_type.add_argument('--local', action='store_true', help='Install as Local type (manual start/stop)')
    install_type.add_argument('--docker', action='store_true', help='Pull and run as a Docker container')
    install_p.add_argument('--port', type=int, default=None, help='Explicit host port for Docker installs (default: auto)')

    # delete
    delete_p = subparsers.add_parser('delete', help='Stop and remove a runtime instance')
    delete_p.add_argument('id', help='Instance id to delete')
    delete_p.add_argument('--purge', action='store_true', help='Also remove the runtime binary (or Docker image) from disk')

    # logs
    logs_p = subparsers.add_parser('logs', help='Tail runtime log output')
    logs_p.add_argument('id', help='Instance id')


async def handle_runtime_command(args) -> int:
    """Dispatch to the appropriate runtime subcommand handler."""
    cmd = getattr(args, 'runtime_command', None)
    if not cmd:
        print('Usage: rocketride runtime <command>')
        print('Commands: list, start, stop, install, delete, logs')
        return 1

    handlers = {
        'list': _cmd_list,
        'start': _cmd_start,
        'stop': _cmd_stop,
        'install': _cmd_install,
        'delete': _cmd_delete,
        'logs': _cmd_logs,
    }

    handler = handlers.get(cmd)
    if not handler:
        print(f'Unknown runtime command: {cmd}')
        return 1

    result = await handler(args)

    # Show the table after every command except logs and list
    if cmd not in ('logs', 'list'):
        print()
        await _cmd_list(args)

    return result


# ── Command handlers ──────────────────────────────────────────────


async def _cmd_list(args) -> int:
    async with StateDB() as db:
        instances = await db.get_all()

    from ...core.runtime.state import _get_process_memory, _is_pid_alive

    # ── TTY detection ─────────────────────────────────────────────
    import sys

    use_color = sys.stdout.isatty()

    # ── Brand palette (ANSI 24-bit) ──────────────────────────────
    if use_color:
        HORIZON = '\033[38;2;65;182;230m'  # #41b6e6 — headers
        AMETHYST = '\033[38;2;95;33;103m'  # #5f2167 — title accent
        GREEN = '\033[38;2;80;220;100m'  # status: running
        RED = '\033[38;2;220;80;80m'  # status: stopped
        DIM = '\033[2m'
        BOLD = '\033[1m'
        RESET = '\033[0m'
    else:
        HORIZON = AMETHYST = GREEN = RED = DIM = BOLD = RESET = ''

    # ── Column definitions (minimum widths) ────────────────────────
    col_names = ['version', 'id', 'pid', 'port', 'type', 'status', 'restarted', 'uptime', 'memory']
    min_widths = {
        'version': 7,
        'id': 2,
        'pid': 3,
        'port': 4,
        'type': 6,
        'status': 6,
        'restarted': 9,
        'uptime': 6,
        'memory': 6,
    }

    # Build rows
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    docker_runtime = None
    rows = []
    for inst in instances:
        pid = inst['pid']
        inst_type = inst.get('type', 'Local')

        # Determine status based on type
        if inst_type == 'Docker':
            # Use Docker SDK to check container status
            if docker_runtime is None:
                docker_runtime = DockerRuntime()
            try:
                docker_status = docker_runtime.get_status(inst['id'])
                docker_state = docker_status.get('state', 'not-installed')
                alive = docker_state == 'running'
                status_text = docker_state
            except Exception:
                alive = False
                status_text = 'unknown'
        else:
            alive = _is_pid_alive(pid)
            status_text = 'online' if alive else 'stopped'

        status_color = GREEN if alive else RED

        # Calculate uptime
        if alive:
            try:
                started = datetime.fromisoformat(inst['started_at'])
                delta = now - started
                total_secs = int(delta.total_seconds())
                if total_secs < 60:
                    uptime = f'{total_secs}s'
                elif total_secs < 3600:
                    uptime = f'{total_secs // 60}m'
                elif total_secs < 86400:
                    uptime = f'{total_secs // 3600}h {(total_secs % 3600) // 60}m'
                else:
                    uptime = f'{total_secs // 86400}d {(total_secs % 86400) // 3600}h'
            except Exception:
                uptime = '-'
        else:
            uptime = '0s'

        # Memory usage (not available for Docker instances)
        if inst_type == 'Docker':
            memory = '-'
        else:
            mem_bytes = _get_process_memory(pid) if alive else None
            if mem_bytes is not None:
                if mem_bytes < 1024 * 1024:
                    memory = f'{mem_bytes / 1024:.0f} KB'
                elif mem_bytes < 1024 * 1024 * 1024:
                    memory = f'{mem_bytes / (1024 * 1024):.1f} MB'
                else:
                    memory = f'{mem_bytes / (1024 * 1024 * 1024):.1f} GB'
            else:
                memory = '-'

        restart_count = inst.get('restart_count', 0)

        rows.append(
            {
                'version': inst['version'],
                'id': inst['id'],
                'pid': str(pid) if pid else '-',
                'port': str(inst['port']) if inst['port'] else '-',
                'type': inst_type,
                'status': (status_color, status_text),
                'restarted': str(restart_count),
                'uptime': uptime,
                'memory': memory,
            }
        )

    # ── Compute dynamic column widths ──────────────────────────────
    col_widths = {name: max(min_widths[name], len(name)) for name in col_names}
    for row in rows:
        for name in col_names:
            val = row[name]
            text = val[1] if isinstance(val, tuple) else val
            col_widths[name] = max(col_widths[name], len(text))

    cols = [(name, col_widths[name]) for name in col_names]

    # ── Render table ─────────────────────────────────────────────
    if use_color:
        GRAY = '\033[38;2;100;100;100m'  # border color
        B = GRAY

        # Build horizontal rules
        def h_rule(left, mid, right, fill='─'):
            segments = [fill * (w + 2) for _, w in cols]
            return f'{B}{left}{mid.join(segments)}{right}{RESET}'

        top = h_rule('┌', '┬', '┐')
        sep = h_rule('├', '┼', '┤')
        bot = h_rule('└', '┴', '┘')

        # Header row
        header_cells = []
        for name, w in cols:
            header_cells.append(f' {BOLD}{HORIZON}{name.upper():<{w}}{RESET} ')
        header = f'{B}│{RESET}{f"{B}│{RESET}".join(header_cells)}{B}│{RESET}'

        # Title
        print(f'{AMETHYST}{BOLD} RocketRide{RESET} {DIM}Runtime instances{RESET}')
        print(top)
        print(header)

        if not instances:
            print(bot)
            return 0

        print(sep)

        # Data rows
        for row in rows:
            cells = []
            for name, w in cols:
                val = row[name]
                if isinstance(val, tuple):
                    color, text = val
                    cells.append(f' {color}{text:<{w}}{RESET} ')
                else:
                    cells.append(f' {val:<{w}} ')
            print(f'{B}│{RESET}{f"{B}│{RESET}".join(cells)}{B}│{RESET}')

        print(bot)
    else:
        # Plain text table for non-TTY (piped) output
        header_parts = [f'{name.upper():<{w}}' for name, w in cols]
        print('  '.join(header_parts))

        if not instances:
            return 0

        for row in rows:
            parts = []
            for name, w in cols:
                val = row[name]
                text = val[1] if isinstance(val, tuple) else val
                parts.append(f'{text:<{w}}')
            print('  '.join(parts))

    return 0


async def _cmd_start(args) -> int:
    instance_id = getattr(args, 'id', None)
    from ...core.runtime.platform import normalize_version

    version = getattr(args, 'version', None)
    explicit_port = getattr(args, 'port', None)

    if version:
        version = normalize_version(version)

    async with StateDB() as db:
        if not instance_id and version:
            existing = await db.find_by_version(version)
            if existing:
                instance_id = existing['id']
            else:
                print(f'No instance found for version {version}.')
                print('Use "rocketride runtime install" to create one first.')
                return 1
        elif not instance_id:
            # No ID and no version — try to find any installed instance to start
            all_instances = await db.get_all()
            if all_instances:
                instance_id = all_instances[0]['id']
            else:
                print('No runtime instances found.')
                print('Use "rocketride runtime install" to create one first.')
                return 1

        # The ID must already exist in the DB
        existing = None
        if instance_id:
            existing = await db.get(instance_id)
            if not existing:
                print(f'No instance found with id: {instance_id}')
                print('Use "rocketride runtime install" to create a new instance first.')
                return 1

            # Refuse to start if already running
            from ...core.runtime.state import _is_pid_alive

            if existing['pid'] and _is_pid_alive(existing['pid']):
                print(f'Instance {instance_id} is already running (PID {existing["pid"]}, port {existing["port"]})')
                return 1

            # Docker instances use Docker SDK for start
            inst_type = existing.get('type', 'Local')
            if inst_type == 'Docker':
                print(f'Starting Docker runtime {instance_id}...')
                docker = DockerRuntime()
                try:
                    docker.start(instance_id)
                except Exception as e:
                    print(f'Failed to start Docker container: {e}')
                    return 1
                async with StateDB() as db2:
                    await db2.register(
                        instance_id,
                        0,
                        existing['port'],
                        existing['version'],
                        existing['owner'],
                        restart_count=existing.get('restart_count', 0),
                        desired_state='running',
                        instance_type='Docker',
                    )
                print('Started.')
                return 0

            if not version:
                version = existing['version']

        # Resolve version if still unknown (new instance, no --version)
        if not version:
            compat = get_compat_range()
            from packaging.specifiers import SpecifierSet
            from packaging.version import Version

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
                print(f'Using installed runtime v{version}')
            else:
                print('No compatible runtime installed. Downloading...')
                version = await resolve_compatible_version(compat)
                await download_runtime(version)
                print(f'Downloaded runtime v{version}')

        binary = runtime_binary(version)
        if not binary.exists():
            print(f'Runtime binary not found for v{version}. Run: rocketride runtime install {version}')
            return 1

        port = explicit_port or find_available_port()

        # Track restarts: first start = 0, subsequent starts increment.
        # Log files from a previous run prove the instance ran before.
        restart_count = 0
        if existing:
            prev_count = existing.get('restart_count', 0)
            has_run_before = prev_count > 0 or (logs_dir(instance_id) / 'stdout.log').exists()
            restart_count = prev_count + 1 if has_run_before else 0

        print(f'Starting runtime v{version} on port {port} (id: {instance_id})...')
        pid = await spawn_runtime(binary, port, instance_id)

    try:
        log_file = logs_dir(instance_id) / 'stderr.log'

        def _on_output(line: str) -> None:
            _print_progress(f'  {line}')

        await wait_ready(pid, log_file=log_file, on_output=_on_output)
        _end_progress(f'Runtime v{version} is online (port {port}, PID {pid})')
        # Only persist pid/port once the runtime is confirmed healthy
        async with StateDB() as db:
            await db.register(instance_id, pid, port, version, 'cli', restart_count=restart_count, desired_state='running')
        return 0
    except Exception as e:
        print(f'\nRuntime started but health check failed: {e}')
        # Kill the orphaned process so it doesn't escape tracking
        await stop_runtime(pid)
        # Reset to stopped state — don't leave stale pid/port in DB
        async with StateDB() as db:
            await db.register(instance_id, 0, 0, version, 'cli', restart_count=restart_count, desired_state='stopped')
        return 1


async def _cmd_stop(args) -> int:
    instance_id = args.id

    async with StateDB() as db:
        inst = await db.get(instance_id)
        if not inst:
            print(f'No instance found with id: {instance_id}')
            return 1

        inst_type = inst.get('type', 'Local')

        if inst_type == 'Docker':
            print(f'Stopping Docker runtime {instance_id}...')
            docker = DockerRuntime()
            try:
                docker.stop(instance_id)
            except Exception as e:
                print(f'Failed to stop Docker container: {e}')
                return 1
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
            print(f'Stopping runtime {instance_id} (PID: {inst["pid"]})...')
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

    print('Stopped.')
    return 0


async def _cmd_install(args) -> int:
    from ...core.runtime.platform import normalize_version

    version = getattr(args, 'version', None)
    force = getattr(args, 'force', False)
    use_docker = getattr(args, 'docker', False)
    use_local = getattr(args, 'local', False)

    # Determine instance type
    if use_docker:
        inst_type = 'Docker'
    elif use_local:
        inst_type = 'Local'
    else:
        inst_type = 'Service'

    if version:
        version = normalize_version(version)

    # ── Docker install ────────────────────────────────────────────
    if use_docker:
        docker = DockerRuntime()
        docker_err = docker.check_docker_status()
        if docker_err:
            print(docker_err)
            return 1

        # Resolve version to Docker image tag
        version_spec = version or 'latest'
        print(f'Resolving Docker image tag for "{version_spec}"...')
        image_tag = await resolve_docker_tag(version_spec)

        explicit_port = getattr(args, 'port', None)
        port = explicit_port or find_available_port()

        def _progress(msg):
            sys.stdout.write(f'\r{msg}')
            sys.stdout.flush()

        async with StateDB() as db:
            existing_docker = await db.find_by_version_and_type(image_tag, 'Docker')
            if existing_docker:
                print(f'Docker runtime v{image_tag} is already installed (id: {existing_docker["id"]})')
                return 0
            instance_id = await db.next_id()

        print(f'Installing Docker runtime (tag: {image_tag}, port: {port}, id: {instance_id})')
        try:
            docker.install(image_tag, instance_id, port, on_progress=_progress)
            print()  # newline after progress
        except Exception as e:
            print(f'\nDocker install failed: {e}')
            return 1

        async with StateDB() as db:
            await db.register(instance_id, 0, port, image_tag, 'cli', desired_state='running', instance_type='Docker')

        print(f'Installed Docker runtime (id: {instance_id})')
        return 0

    # ── Local / Service install ───────────────────────────────────
    if version:
        # Check if already installed (scoped by type)
        binary = runtime_binary(version)
        async with StateDB() as db:
            existing = await db.find_by_version_and_type(version, inst_type)
        if binary.exists() and existing:
            print(f'Runtime v{version} ({inst_type}) is already installed (id: {existing["id"]})')
            return 0

        # Validate against the compatibility range (unless --force)
        if not force:
            from ...core.runtime.platform import _base_version

            compat = get_compat_range()
            try:
                from packaging.specifiers import SpecifierSet
                from packaging.version import Version

                base = _base_version(version)
                if Version(base) not in SpecifierSet(compat):
                    print(f'Runtime v{version} is not compatible with this SDK (requires {compat})')
                    print('Use --force to install anyway.')
                    return 1
            except Exception:
                pass  # Non-PEP 440 versions (e.g. prereleases) skip validation
    else:
        print('Resolving latest compatible version...')
        compat = get_compat_range()
        version = await resolve_compatible_version(compat)

    binary = runtime_binary(version)
    if not binary.exists():
        from ...cli.utils.formatters import format_size

        def _on_phase(phase: str) -> None:
            if phase == 'extracting':
                _end_progress(f'Extracting runtime v{version}...')

        def _on_download_progress(downloaded: int, total: int) -> None:
            dl_str = format_size(downloaded)
            if total:
                pct = int(downloaded * 100 / total)
                total_str = format_size(total)
                _print_progress(f'Downloading runtime v{version}... {pct}% ({dl_str}/{total_str})')
            else:
                _print_progress(f'Downloading runtime v{version}... {dl_str}')

        await download_runtime(version, on_progress=_on_download_progress, on_phase=_on_phase)

    # Register in state DB so it shows up in `list`
    async with StateDB() as db:
        existing = await db.find_by_version_and_type(version, inst_type)
        instance_id = existing['id'] if existing else await db.next_id()
        await db.register(instance_id, 0, 0, version, 'cli', desired_state='stopped', instance_type=inst_type)

    print(f'Installed runtime v{version} (id: {instance_id})')

    if inst_type == 'Service':
        port = find_available_port()
        print(f'Starting service on port {port}...')
        pid = await spawn_runtime(binary, port, instance_id)
        try:
            log_file = logs_dir(instance_id) / 'stderr.log'
            await wait_ready(pid, log_file=log_file, on_output=lambda line: _print_progress(f'  {line}'))
            _end_progress(f'Runtime v{version} is online (port {port}, PID {pid})')
            async with StateDB() as db:
                await db.register(instance_id, pid, port, version, 'cli', desired_state='running', instance_type='Service')
        except Exception as e:
            print(f'\nAuto-start failed: {e}')
            print(f'Start manually: rocketride runtime start {instance_id}')
            await stop_runtime(pid)
            async with StateDB() as db:
                await db.register(instance_id, 0, 0, version, 'cli', desired_state='stopped', instance_type='Service')
            return 1

    return 0


async def _cmd_delete(args) -> int:
    instance_id = args.id
    purge = getattr(args, 'purge', False)

    from ...core.runtime.state import _is_pid_alive

    async with StateDB() as db:
        inst = await db.get(instance_id)
        # If not found by ID, try as a version string (for --purge by version)
        if not inst:
            inst = await db.find_by_version(instance_id, include_deleted=True)
            if inst:
                instance_id = inst['id']
        if not inst:
            print(f'No instance found with id or version: {args.id}')
            return 1

    pid = inst['pid']
    version = inst['version']
    inst_type = inst.get('type', 'Local')
    already_deleted = bool(inst.get('deleted'))

    async def _remove_log_dir():
        """Remove the log directory with retries for Windows file-lock delays."""
        log_dir = logs_dir(instance_id)
        if not log_dir.exists():
            return
        for attempt in range(5):
            try:
                shutil.rmtree(str(log_dir))
                return
            except PermissionError:
                if attempt < 4:
                    await asyncio.sleep(1)
                else:
                    print(f'Warning: could not remove {log_dir} — files may still be locked.')

    # ── Docker delete ─────────────────────────────────────────────
    if inst_type == 'Docker':
        docker = DockerRuntime()
        if purge:
            print(f'Purging Docker runtime {instance_id}...')
            try:
                docker.remove(instance_id, remove_image=True)
            except Exception as e:
                print(f'Failed to remove Docker container: {e}')
                return 1

            await _remove_log_dir()

            async with StateDB() as db:
                await db.unregister(instance_id)

            print(f'Purged Docker instance {instance_id} (container and image removed).')
        else:
            if already_deleted:
                print(f'Instance {instance_id} is already deleted. Use --purge to remove the image.')
                return 0

            print(f'Removing Docker runtime {instance_id}...')
            try:
                docker.remove(instance_id, remove_image=False)
            except Exception as e:
                print(f'Failed to remove Docker container: {e}')
                return 1

            await _remove_log_dir()

            async with StateDB() as db:
                await db.soft_delete(instance_id)

            print(f'Deleted Docker instance {instance_id} (container removed, image kept).')
        return 0

    # ── Local / Service delete ────────────────────────────────────

    if purge:
        # ── Hard delete (purge) ──────────────────────────────────
        # 1. Stop the process if running
        if pid and _is_pid_alive(pid):
            print(f'Stopping running runtime {instance_id}...')
            await stop_runtime(pid)

        # 2. Check if any OTHER non-deleted instance uses the same version binary
        async with StateDB() as db:
            all_instances = await db.get_all()
        version_in_use = False
        for other in all_instances:
            if other['id'] == instance_id:
                continue
            if other['version'] == version and other['pid'] and _is_pid_alive(other['pid']):
                version_in_use = True
                break

        # 3. Remove the binary directory
        version_dir = runtimes_dir(version)
        if version_in_use:
            print(f'Keeping runtime v{version} binary (still in use by another instance).')
        elif version_dir.exists():
            for attempt in range(5):
                try:
                    shutil.rmtree(str(version_dir))
                    print(f'Removed runtime v{version} from {version_dir}')
                    break
                except PermissionError:
                    if attempt < 4:
                        await asyncio.sleep(1)
                    else:
                        print(f'Could not remove {version_dir} — files may still be locked.')
                        print('The instance record has NOT been removed. Try again shortly.')
                        return 1

        # 4. Remove logs
        await _remove_log_dir()

        # 5. Hard-delete the DB row
        async with StateDB() as db:
            await db.unregister(instance_id)

        print(f'Purged instance {instance_id}.')
    else:
        # ── Soft delete ──────────────────────────────────────────
        if already_deleted:
            print(f'Instance {instance_id} is already deleted. Use --purge to remove the binary.')
            return 0

        # 1. Stop the process if running
        if pid and _is_pid_alive(pid):
            print(f'Stopping running runtime {instance_id}...')
            await stop_runtime(pid)

        # 2. Remove logs
        await _remove_log_dir()

        # 3. Soft-delete the row (hide from list, keep for ID tracking)
        async with StateDB() as db:
            await db.soft_delete(instance_id)

        print(f'Deleted instance {instance_id}.')

    return 0


async def _cmd_logs(args) -> int:
    instance_id = args.id
    log_file = logs_dir(instance_id) / 'stdout.log'

    if not log_file.exists():
        print(f'No log file found for instance {instance_id}')
        return 1

    print(f'Tailing {log_file} (Ctrl+C to stop)\n')

    # On Windows, asyncio.sleep doesn't get interrupted by Ctrl+C.
    # Use a threading.Event to bridge the signal into the async loop.
    import signal
    import threading

    stop = threading.Event()

    original_handler = signal.getsignal(signal.SIGINT)
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    try:
        with open(log_file, 'r') as f:
            # Print existing content
            content = f.read()
            if content:
                sys.stdout.write(content)
                sys.stdout.flush()

            # Tail new content
            while not stop.is_set():
                line = f.readline()
                if line:
                    sys.stdout.write(line)
                    sys.stdout.flush()
                else:
                    stop.wait(0.2)
    finally:
        signal.signal(signal.SIGINT, original_handler)

    print()
    return 0
