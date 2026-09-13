/** Managed SDK/CLI contracts with injected HTTP only; no provider or engine. */
import { RocketRideClient } from '../src/client/client';
import { EvaluationSpec } from '../src/client/evals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SPEC: EvaluationSpec = {
	schemaVersion: 1,
	name: 'Policy',
	projectId: 'p1',
	pipeline: { project_id: 'p1', components: [{ id: 'chat_1' }] },
	source: 'chat_1',
	inputMode: 'chat',
	environment: 'development',
	datasetName: 'Reviewed examples',
	repetitions: 2,
	cases: [{ id: 'c1', name: 'Refund', input: 'Return?', reference: '30 days', approved: true }],
	scorers: [{ id: 's1', name: 'Human', kind: 'human' }],
	passCriteria: { minimumPassRate: 1, maxRegressions: 0 },
};
const RUN = { id: 'r1', status: 'completed', summary: { gate: 'pass' }, reportRevision: 3 };

function transport(...responses: unknown[]) {
	return jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
		const value = responses.shift();
		if (value instanceof Error) throw value;
		const [status, body] = Array.isArray(value) ? value : [200, value];
		return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
	});
}

function api(uri = 'https://api.rocketride.ai/task/service') {
	const client = new RocketRideClient({ uri, auth: 'test-secret', env: {} });
	expect(client).toHaveProperty('evals');
	return Reflect.get(client, 'evals');
}

let tempDir: string;
beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketride-evals-test-'));
});
afterEach(() => {
	jest.restoreAllMocks();
	process.exitCode = 0;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

test('public namespace uses authenticated HTTP without a WebSocket connection', async () => {
	const http = transport({ environments: [] });
	expect(await api().capabilities()).toEqual({ environments: [] });
	expect(http.mock.calls[0][0]).toBe('https://api.rocketride.ai/evals/v1/capabilities');
	expect(http.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer test-secret' } });
});

test('routes, guards, idempotency and exact case-level review body', async () => {
	const http = transport(...Array(12).fill({}));
	const evals = api();
	await evals.list('p &?');
	await evals.get('e/1');
	await evals.create(SPEC);
	await evals.revise('e1', SPEC, 2);
	await evals.run('e1', { revision: 3, idempotencyKey: 'ci-unchanged', baselineRunId: 'b1' });
	await evals.runs('e1');
	await evals.status('r1');
	await evals.cancel('r1');
	await evals.baseline('e1', 'r1');
	await evals.report('r1');
	await evals.review('r1', { caseId: 'c1', scorerId: 's1', status: 'pass', reason: 'Checked', expectedReportRevision: 3 });
	await evals.assist('Improve wording', SPEC);
	const calls = http.mock.calls;
	expect(calls[0][0]).toMatch(/\/evaluations\?projectId=p\+%26%3F$/);
	expect(calls[1][0]).toMatch(/\/evaluations\/e%2F1$/);
	expect(JSON.parse(calls[2][1]!.body as string)).toEqual(SPEC);
	expect(JSON.parse(calls[3][1]!.body as string)).toEqual({ spec: SPEC, expectedRevision: 2 });
	expect(JSON.parse(calls[4][1]!.body as string)).toEqual({ revision: 3, idempotencyKey: 'ci-unchanged', baselineRunId: 'b1' });
	expect(calls[5][0]).toMatch(/\/runs\?evaluationId=e1$/);
	expect(calls[6][0]).toMatch(/\/runs\/r1$/);
	expect(JSON.parse(calls[7][1]!.body as string)).toEqual({});
	expect(JSON.parse(calls[8][1]!.body as string)).toEqual({ runId: 'r1' });
	expect(calls[9][0]).toMatch(/\/runs\/r1\/report\?format=json$/);
	expect(JSON.parse(calls[10][1]!.body as string)).toEqual({ caseId: 'c1', scorerId: 's1', status: 'pass', reason: 'Checked', expectedReportRevision: 3 });
	expect(JSON.parse(calls[11][1]!.body as string)).toEqual({ instruction: 'Improve wording', spec: SPEC });
});

test.each(['ftp://example.com', 'https://u:secret@example.com:443', 'https://api.rocketride.ai/prefix', 'https://api.rocketride.ai/?token=secret', 'https://api.rocketride.ai/#secret'])('reject original unsafe endpoint %s', async (uri) => {
	const http = transport({});
	await expect(api(uri).capabilities()).rejects.toThrow();
	expect(http).not.toHaveBeenCalled();
});

test.each([{ response: [307, 'test-secret'] }, { response: [409, { error: { code: 'conflict', message: 'Stale test-secret' } }] }, { response: new Error('test-secret') }])('no retry or credential disclosure on HTTP failure %#', async ({ response }) => {
	const http = transport(response);
	let error: unknown;
	try {
		await api().run('e1', { revision: 1, idempotencyKey: 'same-key' });
	} catch (err) {
		error = err;
	}
	expect(error).toBeInstanceOf(Error);
	expect(String(error)).not.toContain('test-secret');
	expect(http).toHaveBeenCalledTimes(1);
});

async function cli(argv: string[]) {
	// Assert discovery before importing the new registration module, so RED is
	// a missing public surface assertion, never a collection/import failure.
	expect(require('fs').existsSync(require('path').join(__dirname, '../src/cli/commands/evals.ts'))).toBe(true);
	const { registerEvalsCommands } = require('../src/cli/commands/evals');
	const { Command } = require('commander');
	const program = new Command().exitOverride();
	registerEvalsCommands(program);
	await program.parseAsync(['evals', ...argv, '--uri', 'https://api.rocketride.ai', '--apikey', 'test-secret'], { from: 'user' });
	return process.exitCode;
}

test.each([
	['pass', 0],
	['fail', 1],
	['incomplete', 2],
])('CLI wait preserves key and returns gate %s', async (gate, code) => {
	const http = transport({ run: { id: 'r1', status: 'queued' } }, { run: { ...RUN, summary: { gate } } });
	const output = jest.spyOn(console, 'log').mockImplementation(() => {});
	expect(await cli(['run', 'e1', '--revision', '1', '--idempotency-key', 'ci-42', '--wait', '--json'])).toBe(code);
	expect(JSON.parse(output.mock.calls[0][0]).run.summary.gate).toBe(gate);
	expect(http.mock.calls.map((call) => call[1]!.method)).toEqual(['POST', 'GET']);
	expect(JSON.parse(http.mock.calls[0][1]!.body as string).idempotencyKey).toBe('ci-42');
});

test('review selects one repetition in SDK and CLI', async () => {
	const http = transport({ run: RUN }, { run: RUN });
	await api().review('r1', { caseId: 'c1', caseResultId: 'trial-row-2', scorerId: 's1', status: 'pass', reason: 'Inspected', expectedReportRevision: 3 });
	expect(JSON.parse(http.mock.calls[0][1]!.body as string).caseResultId).toBe('trial-row-2');
	const output = jest.spyOn(console, 'log').mockImplementation(() => {});
	expect(await cli(['review', 'r1', '--case-id', 'c1', '--case-result-id', 'trial-row-2', '--scorer-id', 's1', '--status', 'fail', '--reason', 'Inspected', '--expected-report-revision', '3', '--json'])).toBe(0);
	expect(JSON.parse(http.mock.calls[1][1]!.body as string)).toEqual({ caseId: 'c1', caseResultId: 'trial-row-2', scorerId: 's1', status: 'fail', reason: 'Inspected', expectedReportRevision: 3 });
	expect(JSON.parse(output.mock.calls[0][0])).toEqual({ run: RUN });
});

test.each([
	{ command: ['capabilities'], route: '/capabilities', body: undefined },
	{ command: ['list', '--project-id', 'p1'], route: '/evaluations?projectId=p1', body: undefined },
	{ command: ['show', 'e1'], route: '/evaluations/e1', body: undefined },
	{ command: ['runs', '--evaluation-id', 'e1'], route: '/runs?evaluationId=e1', body: undefined },
	{ command: ['status', 'r1'], route: '/runs/r1', body: undefined },
	{ command: ['cancel', 'r1'], route: '/runs/r1/cancel', body: {} },
	{ command: ['baseline', 'e1', 'r1'], route: '/evaluations/e1/baseline', body: { runId: 'r1' } },
])('CLI lifecycle and read route $route', async ({ command, route, body }) => {
	const http = transport({ run: RUN });
	const output = jest.spyOn(console, 'log').mockImplementation(() => {});
	expect(await cli([...command, '--json'])).toBe(0);
	expect(http.mock.calls[0][0]).toBe('https://api.rocketride.ai/evals/v1' + route);
	expect(http.mock.calls[0][1]!.body).toBe(body === undefined ? undefined : JSON.stringify(body));
	expect(JSON.parse(output.mock.calls[0][0])).toEqual({ run: RUN });
});

test('CLI authoring preserves spec and performs no implicit execution', async () => {
	const specFile = path.join(tempDir, 'spec.json');
	fs.writeFileSync(specFile, JSON.stringify(SPEC));
	const http = transport(...Array(5).fill({}));
	jest.spyOn(console, 'log').mockImplementation(() => {});
	for (const command of [
		['create', specFile],
		['save', specFile],
		['save', specFile, '--id', 'e1', '--expected-revision', '2'],
		['revision', 'e1', specFile, '--expected-revision', '2'],
		['assist', specFile, '--instruction', 'Clarify'],
	])
		expect(await cli([...command, '--json'])).toBe(0);
	expect(http.mock.calls.map((call) => JSON.parse(call[1]!.body as string))).toEqual([SPEC, SPEC, { spec: SPEC, expectedRevision: 2 }, { spec: SPEC, expectedRevision: 2 }, { instruction: 'Clarify', spec: SPEC }]);
	expect(http.mock.calls.some((call) => String(call[0]).endsWith('/runs'))).toBe(false);
});

test('CLI save requires a guard before HTTP', async () => {
	const http = transport({});
	const output = jest.spyOn(console, 'log').mockImplementation(() => {});
	expect(await cli(['save', 'spec.json', '--id', 'e1', '--json'])).toBe(2);
	expect(http).not.toHaveBeenCalled();
	expect(JSON.parse(output.mock.calls[0][0]).error.message).toContain('expected-revision');
});

test.each([
	{ compatible: true, gate: 'pass', code: 0 },
	{ compatible: true, gate: 'fail', code: 1 },
	{ compatible: false, gate: 'pass', code: 2 },
])('compare uses server evidence %#', async ({ compatible, gate, code }) => {
	const run = { ...RUN, baselineRunId: 'b1', summary: { gate }, comparison: { compatible, regressions: 2 } };
	const http = transport({ run });
	const output = jest.spyOn(console, 'log').mockImplementation(() => {});
	expect(await cli(['compare', 'r1', '--json'])).toBe(code);
	expect(JSON.parse(output.mock.calls[0][0])).toEqual({ run });
	expect(http).toHaveBeenCalledTimes(1);
	expect(http.mock.calls[0][1]!.method).toBe('GET');
});

test('compare does not invent missing evidence', async () => {
	transport({ run: RUN });
	const output = jest.spyOn(console, 'log').mockImplementation(() => {});
	expect(await cli(['compare', 'r1', '--json'])).toBe(2);
	expect(JSON.parse(output.mock.calls[0][0]).error.code).toBe('comparison_unavailable');
});

test.each(['queued', 'running', 'cancelled', 'error'])('gate never passes a %s run', async (status) => {
	transport({ run: { ...RUN, status } });
	jest.spyOn(console, 'log').mockImplementation(() => {});
	expect(await cli(['status', 'r1', '--gate', '--json'])).toBe(2);
});

test('wait deadline aborts pending HTTP and retains durable run identity', async () => {
	const http = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
		if (options?.method === 'POST') return new Response(JSON.stringify({ run: { id: 'r1', status: 'queued' } }));
		return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('test-secret')), { once: true }));
	});
	const output = jest.spyOn(console, 'log').mockImplementation(() => {});
	const started = performance.now();
	expect(await cli(['run', 'e1', '--revision', '1', '--idempotency-key', 'stable', '--wait', '--wait-timeout', '0.02', '--json'])).toBe(2);
	expect(performance.now() - started).toBeLessThan(1000);
	expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ error: { code: 'timeout' }, run: { id: 'r1' }, idempotencyKey: 'stable' });
	expect(http.mock.calls.map((call) => call[1]!.method)).toEqual(['POST', 'GET']);
});

test.each([
	['--wait-timeout', 'NaN'],
	['--poll-interval', '0'],
	['--revision', '0'],
])('reject invalid %s before enqueue', async (option, value) => {
	const http = transport({});
	jest.spyOn(console, 'log').mockImplementation(() => {});
	expect(await cli(['run', 'e1', '--revision', '1', '--idempotency-key', 'stable', option, value, '--json'])).toBe(2);
	expect(http).not.toHaveBeenCalled();
});

test('exclusive JUnit and JSON report files preserve complete evidence and refuse symlinks', async () => {
	const target = path.join(tempDir, 'report.xml');
	const report = '<testsuites><testsuite name="Managed"/></testsuites>';
	const http = transport(report, report, report, { schemaVersion: 1, run: RUN });
	jest.spyOn(console, 'log').mockImplementation(() => {});
	const args = ['report', 'r1', '--format', 'junit', '--output', target, '--json'];
	expect(await cli(args)).toBe(0);
	expect(fs.readFileSync(target, 'utf8')).toBe(report);
	expect(await cli(args)).toBe(2);
	const link = path.join(tempDir, 'link.xml');
	fs.symlinkSync(target, link);
	expect(await cli(['report', 'r1', '--format', 'junit', '--output', link, '--json'])).toBe(2);
	expect(fs.readFileSync(target, 'utf8')).toBe(report);
	const jsonFile = path.join(tempDir, 'report.json');
	expect(await cli(['report', 'r1', '--output', jsonFile, '--json'])).toBe(0);
	expect(JSON.parse(fs.readFileSync(jsonFile, 'utf8'))).toEqual({ schemaVersion: 1, run: RUN });
	expect(http).toHaveBeenCalledTimes(4);
});

test('output redacts credentials and creates private exclusive JSON files', async () => {
	const target = path.join(tempDir, 'result.json');
	const response = { message: 'test-secret Bearer another-secret', password: 'embedded-secret' };
	transport(response, response);
	const output = jest.spyOn(console, 'log').mockImplementation(() => {});
	expect(await cli(['capabilities', '--json', target])).toBe(0);
	const text = fs.readFileSync(target, 'utf8') + output.mock.calls.flat().join('');
	for (const secret of ['test-secret', 'another-secret', 'embedded-secret']) expect(text).not.toContain(secret);
	if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o600);
	expect(await cli(['capabilities', '--json', target])).toBe(2);
});

test('SDK retains conflict metadata and rejects malformed success responses', async () => {
	transport([409, { error: { code: 'conflict', message: 'Stale' } }], 'not JSON');
	const evals = api();
	await expect(evals.revise('e1', SPEC, 2)).rejects.toMatchObject({ status: 409, code: 'conflict' });
	await expect(evals.status('r1')).rejects.toMatchObject({ code: 'invalid_response' });
});

test('endpoint overrides keep original validation', async () => {
	const http = transport({});
	const client = new RocketRideClient({ uri: 'https://api.rocketride.ai', auth: 'test-secret', env: {} });
	// Attach is deliberately stubbed at the socket boundary, never a live server.
	jest.spyOn(client as unknown as { _attachAnonymous: () => Promise<void> }, '_attachAnonymous').mockResolvedValue();
	await client.attach('https://next.rocketride.ai/task/service');
	await client.evals.capabilities();
	expect(http.mock.calls[0][0]).toBe('https://next.rocketride.ai/evals/v1/capabilities');
	await client.attach('https://next.rocketride.ai/?credential=secret');
	await expect(client.evals.capabilities()).rejects.toThrow();
	expect(http).toHaveBeenCalledTimes(1);
});

test('JSON file failure prevents mutation', async () => {
	const target = path.join(tempDir, 'existing.json');
	fs.writeFileSync(target, 'preserve');
	const http = transport({ run: RUN });
	jest.spyOn(console, 'log').mockImplementation(() => {});
	expect(await cli(['run', 'e1', '--revision', '1', '--idempotency-key', 'stable', '--json', target])).toBe(2);
	expect(http).not.toHaveBeenCalled();
	expect(fs.readFileSync(target, 'utf8')).toBe('preserve');
});

test('managed CLI usage failures have exit code two', async () => {
	const http = transport({});
	await expect(cli(['run', 'e1', '--revision', '1', '--json'])).rejects.toMatchObject({ exitCode: 2 });
	expect(http).not.toHaveBeenCalled();
});
