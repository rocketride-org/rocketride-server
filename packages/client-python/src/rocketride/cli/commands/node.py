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
Custom node commands: ``node convert``.

``node convert`` rewrites an old-format ``services*.json`` (``preconfig``,
``fields``, ``shape``) into the current format and adds the node's ``legacy``
block (breaking change B6). It is a WORKSPACE operation: no connection, no
configuration. The rules live in ``cli/node_convert.py``. Kept in exact parity
with the TypeScript CLI's ``src/cli/commands/node.ts``.
"""

import os

from ..node_convert import convert_definition, load_json
from ..utils.common import run_cli_command
from ..utils.output import Output


async def run_node(args) -> int:
    """
    Execute one ``node`` subcommand.

    Args:
        args: Parsed argparse namespace (node_subcommand + verb args).

    Returns:
        Exit code: 0 when every file converted, 1 otherwise.
    """

    async def action(out: Output) -> int:
        subcommand = args.node_subcommand
        if subcommand != 'convert':
            return out.fail(f'Unknown node subcommand: {subcommand}')

        # --out names ONE destination, so it takes one file
        if args.out and len(args.files) != 1:
            return out.fail('--out takes exactly one input file', 'convert the files one at a time')

        results = []
        failed = 0
        for path in args.files:
            # Step 1: read and convert; a file that is not old-format is reported, not rewritten
            try:
                with open(path, encoding='utf-8') as handle:
                    old = load_json(handle.read())
                conversion = convert_definition(old)
            except (OSError, ValueError) as err:
                failed += 1
                out.warn(f'{path}: {err}')
                results.append({'file': path, 'error': str(err)})
                continue

            # Step 2: write (in place unless --out), or print under --dry-run
            target = args.out or path
            if args.dry_run:
                out.line(conversion.text().rstrip('\n'))
            else:
                parent = os.path.dirname(os.path.abspath(target))
                os.makedirs(parent, exist_ok=True)
                with open(target, 'w', encoding='utf-8', newline='\n') as handle:
                    handle.write(conversion.text())
                out.line(f'Converted {path} -> {target}' + (' (legacy block added)' if conversion.legacy else ''))
            for warning in conversion.warnings:
                out.warn(f'{path}: {warning}')
            entry = {
                'file': path,
                'out': None if args.dry_run else target,
                'legacy': conversion.legacy,
                'warnings': conversion.warnings,
            }
            # A dry run writes nothing, so the result carries the definition itself
            if args.dry_run:
                entry['definition'] = conversion.definition
            results.append(entry)

        # Each failure was named on stderr; the JSON result keeps every file's outcome
        out.result({'files': results})
        if failed:
            out.line(f'{failed} of {len(args.files)} file(s) did not convert')
            return 1
        return 0

    return await run_cli_command(args, action)
