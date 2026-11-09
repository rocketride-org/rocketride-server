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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { cardAnswer, dirtyFileAnswer, isWriteOpen, modelTitles, parseModel } from './driver';
import { findLeaks, heldKeys, Scrubber, scrubbedLines, withoutKeys } from './evidence';
import { scopePrefix, storePath } from './store';
import { loadTask } from './task';
import { cardMatches, setPointer, supportedEvent } from './trial';

// Synthetic values, shaped like keys, for these tests only.
const FAKE_ANTHROPIC = `sk-ant-test-${'a1B2'.repeat(10)}`;
const FAKE_OPENAI = `sk-proj-test${'Z9y8'.repeat(10)}`;
const CANARY = `sk-ant-rrEvalCanary${'0'.repeat(30)}`;

test('heldKeys takes each model key under either name, and every other ROCKETRIDE_ value but the settings', () => {
	const keys = heldKeys({
		ANTHROPIC_API_KEY: FAKE_ANTHROPIC,
		ROCKETRIDE_OPENAI_KEY: FAKE_OPENAI,
		ROCKETRIDE_DB_BROKER_TOKEN: 'broker-token-value',
		ROCKETRIDE_ANTHROPIC_KEYS: 'a-key-under-a-misspelled-name',
		ROCKETRIDE_SHORT_KEY: 'x',
		ROCKETRIDE_BUILD_ROOT: '/home/someone/checkout/build',
		PATH: '/bin',
	});
	assert.deepEqual(
		keys.map((k) => k.name),
		['ROCKETRIDE_ANTHROPIC_KEY', 'ROCKETRIDE_OPENAI_KEY', 'ROCKETRIDE_DB_BROKER_TOKEN', 'ROCKETRIDE_ANTHROPIC_KEYS']
	);
});

test('the scrubber names a held key, blanks other key shapes, and keeps canaries', () => {
	const s = new Scrubber([{ name: 'ROCKETRIDE_ANTHROPIC_KEY', value: FAKE_ANTHROPIC }]).keeping([CANARY]);
	const out = s.scrub(`held ${FAKE_ANTHROPIC} other ${FAKE_OPENAI} canary ${CANARY}`);
	assert.equal(out, `held [redacted ROCKETRIDE_ANTHROPIC_KEY] other [redacted] canary ${CANARY}`);
});

test('withoutKeys leaves the dev servers no key under any name, and keeps the rest', () => {
	const env = withoutKeys({ ANTHROPIC_API_KEY: FAKE_ANTHROPIC, ROCKETRIDE_OPENAI_KEY: FAKE_OPENAI, ROCKETRIDE_BUILD_ROOT: '/home/someone/checkout/build', PATH: '/bin' });
	assert.deepEqual(env, { ROCKETRIDE_BUILD_ROOT: '/home/someone/checkout/build', PATH: '/bin' });
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
