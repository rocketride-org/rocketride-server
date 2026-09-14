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
Deploy lifecycle commands: ``deploy add/list/get/versions/history/
publish/run/artifact/enable/disable/remove/log`` plus the ``deploy
schedule`` subgroup.

CLI verbs follow the platform vocabulary — deploy = version to server,
publish = bind to a rung — regardless of SDK method names. Every verb
here targets the DEPLOYMENT connection (ROCKETRIDE_DEPLOY_* pair) and
hard-stops when it is absent: the development connection is never a
deploy fallback. Kept in exact parity with the TypeScript CLI's
``src/cli/commands/deploy.ts``.
"""

import json
import sys
from datetime import datetime
from typing import Any, Dict, Optional

from ..utils.common import connect_client, run_cli_command
from ..utils.env import NO_DEPLOY_TARGET_MESSAGE
from ..utils.output import Output


def _format_when(seconds: Optional[float]) -> str:
    """
    Format a unix-seconds timestamp for human output, or ``-`` when absent.

    Args:
        seconds: Unix timestamp in seconds.

    Returns:
        Localized date-time string.
    """
    if not seconds:
        return '-'
    return datetime.fromtimestamp(seconds).strftime('%c')


def _print_deployment(out: Output, deployment: Dict[str, Any]) -> None:
    """
    Print one deployment row as a compact human line block.

    Args:
        out: The output channel.
        deployment: The row to print.
    """
    line = f'{deployment.get("projectId", "?")}  v{deployment.get("version", "?")}  {deployment.get("state", "?")}  {deployment.get("pipelineName", "")}'
    out.line(line.rstrip())
    if deployment.get('teamId'):
        out.line(f'  Team: {deployment["teamId"]}')
    if deployment.get('deployedAt'):
        out.line(f'  Deployed: {_format_when(deployment["deployedAt"])}')


def _print_history_entry(out: Output, entry: Dict[str, Any]) -> None:
    """
    Print one history row; rows are self-describing by contract.

    Args:
        out: The output channel.
        entry: The audit-trail row.
    """
    actor = entry.get('actor') or {}
    who = actor.get('name') or actor.get('email') or ''
    version = f' v{entry["version"]}' if entry.get('version') is not None else ''
    team = f' team {entry["teamId"]}' if entry.get('teamId') else ''
    by = f'  by {who}' if who else ''
    out.line(f'{_format_when(entry.get("at"))}  {entry.get("action", "?")}{version}{team}{by}')
    data = entry.get('data') or {}
    if data.get('comment'):
        out.line(f'  {data["comment"]}')
    if data.get('message'):
        out.line(f'  {data["message"]}')


async def _connect_deploy(args, out: Output):
    """
    Connect to the deployment target, enforcing the hard stop.

    Args:
        args: Parsed argparse namespace.
        out: The command's output channel.

    Returns:
        The connected client, or None after reporting the stop.
    """
    if not args.uri:
        out.fail(NO_DEPLOY_TARGET_MESSAGE)
        return None
    return await connect_client(args.uri, args.apikey)


async def run_deploy(args) -> int:
    """
    Execute one ``deploy`` subcommand.

    Args:
        args: Parsed argparse namespace (deploy_subcommand + verb args).

    Returns:
        Exit code.
    """

    async def action(out: Output) -> int:
        subcommand = args.deploy_subcommand

        # deploy add: push a pipe/node artifact as the next registry version
        if subcommand == 'add':
            if args.kind not in ('pipe', 'node'):
                return out.fail(
                    f"Unknown artifact kind '{args.kind}'",
                    "use 'pipe' or 'node' (apps deploy via 'rocketride app deploy')",
                )
            client = await _connect_deploy(args, out)
            if client is None:
                return 1
            if args.kind == 'pipe':
                with open(args.file, 'r', encoding='utf-8') as f:
                    pipeline = json.load(f)
                result = await client.deploy.add(pipeline, kind='pipe', comment=args.comment, deploy_to=args.deploy_to)
            else:
                with open(args.file, 'rb') as f:
                    data = f.read()
                result = await client.deploy.add(
                    None, kind='node', data=data, comment=args.comment, deploy_to=args.deploy_to
                )
            artifact = result.get('artifact') or {}
            name = f' ({artifact["name"]})' if artifact.get('name') else ''
            out.line(f'Deployed {args.kind} version v{artifact.get("version", "?")}{name}')
            if artifact.get('projectId'):
                out.line(f'Project: {artifact["projectId"]}')
            out.line('Deploying activates nothing - publish a rung to serve it.')
            out.result(
                {
                    'projectId': artifact.get('projectId'),
                    'version': artifact.get('version'),
                    'name': artifact.get('name'),
                }
            )
            return 0

        if subcommand == 'list':
            client = await _connect_deploy(args, out)
            if client is None:
                return 1
            envelope = await client.deploy.list(team_id=args.team)
            rows = envelope.get('rows', [])
            if not rows:
                out.line('No deployments found')
            else:
                out.line(f'Found {len(rows)} deployment(s) (of {envelope.get("total", len(rows))}):')
                out.line('')
                for row in rows:
                    _print_deployment(out, row)
                    out.line('')
            out.result({'deployments': rows, 'total': envelope.get('total', len(rows))})
            return 0

        if subcommand == 'get':
            client = await _connect_deploy(args, out)
            if client is None:
                return 1
            deployment = await client.deploy.get(args.project, args.team or '')
            _print_deployment(out, deployment)
            for source_id, schedule in (deployment.get('schedules') or {}).items():
                state = 'paused' if schedule.get('paused') else ('active' if schedule.get('cron') else 'none')
                out.line(f'  Schedule {source_id}: {schedule.get("cron", "-")} ({state})')
            out.result({'deployment': deployment})
            return 0

        if subcommand == 'versions':
            client = await _connect_deploy(args, out)
            if client is None:
                return 1
            envelope = await client.deploy.versions(args.project)
            rows = envelope.get('rows', [])
            if not rows:
                out.line('No versions found')
            else:
                out.line(f'Found {len(rows)} version(s) (of {envelope.get("total", len(rows))}):')
                for row in rows:
                    published_by = row.get('publishedBy') or {}
                    who = published_by.get('name') or published_by.get('email') or ''
                    by = f'  by {who}' if who else ''
                    comment = f'  {row["comment"]}' if row.get('comment') else ''
                    out.line(f'v{row.get("version", "?")}  {_format_when(row.get("publishedAt"))}{by}{comment}')
            out.result({'versions': rows, 'total': envelope.get('total', len(rows))})
            return 0

        if subcommand == 'history':
            client = await _connect_deploy(args, out)
            if client is None:
                return 1
            envelope = await client.deploy.history(args.project, team_id=args.team)
            rows = envelope.get('rows', [])
            if not rows:
                out.line('No history found')
            else:
                for row in rows:
                    _print_history_entry(out, row)
            out.result({'history': rows, 'total': envelope.get('total', len(rows))})
            return 0

        # deploy publish: the rung bind. The SDK method is named
        # deploy.deploy for legacy reasons; the CLI verb follows the
        # platform vocabulary.
        if subcommand == 'publish':
            client = await _connect_deploy(args, out)
            if client is None:
                return 1
            deployment = await client.deploy.deploy(args.project, args.version, args.team or '')
            target = f' to team {args.team}' if args.team else ''
            out.line(f'Published {args.project} v{args.version}{target}.')
            _print_deployment(out, deployment)
            out.result({'deployment': deployment})
            return 0

        if subcommand == 'run':
            client = await _connect_deploy(args, out)
            if client is None:
                return 1
            result = await client.deploy.run(args.project, args.source, args.team or '')
            token = f' (token {result["token"]})' if result.get('token') else ''
            out.line(f'Run started for {args.project}/{args.source}{token}.')
            out.result(result)
            return 0

        if subcommand == 'artifact':
            client = await _connect_deploy(args, out)
            if client is None:
                return 1
            artifact = await client.deploy.artifact(args.project, args.version)
            if not out.json_requested:
                sys.stdout.write(json.dumps(artifact, indent=2) + '\n')
            out.result(artifact)
            return 0

        if subcommand in ('enable', 'disable', 'remove'):
            client = await _connect_deploy(args, out)
            if client is None:
                return 1
            method = getattr(client.deploy, subcommand)
            deployment = await method(args.project, args.team or '')
            out.line(f'Deployment {args.project} {subcommand}d.')
            out.result({'deployment': deployment})
            return 0

        # deploy log: fronts the build.log read verb — error detail for a
        # failed app build lives in the scrubbed build.log beside the artifact
        if subcommand == 'log':
            client = await _connect_deploy(args, out)
            if client is None:
                return 1
            result = await client.build_log(args.app_id, args.version)
            if not out.json_requested:
                sys.stdout.write((result.get('log') or '') + '\n')
            out.result(result)
            return 0

        if subcommand == 'schedule':
            return await _run_schedule(args, out)

        return out.fail(f'Unknown deploy subcommand: {subcommand}')

    return await run_cli_command(args, action)


async def _run_schedule(args, out: Output) -> int:
    """
    Execute one ``deploy schedule`` subcommand.

    Args:
        args: Parsed argparse namespace (schedule_subcommand + verb args).
        out: The command's output channel.

    Returns:
        Exit code.
    """
    subcommand = args.schedule_subcommand

    if subcommand == 'set':
        client = await _connect_deploy(args, out)
        if client is None:
            return 1
        schedule = None if args.cron == 'none' else args.cron
        deployment = await client.deploy.set_schedule(
            args.project, args.source, schedule, args.team or '', ttl=args.ttl
        )
        if schedule:
            out.line(f'Schedule set for {args.project}/{args.source}: {schedule}')
        else:
            out.line(f'Schedule cleared for {args.project}/{args.source}.')
        out.result({'deployment': deployment})
        return 0

    if subcommand in ('pause', 'resume'):
        client = await _connect_deploy(args, out)
        if client is None:
            return 1
        method = client.deploy.pause_schedule if subcommand == 'pause' else client.deploy.resume_schedule
        deployment = await method(args.project, args.source, args.team or '')
        out.line(f'Schedule {subcommand}d for {args.project}/{args.source}.')
        out.result({'deployment': deployment})
        return 0

    if subcommand == 'preview':
        client = await _connect_deploy(args, out)
        if client is None:
            return 1
        preview = await client.deploy.preview(args.cron, args.count)
        if preview.get('valid') is False:
            out.line(f'Invalid: {preview.get("error", "unknown reason")}')
            out.result(preview)
            return 1
        occurrences = preview.get('next') or []
        out.line(f'Valid. Next {len(occurrences)} occurrence(s):')
        for when in occurrences:
            out.line(f'  {_format_when(when)}')
        out.result(preview)
        return 0

    out.fail(f'Unknown schedule subcommand: {subcommand}')
    return 1
