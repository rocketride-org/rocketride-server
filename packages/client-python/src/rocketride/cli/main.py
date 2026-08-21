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
RocketRide CLI entry point.

Command surface (kept in exact parity with the TypeScript client's CLI):

    init                       Initialize the workspace (login + provision)
    login                      (Re-)authenticate and save .env credentials
    list                       List active tasks
    start / stop / upload      Task lifecycle
    store dir/type/write/...   File store operations
    app create/deploy/verify   App lifecycle
    deploy add/list/publish/.. Deploy lifecycle (deployment target)

All output is plain, line-oriented text; every command also accepts
``--json`` / ``--json=<file>`` for a machine-readable result. Continuous
live monitoring is deliberately absent — the platform's event monitor
and server monitor apps own that job.

Configuration comes from flags or the workspace ``.env``
(ROCKETRIDE_URI/ROCKETRIDE_APIKEY for development,
ROCKETRIDE_DEPLOY_URI/ROCKETRIDE_DEPLOY_APIKEY for deploy verbs), which
``rocketride init`` writes.
"""

import argparse
import asyncio
import os
import sys

from .utils.env import (
    ENV_DEPLOY_APIKEY,
    ENV_DEPLOY_URI,
    ENV_DEV_APIKEY,
    ENV_DEV_URI,
    load_dot_env,
)


def _add_connection_args(parser: argparse.ArgumentParser) -> None:
    """
    Add the development-connection options (``--uri``, ``--apikey``,
    ``--json``) with defaults from the (already loaded) environment.

    Args:
        parser: The subcommand parser to extend.
    """
    from ..core.constants import CONST_DEFAULT_WEB_LOCAL

    parser.add_argument(
        '--uri',
        default=os.getenv(ENV_DEV_URI, CONST_DEFAULT_WEB_LOCAL),
        help=f'RocketRide server URI (can use {ENV_DEV_URI} in .env or env var)',
    )
    parser.add_argument(
        '--apikey',
        default=os.getenv(ENV_DEV_APIKEY),
        help=f'API key for server authentication (can use {ENV_DEV_APIKEY} in .env or env var)',
    )
    _add_json_arg(parser)


def _add_deploy_connection_args(parser: argparse.ArgumentParser) -> None:
    """
    Add the deployment-target options (``--uri``, ``--apikey``,
    ``--json``). Lifecycle verbs hard-stop when the pair is absent — the
    development connection is never a deploy fallback.

    Args:
        parser: The subcommand parser to extend.
    """
    parser.add_argument(
        '--uri',
        default=os.getenv(ENV_DEPLOY_URI),
        help=f'Deployment target URI (can use {ENV_DEPLOY_URI} env var)',
    )
    parser.add_argument(
        '--apikey',
        default=os.getenv(ENV_DEPLOY_APIKEY),
        help=f'Deployment target API key (can use {ENV_DEPLOY_APIKEY} env var)',
    )
    _add_json_arg(parser)


def _add_json_arg(parser: argparse.ArgumentParser) -> None:
    """
    Add the ``--json [FILE]`` option (bare = JSON on stdout).

    Args:
        parser: The subcommand parser to extend.
    """
    parser.add_argument(
        '--json',
        nargs='?',
        const='-',
        default=None,
        metavar='FILE',
        help='Output the result as a JSON value (to stdout, or to FILE)',
    )


def setup_parser() -> argparse.ArgumentParser:
    """
    Build the argument parser with every command group registered.

    Returns:
        The configured root parser.
    """
    parser = argparse.ArgumentParser(
        description='RocketRide Unified Pipeline and File Management CLI',
        epilog='Use "rocketride <command> --help" for command-specific help',
    )
    subparsers = parser.add_subparsers(dest='command', help='Available commands', metavar='COMMAND')

    # ── init ─────────────────────────────────────────────────────────────
    init_parser = subparsers.add_parser(
        'init', help='Initialize this workspace: sign in, vendor platform packages, install agent docs'
    )
    _add_connection_args(init_parser)
    init_parser.add_argument(
        '--no-deploy', dest='deploy', action='store_false', help='Do not configure a deploy target'
    )
    init_parser.add_argument(
        '--no-install', dest='install', action='store_false', help='Skip the workspace install after vendoring'
    )

    # ── login ────────────────────────────────────────────────────────────
    login_parser = subparsers.add_parser(
        'login', help='(Re-)authenticate against a server and save credentials to .env'
    )
    _add_connection_args(login_parser)
    login_parser.add_argument(
        '--deploy',
        dest='deploy_pair',
        action='store_true',
        help='Re-authenticate the deployment pair (ROCKETRIDE_DEPLOY_*) instead',
    )
    login_parser.add_argument(
        '--no-deploy', dest='deploy', action='store_false', help='Do not mirror the credentials into the deploy pair'
    )

    # ── list ─────────────────────────────────────────────────────────────
    list_parser = subparsers.add_parser('list', help='List all active tasks')
    _add_connection_args(list_parser)

    # ── start ────────────────────────────────────────────────────────────
    start_parser = subparsers.add_parser('start', help='Start a new pipeline')
    _add_connection_args(start_parser)
    start_parser.add_argument(
        '--pipeline',
        default=os.getenv('ROCKETRIDE_PIPELINE'),
        help='Path to pipeline configuration file (can use ROCKETRIDE_PIPELINE in .env or env var)',
    )
    start_parser.add_argument(
        '--token',
        default=os.getenv('ROCKETRIDE_TOKEN'),
        help='Optional existing task token (can use ROCKETRIDE_TOKEN in .env or env var)',
    )
    start_parser.add_argument('--threads', type=int, default=4, help='Number of threads (default: %(default)s)')
    start_parser.add_argument(
        '--args', dest='pipeline_args', nargs=argparse.REMAINDER, help='Additional pipeline arguments'
    )

    # ── stop ─────────────────────────────────────────────────────────────
    stop_parser = subparsers.add_parser('stop', help='Stop a running task')
    _add_connection_args(stop_parser)
    stop_parser.add_argument(
        '--token',
        default=os.getenv('ROCKETRIDE_TOKEN'),
        help='Task token to stop (can use ROCKETRIDE_TOKEN in .env or env var)',
    )

    # ── upload ───────────────────────────────────────────────────────────
    upload_parser = subparsers.add_parser('upload', help='Upload files using --pipeline or an existing task token')
    _add_connection_args(upload_parser)
    upload_parser.add_argument('files', nargs='+', help='Files, wildcards, or directories to upload')
    upload_parser.add_argument(
        '--pipeline',
        default=os.getenv('ROCKETRIDE_PIPELINE'),
        help='Pipeline file to start new task (can use ROCKETRIDE_PIPELINE in .env or env var)',
    )
    upload_parser.add_argument(
        '--token',
        default=os.getenv('ROCKETRIDE_TOKEN'),
        help='Existing task token to use for uploads (can use ROCKETRIDE_TOKEN in .env or env var)',
    )
    upload_parser.add_argument('--threads', type=int, default=4, help='Number of threads (default: %(default)s)')
    upload_parser.add_argument(
        '--max-concurrent',
        dest='max_concurrent',
        type=int,
        default=5,
        help='Maximum concurrent uploads (accepted for parity; the Python client parallelizes automatically)',
    )
    upload_parser.add_argument(
        '--args', dest='pipeline_args', nargs=argparse.REMAINDER, help='Additional pipeline arguments'
    )

    # ── store ────────────────────────────────────────────────────────────
    store_parser = subparsers.add_parser('store', help='File store operations')
    store_subparsers = store_parser.add_subparsers(dest='store_subcommand', help='Store commands', metavar='COMMAND')

    dir_parser = store_subparsers.add_parser('dir', help='List directory contents')
    _add_connection_args(dir_parser)
    dir_parser.add_argument('path', nargs='?', default='', help='Directory path (default: root)')

    type_parser = store_subparsers.add_parser('type', help='Display file contents')
    _add_connection_args(type_parser)
    type_parser.add_argument('path', help='File path')

    write_parser = store_subparsers.add_parser('write', help='Write a file')
    _add_connection_args(write_parser)
    write_parser.add_argument('path', help='File path')
    write_group = write_parser.add_mutually_exclusive_group(required=True)
    write_group.add_argument('--file', help='Local file to upload')
    write_group.add_argument('--content', help='Inline text content')

    rm_parser = store_subparsers.add_parser('rm', help='Delete a file')
    _add_connection_args(rm_parser)
    rm_parser.add_argument('path', help='File path')

    mkdir_parser = store_subparsers.add_parser('mkdir', help='Create a directory')
    _add_connection_args(mkdir_parser)
    mkdir_parser.add_argument('path', help='Directory path')

    stat_parser = store_subparsers.add_parser('stat', help='Get file/directory metadata')
    _add_connection_args(stat_parser)
    stat_parser.add_argument('path', help='File or directory path')

    # ── app ──────────────────────────────────────────────────────────────
    app_parser = subparsers.add_parser('app', help='App lifecycle operations')
    app_subparsers = app_parser.add_subparsers(dest='app_subcommand', help='App commands', metavar='COMMAND')

    app_deploy_parser = app_subparsers.add_parser(
        'deploy', help="Pack an app folder's source and deploy it as the next registry version"
    )
    _add_deploy_connection_args(app_deploy_parser)
    app_deploy_parser.add_argument('folder', help='App folder to pack and deploy')
    app_deploy_parser.add_argument(
        '--workspace', help='Workspace root the zip is rooted at (default: current directory)'
    )
    app_deploy_parser.add_argument('--comment', help='What-changed note kept in the registry')
    app_deploy_parser.add_argument('--verbose', action='store_true', help='Narrate every pack step')

    app_create_parser = app_subparsers.add_parser(
        'create', help='Scaffold a new app under ./apps/<slug> (same templates as the App Builder wizard)'
    )
    _add_connection_args(app_create_parser)
    app_create_parser.add_argument('slug', help='App slug')
    app_create_parser.add_argument('--template', default='Blank', help='Template: Blank or Dashboard')
    app_create_parser.add_argument('--name', help='Display name (default: title-cased slug)')
    app_create_parser.add_argument('--developer', help="Developer id for <developerId>.<slug> (default: 'local')")
    app_create_parser.add_argument('--sidebar', action='store_true', help='Two-column layout with a navigation sidebar')
    app_create_parser.add_argument(
        '--no-status-footer', dest='status_footer', action='store_false', help='Omit the bottom status bar'
    )
    app_create_parser.add_argument(
        '--doc-tabs', dest='doc_tabs', action='store_true', help='Document tab strip (Documents + DocTabs)'
    )
    app_create_parser.add_argument('--workspace', help='Workspace root (default: current directory)')
    app_create_parser.add_argument(
        '--no-install', dest='install', action='store_false', help='Skip the workspace pnpm install'
    )

    app_verify_parser = app_subparsers.add_parser(
        'verify', help='Pre-check an app folder for deploy: manifest, id grammar, assets, includes, pack dry run'
    )
    _add_json_arg(app_verify_parser)
    app_verify_parser.add_argument('folder', help='App folder to verify')
    app_verify_parser.add_argument(
        '--workspace', help='Workspace root the pack would be rooted at (default: current directory)'
    )

    # ── deploy ───────────────────────────────────────────────────────────
    deploy_parser = subparsers.add_parser('deploy', help='Deploy lifecycle operations (deployment target)')
    deploy_subparsers = deploy_parser.add_subparsers(
        dest='deploy_subcommand', help='Deploy commands', metavar='COMMAND'
    )

    d_add = deploy_subparsers.add_parser(
        'add', help='Deploy an artifact file as the next registry version (deploying activates nothing)'
    )
    _add_deploy_connection_args(d_add)
    d_add.add_argument('file', help='Artifact file (pipeline JSON, or node package JSON)')
    d_add.add_argument('--kind', default='pipe', help='Artifact kind: pipe or node (default: %(default)s)')
    d_add.add_argument('--comment', help='What-changed note kept in the registry')
    d_add.add_argument('--deploy-to', dest='deploy_to', help='Also point this team at the new version in the same call')

    d_list = deploy_subparsers.add_parser('list', help='List deployments')
    _add_deploy_connection_args(d_list)
    d_list.add_argument('--team', help='Scope to one team')

    d_get = deploy_subparsers.add_parser('get', help="Show one deployment's state")
    _add_deploy_connection_args(d_get)
    d_get.add_argument('project', help='Project id')
    d_get.add_argument('--team', default='', help='Team the deployment belongs to')

    d_versions = deploy_subparsers.add_parser('versions', help="List a project's registry versions")
    _add_deploy_connection_args(d_versions)
    d_versions.add_argument('project', help='Project id')

    d_history = deploy_subparsers.add_parser('history', help="Show a project's deploy/publish audit trail")
    _add_deploy_connection_args(d_history)
    d_history.add_argument('project', help='Project id')
    d_history.add_argument('--team', help='Scope to one team')

    d_publish = deploy_subparsers.add_parser(
        'publish', help='Bind a team to a registry version (first publish, update, promote, rollback)'
    )
    _add_deploy_connection_args(d_publish)
    d_publish.add_argument('project', help='Project id')
    d_publish.add_argument('version', type=int, help='Registry version number')
    d_publish.add_argument('--team', default='', help='Team to bind')

    d_run = deploy_subparsers.add_parser('run', help="Trigger a deployment's source to run now")
    _add_deploy_connection_args(d_run)
    d_run.add_argument('project', help='Project id')
    d_run.add_argument('source', help='Source component id')
    d_run.add_argument('--team', default='', help='Team whose deployment runs')

    d_artifact = deploy_subparsers.add_parser('artifact', help="Fetch one registry version's artifact JSON")
    _add_deploy_connection_args(d_artifact)
    d_artifact.add_argument('project', help='Project id')
    d_artifact.add_argument('version', type=int, help='Registry version number')

    for verb, help_text in (
        ('enable', 'Enable a disabled deployment'),
        ('disable', 'Disable a deployment (whole-deployment kill switch)'),
        ('remove', 'Remove a deployment (registry versions and audit history survive)'),
    ):
        verb_parser = deploy_subparsers.add_parser(verb, help=help_text)
        _add_deploy_connection_args(verb_parser)
        verb_parser.add_argument('project', help='Project id')
        verb_parser.add_argument('--team', default='', help='Team the deployment belongs to')

    d_log = deploy_subparsers.add_parser('log', help="Read an app version's build log")
    _add_deploy_connection_args(d_log)
    d_log.add_argument('app_id', help='App id')
    d_log.add_argument('version', type=int, help='Registry version number')

    d_schedule = deploy_subparsers.add_parser('schedule', help='Per-source schedule operations')
    schedule_subparsers = d_schedule.add_subparsers(
        dest='schedule_subcommand', help='Schedule commands', metavar='COMMAND'
    )

    s_set = schedule_subparsers.add_parser('set', help="Set a source's schedule (5-field cron), or 'none' to clear it")
    _add_deploy_connection_args(s_set)
    s_set.add_argument('project', help='Project id')
    s_set.add_argument('source', help='Source component id')
    s_set.add_argument('cron', help="5-field cron expression, or 'none'")
    s_set.add_argument('--team', default='', help='Team the deployment belongs to')
    s_set.add_argument('--ttl', type=int, help='Run window in seconds (fixed window)')

    for verb, help_text in (
        ('pause', "Pause a source's schedule (cron/ttl kept, never fires)"),
        ('resume', "Resume a source's paused schedule"),
    ):
        verb_parser = schedule_subparsers.add_parser(verb, help=help_text)
        _add_deploy_connection_args(verb_parser)
        verb_parser.add_argument('project', help='Project id')
        verb_parser.add_argument('source', help='Source component id')
        verb_parser.add_argument('--team', default='', help='Team the deployment belongs to')

    s_preview = schedule_subparsers.add_parser(
        'preview', help='Validate a cron expression and show its next occurrences'
    )
    _add_deploy_connection_args(s_preview)
    s_preview.add_argument('cron', help='5-field cron expression')
    s_preview.add_argument('--count', type=int, default=5, help='Number of occurrences to show (default: %(default)s)')

    return parser


async def _dispatch(args) -> int:
    """
    Route the parsed arguments to the command implementation.

    Args:
        args: Parsed argparse namespace.

    Returns:
        Exit code.
    """
    # Imported here so `rocketride --help` stays fast and .env is loaded
    from .commands.app import run_app
    from .commands.auth import run_init, run_login
    from .commands.deploy import run_deploy
    from .commands.store import run_store
    from .commands.tasks import run_list, run_start, run_stop, run_upload

    if args.command == 'init':
        return await run_init(args)
    if args.command == 'login':
        return await run_login(args)
    if args.command == 'list':
        return await run_list(args)
    if args.command == 'start':
        return await run_start(args)
    if args.command == 'stop':
        return await run_stop(args)
    if args.command == 'upload':
        return await run_upload(args)
    if args.command == 'store':
        if not getattr(args, 'store_subcommand', None):
            print('Error: Store subcommand is required (dir, type, write, rm, mkdir, stat)', file=sys.stderr)
            return 1
        return await run_store(args)
    if args.command == 'app':
        if not getattr(args, 'app_subcommand', None):
            print('Error: App subcommand is required (create, deploy, verify)', file=sys.stderr)
            return 1
        return await run_app(args)
    if args.command == 'deploy':
        if not getattr(args, 'deploy_subcommand', None):
            print(
                'Error: Deploy subcommand is required (add, list, get, versions, history, publish, run, artifact, enable, disable, remove, log, schedule)',
                file=sys.stderr,
            )
            return 1
        if args.deploy_subcommand == 'schedule' and not getattr(args, 'schedule_subcommand', None):
            print('Error: Schedule subcommand is required (set, pause, resume, preview)', file=sys.stderr)
            return 1
        return await run_deploy(args)
    print(f'Unknown command: {args.command}', file=sys.stderr)
    return 1


def main() -> None:
    """
    Entry point for the CLI application.

    Loads the workspace ``.env`` (real environment wins), parses the
    command line, dispatches, and exits with the command's code.
    """
    # The workspace .env must be in os.environ BEFORE the parser is
    # built — argparse defaults read it at construction time
    load_dot_env()

    parser = setup_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    try:
        exit_code = asyncio.run(_dispatch(args))
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print('\nOperation interrupted by user', file=sys.stderr)
        sys.exit(130)


if __name__ == '__main__':
    main()
