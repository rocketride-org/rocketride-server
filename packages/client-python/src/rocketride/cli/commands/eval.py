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
RocketRide CLI Golden-Dataset Eval Command Implementation.

This module provides the EvalCommand class for running golden-dataset
evaluations (``<name>.eval.json`` spec files) against RocketRide pipelines.
Use this command to gate pipeline changes in CI or to check output quality
interactively: each spec starts its pipeline on the engine, sends every case
input through chat, evaluates the declared assertions (including LLM-as-judge
assertions that run a judge ``.pipe`` on the same engine), and always tears
the pipeline down again.

The eval command expands shell-style glob patterns in-CLI (so behavior is
identical on shells that do not expand globs, e.g. Windows), validates every
spec before connecting, and reports per-case results in human-readable, JSON,
or JUnit XML format.

Key Features:
    - Run one or more eval specs in a single invocation
    - In-CLI glob expansion for cross-platform wildcard support
    - Case filtering via --case and early exit via --fail-fast
    - Machine-readable output via --json, JUnit XML via --junit for CI

Exit Codes:
    0: All cases passed
    1: At least one case failed (or errored)
    2: Usage error, spec parse/validation error, connection failure, or no
       case produced a result (e.g. a --case filter that matches nothing)

Usage:
    rocketride eval my_pipeline.eval.json --apikey <key>
    rocketride eval evals/*.eval.json --case greeting --fail-fast
    rocketride eval evals/*.eval.json --json
    rocketride eval evals/*.eval.json --junit reports/evals.xml

Components:
    EvalCommand: Main command implementation for golden-dataset evaluation
"""

import glob
import json
import os
import sys
from typing import TYPE_CHECKING

from ...evals.judge import make_judge
from ...evals.reporters import EvalReport, render_human, render_json, render_junit
from ...evals.runner import run_spec
from ...evals.spec import EvalSpec, EvalSpecError, load_spec
from .base import BaseCommand

if TYPE_CHECKING:
    from ..main import RocketRideClient


class EvalCommand(BaseCommand):
    """
    Command implementation for running golden-dataset eval specs.

    Expands file arguments (including glob patterns), loads and validates
    every eval spec up front, then runs each spec's cases sequentially
    against the engine and reports per-case results in human-readable,
    JSON, or JUnit XML format, with exit codes suitable for CI usage.

    Example:
        ```python
        # Initialize and execute eval command
        command = EvalCommand(cli, args)
        exit_code = await command.execute(client)
        ```

    Key Features:
        - Multi-spec evaluation with in-CLI glob expansion
        - Fail-fast and case-name filtering for tight iteration loops
        - Human-readable, JSON, and JUnit XML output formats
        - Exit codes: 0 all passed, 1 any failed, 2 nothing processable
    """

    def __init__(self, cli, args):
        """
        Initialize EvalCommand with CLI context and parsed arguments.

        Args:
            cli: CLI instance providing cancellation state and event handling
            args: Parsed command line arguments containing files and options
        """
        super().__init__(cli, args)

    def _expand_files(self, patterns: list[str]) -> list[str]:
        """
        Expand file arguments into a deduplicated, ordered list of paths.

        Literal paths are kept as-is; anything else is treated as a glob
        pattern (expanded in-CLI so wildcards work on shells that do not
        expand them). Patterns that match nothing are kept verbatim so they
        can be reported as unreadable spec files.

        Args:
            patterns: File paths and/or glob patterns from the command line

        Returns:
            list[str]: Expanded file paths, deduplicated, preserving order
        """
        expanded: list[str] = []
        for pattern in patterns:
            if os.path.isfile(pattern):
                expanded.append(pattern)
                continue

            # Not a literal file - try shell-style glob expansion
            matches = sorted(path for path in glob.glob(pattern, recursive=True) if os.path.isfile(path))
            if matches:
                expanded.extend(matches)
            else:
                # Keep the unmatched pattern so it is reported as a missing file
                expanded.append(pattern)

        # Remove duplicates while preserving order
        seen = set()
        unique_files = []
        for file_path in expanded:
            if file_path not in seen:
                seen.add(file_path)
                unique_files.append(file_path)
        return unique_files

    async def execute(self, client: 'RocketRideClient') -> int:
        """
        Execute the golden-dataset eval command.

        Expands file arguments, loads and validates every spec before any
        server contact, connects, runs each spec's cases sequentially, and
        reports the results in the requested format.

        Args:
            client: RocketRideClient instance for server communication

        Returns:
            Exit code: 0 if all cases passed, 1 if at least one case failed
            or a pipeline could not be started, 2 on usage error, spec
            parse/validation error, connection failure, or when no case
            produced a result at all

        Process Flow:
            1. Expand glob patterns and literal paths into a spec file list
            2. Load and validate every spec (any invalid spec exits 2)
            3. Connect to the server
            4. Run each spec: start pipeline, chat each case, evaluate
               assertions, always tear the pipeline down
            5. Report results (human, --json, and/or --junit)
            6. Compute the exit code from the aggregate results
        """
        # Save the client for SDK calls
        self.client = client

        # Expand globs and literal paths into the working spec file list
        files = self._expand_files(self.args.files)

        # Load and validate every spec up front: a broken eval definition is
        # a usage error, so nothing runs (mirroring how a bad flag behaves)
        specs: list[EvalSpec] = []
        for file_path in files:
            try:
                specs.append(load_spec(file_path))
            except EvalSpecError as err:
                print(f'Error: {err}', file=sys.stderr)
                return 2

        # Connect once for all specs
        try:
            if not self.cli.client.is_connected():
                await self.cli.connect()
        except Exception as err:
            print(f'Error: Unable to connect to server: {err}', file=sys.stderr)
            return 2

        # Run each spec sequentially, isolating spec-level failures (e.g. a
        # pipeline that fails to start) so remaining specs still run
        reports: list[EvalReport] = []
        had_spec_error = False
        for spec in specs:
            try:
                report = await run_spec(
                    self.client,
                    spec,
                    case_filter=self.args.case,
                    fail_fast=self.args.fail_fast,
                    judge_factory=make_judge,
                )
            except Exception as err:
                had_spec_error = True
                print(f'Error: {spec.path}: {err}', file=sys.stderr)
                if self.args.fail_fast:
                    break
                continue

            reports.append(report)
            if self.args.fail_fast and not report.all_passed:
                break

        # Emit results in the requested format; --json owns stdout entirely
        if self.args.json:
            print(json.dumps(render_json(reports), indent=2))
        else:
            print(render_human(reports, use_color=sys.stdout.isatty()))

        # --junit writes the XML report in addition to the output above
        if self.args.junit:
            try:
                junit_dir = os.path.dirname(self.args.junit)
                if junit_dir:
                    os.makedirs(junit_dir, exist_ok=True)
                with open(self.args.junit, 'w', encoding='utf-8') as handle:
                    handle.write(render_junit(reports))
            except OSError as err:
                print(f'Error: Cannot write JUnit report to {self.args.junit}: {err}', file=sys.stderr)
                return 2

        # Exit 2 if no case produced a result at all (every spec errored, or
        # the --case filter matched nothing)
        total_results = sum(len(report.case_results) for report in reports)
        if total_results == 0:
            return 2

        # Exit 1 if any case failed or any spec could not run to completion
        failed = sum(report.failed_count for report in reports)
        if failed > 0 or had_spec_error:
            return 1
        return 0
