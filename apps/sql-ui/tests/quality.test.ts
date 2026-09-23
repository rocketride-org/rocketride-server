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
// SCHEMA QUALITY — unit tests for the three snapshot-only rules
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ISqlSchemaResponse } from '../src/connect';
import { RULE_LABELS, normaliseType, runSchemaChecks } from '../src/schema/quality';

// =============================================================================
// TYPE NORMALISATION
// =============================================================================

describe('normaliseType', () => {
	it('ignores case, spacing and parenthesised arguments', () => {
		assert.equal(normaliseType('int(11)'), 'INT');
		assert.equal(normaliseType('  varchar( 255 ) '), 'VARCHAR');
		assert.equal(normaliseType('DECIMAL(10, 2)'), 'DECIMAL');
	});

	it('resolves the exact aliases the engines treat as identical', () => {
		assert.equal(normaliseType('INTEGER'), normaliseType('int'));
		assert.equal(normaliseType('character varying(80)'), normaliseType('VARCHAR(80)'));
		assert.equal(normaliseType('double precision'), normaliseType('DOUBLE'));
		assert.equal(normaliseType('bool'), 'BOOLEAN');
	});

	it('keeps genuinely different types apart', () => {
		assert.notEqual(normaliseType('INT'), normaliseType('BIGINT'));
		assert.notEqual(normaliseType('TEXT'), normaliseType('VARCHAR(255)'));
	});
});

// =============================================================================
// RULES
// =============================================================================

describe('runSchemaChecks', () => {
	it('reports nothing for an empty or errored snapshot', () => {
		assert.deepEqual(runSchemaChecks(null), []);
		assert.deepEqual(runSchemaChecks({ error: 'boom' }), []);
	});

	it('R1 warns for a table with no primary key', () => {
		const schema: ISqlSchemaResponse = {
			tables: {
				audit_log: { columns: [{ column: 'id', type: 'BIGINT' }] },
				customers: { columns: [{ column: 'id', type: 'BIGINT' }], primary_key: ['id'] },
			},
		};
		const findings = runSchemaChecks(schema, 'mysql');
		assert.equal(findings.length, 1);
		assert.equal(findings[0]?.rule, 'R1');
		assert.equal(findings[0]?.table, 'audit_log');
		assert.equal(findings[0]?.severity, 'warning');
	});

	it('R1 drops to information on ClickHouse, which reflects no primary key', () => {
		const schema: ISqlSchemaResponse = {
			tables: {
				events: { columns: [{ column: 'ts', type: 'DateTime' }] },
				hits: { columns: [{ column: 'ts', type: 'DateTime' }] },
			},
		};
		const findings = runSchemaChecks(schema, 'clickhouse');
		assert.equal(findings.length, 2);
		assert.equal(findings.every((f) => f.severity === 'info'), true);
		assert.equal(findings[0]?.message, 'ClickHouse reflects no primary-key constraint, so this says nothing about the table.');
		// Nothing on a ClickHouse schema should reach the tab badge.
		assert.equal(findings.filter((f) => f.severity === 'warning').length, 0);
	});

	it('names every rule in words, so a grid column can be read', () => {
		assert.deepEqual(RULE_LABELS, {
			R1: 'No primary key',
			R2: 'Type strings differ',
			R3: 'Dangling foreign key',
		});
	});

	it('R3 fires for a key pointing at a table missing from the snapshot', () => {
		const findings = runSchemaChecks({
			tables: {
				orders: {
					columns: [{ column: 'id', type: 'INT' }, { column: 'customer_id', type: 'INT' }],
					primary_key: ['id'],
					foreign_keys: [{ columns: ['customer_id'], referred_table: 'customers', referred_columns: ['id'] }],
				},
			},
		});
		assert.equal(findings.length, 1);
		assert.equal(findings[0]?.rule, 'R3');
		assert.equal(findings[0]?.evidence, 'customers missing');
	});

	it('R3 fires for a key pointing at a missing COLUMN of a present table', () => {
		const findings = runSchemaChecks({
			tables: {
				customers: { columns: [{ column: 'id', type: 'INT' }], primary_key: ['id'] },
				orders: {
					columns: [{ column: 'id', type: 'INT' }, { column: 'customer_id', type: 'INT' }],
					primary_key: ['id'],
					foreign_keys: [{ columns: ['customer_id'], referred_table: 'customers', referred_columns: ['uuid'] }],
				},
			},
		});
		assert.deepEqual(findings.map((f) => f.rule), ['R3']);
		assert.equal(findings[0]?.evidence, 'customers.uuid missing');
	});

	it('R2 reports a real type difference as information, not a problem', () => {
		const findings = runSchemaChecks({
			tables: {
				customers: { columns: [{ column: 'id', type: 'BIGINT' }], primary_key: ['id'] },
				orders: {
					columns: [{ column: 'id', type: 'INT' }, { column: 'customer_id', type: 'INT(11)' }],
					primary_key: ['id'],
					foreign_keys: [{ columns: ['customer_id'], referred_table: 'customers', referred_columns: ['id'] }],
				},
			},
		});
		assert.equal(findings.length, 1);
		assert.equal(findings[0]?.rule, 'R2');
		assert.equal(findings[0]?.severity, 'info');
		assert.equal(findings[0]?.evidence, 'INT(11) -> BIGINT');
	});

	it('R2 stays quiet when the two spellings mean the same type', () => {
		const findings = runSchemaChecks({
			tables: {
				customers: { columns: [{ column: 'id', type: 'INTEGER' }], primary_key: ['id'] },
				orders: {
					columns: [{ column: 'id', type: 'INT' }, { column: 'customer_id', type: 'int(11)' }],
					primary_key: ['id'],
					foreign_keys: [{ columns: ['customer_id'], referred_table: 'customers', referred_columns: ['id'] }],
				},
			},
		});
		assert.deepEqual(findings, []);
	});

	it('compares every column pair of a composite key', () => {
		const findings = runSchemaChecks({
			tables: {
				orders: {
					columns: [{ column: 'tenant_id', type: 'INT' }, { column: 'no', type: 'BIGINT' }],
					primary_key: ['tenant_id', 'no'],
				},
				shipments: {
					columns: [{ column: 'tenant_id', type: 'INT' }, { column: 'order_no', type: 'INT' }],
					primary_key: ['tenant_id'],
					foreign_keys: [{
						columns: ['tenant_id', 'order_no'],
						referred_table: 'orders',
						referred_columns: ['tenant_id', 'no'],
					}],
				},
			},
		});
		// Only the second pair differs.
		assert.deepEqual(findings.map((f) => [f.rule, f.column]), [['R2', 'order_no']]);
	});

	it('never invents a relationship from a column name', () => {
		const findings = runSchemaChecks({
			tables: {
				customers: { columns: [{ column: 'id', type: 'INT' }], primary_key: ['id'] },
				// customer_id looks like a key and is not declared as one.
				audit_log: { columns: [{ column: 'customer_id', type: 'INT' }], primary_key: ['customer_id'] },
			},
		});
		assert.deepEqual(findings, []);
	});

	it('puts warnings before information', () => {
		const findings = runSchemaChecks({
			tables: {
				customers: { columns: [{ column: 'id', type: 'BIGINT' }], primary_key: ['id'] },
				orders: {
					columns: [{ column: 'customer_id', type: 'INT' }],
					foreign_keys: [{ columns: ['customer_id'], referred_table: 'customers', referred_columns: ['id'] }],
				},
			},
		}, 'mysql');
		assert.deepEqual(findings.map((f) => f.rule), ['R1', 'R2']);
		assert.equal(findings[0]?.severity, 'warning');
		assert.equal(findings[1]?.severity, 'info');
	});
});
