"""
CLI commands for runtime management.

Registered as ``rocketride runtime <command>`` (alias ``rocketride r <command>``).

Commands:
    list                    List tracked runtime instances
    start [id]              Start a runtime instance
    stop [id]               Stop a running runtime instance
    install [version]       Download a runtime binary
    delete [id]             Stop and deregister a runtime instance (--purge to remove binary)
    versions                List available runtime versions
    logs [id]               Tail runtime log output
"""

import sys

from ...core.runtime.paths import logs_dir
from ...core.runtime.state import StateDB, _is_pid_alive, _get_process_memory
from ...core.runtime.docker import DockerRuntime
from ...core.runtime.service import RuntimeService
from ...core.runtime.resolver import get_compat_range


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
    install_p.add_argument('--new', action='store_true', help='Create a new instance even if one exists for this version')

    # delete
    delete_p = subparsers.add_parser('delete', help='Stop and remove a runtime instance')
    delete_p.add_argument('id', help='Instance id to delete')
    delete_p.add_argument('--purge', action='store_true', help='Also remove the runtime binary (or Docker image) from disk')

    # versions
    versions_p = subparsers.add_parser('versions', help='List available runtime versions')
    versions_p.add_argument('--prerelease', action='store_true', help='Include pre-release versions')

    # logs
    logs_p = subparsers.add_parser('logs', help='Tail runtime log output')
    logs_p.add_argument('id', help='Instance id')


async def handle_runtime_command(args) -> int:
    """Dispatch to the appropriate runtime subcommand handler."""
    cmd = getattr(args, 'runtime_command', None)
    if not cmd:
        print('Usage: rocketride runtime <command>')
        print('Commands: list, start, stop, install, delete, versions, logs')
        return 1

    handlers = {
        'list': _cmd_list,
        'start': _cmd_start,
        'stop': _cmd_stop,
        'install': _cmd_install,
        'delete': _cmd_delete,
        'versions': _cmd_versions,
        'logs': _cmd_logs,
    }

    handler = handlers.get(cmd)
    if not handler:
        print(f'Unknown runtime command: {cmd}')
        return 1

    result = await handler(args)

    # Show the table after every command except logs, list, and versions
    if cmd not in ('logs', 'list', 'versions'):
        print()
        await _cmd_list(args)

    return result


# ── Command handlers ──────────────────────────────────────────────


async def _cmd_list(args) -> int:
    async with StateDB() as db:
        instances = await db.get_all()

    # ── TTY detection ─────────────────────────────────────────────
    use_color = sys.stdout.isatty()

    # ── Brand palette (ANSI 24-bit) ──────────────────────────────
    if use_color:
        HORIZON = '\033[38;2;65;182;230m'
        AMETHYST = '\033[38;2;95;33;103m'
        GREEN = '\033[38;2;80;220;100m'
        RED = '\033[38;2;220;80;80m'
        DIM = '\033[2m'
        BOLD = '\033[1m'
        RESET = '\033[0m'
    else:
        HORIZON = AMETHYST = GREEN = RED = DIM = BOLD = RESET = ''

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

    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    docker_runtime = None
    rows = []
    for inst in instances:
        pid = inst['pid']
        inst_type = inst.get('type', 'Local')

        if inst_type == 'Docker':
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
            status_text = 'running' if alive else 'stopped'

        status_color = GREEN if alive else RED

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

    col_widths = {name: max(min_widths[name], len(name)) for name in col_names}
    for row in rows:
        for name in col_names:
            val = row[name]
            text = val[1] if isinstance(val, tuple) else val
            col_widths[name] = max(col_widths[name], len(text))

    cols = [(name, col_widths[name]) for name in col_names]

    if use_color:
        GRAY = '\033[38;2;100;100;100m'
        B = GRAY

        def h_rule(left, mid, right, fill='─'):
            segments = [fill * (w + 2) for _, w in cols]
            return f'{B}{left}{mid.join(segments)}{right}{RESET}'

        top = h_rule('┌', '┬', '┐')
        sep = h_rule('├', '┼', '┤')
        bot = h_rule('└', '┴', '┘')

        header_cells = []
        for name, w in cols:
            header_cells.append(f' {BOLD}{HORIZON}{name.upper():<{w}}{RESET} ')
        header = f'{B}│{RESET}{f"{B}│{RESET}".join(header_cells)}{B}│{RESET}'

        print(f'{AMETHYST}{BOLD} RocketRide{RESET} {DIM}Runtime instances{RESET}')
        print(top)
        print(header)

        if not instances:
            print(bot)
            return 0

        print(sep)

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
    version = getattr(args, 'version', None)
    explicit_port = getattr(args, 'port', None)

    service = RuntimeService()
    try:
        inst = await service.start(
            instance_id,
            port=explicit_port,
            version=version,
            on_progress=lambda msg: _print_progress(msg),
        )
        _end_progress(f'Runtime v{inst["version"]} is online (port {inst["port"]}, PID {inst["pid"]})')
        return 0
    except Exception as e:
        _end_progress('')
        print(str(e))
        return 1


async def _cmd_stop(args) -> int:
    instance_id = args.id
    service = RuntimeService()
    try:
        print(f'Stopping runtime {instance_id}...')
        await service.stop(instance_id)
        print('Stopped.')
        return 0
    except Exception as e:
        print(str(e))
        return 1


async def _cmd_install(args) -> int:
    version = getattr(args, 'version', None)
    force = getattr(args, 'force', False)
    use_docker = getattr(args, 'docker', False)
    use_local = getattr(args, 'local', False)
    explicit_port = getattr(args, 'port', None)
    allow_new = getattr(args, 'new', False)

    if use_docker:
        inst_type = 'Docker'
    elif use_local:
        inst_type = 'Local'
    else:
        inst_type = 'Service'

    service = RuntimeService()
    try:
        inst = await service.install(
            version=version,
            type=inst_type,
            force=force,
            port=explicit_port,
            allow_duplicate=allow_new,
            on_progress=lambda msg, pct=None: (_print_progress(msg) if msg and ('Downloading' in msg or 'Extracting' in msg) else _end_progress(msg)),
        )
        _end_progress(f'Installed runtime v{inst["version"]} (id: {inst["id"]})')
        return 0
    except Exception as e:
        _end_progress('')
        print(str(e))
        return 1


async def _cmd_delete(args) -> int:
    instance_id = args.id
    purge = getattr(args, 'purge', False)

    service = RuntimeService()
    try:
        await service.delete(instance_id, purge=purge, on_progress=lambda msg: print(msg))
        return 0
    except Exception as e:
        print(str(e))
        return 1


async def _cmd_versions(args) -> int:
    include_prerelease = getattr(args, 'prerelease', False)
    service = RuntimeService()
    try:
        versions = await service.list_versions(include_prerelease=include_prerelease)

        use_color = sys.stdout.isatty()
        BOLD = '\033[1m' if use_color else ''
        GREEN = '\033[38;2;80;220;100m' if use_color else ''
        DIM = '\033[2m' if use_color else ''
        RESET = '\033[0m' if use_color else ''

        compat = get_compat_range()
        print(f'{BOLD}RocketRide Runtime Versions{RESET} {DIM}(compatible: {compat}){RESET}\n')

        if not versions:
            print('  No compatible versions found.')
            return 0

        header = ['VERSION', 'STATUS']
        rows = []

        for v in versions:
            parts = []
            if v['instances']:
                for inst in v['instances']:
                    status = 'running' if inst['running'] else 'stopped'
                    detail = f'{status} (id: {inst["id"]}'
                    if inst['running']:
                        detail += f', port {inst["port"]}'
                    detail += ')'
                    parts.append(detail)
            elif v['installed']:
                parts.append('installed')
            else:
                parts.append('available')
            rows.append([v['version'], ', '.join(parts)])

        widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(header)]

        print(f'  {BOLD}{header[0]:<{widths[0]}}{RESET}    {BOLD}{header[1]:<{widths[1]}}{RESET}')
        for row in rows:
            version_str = f'{row[0]:<{widths[0]}}'
            status_str = row[1]
            is_installed = any(kw in status_str for kw in ('installed', 'running', 'stopped'))
            color = GREEN if is_installed else DIM
            print(f'  {version_str}    {color}{status_str}{RESET}')

        return 0
    except Exception as e:
        print(str(e))
        return 1


async def _cmd_logs(args) -> int:
    instance_id = args.id
    log_file = logs_dir(instance_id) / 'stdout.log'

    if not log_file.exists():
        print(f'No log file found for instance {instance_id}')
        return 1

    print(f'Tailing {log_file} (Ctrl+C to stop)\n')

    import signal
    import threading

    stop = threading.Event()

    original_handler = signal.getsignal(signal.SIGINT)
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    try:
        with open(log_file, 'r') as f:
            content = f.read()
            if content:
                sys.stdout.write(content)
                sys.stdout.flush()

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
