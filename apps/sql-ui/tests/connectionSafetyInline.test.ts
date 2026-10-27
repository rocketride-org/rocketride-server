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
// SAFETY LEVEL, CHANGED IN PLACE — only the level crosses, never the config
// =============================================================================
//
// The safety level could only be changed in the connection editor, which
// rebuilds and re-validates the whole record: on a direct connection that
// means a full node config, password included, and a required field left
// empty (a trust-auth PostgreSQL user) blocks the save. The Query page now
// changes the level in place through its own owned call, which carries the
// connection id and the level only. The record's owner sets that one field on
// the record it already holds, so the stored config (secrets included) is
// never sent, shown or rebuilt for it.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ExplorerToolError } from 'shared/explorer/errors';
import { account } from 'shared/explorer/devtool/testing';
import type { IPrefsAccessor } from 'shared/explorer/history/types';
import { SQL_APP_ID } from '../src/appId';
import { getSavedConnections, resetSavedConnections } from '../src/connect';
import type { DirectConnection, SavedSqlConnection } from '../src/connect';
import { createSqlCore } from '../src/sqlCore';
import { createLocalSqlEnv } from '../src/localEnv';
import { SQL_OP_TIMEOUT_MS } from '../src/sqlTimeouts';
import { isSafetyDowngrade, safetyDowngradeCopy } from '../src/sql/safety';
import { DIRECT, PIPELINE, postgres, rig } from './devtoolRig';
import { taskRow } from './support';
import { USER, engineScript, scriptedClientRealm, until } from './realm';

const OTHER_USER = account('u2', 'org-1', 'team-1');

const SECRET = 's3cret-do-not-send';
const WITH_SECRET: DirectConnection = { ...DIRECT, config: { host: 'db.internal', password: SECRET } };
const read = (...parts: string[]): string => fs.readFileSync(path.resolve(__dirname, '..', ...parts), 'utf8');

/**
 * The record a list holds for an id.
 *
 * @param id - The connection id.
 * @returns The record.
 */
function saved(id: string): SavedSqlConnection | undefined {
	return getSavedConnections().find((c) => c.id === id);
}

describe('setting the level as a dev tool (sql.setConnectionSafety)', () => {
	it('sets the level on the stored record and keeps everything else, the secret included', async () => {
		const r = await rig({ saved: [PIPELINE, WITH_SECRET] });
		try {
			await until(() => getSavedConnections().length === 2, 'the list');
			await r.env.setConnectionSafety('c-direct', 'every');
			await until(() => saved('c-direct')?.safety === 'every', 'the level');
			assert.deepEqual(saved('c-direct'), { ...WITH_SECRET, safety: 'every' });
			const writes = r.engine.requests.filter((request) => request.op === 'client.fsWriteJson');
			const written = (writes[writes.length - 1]?.params as { value: SavedSqlConnection[] }).value;
			assert.deepEqual(written.find((c) => c.id === 'c-direct'), { ...WITH_SECRET, safety: 'every' });
		} finally {
			r.dispose();
		}
	});

	it('the call carries the id and the level only: the config never travels with it', async () => {
		const r = await rig({ saved: [PIPELINE, WITH_SECRET] });
		try {
			await until(() => getSavedConnections().length === 2, 'the list');
			await r.env.setConnectionSafety('c-direct', 'off');
			const calls = r.h.wire.filter((entry) => JSON.stringify(entry.value).includes('sql.setConnectionSafety'));
			assert.ok(calls.length > 0, 'the call crossed the wire');
			for (const entry of calls) assert.ok(!JSON.stringify(entry.value).includes(SECRET), 'no secret in the call or its reply');
		} finally {
			r.dispose();
		}
	});

	it('writes nothing when the level is already set', async () => {
		const r = await rig({ saved: [PIPELINE, { ...WITH_SECRET, safety: 'every' }] });
		try {
			await until(() => getSavedConnections().length === 2, 'the list');
			await r.env.setConnectionSafety('c-direct', 'every');
			assert.equal(r.engine.ops().includes('client.fsWriteJson'), false);
		} finally {
			r.dispose();
		}
	});

	it('refuses an unknown level, an unknown connection, and a frame of another account, writing nothing', async () => {
		const r = await rig({ saved: [PIPELINE, WITH_SECRET] });
		try {
			await until(() => getSavedConnections().length === 2, 'the list');
			const call = (params: { connId: string; safety: unknown; owner: string | null }) => r.frame.caller.callReply('sql.setConnectionSafety', params as never, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.setConnectionSafety'] });
			const owner = r.frame.owner();
			await assert.rejects(call({ connId: 'c-direct', safety: 'paranoid', owner }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			await assert.rejects(call({ connId: 'c-none', safety: 'every', owner }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			await assert.rejects(call({ connId: 'c-direct', safety: 'every', owner: 'someone-else' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
			assert.equal(saved('c-direct')?.safety, undefined);
			assert.equal(r.engine.ops().includes('client.fsWriteJson'), false);
		} finally {
			r.dispose();
		}
	});
});

describe('setting the level in the full app', () => {
	it('goes straight to the core, which keeps the stored config', async () => {
		resetSavedConnections({ force: true });
		const engine = scriptedClientRealm(engineScript([WITH_SECRET], [taskRow('p1')], postgres));
		const core = createSqlCore({ cm: engine.cm, appId: SQL_APP_ID, mode: 'app', focusTarget: null });
		const prefs: IPrefsAccessor = { getPref: () => undefined, setPref: () => undefined };
		const env = createLocalSqlEnv(core, true, () => undefined, prefs);
		try {
			engine.realm.login(USER);
			await until(() => getSavedConnections().length === 1, 'the saved list');
			await env.setConnectionSafety('c-direct', 'every');
			assert.deepEqual(saved('c-direct'), { ...WITH_SECRET, safety: 'every' });
		} finally {
			core.dispose();
		}
	});
});

describe('setting the level in the full app when the account changes', () => {
	it('is refused like a save: both are pinned to the account signed in when they were asked', async () => {
		resetSavedConnections({ force: true });
		const engine = scriptedClientRealm(engineScript([WITH_SECRET], [taskRow('p1')], postgres));
		// The account's saved list is slow to read: both changes wait for it.
		const answer = engine.script['client.fsReadJson']!;
		const waiting: Array<() => void> = [];
		engine.script['client.fsReadJson'] = (params) => new Promise((resolve) => { waiting.push(() => resolve(answer(params))); });
		const core = createSqlCore({ cm: engine.cm, appId: SQL_APP_ID, mode: 'app', focusTarget: null });
		try {
			engine.realm.login(USER);
			await until(() => waiting.length > 0, 'the first account\'s list read');
			const setting = core.setConnectionSafety('c-direct', 'off');
			const saving = core.saveConnection({ ...WITH_SECRET, name: 'Renamed' });
			// Another account signs in; its list reads at once.
			engine.script['client.fsReadJson'] = answer;
			engine.realm.logout();
			engine.realm.login(OTHER_USER);
			waiting.splice(0).forEach((go) => go());
			const kindOf = async (work: Promise<unknown>): Promise<string> => work.then(() => 'saved', (error: unknown) => (error instanceof ExplorerToolError ? error.kind : 'other'));
			const [setKind, saveKind] = await Promise.all([kindOf(setting), kindOf(saving)]);
			assert.equal(setKind, 'stale');
			assert.equal(setKind, saveKind, 'the same pin as a save');
			assert.equal(saved('c-direct')?.safety, undefined);
			assert.equal(engine.requests.some((q) => q.op === 'client.fsWriteJson'), false, 'nothing was written');
		} finally {
			core.dispose();
		}
	});
});

describe('the Query page offers the level in place', () => {
	const view = read('src', 'views', 'QueryView.tsx');
	const dialog = read('src', 'components', 'SafetyDowngradeDialog.tsx');

	it('is a button that opens a menu of the three levels: arrow keys on it change nothing', () => {
		assert.doesNotMatch(view, /<select/, 'a closed native select commits a value on every arrow key');
		assert.match(view, /ariaExpanded=\{safetyMenuOpen\}/);
		assert.match(view, /\{`Safety: \$\{SAFETY_CHOICES\[shownSafety\]\}`\}/);
		assert.match(view, /aria-label="Safety level for this connection"/);
		assert.match(view, /SAFETY_LEVELS\.map\(\(level\) => \(/);
		assert.match(view, /onClick=\{\(\) => chooseSafety\(level\)\}/);
	});

	it('asks before a lower level, and only a confirmed choice is saved, with the connection id only', () => {
		assert.match(view, /if \(isSafetyDowngrade\(safety, level\)\) \{\s*setConfirmSafety\(level\);\s*return;\s*\}/);
		assert.match(view, /<SafetyDowngradeDialog[\s\S]*?onConfirm=\{\(\) => \{[\s\S]*?commitSafety\(level\);/);
		assert.match(view, /env\.setConnectionSafety\(connId, next\)/);
		assert.equal((view.match(/env\.setConnectionSafety\(/g) ?? []).length, 1, 'one place saves the level');
		assert.doesNotMatch(view, /saveConnection\(/, 'the page never rebuilds or resends the record');
	});

	it('the downgrade dialog starts on Cancel, the button does not take focus back under it, and Cancel changes nothing', () => {
		const choose = /const chooseSafety = useCallback\(\(level: SafetyLevel\): void => \{([\s\S]*?)\}, \[/.exec(view)?.[1] ?? '';
		const asks = choose.indexOf('setConfirmSafety(level)');
		assert.ok(asks > 0);
		assert.ok(!choose.slice(choose.indexOf('if (isSafetyDowngrade'), asks).includes('focusSafetyButton'), 'no focus move before the dialog opens');
		assert.match(dialog, /focusCancelIn\(anchorRef\.current\)/);
		assert.match(view, /onCancel=\{\(\) => \{\s*setConfirmSafety\(null\);\s*focusSafetyButton\(\);\s*\}\}/);
	});

	it('keeps focus: the button is never disabled while saving, focus returns to it from the menu and the dialog, and after the save if focus was lost', () => {
		assert.doesNotMatch(view, /disabled=\{[^}]*savingSafety/);
		assert.match(view, /if \(savingSafety \|\| level === safety\) \{\s*focusSafetyButton\(\);\s*return;\s*\}/);
		assert.match(view, /if \(document\.activeElement === null \|\| document\.activeElement === document\.body\) focusSafetyButton\(\);/);
	});

	it('a pending level never sticks: it clears on failure, and after a short grace once the save succeeded, asking the owner once', () => {
		assert.match(view, /setPendingSafety\(null\);\s*announce\(`The safety level was not changed/);
		assert.match(view, /safetySyncTimerRef\.current = setTimeout\(\(\) => \{\s*void env\.getConnection\(connId\)\.then\(/);
		assert.match(view, /\(record\) => setAskedSafety\(record === null \? null : \{ level: safetyLevelOf\(record\), against: connectionRecordRef\.current \}\),/);
		assert.match(view, /\.finally\(\(\) => setPendingSafety\(null\)\);/);
		// The owner's answer is the level in force until the copy catches up, and
		// the runner asks by it too.
		assert.match(view, /const safety = enforcedSafety\(connectionRecord, askedSafety\);/);
		assert.match(view, /return \(\) => \{ if \(safetySyncTimerRef\.current !== null\) clearTimeout\(safetySyncTimerRef\.current\); \};/);
	});

	it('says why it is unavailable when there is no saved record to change', () => {
		assert.match(view, /gateReason=\{safetyGate\}/);
		assert.match(view, /'Reading the saved connection…'/);
		assert.match(view, /'This connection is not saved, so its level cannot be changed here\.'/);
	});

	it('the remote env sends the id, the level and the owner, nothing else', () => {
		assert.match(read('src', 'sqlEnv.ts'), /caller\.callReply\('sql\.setConnectionSafety', \{ connId, safety, owner: owner\(\) \}/);
	});

	it('the README says where the level can be changed, and that lowering it asks', () => {
		const prose = read('README.md').replace(/\s+/g, ' ');
		assert.match(prose, /The line under the editor names the level and changes it in place: only the level is sent, so a direct connection's password is neither re-typed nor sent again\. Lowering the level asks first, from the Query page or the connection editor\./);
	});
});

describe('isSafetyDowngrade and its question', () => {
	it('is a downgrade only toward asking less', () => {
		assert.equal(isSafetyDowngrade('risky', 'off'), true);
		assert.equal(isSafetyDowngrade('every', 'risky'), true);
		assert.equal(isSafetyDowngrade('every', 'off'), true);
		assert.equal(isSafetyDowngrade('off', 'risky'), false);
		assert.equal(isSafetyDowngrade('risky', 'every'), false);
		assert.equal(isSafetyDowngrade('risky', 'risky'), false);
	});

	it('asks in plain words what the lower level lets through', () => {
		assert.deepEqual(safetyDowngradeCopy('off', 'Shop Postgres'), {
			title: 'Never ask before writes on Shop Postgres?',
			message: 'Every statement will run as typed, DROP and TRUNCATE included, in every document of this connection. The node\'s allow_execute still decides what may run at all.',
			confirmLabel: "Don't ask",
		});
		assert.deepEqual(safetyDowngradeCopy('risky', 'Shop Postgres'), {
			title: 'Ask only before risky writes on Shop Postgres?',
			message: 'A bounded UPDATE or DELETE, an INSERT, a CALL and similar statements will run without asking, in every document of this connection. DROP, TRUNCATE, ALTER and an UPDATE or DELETE without WHERE still ask.',
			confirmLabel: 'Ask before risky writes',
		});
	});
});
