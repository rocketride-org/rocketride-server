# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Profiler commands: ``profile start/stop/run/status/list/report/threads/tree``.

Thin wrappers over the client's ``cprofile_*`` methods. ``--token`` names
a task, whose engine subprocess is profiled; without it the server process
is. Only ``run`` can profile the server process: the server ends a session
there when the connection that started it closes, and every CLI invocation
is its own connection.

Kept in exact parity with the TypeScript CLI's ``src/cli/commands/profile.ts``
— the text formats are pinned by identical expected output in both suites.
"""

import asyncio
import re
import signal
import sys
from typing import Any, Dict, List, Optional

from ..utils.common import connect_client, run_cli_command
from ..utils.output import Output

# Option grammars, identical in both CLIs
_DECIMAL = re.compile(r'[0-9]+\.?[0-9]*|\.[0-9]+')
_COUNT = re.compile(r'[0-9]+')

# How long `profile list` waits for one task's status before giving up on it
_LIST_TIMEOUT_SECONDS = 10


def _seconds(value: float) -> str:
    """Format a duration in seconds for the tables, e.g. ``1.234s``."""
    return f'{value:.3f}s'


def _percent(value: float) -> str:
    """Format a share as a percentage with one decimal, e.g. ``45.6%``."""
    return f'{value:.1f}%'


def _scope(token: Optional[str]) -> str:
    """Describe what ``--token`` selects, for human output."""
    return f'task {token}' if token else 'the server process'


def _parse_decimal(text: Optional[str]) -> Optional[float]:
    """Parse a non-negative decimal exactly as typed, or None when it is not one."""
    return float(text) if text is not None and _DECIMAL.fullmatch(text) else None


def _parse_count(text: Optional[str]) -> Optional[int]:
    """Parse a non-negative integer exactly as typed, or None when it is not one."""
    return int(text) if text is not None and _COUNT.fullmatch(text) else None


def _fail_without_token(out: Output, verb: str) -> int:
    """Refuse start/stop on the server process, naming the command that can."""
    return out.fail(
        f'profile {verb} needs --token',
        'a session on the server process ends with the connection that started it; '
        "profile the server with 'rocketride profile run'",
    )


def _print_stopped(out: Output, stopped: Dict[str, Any], token: Optional[str]) -> None:
    """Print how a stopped session went and where to read it."""
    out.line(f"Profiling stopped: session '{stopped.get('session')}' ran {_seconds(stopped.get('runtime') or 0)}")
    out.line(f'Read it with: rocketride profile report|threads|tree{f" --token {token}" if token else ""}')


async def _wait_for_stop(seconds: Optional[float]) -> None:
    """
    Wait out ``seconds``, or until Ctrl+C when no duration is given.

    The first SIGINT/SIGTERM ends the wait instead of the process, so the
    caller can still stop the session on its own connection; the one after
    that gets the usual handling back.

    Args:
        seconds: How long to wait, or None to wait for Ctrl+C.
    """
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    previous: Dict[int, Any] = {}

    def restore() -> None:
        for signum, handler in previous.items():
            # None means the handler was not set from Python
            signal.signal(signum, signal.SIG_DFL if handler is None else handler)
        previous.clear()

    def on_signal(signum, frame) -> None:
        restore()
        loop.call_soon_threadsafe(stop.set)

    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            previous[signum] = signal.signal(signum, on_signal)
        except ValueError:
            # Not the main thread, where signals cannot be caught; the duration still applies
            pass
    try:
        await asyncio.wait_for(stop.wait(), seconds)
    except asyncio.TimeoutError:
        pass
    finally:
        restore()


def format_threads(threads: List[Dict[str, Any]]) -> List[str]:
    """
    Render the ``profile threads`` table.

    Args:
        threads: Threads from rrext_cprofile_threads, busiest first.

    Returns:
        The lines to print.
    """
    if not threads:
        return ['No threads recorded']
    # Plain left-to-right addition, as the TypeScript CLI does: sum() compensates on 3.12+
    total = 0.0
    for thread in threads:
        total += thread['ttot']
    header = ['ID', 'NAME', 'TID', 'TIME', 'SHARE']
    rows = [
        [
            str(thread['id']),
            '-' if thread['name'] is None else thread['name'],
            str(thread['tid']),
            _seconds(thread['ttot']),
            _percent(thread['ttot'] / total * 100) if total > 0 else '-',
        ]
        for thread in threads
    ]
    widths = [max(len(title), *(len(row[i]) for row in rows)) for i, title in enumerate(header)]

    def render(cells: List[str]) -> str:
        # NAME is the one text column; the rest are numbers, right-aligned
        return '  '.join(cell.ljust(widths[i]) if i == 1 else cell.rjust(widths[i]) for i, cell in enumerate(cells))

    return [render(header), *(render(row) for row in rows), f'{len(threads)} thread(s), {_seconds(total)} total']


def format_tree(result: Dict[str, Any], thread: Optional[int] = None) -> List[str]:
    """
    Render the ``profile tree`` call tree.

    The synthetic ``<root>`` is not a row: its totals head the output, and
    its children are the top level. Pruning happened on the server.

    Args:
        result: Response from rrext_cprofile_report_tree.
        thread: The thread id asked for, or None for all threads.

    Returns:
        The lines to print.
    """
    total = result['total_time']
    which = 'all threads' if thread is None else f'thread {thread}'
    lines = [f'Call tree, {which}: {_seconds(total)}, {result["total_calls"]:,} calls']
    roots = (result.get('tree') or {}).get('children') or []
    if not roots:
        lines.append('No calls to show')
        return lines

    def row(pct: str, cumtime: str, tottime: str, ncalls: str, label: str) -> str:
        return f'{pct:>6}  {cumtime:>10}  {tottime:>10}  {ncalls:>10}  {label}'

    # lead + connector prefixes this node's name; child_lead prefixes its children's
    def walk(node: Dict[str, Any], lead: str, connector: str, child_lead: str) -> None:
        pct = _percent(node['cumtime'] / total * 100) if total > 0 else '-'
        where = f'  ({node["file"]}:{node["line"]})' if node['line'] else f'  ({node["file"]})'
        label = f'{lead}{connector}{node["name"]}{where if node["file"] else ""}'
        lines.append(row(pct, _seconds(node['cumtime']), _seconds(node['tottime']), f'{node["ncalls"]:,}', label))
        children = node['children']
        for i, child in enumerate(children):
            last = i == len(children) - 1
            walk(child, child_lead, '`-- ' if last else '+-- ', child_lead + ('    ' if last else '|   '))

    lines.append('')
    lines.append(row('CUM%', 'CUMTIME', 'TOTTIME', 'NCALLS', 'FUNCTION'))
    for root in roots:
        walk(root, '', '', '')
    return lines


async def _read_task_status(client, token: str, name: Optional[str]) -> Dict[str, Any]:
    """
    Read one task's profiling status for ``profile list``.

    Never raises: a task that fails or does not answer in time is reported,
    not fatal to the list.

    Args:
        client: The connected client.
        token: The task's token.
        name: The task's name from the task list.

    Returns:
        The task's entry, with its status or the error.
    """
    try:
        status = await asyncio.wait_for(client.cprofile_status(target=token), _LIST_TIMEOUT_SECONDS)
        return {'token': token, 'name': name, 'status': status}
    except asyncio.TimeoutError:
        return {'token': token, 'name': name, 'error': f'no answer within {_LIST_TIMEOUT_SECONDS}s'}
    except Exception as err:  # noqa: BLE001
        return {'token': token, 'name': name, 'error': str(err)}


def format_profile_list(entries: List[Dict[str, Any]], active_only: bool = False) -> List[str]:
    """
    Render the ``profile list`` table.

    Processes whose status could not be read follow the table, one line
    each; ``active_only`` drops the readable ones that are not profiling.

    Args:
        entries: The server process first (token None), then every task.
        active_only: Keep only the processes being profiled.

    Returns:
        The lines to print.
    """
    shown = [e for e in entries if e.get('status') and (not active_only or e['status'].get('active'))]
    failed = [e for e in entries if 'error' in e]
    profiling = sum(1 for e in entries if (e.get('status') or {}).get('active'))
    lines: List[str] = []

    if not shown:
        lines.append('No active profiling sessions')
    else:
        header = ['TOKEN', 'NAME', 'STATE', 'RUNNING', 'REPORT', 'SESSION']
        rows = []
        for entry in shown:
            status = entry['status']
            active = bool(status.get('active'))
            rows.append(
                [
                    '(server)' if entry['token'] is None else entry['token'],
                    '-' if entry['name'] is None else entry['name'],
                    'active' if active else 'inactive',
                    _seconds(status.get('runtime') or 0) if active else '-',
                    '-' if active else ('yes' if status.get('has_report') else 'no'),
                    (status.get('session') if active else None) or '-',
                ]
            )
        widths = [max(len(title), *(len(row[i]) for row in rows)) for i, title in enumerate(header)]

        def render(cells: List[str]) -> str:
            # RUNNING is the one number, right-aligned; SESSION is last and unpadded
            return '  '.join(
                cell if i == len(cells) - 1 else cell.rjust(widths[i]) if i == 3 else cell.ljust(widths[i])
                for i, cell in enumerate(cells)
            )

        lines.append(render(header))
        lines.extend(render(row) for row in rows)

    for entry in failed:
        lines.append(f'{"(server)" if entry["token"] is None else entry["token"]}: {entry["error"]}')
    unreadable = f', {len(failed)} unreadable' if failed else ''
    lines.append(f'{len(entries)} process(es), {profiling} profiling{unreadable}')
    return lines


async def run_profile(args) -> int:
    """
    Execute one ``profile`` subcommand.

    Args:
        args: Parsed argparse namespace (profile_subcommand, token, ...).

    Returns:
        Exit code.
    """

    async def action(out: Output) -> int:
        subcommand = args.profile_subcommand
        token = getattr(args, 'token', None)

        if subcommand in ('start', 'stop') and not token:
            return _fail_without_token(out, subcommand)

        if subcommand == 'start':
            client = await connect_client(args.uri, args.apikey)
            started = await client.cprofile_start(target=token, session=args.session)
            if started.get('status') == 'error':
                return out.fail(started.get('message') or 'Profiling did not start')
            out.line(f"Profiling started: session '{started.get('session')}' on {_scope(token)}")
            out.line(f'Stop it with: rocketride profile stop --token {token}')
            out.result(started)
            return 0

        if subcommand == 'stop':
            client = await connect_client(args.uri, args.apikey)
            stopped = await client.cprofile_stop(target=token)
            if stopped.get('status') == 'error':
                return out.fail(stopped.get('message') or 'Profiling did not stop')
            _print_stopped(out, stopped, token)
            out.result(stopped)
            return 0

        if subcommand == 'run':
            seconds = None
            if args.duration is not None:
                seconds = _parse_decimal(args.duration)
                if seconds is None or seconds <= 0:
                    return out.fail('--duration must be a positive number of seconds')
            client = await connect_client(args.uri, args.apikey)
            started = await client.cprofile_start(target=token, session=args.session)
            if started.get('status') == 'error':
                return out.fail(started.get('message') or 'Profiling did not start')
            out.line(f"Profiling started: session '{started.get('session')}' on {_scope(token)}")
            # stderr: a prompt, so it shows under bare --json without breaking stdout
            if seconds is None:
                print('Press Ctrl+C to stop.', file=sys.stderr)
            else:
                print(f'Stopping in {args.duration}s — press Ctrl+C to stop sooner.', file=sys.stderr)
            await _wait_for_stop(seconds)
            stopped = await client.cprofile_stop(target=token)
            if stopped.get('status') == 'error':
                return out.fail(stopped.get('message') or 'Profiling did not stop')
            _print_stopped(out, stopped, token)
            out.result(stopped)
            return 0

        if subcommand == 'status':
            client = await connect_client(args.uri, args.apikey)
            status = await client.cprofile_status(target=token)
            scope = _scope(token)
            if status.get('active'):
                out.line(
                    f"Profiling active on {scope}: session '{status.get('session')}', "
                    f'running {_seconds(status.get("runtime") or 0)} (owner {status.get("owner")})'
                )
            else:
                available = 'a report is available' if status.get('has_report') else 'no report yet'
                out.line(f'Profiling inactive on {scope}; {available}')
            out.result(status)
            return 0

        if subcommand == 'list':
            client = await connect_client(args.uri, args.apikey)
            entries: List[Dict[str, Any]] = [{'token': None, 'name': None, 'status': await client.cprofile_status()}]
            tasks = await client.get_tasks()
            entries.extend(
                await asyncio.gather(*(_read_task_status(client, t.get('token'), t.get('name')) for t in tasks))
            )
            for line in format_profile_list(entries, args.active):
                out.line(line)
            # The same filter as the text; an unreadable process is kept, its state unknown
            out.result(
                {'processes': [e for e in entries if not args.active or 'error' in e or e['status'].get('active')]}
            )
            return 0

        if subcommand == 'report':
            client = await connect_client(args.uri, args.apikey)
            result = await client.cprofile_report(target=token)
            # Formatted by the server; printed as is
            out.line(result['report'].rstrip('\n'))
            out.result(result)
            return 0

        if subcommand == 'threads':
            client = await connect_client(args.uri, args.apikey)
            result = await client.cprofile_threads(target=token)
            if result.get('error'):
                return out.fail(result['error'])
            for line in format_threads(result['threads']):
                out.line(line)
            out.result(result)
            return 0

        if subcommand == 'tree':
            thread = None
            if args.thread is not None:
                thread = _parse_count(args.thread)
                if thread is None:
                    return out.fail("--thread must be a thread id from 'rocketride profile threads'")
            min_pct = _parse_decimal(args.min_pct)
            if min_pct is None or min_pct > 100:
                return out.fail('--min-pct must be a number from 0 to 100')
            max_depth = _parse_count(args.max_depth)
            if max_depth is None or max_depth < 1:
                return out.fail('--max-depth must be a positive integer')
            client = await connect_client(args.uri, args.apikey)
            result = await client.cprofile_report_tree(
                target=token,
                max_depth=max_depth,
                min_pct=min_pct,
                include_system=args.include_system,
                thread=thread,
            )
            if result.get('error'):
                return out.fail(result['error'])
            for line in format_tree(result, thread):
                out.line(line)
            out.result(result)
            return 0

        return out.fail(f'Unknown profile subcommand: {subcommand}')

    return await run_cli_command(args, action)
