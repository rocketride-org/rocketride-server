/** Managed ``rocketride evals`` commands, separate from offline ``eval``. */
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { EvalsApi, EvalsError, EvaluationReview, EvaluationSpec, evaluationGateExitCode, redactEvalsText } from '../../client/evals';
import { addConnectionOptions, ConnectionOptions } from '../common';
import { Output } from '../output';

interface Options extends ConnectionOptions {
	timeout: string;
	projectId?: string;
	evaluationId?: string;
	id?: string;
	expectedRevision?: string;
	revision?: string;
	idempotencyKey?: string;
	baselineRunId?: string;
	wait?: boolean;
	gate?: boolean;
	waitTimeout?: string;
	pollInterval?: string;
	format?: 'json' | 'junit';
	output?: string;
	instruction?: string;
	caseId?: string;
	caseResultId?: string;
	scorerId?: string;
	status?: EvaluationReview['status'];
	reason?: string;
	expectedReportRevision?: string;
}

function seconds(value: string | undefined, name: string): number {
	const milliseconds = Number(value) * 1000;
	if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 2_147_483_647) throw new Error(`${name} must be positive finite seconds within the timer limit`);
	return milliseconds;
}

function readSpec(path: string): EvaluationSpec {
	try {
		const value = JSON.parse(fs.readFileSync(path, 'utf8'));
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
		return value;
	} catch {
		throw new Error('Cannot read spec: expected a readable strict JSON object file');
	}
}

function writeNew(path: string, content: string): void {
	try {
		fs.writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
	} catch {
		throw new Error('Cannot write output: use a new file in an existing writable directory (existing files and symlinks are refused)');
	}
}

function checkNewOutput(file: string): void {
	try {
		// lstat detects dangling symlinks too; final creation still uses O_EXCL.
		try {
			fs.lstatSync(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			const parent = path.dirname(path.resolve(file));
			if (!fs.statSync(parent).isDirectory()) throw new Error();
			fs.accessSync(parent, fs.constants.W_OK);
			return;
		}
		throw new Error();
	} catch {
		throw new Error('Cannot write output: use a new file in an existing writable directory (existing files and symlinks are refused)');
	}
}

function safeOutput(value: unknown, credential: string): unknown {
	if (typeof value === 'string') return redactEvalsText(value, credential);
	if (Array.isArray(value)) return value.map((item) => safeOutput(item, credential));
	if (value && typeof value === 'object') {
		const secretKeys = new Set(['apikey', 'authorization', 'password', 'secret', 'clientsecret', 'credential', 'auth', 'token', 'accesstoken', 'refreshtoken', 'privatekey']);
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, '')) ? '[REDACTED]' : safeOutput(item, credential)]));
	}
	return value;
}

async function execute(verb: string, args: string[], options: Options, api: EvalsApi): Promise<[unknown, number]> {
	const [first, second] = args;
	switch (verb) {
		case 'capabilities':
			return [await api.capabilities(), 0];
		case 'list':
			return [await api.list(options.projectId), 0];
		case 'show':
			return [await api.get(first), 0];
		case 'save':
		case 'create':
		case 'revision': {
			const evaluationId = verb === 'revision' ? first : options.id;
			if (evaluationId && options.expectedRevision === undefined) throw new Error('--expected-revision is required when saving an existing evaluation');
			if (options.expectedRevision !== undefined && !evaluationId) throw new Error('--expected-revision requires --id');
			const spec = readSpec(verb === 'revision' ? second : first);
			return [evaluationId ? await api.revise(evaluationId, spec, Number(options.expectedRevision)) : await api.create(spec), 0];
		}
		case 'runs':
			return [await api.runs(options.evaluationId), 0];
		case 'run':
		case 'status': {
			const waitOptions = { timeout: seconds(options.waitTimeout, 'wait-timeout'), pollInterval: seconds(options.pollInterval, 'poll-interval') };
			let result = verb === 'run' ? await api.run(first, { revision: Number(options.revision), idempotencyKey: options.idempotencyKey!, ...(options.baselineRunId === undefined ? {} : { baselineRunId: options.baselineRunId }) }) : options.wait ? await api.wait(first, waitOptions) : await api.status(first);
			if (!result.run?.id) throw new EvalsError('Managed run response is invalid', undefined, 'invalid_response');
			if (verb === 'run' && options.wait && ['queued', 'running'].includes(result.run.status)) {
				try {
					result = await api.wait(result.run.id, waitOptions);
				} catch (error) {
					if (!(error instanceof EvalsError)) throw error;
					return [{ error: { message: error.message, code: error.code }, run: result.run, idempotencyKey: options.idempotencyKey }, 2];
				}
			}
			return [result, options.wait || options.gate ? evaluationGateExitCode(result.run) : 0];
		}
		case 'cancel':
			return [await api.cancel(first), 0];
		case 'baseline':
			return [await api.baseline(first, second), 0];
		case 'report': {
			const format = options.format ?? 'json';
			const report = await api.report(first, format);
			if (options.output) {
				writeNew(options.output, typeof report === 'string' ? report : JSON.stringify(report, null, 2) + '\n');
				return [{ runId: first, format, output: options.output }, 0];
			}
			return [report, 0];
		}
		case 'compare': {
			const result = await api.compare(first);
			return [result, result.run.comparison?.compatible === true ? evaluationGateExitCode(result.run) : 2];
		}
		case 'assist':
			return [await api.assist(options.instruction!, readSpec(first)), 0];
		case 'review':
			return [
				await api.review(first, {
					caseId: options.caseId!,
					scorerId: options.scorerId!,
					status: options.status!,
					reason: options.reason!,
					expectedReportRevision: Number(options.expectedReportRevision),
					...(options.caseResultId === undefined ? {} : { caseResultId: options.caseResultId }),
				}),
				0,
			];
		default:
			throw new Error('Unknown managed evaluation command');
	}
}

async function run(verb: string, args: string[], options: Options): Promise<void> {
	// Preserve existing JSON modes, with exclusive private files for eval evidence.
	const jsonFile = typeof options.json === 'string' ? options.json : undefined;
	const out = new Output(jsonFile ? undefined : options.json);
	const credential = options.apikey ?? '';
	if (jsonFile) {
		try {
			checkNewOutput(jsonFile);
		} catch (error) {
			out.fail((error as Error).message);
			process.exitCode = 2;
			return;
		}
	}
	let result: unknown;
	let code = 2;
	try {
		const api = new EvalsApi(() => ({ uri: options.uri ?? '', auth: credential }), seconds(options.timeout, 'timeout'));
		[result, code] = await execute(verb, args, options, api);
		result = safeOutput(result, credential);
		if (typeof result === 'string') {
			out.line(result);
			result = { format: 'junit', report: result };
		} else {
			out.line(JSON.stringify(result, null, 2));
		}
		out.result(result);
	} catch (error) {
		const message = redactEvalsText(error instanceof Error ? error.message : 'Managed evaluation command failed', credential);
		out.fail(message);
		result = { error: { message, code: error instanceof EvalsError ? error.code : 'usage_error' } };
		out.result(result);
		code = 2;
	}
	if (jsonFile) {
		try {
			writeNew(jsonFile, JSON.stringify(result, null, 2) + '\n');
		} catch (error) {
			out.fail((error as Error).message);
			code = 2;
		}
	}
	out.finish();
	process.exitCode = code;
}

export function registerEvalsCommands(program: Command): void {
	const group = program.command('evals').description('Managed evaluations, revisions, durable runs and reviews');
	group.exitOverride((error) => {
		error.exitCode = error.exitCode === 0 ? 0 : 2;
		throw error;
	});
	const command = (name: string, description: string): Command => {
		const cmd = addConnectionOptions(group.command(name).description(description)).option('--timeout <seconds>', 'HTTP request timeout in seconds', '30');
		cmd.action(async (...values: unknown[]) => {
			const self = values[values.length - 1] as Command;
			await run(name, values.slice(0, -2) as string[], self.opts<Options>());
		});
		return cmd;
	};
	command('capabilities', 'Show available environments, scorers and authoring assistant');
	command('list', 'List managed evaluations').option('--project-id <id>');
	command('show', 'Show an evaluation and its revision history').argument('<id>');
	command('save', 'Save a JSON spec; creates unless --id is supplied').argument('<spec>').option('--id <id>').option('--expected-revision <revision>');
	command('create', 'Create an evaluation from a JSON spec').argument('<spec>');
	command('revision', 'Create a revision with a stale-write guard').argument('<id>').argument('<spec>').requiredOption('--expected-revision <revision>');
	command('runs', 'List durable runs').option('--evaluation-id <id>');
	for (const verb of ['run', 'status']) {
		const cmd = command(verb, verb === 'run' ? 'Start a durable run' : 'Read a durable run')
			.argument('<id>', verb === 'run' ? 'Evaluation ID' : 'Run ID')
			.option('--wait', 'Wait for a terminal run and return its gate exit code')
			.option('--wait-timeout <seconds>', 'Total wait budget in seconds', '300')
			.option('--poll-interval <seconds>', 'Polling interval in seconds', '1')
			.option('--gate', 'Return 0 pass, 1 fail, 2 incomplete/error');
		if (verb === 'run') cmd.requiredOption('--revision <revision>').requiredOption('--idempotency-key <key>', 'Stable key to reuse when resuming this exact run request').option('--baseline-run-id <id>');
	}
	command('cancel', 'Request cancellation of a durable run').argument('<id>');
	command('baseline', 'Select a completed run as the evaluation baseline').argument('<id>', 'Evaluation ID').argument('<run-id>');
	command('report', 'Download the complete versioned report').argument('<id>').option('--format <format>', 'json or junit', 'json').option('--output <file>', 'New file; existing files and symlinks are refused');
	command('compare', 'Show the recorded server baseline comparison and return its gate').argument('<id>', 'Candidate run ID');
	command('assist', 'Propose a spec using the configured assistant; does not save or run').argument('<spec>').requiredOption('--instruction <text>');
	command('review', 'Review human scorer evidence with a report revision guard').argument('<id>').requiredOption('--case-id <id>').requiredOption('--scorer-id <id>').requiredOption('--status <status>', 'pass, fail or abstain').option('--case-result-id <id>', 'Exact run.cases[].id; required for repeated trials').requiredOption('--reason <text>').requiredOption('--expected-report-revision <revision>');
}
