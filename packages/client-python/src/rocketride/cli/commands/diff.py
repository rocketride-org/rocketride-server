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
from ...pipediff.reporters import _term_safe, render_human, render_json, render_markdown


# An empty pipeline used as the "old" side when --git names a ref in which the
# file does not yet exist: everything in the working-tree file is then reported
# as newly added.
_EMPTY_PIPE: Dict[str, Any] = {'components': []}

_TOO_DEEP = 'Pipeline nesting is too deep to load, compare, or render; reduce nested values'


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

    The message is escaped the way the human report is. It can carry text taken
    from the inputs - a component id, a path, a ref, a name git echoes back - and
    the pipe-diff Action pastes this stream into a pull-request comment, so a
    crafted ``.pipe`` must not be able to print control, bidi, invisible or
    line-separator characters there (a forged ``Error:`` line, a recoloured or
    reordered block). They print as ``\\x1b`` / ``\\u202e`` escapes; ordinary text
    is unchanged.

    Args:
        message: Human-readable error description.

    Returns:
        The integer exit code ``2``.
    """
    print(f'Error: {_term_safe(message)}', file=sys.stderr)
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

    # ``is not None``, not truthiness: an empty ``--git ""`` must not be read as
    # "no --git" and silently fall back to file mode.
    if git_ref is not None:
        if not git_ref.strip():
            raise ValueError('--git requires a non-empty REF')
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


def _stream_can_print(text: str, stream: Any) -> bool:
    """
    Report whether ``stream`` can carry ``text`` exactly.

    ``main()`` opens the standard streams with ``errors='replace'`` so no output
    can crash a command; a character the stream cannot encode (a lone surrogate,
    or a letter on an ASCII console) therefore prints as ``?``.
    """
    try:
        text.encode(getattr(stream, 'encoding', None) or 'utf-8')
    except (UnicodeEncodeError, LookupError):
        return False
    return True


def _show_unprintable(text: str, stream: Any) -> str:
    """
    Return ``text`` with every character ``stream`` cannot encode written as an escape.

    The default would be ``errors='replace'``, which prints each such character as
    ``?``: ``日本 -> 中国`` on a cp1252 console reads ``?? -> ??``, a change that looks
    like none. Escapes (``\\u65e5``) keep the two values visibly different.
    """
    encoding = getattr(stream, 'encoding', None) or 'utf-8'
    try:
        return text.encode(encoding, errors='backslashreplace').decode(encoding)
    except (LookupError, UnicodeError):
        return text


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
        # Build the document outside the handler: only the serializer's
        # non-finite-number failure is an input problem; a ValueError from the
        # reporter itself is a bug and must keep its traceback.
        document = render_json(diff)
        try:
            text = json.dumps(document, indent=2, ensure_ascii=False, sort_keys=True, allow_nan=False)
            # Two values that differ only in characters stdout cannot carry (the
            # lone surrogates "\ud800" and "\udc00" are both valid in a .pipe)
            # would both print as "?": escape them instead, which is still JSON.
            if not _stream_can_print(text, sys.stdout):
                text = json.dumps(document, indent=2, ensure_ascii=True, sort_keys=True, allow_nan=False)
            return text
        except ValueError as exc:  # a non-finite number; JSON has no spelling for it
            raise PipeDiffError(f'The report contains a value JSON cannot represent: {exc}') from exc
    if getattr(args, 'markdown', False):
        return _show_unprintable(render_markdown(diff), sys.stdout)
    return _show_unprintable(render_human(diff, use_color=_should_use_color(sys.stdout)), sys.stdout)


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

    # ValueError is a usage error only while reading arguments and inputs; from
    # the comparison or a reporter it would be a bug, so it is not caught there
    # and keeps its traceback instead of passing for bad input.
    try:
        old_obj, new_obj = _resolve_inputs(args)
    except (PipeDiffError, ValueError) as exc:
        return _fail(str(exc))
    except RecursionError:
        return _fail(_TOO_DEEP)
    try:
        diff = diff_pipes(old_obj, new_obj, include_layout=include_layout)
        # Build the complete report before writing stdout: loading, comparison
        # and rendering can each exceed Python's recursion limit for deep JSON.
        report = _render(args, diff)
    except PipeDiffError as exc:
        return _fail(str(exc))
    except RecursionError:
        return _fail(_TOO_DEEP)
    code = 0 if getattr(args, 'exit_zero', False) else (1 if diff.has_semantic_changes else 0)

    # Report output goes to stdout only; nothing above this point wrote there.
    print(report)
    return code
