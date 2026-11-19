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
Pipeline workspace commands: ``pipe new``.

``pipe new`` is a WORKSPACE operation: it needs no connection and writes
``pipelines/<id>/<id>.pipe`` with its store block, icon, README and
``assets/`` through the SDK's one pipeline scaffold. Deploying the result
is ``rocketride deploy add pipelines/<id>/<id>.pipe``. Kept in exact parity
with the TypeScript CLI's ``src/cli/commands/pipe.ts``.
"""

import os

from ..utils.common import run_cli_command
from ..utils.output import Output


async def run_pipe(args) -> int:
    """
    Execute one ``pipe`` subcommand.

    Args:
        args: Parsed argparse namespace (pipe_subcommand + verb args).

    Returns:
        Exit code.
    """

    async def action(out: Output) -> int:
        subcommand = args.pipe_subcommand

        # pipe new: scaffold a new pipeline — no server connection at all
        if subcommand == 'new':
            from ..._pipe_bundle import scaffold_pipe

            created = scaffold_pipe(
                args.workspace or os.getcwd(),
                args.id,
                name=args.name,
                dir=args.dir or 'pipelines',
            )
            for file in created['files']:
                out.line(f'  + {file}')
            out.line(f'Created {args.id} at {created["folder"]}')
            out.line(
                f'Edit {created["pipePath"]} (the store block lists it), then deploy with: '
                f'rocketride deploy add {created["pipePath"]}'
            )
            out.result(
                {
                    'pipeId': args.id,
                    'folder': created['folder'],
                    'pipePath': created['pipePath'],
                    'files': created['files'],
                }
            )
            return 0

        return out.fail(f'Unknown pipe subcommand: {subcommand}')

    return await run_cli_command(args, action)
