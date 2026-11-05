// =============================================================================
// MIT License
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
// CONNECTION SAFETY LEVEL — stored on the saved connection, both mounts
// =============================================================================
//
// How much a connection asks before a statement that changes something runs
// is a field of the SAVED CONNECTION RECORD (`safety`), so it persists per
// user per server in both mounts: the full app and a dev tool write the same
// file, and a dev-tool frame's own preferences last only for the session.
// The record's owner checks every record a frame hands it; an unknown level
// is refused rather than stored. An absent level reads as the default,
// "Ask before risky writes".
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ExplorerToolError } from 'shared/explorer/errors';
import { getSavedConnections } from '../src/connect';
import type { SavedSqlConnection } from '../src/connect';
import { DEFAULT_SAFETY_LEVEL, SAFETY_LEVELS, isSafetyLevel, safetyLevelOf } from '../src/connect/savedConnections';
import { checkSavedConnection } from '../src/sqlCore';
import { SQL_OP_TIMEOUT_MS } from '../src/sqlTimeouts';
import { DIRECT, PIPELINE, rig } from './devtoolRig';
import { until } from './realm';

const editor = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'NewConnectionModal.tsx'), 'utf8');

describe('the safety level values', () => {
	it('are off, risky and every, and the default is risky', () => {
		assert.deepEqual([...SAFETY_LEVELS], ['off', 'risky', 'every']);
		assert.equal(DEFAULT_SAFETY_LEVEL, 'risky');
		for (const level of SAFETY_LEVELS) assert.equal(isSafetyLevel(level), true);
		for (const value of ['', 'Every', 'always', null, undefined, 1]) assert.equal(isSafetyLevel(value), false, String(value));
	});

	it('a record without a level, or no record at all, reads as the default', () => {
		assert.equal(safetyLevelOf(PIPELINE), 'risky');
		assert.equal(safetyLevelOf(null), 'risky');
		assert.equal(safetyLevelOf({ ...PIPELINE, safety: 'every' }), 'every');
		assert.equal(safetyLevelOf({ ...DIRECT, safety: 'off' }), 'off');
	});

	it('a stored value that is not a level reads as the default, never as off', () => {
		assert.equal(safetyLevelOf({ ...PIPELINE, safety: 'nope' } as unknown as SavedSqlConnection), 'risky');
	});
});

describe('checkSavedConnection and the level', () => {
	it('keeps a known level on either kind of record', () => {
		for (const safety of SAFETY_LEVELS) {
			assert.equal(checkSavedConnection({ ...PIPELINE, safety }).safety, safety);
			assert.equal(checkSavedConnection({ ...DIRECT, safety }).safety, safety);
		}
	});

	it('accepts a record with no level (older records, older builds)', () => {
		assert.equal(checkSavedConnection({ ...PIPELINE }).safety, undefined);
	});

	it('refuses an unknown level, naming the field', () => {
		for (const safety of ['paranoid', 'Risky', '', 0, null, true]) {
			assert.throws(
				() => checkSavedConnection({ ...PIPELINE, safety }),
				(error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid' && /'safety'/.test(error.message),
				String(safety),
			);
		}
	});
});

describe('the level round-trips through a dev tool\'s save', () => {
	it('a frame\'s save carries the level into the list and the file; a frame reads it back', async () => {
		const r = await rig();
		try {
			await until(() => getSavedConnections().length === 2, 'the list');
			await r.env.saveConnection({ ...PIPELINE, id: 'c-safe', name: 'Safe', safety: 'every' });
			await until(() => getSavedConnections().some((c) => c.id === 'c-safe'), 'the save');
			assert.equal(getSavedConnections().find((c) => c.id === 'c-safe')?.safety, 'every');
			const writes = r.engine.requests.filter((request) => request.op === 'client.fsWriteJson');
			const written = (writes[writes.length - 1]?.params as { value: SavedSqlConnection[] }).value;
			assert.equal(written.find((c) => c.id === 'c-safe')?.safety, 'every');
			assert.equal((await r.env.getConnection('c-safe'))?.safety, 'every');
		} finally {
			r.dispose();
		}
	});

	it('a frame\'s save with an unknown level is refused and writes nothing', async () => {
		const r = await rig();
		try {
			await until(() => getSavedConnections().length === 2, 'the list');
			const owner = r.frame.owner();
			await assert.rejects(
				r.frame.caller.callReply('sql.saveConnection', { connection: { ...PIPELINE, id: 'c-bad', safety: 'paranoid' } as unknown as SavedSqlConnection, owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.saveConnection'] }),
				(error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid',
			);
			assert.equal(getSavedConnections().some((c) => c.id === 'c-bad'), false);
			assert.equal(r.engine.ops().includes('client.fsWriteJson'), false);
		} finally {
			r.dispose();
		}
	});
});

describe('the connection editor carries the level', () => {
	it('shows the edited record\'s live level, or the default for a new one, until the user picks one', () => {
		assert.match(editor, /const safetyChoice = editorSafetyChoice\(editing === null \? null : safetyLevelOf\(editing\), pickedSafety\);/);
	});

	it('puts the level on the record of both save paths, which rebuild it from the form', () => {
		const records = [...editor.matchAll(/const record: SavedSqlConnection = \{([\s\S]*?)\n\t*\};/g)].map((m) => m[1] as string);
		assert.equal(records.length, 2, 'the pipeline and the direct save');
		for (const body of records) assert.match(body, /\n\t*safety,(?:\n|$)/);
	});

	it('offers the three levels in plain words, never as a "safe mode"', () => {
		assert.match(editor, /Safety level for this connection/);
		for (const label of ["Don't ask", 'Ask before risky writes', 'Ask before every write']) assert.ok(editor.includes(label), label);
		assert.doesNotMatch(editor, /safe mode/i);
		assert.match(editor, /this setting only adds questions/);
	});

	it('says what "every write" covers the way the classifier reads statements', () => {
		assert.ok(editor.includes('Anything that is not SELECT, EXPLAIN, SHOW or DESCRIBE. A WITH … SELECT counts as SELECT, and so does a SELECT that calls a function.'));
	});

	it('says that a write inside a function or procedure is not seen at "Ask before risky writes"', () => {
		assert.ok(editor.includes('A write inside a function or procedure (SELECT my_fn(), CALL, DO, COPY … PROGRAM) is not seen.'));
		const readme = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');
		assert.match(readme, /A write made inside a function or procedure is not seen at \*\*Ask before risky writes\*\*: `SELECT my_fn\(\)`, `DO`, `CALL` and `COPY … PROGRAM`/);
		assert.match(readme, /a `SELECT` that calls a function counts as a read even at \*\*Ask before every write\*\*/);
	});
});
