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
``eval`` — run golden-dataset eval specs against their pipelines.

Runs golden-dataset evaluations (``<name>.eval.json`` spec files) against
RocketRide pipelines. Use this command to gate pipeline changes in CI or to
check output quality interactively: each spec starts its pipeline on the
engine, sends every case input through chat, evaluates the declared
assertions (including LLM-as-judge assertions that run a judge ``.pipe`` on
the same engine), and always tears the pipeline down again.

The eval command expands shell-style glob patterns in-CLI (so behavior is
identical on shells that do not expand globs, e.g. Windows), validates every
spec before connecting, and reports per-case results in human-readable, JSON,
or JUnit XML format.

Its ``--json [FILE]`` is the shared result option every other subcommand
takes, routed through the shared ``Output`` channel: bare ``--json`` owns
stdout (the human report is suppressed so stdout carries exactly one JSON
document), and ``--json FILE`` writes that document to FILE while the human
report keeps flowing on stdout. The two paths that exit 2 before any case
runs — an unparsable spec, and a server the CLI cannot reach — record the
shared ``{"error": {"message", "hint"}}`` envelope in place of the report,
so the destination is always rewritten and an earlier run's green summary
is never left behind to be read as this run's result. The command does not
route through ``run_cli_command``, though: that runner maps any raised
error to exit code 1, while this command's documented contract reserves 1
for "a case failed" and reports usage, spec and connection errors as 2.
Client cleanup and the ``Output`` flush are therefore done here explicitly.

Key Features:
    - Run one or more eval specs in a single invocation
    - In-CLI glob expansion for cross-platform wildcard support
    - Case filtering via --case and early exit via --fail-fast
    - Machine-readable output via --json [FILE], JUnit XML via --junit for CI
    - A spec that cannot be run at all is reported in every output format,
      so a CI artifact never shows a green run for a failed one

Exit Codes:
    0: All cases passed
    1: At least one case failed (or errored), or a spec could not run to
       completion
    2: Usage error, spec parse/validation error, connection failure, or no
       case produced a result (e.g. a --case filter that matches nothing)

Usage:
    rocketride eval my_pipeline.eval.json --apikey <key>
    rocketride eval evals/*.eval.json --case greeting --fail-fast
    rocketride eval evals/*.eval.json --json
    rocketride eval evals/*.eval.json --json reports/evals.json
    rocketride eval evals/*.eval.json --junit reports/evals.xml
"""

import os
import sys

from ...evals.judge import make_judge
from ...evals.reporters import EvalReport, SpecError, render_human, render_json, render_junit
from ...evals.runner import run_spec
from ...evals.spec import EvalSpec, EvalSpecError, load_spec
from ..utils.common import connect_client, disconnect_all, hint_for
from ..utils.file_utils import expand_file_patterns
from ..utils.output import Output


async def run_eval(args) -> int:
    """
    Execute the golden-dataset eval command.

    Expands file arguments, loads and validates every spec before any
    server contact, connects, runs each spec's cases sequentially, and
    reports the results in the requested format.

    Args:
        args: Parsed argparse namespace (files, case, fail_fast, json,
            junit, uri, apikey), where ``json`` is the shared option's
            value: None (human), '-' (JSON on stdout), or a file path

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
        5. Report results (human, --json [FILE], and/or --junit)
        6. Compute the exit code from the aggregate results
    """
    # The shared result channel: None -> human, '-' -> JSON on stdout,
    # <path> -> JSON written to that file (human report still on stdout).
    # Opened before anything can fail so that EVERY exit path leaves a
    # document behind — the exit-2 paths below record the shared error
    # envelope, which is what overwrites a stale report from a previous run.
    out = Output(args.json)
    try:
        # Expand globs and literal paths into the working spec file list
        files = expand_file_patterns(args.files)

        # Load and validate every spec up front: a broken eval definition is
        # a usage error, so nothing runs (mirroring how a bad flag behaves).
        specs: list[EvalSpec] = []
        for file_path in files:
            try:
                specs.append(load_spec(file_path))
            except EvalSpecError as err:
                # No hint: the message already names the file and the field
                # to fix, and the other commands pass none for a parse or
                # validation error either.
                out.fail(str(err))
                return 2

        # Connect once for all specs. A connection failure is exit code 2 by
        # contract, so it is handled here rather than by a generic catch-all.
        try:
            client = await connect_client(args.uri, args.apikey)
        except Exception as err:  # noqa: BLE001
            out.fail(f'Unable to connect to server: {err}', hint_for(err, args.uri))
            return 2

        # Run each spec sequentially, isolating spec-level failures (e.g. a
        # pipeline that fails to start) so remaining specs still run. A spec
        # that raises produces no report, so it is recorded separately and
        # carried into every output format: a machine report that omitted it
        # would show a green run for a run that failed.
        reports: list[EvalReport] = []
        spec_errors: list[SpecError] = []
        for spec in specs:
            try:
                report = await run_spec(
                    client,
                    spec,
                    case_filter=args.case,
                    fail_fast=args.fail_fast,
                    judge_factory=make_judge,
                )
            except Exception as err:  # noqa: BLE001
                spec_error = SpecError.from_exception(spec.path, err)
                spec_errors.append(spec_error)
                print(f'Error: {spec_error.spec_path}: {spec_error.message}', file=sys.stderr)
                if args.fail_fast:
                    break
                continue

            reports.append(report)
            if args.fail_fast and not report.all_passed:
                break

        # Emit results in the requested format. The JSON document is always
        # recorded; Output decides where it lands (nowhere in human mode,
        # stdout under bare --json, the file under --json FILE) and
        # suppresses the human report only when it owns stdout.
        out.result(render_json(reports, spec_errors))
        out.line(render_human(reports, use_color=sys.stdout.isatty(), spec_errors=spec_errors))

        # --junit writes the XML report in addition to the output above
        if args.junit:
            try:
                junit_dir = os.path.dirname(args.junit)
                if junit_dir:
                    os.makedirs(junit_dir, exist_ok=True)
                with open(args.junit, 'w', encoding='utf-8') as handle:
                    handle.write(render_junit(reports, spec_errors))
            except OSError as err:
                print(f'Error: Cannot write JUnit report to {args.junit}: {err}', file=sys.stderr)
                return 2

        # Exit 2 if no case produced a result at all (every spec errored, or
        # the --case filter matched nothing). The reports written above still
        # carry the spec errors that got us here.
        total_results = sum(len(report.case_results) for report in reports)
        if total_results == 0:
            return 2

        # Exit 1 if any case failed or any spec could not run to completion
        failed = sum(report.failed_count for report in reports)
        if failed > 0 or spec_errors:
            return 1
        return 0
    finally:
        # This command owns its client and its Output (it does not go through
        # the shared runner), so both are closed out here on every path — in
        # the order run_cli_command uses: disconnect, then flush.
        await disconnect_all()
        out.finish()
