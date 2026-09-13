"""Managed ``rocketride evals`` commands, separate from offline ``eval``."""

import json
import os
import re
from typing import Any

from ...evals import EvalsApi, EvalsError, _positive, _redact, gate_exit_code
from ..utils.output import Output


def register_evals_commands(subparsers, add_connection_args) -> None:
    group = subparsers.add_parser('evals', help='Managed evaluations, revisions, durable runs and reviews')
    commands = group.add_subparsers(dest='evals_subcommand', required=True)

    def command(name, help_text):
        parser = commands.add_parser(name, help=help_text)
        add_connection_args(parser)
        parser.add_argument('--timeout', type=float, default=30, help='HTTP request timeout in seconds (default: 30)')
        return parser

    command('capabilities', 'Show available environments, scorers and authoring assistant')
    command('list', 'List managed evaluations').add_argument('--project-id')
    command('show', 'Show an evaluation and its revision history').add_argument('id')
    for verb in ('save', 'create'):
        parser = command(
            verb,
            'Save a JSON evaluation spec; creates unless --id is supplied'
            if verb == 'save'
            else 'Create an evaluation from a JSON spec',
        )
        parser.add_argument('spec', help='Strict JSON evaluation spec file')
        if verb == 'save':
            parser.add_argument('--id')
            parser.add_argument('--expected-revision', type=int)
    parser = command('revision', 'Create a revision with a stale-write guard')
    parser.add_argument('id')
    parser.add_argument('spec')
    parser.add_argument('--expected-revision', type=int, required=True)
    command('runs', 'List durable runs').add_argument('--evaluation-id')
    for verb in ('run', 'status'):
        parser = command(verb, 'Start a durable run' if verb == 'run' else 'Read a durable run')
        parser.add_argument('id', help='Evaluation ID' if verb == 'run' else 'Run ID')
        parser.add_argument('--wait', action='store_true', help='Wait for a terminal run and return its gate exit code')
        parser.add_argument(
            '--wait-timeout', type=float, default=300, help='Total wait budget in seconds (default: 300)'
        )
        parser.add_argument('--poll-interval', type=float, default=1, help='Polling interval in seconds (default: 1)')
        parser.add_argument('--gate', action='store_true', help='Return 0 pass, 1 fail, 2 incomplete/error')
        if verb == 'run':
            parser.add_argument('--revision', type=int, required=True)
            parser.add_argument(
                '--idempotency-key', required=True, help='Stable key to reuse if this exact run request is resumed'
            )
            parser.add_argument('--baseline-run-id')
    command('cancel', 'Request cancellation of a durable run').add_argument('id')
    parser = command('baseline', 'Select a completed run as the evaluation baseline')
    parser.add_argument('id', help='Evaluation ID')
    parser.add_argument('run_id')
    parser = command('report', 'Download the complete versioned report')
    parser.add_argument('id', help='Run ID')
    parser.add_argument('--format', choices=('json', 'junit'), default='json')
    parser.add_argument('--output', help='New output file; existing files and symlinks are refused')
    command('compare', 'Show the recorded server baseline comparison and return its gate').add_argument(
        'id', help='Candidate run ID'
    )
    parser = command('assist', 'Propose a spec using the configured assistant; does not save or run')
    parser.add_argument('spec', help='JSON evaluation spec file')
    parser.add_argument('--instruction', required=True)
    parser = command('review', 'Review human scorer evidence with a report revision guard')
    parser.add_argument('id', help='Run ID')
    parser.add_argument('--case-id', required=True)
    parser.add_argument('--case-result-id', help='Exact run.cases[].id; required when the case has repeated trials')
    parser.add_argument('--scorer-id', required=True)
    parser.add_argument('--status', choices=('pass', 'fail', 'abstain'), required=True)
    parser.add_argument('--reason', required=True)
    parser.add_argument('--expected-report-revision', type=int, required=True)


def _read_spec(path: str) -> dict:
    def reject_constant(_value):
        raise ValueError('Non-finite JSON value')

    try:
        with open(path, encoding='utf-8') as stream:
            spec = json.load(stream, parse_constant=reject_constant)
        if not isinstance(spec, dict):
            raise ValueError
        json.dumps(spec, allow_nan=False)
        return spec
    except (OSError, ValueError):
        raise ValueError('Cannot read spec: expected a readable strict JSON object file') from None


def _write_new(path: str, content: str) -> None:
    try:
        with _open_new_output(path) as stream:
            stream.write(content)
    except OSError:
        raise ValueError(
            'Cannot write output: use a new file in an existing writable directory (existing files and symlinks are refused)'
        ) from None


def _open_new_output(path: str):
    """Reserve the output atomically before any remote mutation."""
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            return os.fdopen(descriptor, 'w', encoding='utf-8', newline='')
        except BaseException:
            os.close(descriptor)
            raise
    except OSError:
        raise ValueError(
            'Cannot write output: use a new file in an existing writable directory (existing files and symlinks are refused)'
        ) from None


def _safe_output(value: Any, credential: str) -> Any:
    if isinstance(value, str):
        return _redact(value, credential)
    if isinstance(value, list):
        return [_safe_output(item, credential) for item in value]
    if isinstance(value, dict):
        secret_keys = {
            'apikey',
            'authorization',
            'password',
            'secret',
            'clientsecret',
            'credential',
            'auth',
            'token',
            'accesstoken',
            'refreshtoken',
            'privatekey',
        }
        return {
            key: '[REDACTED]'
            if re.sub(r'[^a-z0-9]', '', key.lower()) in secret_keys
            else _safe_output(item, credential)
            for key, item in value.items()
        }
    return value


async def _execute(args, api: EvalsApi) -> tuple[Any, int]:
    verb = args.evals_subcommand
    if verb == 'capabilities':
        return await api.capabilities(), 0
    if verb == 'list':
        return await api.list(project_id=args.project_id), 0
    if verb == 'show':
        return await api.get(args.id), 0
    if verb in ('save', 'create', 'revision'):
        evaluation_id = getattr(args, 'id', None)
        guard = getattr(args, 'expected_revision', None)
        if evaluation_id and guard is None:
            raise ValueError('--expected-revision is required when saving an existing evaluation')
        if guard is not None and not evaluation_id:
            raise ValueError('--expected-revision requires --id')
        spec = _read_spec(args.spec)
        return (
            await api.revise(evaluation_id, spec, expected_revision=guard) if evaluation_id else await api.create(spec)
        ), 0
    if verb == 'runs':
        return await api.runs(evaluation_id=args.evaluation_id), 0
    if verb in ('run', 'status'):
        _positive(args.wait_timeout, 'wait-timeout')
        _positive(args.poll_interval, 'poll-interval')
        if verb == 'run':
            result = await api.run(
                args.id,
                revision=args.revision,
                idempotency_key=args.idempotency_key,
                baseline_run_id=args.baseline_run_id,
            )
        elif args.wait:
            result = await api.wait(args.id, timeout=args.wait_timeout, poll_interval=args.poll_interval)
        else:
            result = await api.status(args.id)
        run = result.get('run')
        if not isinstance(run, dict) or not run.get('id'):
            raise EvalsError('Managed run response is invalid', code='invalid_response')
        if verb == 'run' and args.wait and run.get('status') in ('queued', 'running'):
            try:
                result = await api.wait(run['id'], timeout=args.wait_timeout, poll_interval=args.poll_interval)
            except EvalsError as error:
                return {
                    'error': {'message': str(error), 'code': error.code},
                    'run': run,
                    'idempotencyKey': args.idempotency_key,
                }, 2
        return result, gate_exit_code(result['run']) if args.wait or args.gate else 0
    if verb == 'cancel':
        return await api.cancel(args.id), 0
    if verb == 'baseline':
        return await api.baseline(args.id, args.run_id), 0
    if verb == 'report':
        report = await api.report(args.id, format=args.format)
        if args.output:
            _write_new(args.output, report if isinstance(report, str) else json.dumps(report, indent=2) + '\n')
            return {'runId': args.id, 'format': args.format, 'output': args.output}, 0
        return report, 0
    if verb == 'compare':
        result = await api.compare(args.id)
        compatible = result['run']['comparison'].get('compatible') is True
        return result, gate_exit_code(result['run']) if compatible else 2
    if verb == 'assist':
        return await api.assist(args.instruction, _read_spec(args.spec)), 0
    if verb == 'review':
        return await api.review(
            args.id,
            case_id=args.case_id,
            case_result_id=args.case_result_id,
            scorer_id=args.scorer_id,
            status=args.status,
            reason=args.reason,
            expected_report_revision=args.expected_report_revision,
        ), 0
    raise ValueError('Unknown managed evaluation command')


async def run_evals(args) -> int:
    # Keep the established output modes, with exclusive, private files for eval
    # evidence. Do not use connect_client: this API is independent of WebSocket.
    json_file = args.json if args.json not in (None, '-') else None
    out = Output(None if json_file else args.json)
    credential = args.apikey or ''
    stream = None
    write_failed = False
    if json_file:
        try:
            stream = _open_new_output(json_file)
        except ValueError as error:
            out.fail(str(error))
            return 2
    try:
        try:
            api = EvalsApi(lambda: (args.uri, credential), timeout=args.timeout)
            result, code = await _execute(args, api)
            result = _safe_output(result, credential)
            if isinstance(result, str):
                out.line(result)
                result = {'format': 'junit', 'report': result}
            else:
                out.line(json.dumps(result, indent=2))
            out.result(result)
        except Exception as error:
            message = _redact(str(error), credential)
            out.fail(message)
            result = {
                'error': {'message': message, 'code': error.code if isinstance(error, EvalsError) else 'usage_error'}
            }
            out.result(result)
            code = 2
        if stream is not None:
            try:
                stream.write(json.dumps(result, indent=2) + '\n')
                stream.flush()
            except OSError:
                write_failed = True
    finally:
        if stream is not None:
            try:
                stream.close()
            except OSError:
                write_failed = True
    if write_failed:
        out.fail(
            'Cannot finish writing output; a remote operation may have completed. Check its status before retrying.'
        )
        return 2
    out.finish()
    return code
