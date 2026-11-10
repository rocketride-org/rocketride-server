// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// DRIVER TESTS: the parts of a browser trial that need no browser
// =============================================================================

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { EVAL_DIR, REPO_ROOT } from './catalog';
import { cardAnswer, dirtyFileAnswer, isWriteOpen, modelTitles, parseModel, replaceShortcut } from './driver';
import { engineEnv, findLeaks, heldKeys, readModelKeys, Scrubber, scrubbedLines, withoutKeys } from './evidence';
import { AGENT_SETTINGS_FILE, agentSettingsFile, APP_ID, scopePrefix, storePath } from './store';
import { loadTask } from './task';
import { cardMatches, setPointer, supportedEvent } from './trial';

// Synthetic values, shaped like keys, for these tests only.
const FAKE_ANTHROPIC = `sk-ant-test-${'a1B2'.repeat(10)}`;
const FAKE_OPENAI = `sk-proj-test${'Z9y8'.repeat(10)}`;
const CANARY = `sk-ant-rrEvalCanary${'0'.repeat(30)}`;

/** A shell that holds model keys under every name the runner must ignore. */
const SHELL_WITH_KEYS = {
	ANTHROPIC_API_KEY: 'sk-ant-shell-anthropic-0000000000',
	OPENAI_API_KEY: 'sk-proj-shell-openai-00000000000000',
	ROCKETRIDE_ANTHROPIC_KEY: 'sk-ant-shell-rocketride-000000000',
	ROCKETRIDE_OPENAI_KEY: 'sk-proj-shell-rocketride-0000000000',
	EVAL_ANTHROPIC_KEY: 'sk-ant-shell-eval-000000000000000',
	EVAL_ARGS: 'run --trials 2',
	ROCKETRIDE_DB_BROKER_TOKEN: 'broker-token-value',
	ROCKETRIDE_BUILD_ROOT: '/home/someone/checkout/build',
	PATH: '/bin',
};

/** Writes a fake env file and returns its path. */
function envFile(text: string): string {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'env-')), '.env.local');
	fs.writeFileSync(file, text);
	return file;
}

test('the model keys come from the env file by their EVAL_ names only, with export and quotes allowed', () => {
	const file = envFile(['# eval keys', `export EVAL_ANTHROPIC_KEY="${FAKE_ANTHROPIC}"`, `EVAL_OPENAI_KEY='${FAKE_OPENAI}'`, 'ANTHROPIC_API_KEY=sk-ant-not-this-one-00000000000', 'SOME_TOKEN = abc # a comment', ''].join('\n'));
	assert.deepEqual(readModelKeys(file), [
		{ name: 'ROCKETRIDE_ANTHROPIC_KEY', value: FAKE_ANTHROPIC },
		{ name: 'ROCKETRIDE_OPENAI_KEY', value: FAKE_OPENAI },
	]);
	assert.deepEqual(readModelKeys(envFile(`EVAL_ANTHROPIC_KEY=${FAKE_ANTHROPIC} # anthropic\nEVAL_OPENAI_KEY=${FAKE_OPENAI}\n`))[0], { name: 'ROCKETRIDE_ANTHROPIC_KEY', value: FAKE_ANTHROPIC });
});

test('a missing or empty eval key stops the runner with its name and never a value', () => {
	const only = envFile(`EVAL_ANTHROPIC_KEY=${FAKE_ANTHROPIC}\nEVAL_OPENAI_KEY=""\n`);
	assert.throws(
		() => readModelKeys(only),
		(err: Error) => /EVAL_OPENAI_KEY is missing or empty/.test(err.message) && !err.message.includes(FAKE_ANTHROPIC)
	);
	assert.throws(() => readModelKeys(envFile('OTHER=1\n')), /EVAL_ANTHROPIC_KEY and EVAL_OPENAI_KEY are missing or empty/);
	assert.throws(() => readModelKeys(path.join(os.tmpdir(), 'no-such-dir', '.env.local')), /no env file at/);
});

test('every command that needs the keys exits 2 naming the missing eval key, before it starts anything', () => {
	const file = envFile(`EVAL_ANTHROPIC_KEY=${FAKE_ANTHROPIC}\n`);
	for (const command of ['run', 'smoke', 'check', 'stack']) {
		const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/run.ts', command, '--env-file', file], { cwd: path.dirname(EVAL_DIR), encoding: 'utf8', env: { ...process.env, ...SHELL_WITH_KEYS } });
		assert.equal(r.status, 2, `${command}: ${r.stderr}`);
		assert.match(r.stderr, /EVAL_OPENAI_KEY is missing or empty/, command);
		assert.ok(!`${r.stdout}${r.stderr}`.includes(FAKE_ANTHROPIC), `${command} printed a key`);
	}
});

test("the engine gets the env file's keys and no shell key; the other processes get no key at all", () => {
	const modelKeys = [
		{ name: 'ROCKETRIDE_ANTHROPIC_KEY', value: FAKE_ANTHROPIC },
		{ name: 'ROCKETRIDE_OPENAI_KEY', value: FAKE_OPENAI },
	];
	assert.deepEqual(engineEnv(modelKeys, SHELL_WITH_KEYS), { ROCKETRIDE_DB_BROKER_TOKEN: 'broker-token-value', ROCKETRIDE_BUILD_ROOT: '/home/someone/checkout/build', PATH: '/bin', ROCKETRIDE_ANTHROPIC_KEY: FAKE_ANTHROPIC, ROCKETRIDE_OPENAI_KEY: FAKE_OPENAI });
	assert.deepEqual(withoutKeys(SHELL_WITH_KEYS), { ROCKETRIDE_BUILD_ROOT: '/home/someone/checkout/build', PATH: '/bin' });
	// held, so scrubbed and scanned for: the file's keys and the engine's other ROCKETRIDE_ secrets, never a shell's model key
	assert.deepEqual(heldKeys(modelKeys, { ...SHELL_WITH_KEYS, ROCKETRIDE_SHORT_KEY: 'x' }), [...modelKeys, { name: 'ROCKETRIDE_DB_BROKER_TOKEN', value: 'broker-token-value' }]);
});

/** The parts of the shell's workspace store (packages/shell) the limits test drives. */
interface ShellStoreModule {
	WorkspaceStore: new (o: { defaultAppId: string }) => { setConnection(client: unknown, connected: boolean): void; getSnapshot(): { settings: Record<string, unknown> } };
	partitionPath(dir: string, partition: string): string;
	appPartition(appId: string): string;
}

test("the shell loads the agent limits the runner writes, as Rocket Builder's settings", async () => {
	// loaded at run time, so this tool's type-check stays inside its own folder
	const { WorkspaceStore, partitionPath, appPartition } = (await import(pathToFileURL(path.join(REPO_ROOT, 'packages/shell/src/workspace/workspaceStore.ts')).href)) as ShellStoreModule;
	assert.equal(partitionPath('.workspace', appPartition(APP_ID)), AGENT_SETTINGS_FILE);
	const files: Record<string, unknown> = { [AGENT_SETTINGS_FILE]: agentSettingsFile({ steps: 0, costUsd: 3 }) };
	const client = {
		fsReadJson: async (p: string) => {
			if (p in files) return files[p];
			throw new Error(`ENOENT ${p}`);
		},
		fsWriteJson: async () => {},
	};
	const shell = new WorkspaceStore({ defaultAppId: APP_ID });
	shell.setConnection(client as never, true);
	for (let i = 0; i < 10; i++) await Promise.resolve();
	assert.deepEqual(shell.getSnapshot().settings, { 'rocketride.pipeBuilder.agentStepLimit': 0, 'rocketride.pipeBuilder.agentCostLimit': 3 });
	// a limit not given keeps the product's default: the file leaves it out
	assert.deepEqual(agentSettingsFile({ costUsd: 3 }).settings, { 'rocketride.pipeBuilder.agentCostLimit': 3 });
});

test('the scrubber names a held key, blanks other key shapes, and keeps canaries', () => {
	const s = new Scrubber([{ name: 'ROCKETRIDE_ANTHROPIC_KEY', value: FAKE_ANTHROPIC }]).keeping([CANARY]);
	const out = s.scrub(`held ${FAKE_ANTHROPIC} other ${FAKE_OPENAI} canary ${CANARY}`);
	assert.equal(out, `held [redacted ROCKETRIDE_ANTHROPIC_KEY] other [redacted] canary ${CANARY}`);
});

test('a service log is scrubbed line by line, even when a key is split across two chunks', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-'));
	const file = path.join(dir, 'engine.log');
	const fd = fs.openSync(file, 'a');
	const lines = scrubbedLines(fd, new Scrubber([{ name: 'ROCKETRIDE_ANTHROPIC_KEY', value: FAKE_ANTHROPIC }]));
	lines.write(`calling with ${FAKE_ANTHROPIC.slice(0, 15)}`);
	assert.equal(fs.readFileSync(file, 'utf8'), '', 'nothing is written before the line ends');
	lines.write(`${FAKE_ANTHROPIC.slice(15)}\nlast line without a newline`);
	lines.end();
	fs.closeSync(fd);
	assert.equal(fs.readFileSync(file, 'utf8'), 'calling with [redacted ROCKETRIDE_ANTHROPIC_KEY]\nlast line without a newline');
	fs.rmSync(dir, { recursive: true });
});

test('the scrubber leaves a task id that merely contains sk- alone', () => {
	const s = new Scrubber([]);
	assert.equal(s.scrub('ask-01-which-vector-db trial 1 and task-0123456789abcdefghij'), 'ask-01-which-vector-db trial 1 and task-0123456789abcdefghij');
	assert.equal(s.scrub(`key "${FAKE_OPENAI}"`), 'key "[redacted]"');
});

test('findLeaks finds a held key, whole or cut short, by name only', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaks-'));
	fs.mkdirSync(path.join(dir, 'final'));
	fs.writeFileSync(path.join(dir, 'clean.txt'), 'nothing here');
	fs.writeFileSync(path.join(dir, 'final', 'cut.txt'), FAKE_ANTHROPIC.slice(0, 20));
	const leaks = findLeaks(dir, [{ name: 'ROCKETRIDE_ANTHROPIC_KEY', value: FAKE_ANTHROPIC }]);
	assert.deepEqual(leaks, [{ file: path.join('final', 'cut.txt'), key: 'ROCKETRIDE_ANTHROPIC_KEY' }]);
	fs.rmSync(dir, { recursive: true });
});

test('modelTitles reads the picker titles from modelEngine.ts', () => {
	assert.deepEqual(modelTitles(parseModel('anthropic/claude-haiku-5-5')), { provider: 'Anthropic', model: 'Claude Haiku 5.5', variable: 'ROCKETRIDE_ANTHROPIC_KEY' });
	assert.deepEqual(modelTitles(parseModel('openai/gpt-6-luna')), { provider: 'OpenAI', model: 'GPT-6 Luna', variable: 'ROCKETRIDE_OPENAI_KEY' });
	assert.throws(() => modelTitles(parseModel('openai/gpt-6-luna-pro')), /offers no gpt-6-luna-pro for openai/);
	assert.throws(() => modelTitles(parseModel('google/gemini')), /no provider google/);
	assert.throws(() => parseModel('claude-haiku-5-5'), /provider\/model/);
});

test('workspace paths map to store paths as workspace.ts maps them', () => {
	assert.equal(storePath('', 'pipelines/support-chat.pipe'), '.projects/support-chat.pipe');
	assert.equal(storePath('', 'apps/daybook-ui/src/App.tsx'), '.projects/.appdev/daybook-ui/src/App.tsx');
	assert.equal(storePath('@/Team/=t1/', 'nodes/my-node/x.py'), '@/Team/=t1/.projects/.nodes/my-node/x.py');
	assert.throws(() => storePath('', 'docs/x.md'), /not a workspace path/);
	assert.equal(scopePrefix({ devTeam: 't1', organization: { teams: [{ id: 't1' }] } }), '@/Team/=t1/');
	assert.equal(scopePrefix({ devTeam: 't1', organization: { teams: [{ id: 't2' }] } }), '');
	assert.equal(scopePrefix(null), '');
});

test('a card policy answers ordinary cards and, when it names one, the unsaved-changes dialog', () => {
	assert.equal(cardAnswer('deny'), 'deny');
	assert.equal(cardAnswer({ default: 'approve', dirty_file_prompt: 'save_mine_first' }), 'approve');
	assert.equal(dirtyFileAnswer('approve'), null);
	assert.equal(dirtyFileAnswer({ default: 'deny', dirty_file_prompt: 'keep_mine' }), 'keep_mine');
});

test('a result card title stands for the outcome turnCard gave it', () => {
	assert.ok(cardMatches('Done', 'done'));
	assert.ok(cardMatches('Stopped', 'stopped'));
	assert.ok(cardMatches('Not finished', 'failed'));
	assert.ok(cardMatches('Not finished', 'incomplete'));
	assert.ok(cardMatches('Which vector database should I use?', 'needs_input'));
	assert.ok(cardMatches('Paused after 60 steps', 'needs_input'));
	assert.ok(!cardMatches('Done', 'needs_input'));
	assert.ok(!cardMatches('Needs you', 'done'));
});

test('the held write is the page opening that one store file for writing, nothing else', () => {
	const at = '@/Team/=local/.projects/translate-bot.pipe';
	const frame = (args: Record<string, unknown>) => JSON.stringify({ type: 'request', seq: 9, command: 'rrext_store', arguments: { subcommand: 'fs_open', path: at, ...args } });
	assert.ok(isWriteOpen(frame({ mode: 'w' }), at));
	assert.ok(!isWriteOpen(frame({ mode: 'r' }), at), 'the freshness check reads');
	assert.ok(!isWriteOpen(frame({ mode: 'w', path: `${at}.bak` }), at));
	assert.ok(!isWriteOpen(JSON.stringify({ command: 'rrext_store', arguments: { subcommand: 'fs_put_json', path: at } }), at));
	assert.ok(!isWriteOpen('not json', at));
});

test('a set_pointer change lands at its JSON pointer, and a missing step is an error', () => {
	const doc = { components: [{ id: 'chat_1' }, { config: { instructions: ['old'] } }] };
	setPointer(doc, 'components/1/config/instructions/0', 'new');
	assert.deepEqual(doc.components[1], { config: { instructions: ['new'] } });
	setPointer(doc, '/components/0/a~1b', 1);
	assert.deepEqual(doc.components[0], { id: 'chat_1', 'a/b': 1 });
	assert.throws(() => setPointer(doc, 'components/5/config/x', 1), /no 5/);
});

test('the driver runs both user-event tasks, and names an event it cannot do', () => {
	for (const id of ['edit-05-user-saves-mid-turn', 'edit-07-app-dirty-buffer']) assert.ok((loadTask(id).user_events ?? []).every(supportedEvent), id);
	assert.ok(!supportedEvent({ when: 'between_freshness_check_and_write', path: 'pipelines/x.pipe', action: 'save' }), 'a save with no change');
	assert.ok(!supportedEvent({ when: 'start', path: 'apps/x/src/App.tsx', action: 'save' }));
});

test("an unsaved edit opens Monaco's Find and Replace with the keys of the browser's platform", () => {
	assert.equal(replaceShortcut('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.0.0 Safari/537.36'), 'Meta+Alt+f');
	assert.equal(replaceShortcut('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.0.0 Safari/537.36'), 'Control+h');
});
