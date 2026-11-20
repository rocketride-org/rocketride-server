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
import stat
import tempfile
from typing import List, Optional

from ..node_convert import convert_definition, load_json
from ..utils.common import run_cli_command
from ..utils.output import Output


def _same_file(a: str, b: str) -> bool:
    """Whether two paths name one file: the same normalized path, or the same file on disk."""
    if os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b)):
        return True
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def _report_overwrites(args) -> Optional[str]:
    """The input or output file a ``--json <file>`` report would replace, or None."""
    report = getattr(args, 'json', None)
    if report in (None, '-'):
        return None
    targets: List[str] = list(args.files) + ([args.out] if args.out else [])
    return next((target for target in targets if _same_file(report, target)), None)


#: The mode of a new definition, before the umask: what an editor would create.
NEW_FILE_MODE = 0o644


def _final_mode(target: str) -> int:
    """
    The permission bits the written definition must end with.

    An existing destination keeps its own bits (an owner-only definition stays
    owner-only, a shared one stays shared); a new one gets ``NEW_FILE_MODE``
    under the process umask.
    """
    try:
        return stat.S_IMODE(os.stat(target).st_mode)
    except FileNotFoundError:
        mask = os.umask(0)
        os.umask(mask)
        return NEW_FILE_MODE & ~mask


def _write_atomic(target: str, text: str) -> None:
    """
    Replace ``target`` with ``text`` only once the new content is complete.

    The text goes to a temporary file in the target's directory first, then
    replaces the target in one rename, so a failed write (a full disk) leaves
    the original definition intact. The temporary file is removed on failure.
    ``mkstemp`` creates it owner-only, so nobody else reads it while it is
    written; before the rename it takes the destination's mode bits (POSIX
    only: Windows has no such bits to carry).
    """
    directory = os.path.dirname(os.path.abspath(target))
    os.makedirs(directory, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f'.{os.path.basename(target)}.', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(handle, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(text)
        if os.name == 'posix':
            os.chmod(temporary, _final_mode(target))
        os.replace(temporary, target)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


async def run_node(args) -> int:
    """
    Execute one ``node`` subcommand.

    Args:
        args: Parsed argparse namespace (node_subcommand + verb args).

    Returns:
        Exit code: 0 when every file converted, 1 otherwise.
    """
    # Checked before the output channel exists: a refused --json file must not
    # receive even the error envelope, since it names a definition
    overwritten = _report_overwrites(args)
    if overwritten is not None:
        return Output(None).fail(
            f'--json {args.json} would replace {overwritten}', 'write the report to another file, or use bare --json'
        )

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

            # Step 2: write (in place unless --out), or print under --dry-run; a
            # destination that cannot be written fails this file, not the batch
            target = args.out or path
            if args.dry_run:
                out.line(conversion.text().rstrip('\n'))
            else:
                try:
                    _write_atomic(target, conversion.text())
                except OSError as err:
                    failed += 1
                    out.warn(f'{path}: cannot write {target}: {err}')
                    results.append({'file': path, 'out': target, 'error': f'cannot write {target}: {err}'})
                    continue
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
