# MIT License
#
# Copyright (c) 2026 Aparavi Software AG Corporation
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
RocketRide CLI Store Command Implementation.

File system-style commands for managing the account file store.

Commands:
    rocketride store dir [path]                          - list directory
    rocketride store type <path>                         - display file contents
    rocketride store write <path> --file/--content       - write file
    rocketride store rm <path>                           - delete file
    rocketride store mkdir <path>                        - create directory
    rocketride store stat <path>                         - file/dir metadata
"""

from typing import TYPE_CHECKING
from .base import BaseCommand

if TYPE_CHECKING:
    from ..main import RocketRideClient


class StoreCommand(BaseCommand):
    """Command implementation for file store operations."""

    def __init__(self, cli, args):
        """Initialize StoreCommand."""
        super().__init__(cli, args)

        self._subcommand_handlers = {
            'dir': self._cmd_dir,
            'type': self._cmd_type,
            'write': self._cmd_write,
            'rm': self._cmd_rm,
            'mkdir': self._cmd_mkdir,
            'stat': self._cmd_stat,
        }

    async def execute(self, client: 'RocketRideClient') -> int:
        """Execute the store command based on subcommand."""
        try:
            if not self.cli.client.is_connected():
                await self.cli.connect()

            if handler := self._subcommand_handlers.get(self.args.store_subcommand):
                return await handler(client)
            else:
                raise ValueError(f'Unknown store subcommand: {self.args.store_subcommand}')

        except Exception as e:  # noqa: BLE001
            print(f'Error: {e}')
            return 1

    async def _cmd_dir(self, client: 'RocketRideClient') -> int:
        """List directory contents."""
        path = getattr(self.args, 'path', '') or ''
        result = await client.fs_list_dir(path)

        entries = result.get('entries', [])
        if not entries:
            print('(empty directory)')
            return 0
        for entry in entries:
            type_indicator = 'DIR ' if entry['type'] == 'dir' else 'FILE'
            print(f'  {type_indicator}  {entry["name"]}')
        print(f'\n  {result["count"]} item(s)')

        return 0

    async def _cmd_type(self, client: 'RocketRideClient') -> int:
        """Display file contents."""
        path = self.args.path
        text = await client.fs_read_string(path)
        print(text, end='')
        return 0

    async def _cmd_write(self, client: 'RocketRideClient') -> int:
        """Write file from local file or inline content."""
        path = self.args.path
        file_path = getattr(self.args, 'file', None)
        content = getattr(self.args, 'content', None)

        if file_path:
            with open(file_path, 'rb') as f:
                data = f.read()
            await client.fs_write(path, data)
        elif content is not None:
            await client.fs_write_string(path, content)
        else:
            raise ValueError('Either --file or --content is required')

        print(f'Written: {path}')
        return 0

    async def _cmd_rm(self, client: 'RocketRideClient') -> int:
        """Delete a file."""
        await client.fs_delete(self.args.path)
        print(f'Deleted: {self.args.path}')
        return 0

    async def _cmd_mkdir(self, client: 'RocketRideClient') -> int:
        """Create a directory."""
        await client.fs_mkdir(self.args.path)
        print(f'Created: {self.args.path}/')
        return 0

    async def _cmd_stat(self, client: 'RocketRideClient') -> int:
        """Get file/directory metadata."""
        path = self.args.path
        result = await client.fs_stat(path)

        if not result.get('exists'):
            print(f'{path}: not found')
        else:
            entry_type = result.get('type', 'unknown')
            modified = result.get('modified')
            if modified:
                from datetime import datetime, timezone

                ts = datetime.fromtimestamp(modified, tz=timezone.utc).isoformat()
                print(f'{path}: {entry_type} (modified: {ts})')
            else:
                print(f'{path}: {entry_type}')
        return 0
