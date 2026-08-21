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
File-store commands: ``store dir/type/write/rm/mkdir/stat``.

Thin wrappers over the client's ``fs_*`` methods with DOS-dir-style
listing output. Kept in exact parity with the TypeScript CLI's
``src/cli/commands/store.ts``.
"""

import sys
from datetime import datetime, timezone

from ..utils.common import connect_client, run_cli_command
from ..utils.output import Output


async def run_store(args) -> int:
    """
    Execute one ``store`` subcommand.

    Args:
        args: Parsed argparse namespace (store_subcommand, path, ...).

    Returns:
        Exit code.
    """

    async def action(out: Output) -> int:
        client = await connect_client(args.uri, args.apikey)
        subcommand = args.store_subcommand

        if subcommand == 'dir':
            # step: list a directory in DOS dir style
            path = getattr(args, 'path', '') or ''
            result = await client.fs_list_dir(path)
            entries = result.get('entries', [])
            if not entries:
                stat = await client.fs_stat(path) if path else {'exists': True, 'type': 'dir'}
                if stat.get('exists') and stat.get('type') == 'dir':
                    out.line(f'    {0:>8,} File(s)  {0:>14,} bytes')
                    out.line(f'    {0:>8,} Dir(s)')
                else:
                    out.line('File Not Found')
                out.result({'path': path, 'entries': []})
                return 0
            total_size = 0
            file_count = 0
            dir_count = 0
            for entry in entries:
                modified = entry.get('modified')
                if modified:
                    dt = datetime.fromtimestamp(modified, tz=timezone.utc)
                    date_str = dt.strftime('%m/%d/%Y  %I:%M %p')
                else:
                    date_str = '                   '
                if entry.get('type') == 'dir':
                    out.line(f'{date_str}    <DIR>          {entry["name"]}')
                    dir_count += 1
                else:
                    size = entry.get('size', 0) or 0
                    total_size += size
                    out.line(f'{date_str}    {size:>14,} {entry["name"]}')
                    file_count += 1
            out.line(f'    {file_count:>8,} File(s)  {total_size:>14,} bytes')
            out.line(f'    {dir_count:>8,} Dir(s)')
            out.result({'path': path, 'entries': entries})
            return 0

        if subcommand == 'type':
            # step: stream the file's text to stdout (raw, no decoration)
            text = await client.fs_read_string(args.path)
            if not out.json_requested:
                sys.stdout.write(text)
            out.result({'path': args.path, 'content': text})
            return 0

        if subcommand == 'write':
            # step: upload a local file through the handle API, or write inline text
            if getattr(args, 'file', None):
                info = await client.fs_open(args.path, 'w')
                handle = info['handle']
                try:
                    with open(args.file, 'rb') as f:
                        while True:
                            chunk = f.read(65536)
                            if not chunk:
                                break
                            await client.fs_write(handle, chunk)
                    await client.fs_close(handle, 'w')
                except Exception:
                    try:
                        await client.fs_close(handle, 'w')
                    except Exception:  # noqa: BLE001
                        pass
                    raise
            elif getattr(args, 'content', None) is not None:
                await client.fs_write_string(args.path, args.content)
            else:
                return out.fail('Either --file or --content is required')
            out.line(f'Written: {args.path}')
            out.result({'path': args.path, 'written': True})
            return 0

        if subcommand == 'rm':
            await client.fs_delete(args.path)
            out.line(f'Deleted: {args.path}')
            out.result({'path': args.path, 'deleted': True})
            return 0

        if subcommand == 'mkdir':
            await client.fs_mkdir(args.path)
            out.line(f'Created: {args.path}/')
            out.result({'path': args.path, 'created': True})
            return 0

        if subcommand == 'stat':
            result = await client.fs_stat(args.path)
            if not result.get('exists'):
                out.line(f'{args.path}: not found')
            else:
                details = []
                if result.get('size') is not None:
                    details.append(f'size: {result["size"]:,}')
                if result.get('modified'):
                    modified = datetime.fromtimestamp(result['modified'], tz=timezone.utc)
                    details.append(f'modified: {modified.isoformat()}')
                suffix = f' ({", ".join(details)})' if details else ''
                out.line(f'{args.path}: {result.get("type")}{suffix}')
            out.result({'path': args.path, **result})
            return 0

        return out.fail(f'Unknown store subcommand: {subcommand}')

    return await run_cli_command(args, action)
