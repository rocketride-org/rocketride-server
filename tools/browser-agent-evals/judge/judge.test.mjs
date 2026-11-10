// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkEvidence, explainFailure } from './explain.mjs';
import { judgeApp } from './judge.mjs';

const TOKEN = 'seeded-token-value';
const EVAL_KEY = 'eval-anthropic-key-value';
const SHELL_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
const CHECKLIST = ['First expectation', 'Second expectation'];

const INIT = { type: 'system', subtype: 'init', tools: ['StructuredOutput', 'mcp__playwright__browser_navigate'] };
const OPENED = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__playwright__browser_navigate' }] } };
const jsonLines = (events) => events.map((event) => JSON.stringify(event)).join('\n');
const transcript = (output, events = [INIT, OPENED]) => jsonLines([...events, { type: 'result', subtype: 'success', total_cost_usd: 0.1, structured_output: output }]);
const lines = (...verdicts) => verdicts.map((verdict, index) => ({ line: index + 1, verdict, did: 'Clicked the button', saw: 'The total changed' }));
const graded = (...verdicts) => transcript({ lines: lines(...verdicts), overall: verdicts.includes('fail') ? 'fail' : 'pass' });

const ALL_PASS = graded('pass', 'pass');
const UNREADABLE = '{"type":"result","structured_outp';

let root;
let originalPath;
let dirs = 0;

/** Points the fake `claude` at the transcripts it prints, one per run, and returns a fresh folder. */
function stage(transcripts) {
	const dir = path.join(root, String(dirs++));
	fs.mkdirSync(dir);
	fs.writeFileSync(path.join(root, 'transcripts.json'), JSON.stringify(transcripts));
	fs.rmSync(path.join(root, 'count'), { force: true });
	return dir;
}

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-test-'));
	const bin = path.join(root, 'bin');
	fs.mkdirSync(bin);
	const fake = `#!/usr/bin/env node
const fs = require('fs');
const root = ${JSON.stringify(root)};
const count = fs.existsSync(root + '/count') ? Number(fs.readFileSync(root + '/count', 'utf8')) : 0;
fs.writeFileSync(root + '/count', String(count + 1));
fs.writeFileSync(root + '/env.json', JSON.stringify(Object.fromEntries(${JSON.stringify(SHELL_CREDENTIALS)}.map((name) => [name, process.env[name]]))));
fs.writeFileSync(root + '/call.json', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), files: fs.readdirSync(process.cwd()) }));
const text = JSON.parse(fs.readFileSync(root + '/transcripts.json', 'utf8'))[count];
if (text === 'HANG') setTimeout(() => {}, 60000);
else process.stdout.write(text);
`;
	fs.writeFileSync(path.join(bin, 'claude'), fake, { mode: 0o755 });
	originalPath = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
});

after(() => {
	process.env.PATH = originalPath;
	fs.rmSync(root, { recursive: true, force: true });
});

describe('judgeApp', () => {
	/** Runs judgeApp against a fake `claude` that prints one given transcript per run. */
	async function judge(transcripts, options = {}) {
		const outDir = path.join(stage(transcripts), 'out');
		return { outDir, result: await judgeApp({ url: 'http://127.0.0.1:1/', checklist: CHECKLIST, runs: transcripts.length, outDir, apiKey: EVAL_KEY, ...options }) };
	}

	const rollUps = [
		['passes when every run passes every line', [ALL_PASS, ALL_PASS, ALL_PASS], 'pass'],
		['fails on one failed line in one run', [ALL_PASS, graded('pass', 'fail'), ALL_PASS], 'fail'],
		['fails when the overall field says fail and the lines pass', [ALL_PASS, transcript({ lines: lines('pass', 'pass'), overall: 'fail' }), ALL_PASS], 'fail'],
		['lets a failure win over not_tested and an invalid run', [UNREADABLE, graded('not_tested', 'pass'), graded('fail', 'pass')], 'fail'],
		['is inconclusive on a not_tested line with no failure', [ALL_PASS, graded('pass', 'not_tested'), ALL_PASS], 'inconclusive'],
		['is inconclusive when nothing was tested', [graded('not_tested', 'not_tested'), graded('not_tested', 'not_tested'), graded('not_tested', 'not_tested')], 'inconclusive'],
		['is inconclusive when nothing was tested and the overall field says fail', [transcript({ lines: lines('not_tested', 'not_tested'), overall: 'fail' })], 'inconclusive'],
		['is inconclusive on an invalid run with no failure', [ALL_PASS, UNREADABLE, ALL_PASS], 'inconclusive'],
	];
	for (const [name, transcripts, verdict] of rollUps) {
		it(name, async () => {
			const { result } = await judge(transcripts);
			assert.equal(result.verdict, verdict);
		});
	}

	const malformed = [
		['an unreadable transcript', UNREADABLE],
		['a session that ended with no output', jsonLines([INIT, OPENED, { type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 0.6 }])],
		['a missing line', transcript({ lines: lines('fail'), overall: 'fail' })],
		['an extra line', transcript({ lines: lines('fail', 'pass', 'pass'), overall: 'fail' })],
		['misnumbered lines', transcript({ lines: lines('fail', 'pass').map((line) => ({ ...line, line: line.line + 1 })), overall: 'fail' })],
		['blank evidence', transcript({ lines: [{ ...lines('fail')[0], saw: '  ' }, lines('pass', 'pass')[1]], overall: 'fail' })],
		['missing evidence', transcript({ lines: [{ line: 1, verdict: 'fail', did: 'Clicked' }, lines('pass', 'pass')[1]], overall: 'fail' })],
		['an unknown verdict', transcript({ lines: [{ ...lines('pass')[0], verdict: 'mostly' }, lines('pass', 'pass')[1]], overall: 'fail' })],
		['a missing overall verdict', transcript({ lines: lines('fail', 'pass') })],
		['a session that never opened the app', transcript({ lines: lines('fail', 'pass'), overall: 'fail' }, [INIT])],
		['a session offered a tool beyond the browser', transcript({ lines: lines('fail', 'pass'), overall: 'fail' }, [{ ...INIT, tools: [...INIT.tools, 'Bash'] }, OPENED])],
	];
	for (const [name, text] of malformed) {
		it(`rejects ${name} and ignores what it claimed`, async () => {
			const { result } = await judge([text]);
			assert.equal(result.verdict, 'inconclusive');
			assert.ok(result.runs[0].invalidReason);
			assert.deepEqual(
				result.lines.map((line) => line.runs),
				[[null], [null]]
			);
		});
	}

	it('reports each line across runs and adds up the cost', async () => {
		const { result } = await judge([ALL_PASS, graded('pass', 'fail')]);
		assert.deepEqual(
			result.lines.map(({ line, text, verdict, runs }) => ({ line, text, verdict, runs })),
			[
				{ line: 1, text: CHECKLIST[0], verdict: 'pass', runs: ['pass', 'pass'] },
				{ line: 2, text: CHECKLIST[1], verdict: 'fail', runs: ['pass', 'fail'] },
			]
		);
		assert.equal(result.costUsd, 0.2);
	});

	it('leaves only transcripts behind, with seeded values replaced', async () => {
		const shown = transcript({ lines: lines('pass', 'pass').map((line) => ({ ...line, saw: `The page showed ${TOKEN}` })), overall: 'pass' });
		const { outDir, result } = await judge([shown], { localStorage: { 'rr:user_token': TOKEN } });
		assert.deepEqual(fs.readdirSync(outDir).sort(), ['run-1.jsonl', 'run-1.stderr']);
		assert.ok(!fs.readFileSync(path.join(outDir, 'run-1.jsonl'), 'utf8').includes(TOKEN));
		assert.ok(!JSON.stringify(result).includes(TOKEN));
		assert.equal(result.verdict, 'pass');
	});

	it('runs the session on the given key alone, never on an Anthropic credential from the shell', async () => {
		const saved = Object.fromEntries(SHELL_CREDENTIALS.map((name) => [name, process.env[name]]));
		for (const name of SHELL_CREDENTIALS) process.env[name] = `shell-${name.toLowerCase()}`;
		try {
			const shown = transcript({ lines: lines('pass', 'pass').map((line) => ({ ...line, saw: `The page showed ${EVAL_KEY}` })), overall: 'pass' });
			const { outDir } = await judge([shown]);
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'env.json'), 'utf8')), { ANTHROPIC_API_KEY: EVAL_KEY });
			assert.ok(!fs.readFileSync(path.join(outDir, 'run-1.jsonl'), 'utf8').includes(EVAL_KEY));
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	/** The fake claude's last call: its arguments, working folder and that folder's files. */
	const lastCall = () => JSON.parse(fs.readFileSync(path.join(root, 'call.json'), 'utf8'));
	const argAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];
	const UPLOAD = 'mcp__playwright__browser_file_upload';

	it('never lets a session upload a file unless given a folder to upload from', async () => {
		await judge([ALL_PASS]);
		const { argv, cwd } = lastCall();
		assert.ok(!argAfter(argv, '--allowedTools').split(',').includes(UPLOAD));
		assert.ok(argAfter(argv, '--disallowedTools').split(',').includes(UPLOAD));
		assert.equal(cwd, '/');
	});

	it('lets a session upload only from a copy of the given folder, outside any repo, with the checklist pointing at the copy', async () => {
		// real-05's invoices: the app reads a PDF the judge drops in
		const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-uploads-'));
		fs.writeFileSync(path.join(uploads, 'invoice-1.pdf'), 'pdf');
		const checklist = [`Dropping in ${path.join(uploads, 'invoice-1.pdf')} adds a row.`, 'Second expectation'];
		const offered = transcript({ lines: lines('pass', 'pass'), overall: 'pass' }, [{ ...INIT, tools: [...INIT.tools, UPLOAD] }, OPENED]);
		const { result } = await judge([offered], { checklist, uploadDir: uploads });
		const { argv, cwd, files } = lastCall();
		assert.ok(argAfter(argv, '--allowedTools').split(',').includes(UPLOAD));
		assert.ok(!argAfter(argv, '--disallowedTools').split(',').includes(UPLOAD));
		// the session runs in the copy, and the copy is gone after the run
		assert.notEqual(cwd, fs.realpathSync(uploads));
		assert.deepEqual(files, ['invoice-1.pdf']);
		assert.ok(argAfter(argv, '-p').includes(`Dropping in ${path.join(cwd, 'invoice-1.pdf')} adds a row.`), 'the prompt names the copy');
		assert.ok(!argAfter(argv, '-p').includes(uploads), 'the prompt never names the original folder');
		assert.ok(!fs.existsSync(cwd));
		// a run offered the upload tool is valid, and the result keeps the person's own line
		assert.equal(result.verdict, 'pass');
		assert.equal(result.lines[0].text, checklist[0]);
	});

	it('calls beforeRun before each session, once the session before it has finished', async () => {
		const sessionsDone = () => (fs.existsSync(path.join(root, 'count')) ? Number(fs.readFileSync(path.join(root, 'count'), 'utf8')) : 0);
		const calls = [];
		await judge([ALL_PASS, ALL_PASS, ALL_PASS], { beforeRun: async (run) => calls.push([run, sessionsDone()]) });
		assert.deepEqual(calls, [
			[1, 0],
			[2, 1],
			[3, 2],
		]);
	});

	it('refuses to start a session without a key', async () => {
		await assert.rejects(judge([ALL_PASS], { apiKey: undefined }), /EVAL_ANTHROPIC_KEY/);
	});

	it('stops a session at its time limit and counts the run as invalid', async () => {
		const { result } = await judge(['HANG'], { timeoutMs: 200 });
		assert.equal(result.verdict, 'inconclusive');
		assert.match(result.runs[0].invalidReason, /timed out/);
	});

	it('reports inconclusive and exits when claude is not installed', () => {
		const checklist = path.join(root, 'checklist.txt');
		fs.writeFileSync(checklist, CHECKLIST.join('\n'));
		const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
		const { status, stdout } = spawnSync(process.execPath, [cli, '--url', 'http://127.0.0.1:1/', '--checklist', checklist, '--out', path.join(root, 'no-claude'), '--runs', '1'], { encoding: 'utf8', timeout: 20000, env: { PATH: path.join(root, 'no-such-dir'), EVAL_ANTHROPIC_KEY: EVAL_KEY } });
		assert.equal(status, 2);
		assert.match(stdout, /could not start claude/);
	});

	it('refuses a checklist with no lines, since nothing would be tested', async () => {
		await assert.rejects(judgeApp({ url: 'http://127.0.0.1:1/', checklist: [], outDir: path.join(root, 'unused') }));
	});
});

describe('explainFailure', () => {
	const FAILED = [{ id: 'runs_and_returns_both', detail: 'Both answers were a 404' }];
	const QUOTE = '"model": "claude-haiku-latest"';
	const OUTSIDE = 'text outside the trial';
	const READ_ONLY = { type: 'system', subtype: 'init', tools: ['Glob', 'Grep', 'Read', 'StructuredOutput'] };
	const explained = (output, init = READ_ONLY) => jsonLines([init, { type: 'result', subtype: 'success', total_cost_usd: 0.1, structured_output: output }]);
	const LEAD = { step: 'Turn 1, the write to pipelines/compare.pipe', lead: 'The pipeline names a model that does not exist.', evidence: [{ file: 'pipelines/compare.pipe', quote: QUOTE }] };

	/** A trial folder holding one pipe and a symlink to a file in a folder beside it. */
	function trialIn(dir) {
		const trialDir = path.join(dir, 'trial');
		fs.mkdirSync(path.join(trialDir, 'pipelines'), { recursive: true });
		fs.writeFileSync(path.join(trialDir, 'pipelines', 'compare.pipe'), `{ ${QUOTE} }`);
		fs.mkdirSync(path.join(dir, 'outside'));
		fs.writeFileSync(path.join(dir, 'outside', 'notes.txt'), OUTSIDE);
		fs.symlinkSync(path.join(dir, 'outside', 'notes.txt'), path.join(trialDir, 'link.txt'));
		return trialDir;
	}

	/** Runs explainFailure over a fresh trial folder against a fake `claude` that prints `text`. */
	async function explain(text, options = {}) {
		const dir = stage([text]);
		const outDir = path.join(dir, 'out');
		return { outDir, lead: await explainFailure({ trialDir: trialIn(dir), failed: FAILED, outDir, apiKey: EVAL_KEY, ...options }) };
	}

	it('verifies a lead whose quote is in its file', async () => {
		const { lead } = await explain(explained(LEAD));
		assert.deepEqual(lead, { text: LEAD.lead, step: LEAD.step, evidence: [{ file: 'pipelines/compare.pipe', quote: QUOTE, found: true }], verified: true, costUsd: 0.1, invalid: null });
	});

	it('leaves a lead unverified when its quote is not in the file', async () => {
		const { lead } = await explain(explained({ ...LEAD, evidence: [{ file: 'pipelines/compare.pipe', quote: '"model": "claude-haiku-4-5"' }] }));
		assert.equal(lead.invalid, null);
		assert.equal(lead.verified, false);
		assert.equal(lead.evidence[0].found, false);
	});

	it('finds no quote outside the trial folder, through .., an absolute path or a symlink', () => {
		const dir = fs.mkdtempSync(path.join(root, 'evidence-'));
		const trialDir = trialIn(dir);
		const evidence = [
			{ file: 'pipelines/compare.pipe', quote: QUOTE },
			{ file: '../outside/notes.txt', quote: OUTSIDE },
			{ file: path.join(dir, 'outside', 'notes.txt'), quote: OUTSIDE },
			{ file: 'link.txt', quote: OUTSIDE },
		];
		assert.deepEqual(
			checkEvidence(trialDir, evidence).map((item) => item.found),
			[true, false, false, false]
		);
	});

	const rejected = [
		['a session offered a tool beyond Read, Grep and Glob', explained(LEAD, { ...READ_ONLY, tools: [...READ_ONLY.tools, 'Bash'] })],
		['a session that ended with no output', jsonLines([READ_ONLY, { type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 0.5 }])],
		['an empty lead', explained({ ...LEAD, lead: '  ' })],
	];
	for (const [name, text] of rejected) {
		it(`rejects ${name} and ignores what it claimed`, async () => {
			const { lead } = await explain(text);
			assert.ok(lead.invalid);
			assert.equal(lead.verified, false);
			assert.deepEqual(lead.evidence, []);
		});
	}

	it('replaces redact values in the transcript and the lead', async () => {
		const { outDir, lead } = await explain(explained({ ...LEAD, lead: `The page showed ${TOKEN}.` }), { redact: [TOKEN] });
		assert.equal(lead.invalid, null);
		assert.ok(!JSON.stringify(lead).includes(TOKEN));
		assert.ok(!fs.readFileSync(path.join(outDir, 'explain.jsonl'), 'utf8').includes(TOKEN));
	});

	it('refuses an outDir inside the trial folder, where the session could quote its own transcript', async () => {
		const trialDir = trialIn(stage([explained(LEAD)]));
		await assert.rejects(explainFailure({ trialDir, failed: FAILED, outDir: path.join(trialDir, 'explain'), apiKey: EVAL_KEY }), /inside/);
	});
});
