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
``diff`` — semantic diff of two ``.pipe`` pipeline files.

Raw JSON diffs of ``.pipe`` files are dominated by canvas coordinate churn
(the per-component ``ui`` block and the top-level ``viewport``); this command
hides that noise and surfaces what actually changed: nodes added/removed,
provider changes, config field changes, and edge (wiring) additions/removals.

Unlike every other RocketRide subcommand, ``diff`` is a purely local
operation. It reads files (or a git ref) and compares parsed JSON entirely on
the client; it never connects to the engine or the network. Consequently it
takes none of the ``--uri``/``--apikey`` connection arguments the other
commands share, and it does not route through the shared ``Output`` channel:
its ``--json`` is a format flag (a whole JSON document on stdout), not the
shared ``--json [FILE]`` result envelope. This is a deliberate and documented
difference.

Usage:
    rocketride diff <old.pipe> <new.pipe>
    rocketride diff --git <ref> <file.pipe>

Flags:
    --include-layout  Enumerate the layout churn (component ``ui`` blocks and the
                      top-level ``viewport``) that is ignored by default, as
                      ``ui.*`` and ``viewport.*`` field changes; with the flag a
                      layout-only edit therefore exits 1. Version changes are
                      always reported regardless of this flag.
    --json            Emit a single JSON document to stdout.
    --markdown        Emit compact, PR-comment-friendly Markdown to stdout.
    --exit-zero       Force exit code 0 on success, even when changes are present
                      (useful for non-gating, informational runs).

Exit codes:
    0  No semantic changes (or --exit-zero on any successful run).
    1  Semantic changes were found.
    2  Usage error, or an unreadable/unparseable file / bad git ref.
"""

import json
import os
import sys
from typing import Any, Dict, List, Optional

# The pipediff engine is the semantic core of this command. These are the pinned
# public names from the rocketride.pipediff package.
from ...pipediff import (
    PipeDiffError,
    diff_pipes,
    load_pipe,
    resolve_git_ref,
)
from ...pipediff.reporters import render_human, render_json, render_markdown


# An empty pipeline used as the "old" side when --git names a ref in which the
# file does not yet exist: everything in the working-tree file is then reported
# as newly added.
_EMPTY_PIPE: Dict[str, Any] = {'components': []}


def _should_use_color(stream: Any = None) -> bool:
    """
    Decide whether ANSI color should be used for human-readable output.

    Color is suppressed when the ``NO_COLOR`` environment variable is present
    (per the informal https://no-color.org convention, regardless of its value)
    or when the target stream is not an interactive terminal.

    Args:
        stream: Stream that will receive the output (defaults to ``sys.stdout``).

    Returns:
        True when color escapes are appropriate, False otherwise.
    """
    if stream is None:
        stream = sys.stdout
    if 'NO_COLOR' in os.environ:
        return False
    isatty = getattr(stream, 'isatty', None)
    return bool(isatty()) if callable(isatty) else False


def _fail(message: str) -> int:
    """
    Report a usage/processing error on stderr and return exit code 2.

    Errors are always written to stderr so that ``--json`` and ``--markdown``
    output on stdout stays pure and machine-parseable.

    Args:
        message: Human-readable error description.

    Returns:
        The integer exit code ``2``.
    """
    print(f'Error: {message}', file=sys.stderr)
    return 2


def _resolve_inputs(args) -> tuple:
    """
    Validate arguments and load the (old, new) pipeline objects.

    Args:
        args: Parsed argparse namespace (paths, git).

    Returns:
        An ``(old, new)`` tuple of parsed pipeline dicts.

    Raises:
        PipeDiffError: Propagated from load_pipe / resolve_git_ref for
            unreadable, unparseable, or structurally invalid inputs, or for a
            bad git ref. The caller converts these into exit code 2.
        ValueError: For argument-usage problems (wrong number of paths for the
            selected mode). The caller converts these into exit code 2.
    """
    paths: List[str] = list(getattr(args, 'paths', None) or [])
    git_ref: Optional[str] = getattr(args, 'git', None)

    if git_ref:
        if len(paths) != 1:
            raise ValueError('--git requires exactly one FILE to compare against the ref')
        file_path = paths[0]
        new_obj = load_pipe(file_path)
        old_obj = resolve_git_ref(git_ref, file_path)
        if old_obj is None:
            # File absent in the ref: treat everything as newly added.
            old_obj = _EMPTY_PIPE
        return old_obj, new_obj

    if len(paths) != 2:
        raise ValueError('exactly two files are required: rocketride diff <old.pipe> <new.pipe>')

    old_obj = load_pipe(paths[0])
    new_obj = load_pipe(paths[1])
    return old_obj, new_obj


def _render(args, diff: Any) -> str:
    """
    Render the diff using the reporter selected by the command flags.

    ``--json`` takes precedence over ``--markdown`` when both are somehow set;
    argparse normally makes them mutually exclusive. With no format flag the
    colored human report is produced (color auto-detected from stdout).

    Args:
        args: Parsed argparse namespace (json, markdown).
        diff: The PipeDiff produced by the engine.

    Returns:
        The fully rendered report string for printing to stdout.
    """
    if getattr(args, 'json', False):
        return json.dumps(render_json(diff), indent=2, ensure_ascii=False, sort_keys=True)
    if getattr(args, 'markdown', False):
        return render_markdown(diff)
    return render_human(diff, use_color=_should_use_color(sys.stdout))


async def run_diff(args) -> int:
    """
    Execute the semantic pipe diff and return the appropriate exit code.

    This command is fully local: it opens no client, so it deliberately does
    NOT run through the shared ``run_cli_command`` runner — that runner maps
    any raised error to exit code 1, while this command's documented contract
    reserves 1 for "changes found" and reports every error as 2.

    Args:
        args: Parsed argparse namespace (paths, git, include_layout, json,
            markdown, exit_zero).

    Returns:
        Exit code per the command contract:
            - 0 when there are no semantic changes, or when ``--exit-zero``
              was passed and the run otherwise succeeded.
            - 1 when semantic changes were found.
            - 2 on a usage error or an unreadable/unparseable input.

    Process Flow:
        1. Validate arguments and load the old/new pipeline objects.
        2. Compute the semantic diff (respecting --include-layout).
        3. Render with the selected reporter and print to stdout.
        4. Map the diff outcome to an exit code (honoring --exit-zero).
    """
    include_layout = bool(getattr(args, 'include_layout', False))

    try:
        resolved = _resolve_inputs(args)
    except ValueError as exc:
        return _fail(str(exc))
    except PipeDiffError as exc:
        return _fail(str(exc))

    old_obj, new_obj = resolved

    try:
        diff = diff_pipes(old_obj, new_obj, include_layout=include_layout)
    except PipeDiffError as exc:
        return _fail(str(exc))

    # Report output goes to stdout only; nothing above this point wrote there.
    print(_render(args, diff))

    if getattr(args, 'exit_zero', False):
        return 0
    return 1 if diff.has_semantic_changes else 0
