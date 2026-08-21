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
Task lifecycle commands: start, stop, upload, list.

All output is plain, line-oriented, append-only text (or ``--json``) —
continuous monitoring belongs to the platform's monitor apps, not the
CLI. Kept in exact parity with the TypeScript CLI's
``src/cli/commands/tasks.ts``.
"""

import os
import time
from typing import Any, Dict

from ..utils.common import connect_client, run_cli_command
from ..utils.config import load_pipeline_config
from ..utils.file_utils import find_files, validate_files
from ..utils.formatters import format_size
from ..utils.output import Output


async def run_start(args) -> int:
    """
    Start a new pipeline and print its task token.

    Args:
        args: Parsed argparse namespace (pipeline, token, threads, args).

    Returns:
        Exit code.
    """

    async def action(out: Output) -> int:
        # step: validate and load the pipeline configuration
        if not args.pipeline:
            return out.fail(
                'Pipeline file is required for the start command', 'pass --pipeline or set ROCKETRIDE_PIPELINE in .env'
            )
        pipeline_data = load_pipeline_config(args.pipeline)
        out.line(f'Starting pipeline from {args.pipeline}...')

        # step: connect and start
        client = await connect_client(args.uri, args.apikey)
        result = await client.use(
            pipeline=pipeline_data,
            threads=args.threads,
            token=args.token,
            args=args.pipeline_args or [],
        )
        token = result.get('token', '')
        out.line('Pipeline started.')
        out.line(f'Token: {token}')
        out.line(f'Stop it with: rocketride stop --token {token}')
        out.result({'token': token})
        return 0

    return await run_cli_command(args, action)


async def run_stop(args) -> int:
    """
    Terminate a running task.

    Args:
        args: Parsed argparse namespace (token).

    Returns:
        Exit code.
    """

    async def action(out: Output) -> int:
        if not args.token:
            return out.fail('Token is required for the stop command', 'pass --token or set ROCKETRIDE_TOKEN in .env')
        client = await connect_client(args.uri, args.apikey)
        await client.terminate(args.token)
        out.line(f'Task {args.token} terminated.')
        out.result({'token': args.token, 'terminated': True})
        return 0

    return await run_cli_command(args, action)


async def run_list(args) -> int:
    """
    List the caller's active tasks.

    Args:
        args: Parsed argparse namespace.

    Returns:
        Exit code.
    """

    async def action(out: Output) -> int:
        client = await connect_client(args.uri, args.apikey)
        tasks = await client.get_tasks()
        if not tasks:
            out.line('No active tasks found')
        else:
            out.line(f'Found {len(tasks)} active task(s):')
            out.line('')
            for i, task in enumerate(tasks, 1):
                out.line(f'Task {i}:')
                out.line(f'  Name: {task.get("name", "N/A")}')
                out.line(f'  Token: {task.get("token", "N/A")}')
                out.line(f'  Source: {task.get("source", "N/A")}')
                out.line(f'  Status: {task.get("status", "N/A")}')
                description = task.get('description', '')
                if description and description != 'N/A':
                    out.line(f'  Description: {description}')
                out.line('')
        out.result({'tasks': tasks})
        return 0

    return await run_cli_command(args, action)


async def run_upload(args) -> int:
    """
    Upload files to a pipeline with plain per-file progress lines.

    Args:
        args: Parsed argparse namespace (files, pipeline, token, threads).

    Returns:
        Exit code.
    """

    async def action(out: Output) -> int:
        if not args.pipeline and not args.token:
            return out.fail(
                'Either --pipeline or --token must be specified for the upload command',
                'pass one of them or set ROCKETRIDE_PIPELINE/ROCKETRIDE_TOKEN in .env',
            )

        # step: expand and validate the file arguments
        all_files = find_files(args.files)
        if not all_files:
            return out.fail('No files found matching the specified patterns')
        valid_files, invalid_files = validate_files(all_files)
        for error in invalid_files:
            out.line(f'skipped  {error}')
        if not valid_files:
            return out.fail('No valid files found')
        out.line(f'Uploading {len(valid_files)} file(s)...')

        # step: per-file progress lines from upload events (append-only)
        async def on_event(message: Dict[str, Any]) -> None:
            if message.get('event', '') != 'apaevt_status_upload':
                return
            body = message.get('body', {}) or {}
            action_name = str(body.get('action', ''))
            name = os.path.basename(str(body.get('filepath', 'unknown')))
            if action_name == 'complete':
                out.line(f'uploaded {name} ({format_size(int(body.get("file_size", 0) or 0))})')
            elif action_name == 'error':
                out.line(f'failed   {name}: {body.get("error", "Unknown error")}')

        client = await connect_client(args.uri, args.apikey, on_event=on_event)

        # step: resolve the task token (start a pipeline when asked to)
        task_token = args.token
        manage_pipeline = bool(args.pipeline) and not args.token
        if manage_pipeline:
            pipeline_config = load_pipeline_config(args.pipeline)
            use_result = await client.use(
                pipeline=pipeline_config,
                threads=args.threads,
                token='UPLOAD_TASK',
                args=args.pipeline_args or [],
            )
            task_token = use_result.get('token', '')

        # step: send the files and collect per-file results — the teardown
        # sits in a finally so a raised send still stops the pipeline this
        # command started, instead of leaving it alive until its TTL expires
        start_time = time.time()
        try:
            results = await client.send_files(valid_files, task_token)
        finally:
            # step: tear down a pipeline this command started
            if manage_pipeline and task_token:
                try:
                    await client.terminate(task_token)
                except Exception as error:  # noqa: BLE001
                    out.line(f'warning: failed to terminate upload pipeline: {error}')
        elapsed_seconds = time.time() - start_time

        # step: summarize
        succeeded = [r for r in results if r.get('action') == 'complete']
        failed = [r for r in results if r.get('action') != 'complete']
        total_bytes = sum(int(r.get('file_size', 0) or 0) for r in succeeded)
        out.line('')
        out.line(
            f'Uploaded {len(succeeded)} of {len(results)} file(s), {format_size(total_bytes)} in {elapsed_seconds:.1f}s.'
        )
        if failed:
            out.line(f'Failed: {len(failed)} file(s).')
        payload: Dict[str, Any] = {
            'uploaded': len(succeeded),
            'failed': len(failed),
            'totalBytes': total_bytes,
            'elapsedSeconds': elapsed_seconds,
            'files': [
                {
                    'filepath': r.get('filepath'),
                    'action': r.get('action'),
                    'size': r.get('file_size'),
                    **({'error': r.get('error')} if r.get('error') else {}),
                }
                for r in results
            ],
        }
        if invalid_files:
            payload['skipped'] = invalid_files
        out.result(payload)
        return 1 if failed else 0

    return await run_cli_command(args, action)
