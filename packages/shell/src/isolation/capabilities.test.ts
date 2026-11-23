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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// CAPABILITY TABLE TESTS — T2, T3
// =============================================================================
//
// T2: the table is well formed (known capabilities, ops and type names), and
//     loading a table with an unknown type name throws.
// T3: no-row guard — every DAP command the SDK client can send either has a
//     row or is on this test's own denied list (design section 8).
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadTable, matchRow, rowFor } from './capabilities';
import { readCapabilityJson, SHELL_ROOT } from './__test__/util';

const KNOWN_CAPS = ['core', 'pipelines.run', 'fs.app'];
const KNOWN_OPS = ['client.request', 'client.addMonitor', 'client.removeMonitor', 'shell.frameToken.refresh', 'shell.notify', 'shell.statusMessage', 'shell.loginRequest', 'shell.openExternal', 'shell.prefs.attach', 'shell.setPref'];
/** The type names of plan section 4.3. */
const BASE_TYPES = ['string', 'int', 'int<=3600', 'bool', 'string[]', 'json', 'object', 'object:mint-project', 'object:handle-project', 'empty-array', 'empty-object', 'bytes<=8MiB', 'run-handle', 'owned-pipe', 'owned-fs-handle', 'app-path', 'app-partition', 'https-url', 'minted-project', 'monitor-key:run-handle', "'r'|'w'", 'r|w'];
const isKnownType = (name: string): boolean => (name.startsWith('optional:') ? BASE_TYPES.includes(name.slice('optional:'.length)) : BASE_TYPES.includes(name));

test('T2 the capability table has known capabilities, ops and type names; an unknown type name fails the load', () => {
	const json = readCapabilityJson();

	// The production loader (a stub that throws on commit A).
	const table = loadTable(json);
	assert.ok(table.rows.length > 0, 'loadTable returned no rows');

	for (const row of json.rows) {
		const where = `${row.cap} ${row.op} ${row.command ?? ''}`;
		assert.ok(KNOWN_CAPS.includes(row.cap), `${where}: unknown capability ${row.cap}`);
		assert.ok(KNOWN_OPS.includes(row.op), `${where}: unknown op ${row.op}`);
		for (const [arg, type] of Object.entries(row.args)) {
			assert.ok(isKnownType(type), `${where}: argument ${arg} has unknown type name ${JSON.stringify(type)}`);
		}
		if (row.top !== undefined) {
			assert.ok(row.top.length === 0 || (row.top.length === 1 && row.top[0] === 'token'), `${where}: top must be [] or ["token"], got ${JSON.stringify(row.top)}`);
		}
		// Each declared subcommand resolves to its own row; a row without subcommands resolves strictly.
		for (const sub of row.subcommands ?? [undefined]) {
			const found = matchRow(row.op, row.command, sub);
			assert.ok(found && found.cap === row.cap && (sub === undefined ? found.subcommands === undefined : found.subcommands?.includes(sub) === true), `${where} ${sub ?? ''}: matchRow does not find this row`);
			assert.ok(rowFor(row.op, row.command, sub), `${where} ${sub ?? ''}: rowFor finds no row for a row of the table`);
		}
	}

	assert.throws(() => loadTable({ v: 1, rows: [{ cap: 'core', op: 'client.request', command: 'rrext_ping', args: { x: 'no-such-type' } }] }), /no-such-type|unknown type/i, 'an unknown type name must fail the load');
});

// =============================================================================
// T3 — no-row guard
// =============================================================================

/**
 * Commands and subcommands the platform refuses in v1 (design section 8). Kept
 * here, not in production code, so a new SDK command fails this test until it
 * gets either a row or a line here.
 */
const DENIED_COMMANDS = new Set(['auth', 'deauth', 'rrext_identify', 'rrext_dashboard', 'rrext_list_connections', 'rrext_list_tasks', 'rrext_get_tasks', 'rrext_services', 'rrext_validate', 'rrext_resolve_config', 'rrext_log', 'rrext_app', 'rrext_saas', 'rrext_billing_rates', 'rrext_deploy_app', 'rrext_public_probe', 'rrext_public_catalog']);
const DENIED_PREFIXES = ['rrext_account_', 'rrext_cprofile_', 'rrext_deploy', 'rrext_public_', 'rrext_billing_'];
/** `rrext_deploy_app` subcommands, which the regexes also pick up. */
const DEPLOY_SUBCOMMANDS = new Set(['versions', 'submit', 'withdraw', 'reply', 'build_log', 'publish', 'remove', 'disable', 'where', 'developer_status', 'developer_register']);
/** Store and process subcommands the table allows (each has a row under its command). */
const ALLOWED_SUBCOMMANDS: Record<string, string[]> = {
	rrext_store: ['fs_stat', 'fs_list_dir', 'fs_open', 'fs_read', 'fs_write', 'fs_close', 'fs_mkdir', 'fs_delete', 'fs_rmdir', 'fs_rename', 'fs_get_json', 'fs_put_json'],
	rrext_process: ['open', 'write', 'close'],
};
/** Subcommands refused in v1. */
const DENIED_SUBCOMMANDS = new Set(['fs_geturl', 'fs_read_many', 'tool']);

/** The DAP command literals found in the SDK client, with the regexes of the plan. */
function sdkCommandLiterals(): Set<string> {
	const source = readFileSync(path.join(SHELL_ROOT, '..', 'client-typescript', 'src', 'client', 'client.ts'), 'utf8');
	const found = new Set<string>();
	for (const re of [/\bcall(?:<[^>]*>)?\('(\w+)'/g, /buildRequest\('(\w+)'/g, /command:\s*'(\w+)'/g]) {
		for (const match of source.matchAll(re)) found.add(match[1]);
	}
	return found;
}

test('T3 every DAP command in the SDK client has a row or is on the denied list', () => {
	// The first production call, so a missing implementation reads as the stub it is.
	assert.ok(rowFor('client.request', 'execute'), 'execute must have a row');

	const rowCommands = new Set(
		readCapabilityJson()
			.rows.filter((r) => r.op === 'client.request')
			.map((r) => r.command)
	);
	for (const denied of DENIED_COMMANDS) {
		assert.ok(!rowCommands.has(denied), `${denied} is on the denied list and also has a row`);
	}

	// A refused subcommand has no row under any command (the denied lists stay in step with the table).
	const tableSubcommands = new Set(readCapabilityJson().rows.flatMap((r) => r.subcommands ?? []));
	for (const denied of [...DENIED_SUBCOMMANDS, ...DEPLOY_SUBCOMMANDS]) {
		assert.ok(!tableSubcommands.has(denied), `${denied} is on the denied list and also has a table row`);
		assert.equal(rowFor('client.request', 'rrext_store', denied), undefined, `rrext_store ${denied} must have no row`);
		assert.equal(rowFor('client.request', 'rrext_process', denied), undefined, `rrext_process ${denied} must have no row`);
	}

	const literals = sdkCommandLiterals();
	assert.ok(literals.size >= 20, `expected the regexes to find the SDK commands, found ${literals.size}`);
	assert.ok(literals.has('execute') && literals.has('rrext_store'), 'the regexes must find execute and rrext_store');

	const uncovered: string[] = [];
	for (const literal of literals) {
		const isSubcommand = Object.values(ALLOWED_SUBCOMMANDS).some((subs) => subs.includes(literal));
		if (DENIED_COMMANDS.has(literal) || DENIED_PREFIXES.some((p) => literal.startsWith(p)) || DEPLOY_SUBCOMMANDS.has(literal) || DENIED_SUBCOMMANDS.has(literal)) continue;
		if (isSubcommand) {
			const command = Object.keys(ALLOWED_SUBCOMMANDS).find((c) => ALLOWED_SUBCOMMANDS[c].includes(literal))!;
			if (!rowFor('client.request', command, literal)) uncovered.push(`${command}/${literal}`);
			continue;
		}
		if (!rowFor('client.request', literal)) uncovered.push(literal);
	}
	assert.deepEqual(uncovered, [], `SDK commands with neither a row nor a denied-list entry: ${uncovered.join(', ')}`);
});
