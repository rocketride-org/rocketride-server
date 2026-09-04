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
RocketRide CLI Semantic Pipeline Diff Command Implementation.

This module provides the DiffCommand class for the ``rocketride diff`` command,
which produces a *semantic* diff of two ``.pipe`` pipeline files. Raw JSON diffs
of ``.pipe`` files are dominated by canvas coordinate churn (the per-component
``ui`` block and the top-level ``viewport``); this command hides that noise and
surfaces what actually changed: nodes added/removed, provider changes, config
field changes, and edge (wiring) additions/removals.

Unlike every other RocketRide subcommand, ``diff`` is a purely local operation.
It reads files (or a git ref) and compares parsed JSON entirely on the client;
it never connects to the engine or the network. Consequently it takes none of
the ``--uri``/``--apikey``/``--token`` connection arguments the other commands
share -- this is a deliberate and documented difference.

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

Components:
    DiffCommand: Main command implementation for semantic ``.pipe`` diffing
"""

import json
import os
import sys
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from .base import BaseCommand

# The pipediff engine is the semantic core of this command. These are the pinned
# public names from the rocketride.pipediff package (Implementer A's modules).
from ...pipediff import (
    PipeDiffError,
    diff_pipes,
    load_pipe,
    resolve_git_ref,
)
from ...pipediff.reporters import render_human, render_json, render_markdown

if TYPE_CHECKING:
    from ..main import RocketRideClient


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


class DiffCommand(BaseCommand):
    """
    Command implementation for the local, semantic ``.pipe`` diff.

    Load two pipeline files (or one working-tree file against a git ref), compute
    a semantic diff that ignores canvas layout noise, and render the result as
    colored text, JSON, or Markdown. This command performs no network I/O and
    requires no authentication.

    Example:
        ```python
        command = DiffCommand(cli, args)
        exit_code = await command.execute()
        ```

    Key Features:
        - Two-file and ``--git <ref>`` comparison modes
        - Layout-noise suppression with an opt-in ``--include-layout`` override
        - Human / JSON / Markdown reporters, selected by flag
        - Standardized exit codes (0 unchanged, 1 changed, 2 error)
        - Pure stdout for report output; all errors are written to stderr
    """

    def __init__(self, cli, args):
        """
        Initialize DiffCommand with CLI context and parsed arguments.

        Args:
            cli: CLI instance (used only for shared plumbing; no connection is
                established by this command).
            args: Parsed command line arguments (paths, --git, --include-layout,
                --json, --markdown, --exit-zero).
        """
        super().__init__(cli, args)

    def _fail(self, message: str) -> int:
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

    def _resolve_inputs(self) -> Optional[tuple]:
        """
        Validate arguments and load the (old, new) pipeline objects.

        Returns:
            A ``(old, new)`` tuple of parsed pipeline dicts on success, or
            ``None`` when validation or loading failed (an error has already been
            printed to stderr by the caller path via raised exceptions).

        Raises:
            PipeDiffError: Propagated from load_pipe / resolve_git_ref for
                unreadable, unparseable, or structurally invalid inputs, or for a
                bad git ref. The caller converts these into exit code 2.
            ValueError: For argument-usage problems (wrong number of paths for the
                selected mode). The caller converts these into exit code 2.
        """
        paths: List[str] = list(getattr(self.args, 'paths', None) or [])
        git_ref: Optional[str] = getattr(self.args, 'git', None)

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

    def _render(self, diff: Any) -> str:
        """
        Render the diff using the reporter selected by the command flags.

        ``--json`` takes precedence over ``--markdown`` when both are somehow set;
        argparse normally makes them mutually exclusive. With no format flag the
        colored human report is produced (color auto-detected from stdout).

        Args:
            diff: The PipeDiff produced by the engine.

        Returns:
            The fully rendered report string for printing to stdout.
        """
        if getattr(self.args, 'json', False):
            return json.dumps(render_json(diff), indent=2, ensure_ascii=False, sort_keys=True)
        if getattr(self.args, 'markdown', False):
            return render_markdown(diff)
        return render_human(diff, use_color=_should_use_color(sys.stdout))

    async def execute(self, client: 'RocketRideClient' = None) -> int:
        """
        Execute the semantic pipe diff and return the appropriate exit code.

        This command is fully local: the ``client`` argument is accepted only to
        match the common command interface and is never used.

        Args:
            client: Unused. Present for signature compatibility with other
                commands dispatched by the CLI.

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
        include_layout = bool(getattr(self.args, 'include_layout', False))

        try:
            resolved = self._resolve_inputs()
        except ValueError as exc:
            return self._fail(str(exc))
        except PipeDiffError as exc:
            return self._fail(str(exc))

        old_obj, new_obj = resolved

        try:
            diff = diff_pipes(old_obj, new_obj, include_layout=include_layout)
        except PipeDiffError as exc:
            return self._fail(str(exc))

        # Report output goes to stdout only; nothing above this point wrote there.
        print(self._render(diff))

        if getattr(self.args, 'exit_zero', False):
            return 0
        return 1 if diff.has_semantic_changes else 0
