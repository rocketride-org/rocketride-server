// Pure contract/state checks and a browser-target bundle check. No server,
// credentials, network mocks, dependency installation, or emitted files.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
// Resolve through the installed build tool so pnpm's isolated layout works.
const { buildSync } = createRequire(require.resolve('@rsbuild/core'))('esbuild');

function load(name) {
	const built = buildSync({ entryPoints: [path.join(__dirname, name)], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
	const module = { exports: {} };
	new Function('module', 'exports', built.outputFiles[0].text)(module, module.exports);
	return module.exports;
}
const { evaluationBaseUrl } = load('api.ts');
const { newSpec, clone, same, validateSpec, importCases, parseCsv, parseSpec, retainReviews, specChanges, pipelineSources } = load('spec.ts');
const { traceUnavailableReason, canBeBaseline, isActiveRun } = load('types.ts');
const { mergeRuns, reviewRequest } = load('state.ts');
const project = { project_id: 'project-1', components: [{ id: 'chat_1', name: 'Chat input', config: { mode: 'Source' } }] };
function spec() {
	return { ...newSpec(project, 'Refund'), cases: [{ id: 'refund', name: 'Refund policy', input: 'Can I return this?', reference: 'Within 30 days', approved: true, tags: ['refund'], provenance: { kind: 'manual' } }] };
}

test('managed API derives the HTTP origin and drops websocket path, credentials, query and fragment', () => {
	assert.equal(evaluationBaseUrl('wss://example.test:8443/custom/engine?token=not-a-real-key#socket'), 'https://example.test:8443/evals/v1');
	assert.equal(evaluationBaseUrl('ws://localhost:5565/task/service'), 'http://localhost:5565/evals/v1');
	assert.equal(evaluationBaseUrl('https://user:password@example.test/engine'), 'https://example.test/evals/v1');
	assert.throws(() => evaluationBaseUrl('file:///tmp/engine'));
	assert.throws(() => evaluationBaseUrl(''));
});

test('snapshot capture preserves the business graph and selects only actual source IDs', () => {
	const value = spec();
	assert.deepEqual(value.pipeline, project);
	value.pipeline.components[0].name = 'Changed draft';
	assert.equal(project.components[0].name, 'Chat input');
	assert.deepEqual(pipelineSources({ components: [{ name: 'No ID', config: { mode: 'Source' } }, ...project.components] }), [{ id: 'chat_1', name: 'Chat input' }]);
});

test('v1 spec validation accepts optional case metadata and every supported scorer kind', () => {
	const value = spec();
	delete value.cases[0].tags;
	delete value.cases[0].provenance;
	value.scorers = ['equals', 'contains', 'not_contains', 'json', 'latency', 'llm_judge', 'human'].map((kind) => ({ id: kind, name: kind, kind }));
	assert.deepEqual(validateSpec(value), []);
});

test('strict validation rejects unknown fields, duplicate IDs, wrong project/source and invalid bounds', () => {
	for (const mutate of [
		(value) => {
			value.typo = true;
		},
		(value) => {
			value.cases.push(clone(value.cases[0]));
		},
		(value) => {
			value.scorers.push(clone(value.scorers[0]));
		},
		(value) => {
			value.projectId = 'different-project';
		},
		(value) => {
			value.source = 'missing';
		},
		(value) => {
			value.repetitions = 11;
		},
		(value) => {
			value.passCriteria.minimumPassRate = NaN;
		},
		(value) => {
			value.scorers[0].threshold = Infinity;
		},
		(value) => {
			value.scorers[0].kind = 'custom_code';
		},
		(value) => {
			value.cases[0].provenance = { kind: 'trace', trace: { projectId: 'p', source: 's', traceId: '123' } };
		},
	]) {
		const value = spec();
		mutate(value);
		assert.ok(validateSpec(value).length > 0);
	}
});

test('CSV parses quoted multiline references, escaped quotes, CRLF and rejects malformed rows atomically', () => {
	assert.deepEqual(parseCsv('\uFEFFname,input,reference\r\nPolicy,"hello, world","line one\n""line two"""\r\n'), [
		['name', 'input', 'reference'],
		['Policy', 'hello, world', 'line one\n"line two"'],
	]);
	assert.throws(() => parseCsv('input\n"unclosed'));
	assert.throws(() => parseCsv('input\n"closed"junk'));
	assert.throws(() => importCases('input,reference\nonly input', 'csv', []));
	assert.throws(() => importCases('input,input\na,b', 'csv', []));
});

test('import preserves provenance, keeps new cases unreviewed and never overwrites existing IDs', () => {
	const source = spec().cases[0];
	const trace = { projectId: 'execution-project', source: 'chat_1', runKind: 'dev', environment: 'development', traceId: 42 };
	const imported = importCases(JSON.stringify([{ ...source, provenance: { kind: 'trace', trace } }]), 'json', []);
	assert.equal(imported[0].approved, false);
	assert.deepEqual(imported[0].provenance, { kind: 'trace', trace });
	assert.throws(() => importCases(JSON.stringify([source]), 'json', [source]));
	assert.throws(() => importCases(JSON.stringify([{ ...source, provenance: { kind: 'trace', invented: true } }]), 'json', []));
	assert.equal(source.approved, true);
});

test('JSON and assistant proposals retain only unchanged reviews and preserve the target snapshot', () => {
	const before = spec();
	const proposed = clone(before);
	proposed.name = 'New name';
	assert.equal(parseSpec(JSON.stringify(proposed), before).cases[0].approved, true);
	proposed.cases[0].reference = 'Changed reference';
	assert.equal(parseSpec(JSON.stringify(proposed), before).cases[0].approved, false);
	proposed.cases.push({ ...before.cases[0], id: 'new', approved: true });
	assert.ok(retainReviews(proposed, before).cases.every((item) => !item.approved));
	proposed.pipeline.components[0].name = 'Changed graph';
	assert.throws(() => parseSpec(JSON.stringify(proposed), before), /target pipeline is read-only/);
	assert.equal(before.cases[0].reference, 'Within 30 days');
});

test('diff shows added, changed and removed case/scorer evidence without false undefined changes', () => {
	const before = spec();
	const after = clone(before);
	after.cases = [];
	after.scorers[0].name = 'New scorer name';
	assert.deepEqual(
		specChanges(before, after).map((change) => change.field),
		['cases / refund', `scorers / ${before.scorers[0].id}`]
	);
	assert.equal(same({ kind: 'contains', expected: undefined }, { kind: 'contains' }), true);
});

test('late run polling cannot undo cancellation or review and retains other durable runs', () => {
	const completed = { id: 'a', status: 'completed', reportRevision: 5, createdAt: '2026-09-13T00:00:00Z' };
	const queued = { id: 'b', status: 'queued', reportRevision: 1, createdAt: '2026-09-13T01:00:00Z' };
	const updated = mergeRuns(
		[completed, queued],
		[
			{ ...completed, status: 'running', reportRevision: 4 },
			{ ...queued, status: 'cancelled', reportRevision: 2 },
		]
	);
	assert.deepEqual(
		updated.map(({ id, status, reportRevision }) => ({ id, status, reportRevision })),
		[
			{ id: 'b', status: 'cancelled', reportRevision: 2 },
			{ id: 'a', status: 'completed', reportRevision: 5 },
		]
	);
	assert.equal(isActiveRun(queued), true);
	assert.equal(isActiveRun(completed), false);
});

test('repeated-case review targets exactly one result and carries optimistic report revision', () => {
	const first = { id: 'trial-1-result', caseId: 'refund', trial: 1 };
	const second = { id: 'trial-2-result', caseId: 'refund', trial: 2 };
	const run = { cases: [first, second], reportRevision: 7 };
	assert.deepEqual(reviewRequest(run, second, 'human', 'fail', 'Incorrect refund period'), { caseId: 'refund', caseResultId: 'trial-2-result', scorerId: 'human', status: 'fail', reason: 'Incorrect refund period', expectedReportRevision: 7 });
});

test('only completed nonempty fully scored runs can be baselines', () => {
	assert.equal(canBeBaseline({ status: 'completed', cases: [{ status: 'pass' }, { status: 'fail' }] }), true);
	for (const status of ['abstain', 'incomplete', 'error', 'pending', 'running']) assert.equal(canBeBaseline({ status: 'completed', cases: [{ status }] }), false);
	assert.equal(canBeBaseline({ status: 'completed', cases: [] }), false);
	assert.equal(canBeBaseline({ status: 'cancelled', cases: [{ status: 'pass' }] }), false);
});

test('trace navigation requires a captured numeric identity and disables staging through the development host', () => {
	const trace = { projectId: 'execution-project', source: 'chat_1', runKind: 'dev', traceId: 42 };
	assert.equal(traceUnavailableReason(trace, 'development', true), undefined);
	assert.match(traceUnavailableReason(trace, 'staging', true), /backend trace proxy/);
	assert.match(traceUnavailableReason({ ...trace, environment: 'staging' }, 'development', true), /backend trace proxy/);
	for (const traceId of [undefined, '42', NaN, -1, Number.MAX_SAFE_INTEGER + 1]) assert.match(traceUnavailableReason({ ...trace, traceId }, 'development', true), /numeric trace identity/);
	assert.match(traceUnavailableReason(trace, 'development', false), /not connected/);
});

test('native evaluation workspace and token CSS build for browsers without emitting files', () => {
	const result = buildSync({ entryPoints: [path.join(__dirname, 'EvaluationWorkspace.tsx')], bundle: true, packages: 'external', platform: 'browser', format: 'esm', target: 'es2022', outfile: path.join(__dirname, 'verification-only.js'), write: false, metafile: true, logLevel: 'silent' });
	assert.deepEqual(result.warnings, []);
	assert.ok(result.outputFiles.some((file) => file.path.endsWith('.js')));
	assert.ok(result.outputFiles.some((file) => file.path.endsWith('.css')));
	assert.ok(Object.values(result.metafile.outputs).some((output) => output.exports.includes('default')));
});
