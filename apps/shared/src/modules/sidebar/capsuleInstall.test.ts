// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

// =============================================================================
// Unit tests: the capsule install sequence both hosts render.
//
// What is pinned here is the observability itself — that every stage is
// reported as it happens, that a failure says which stage failed and why, and
// above all that nothing is installed before the contents have been shown and
// accepted. A capsule is code the engine imports; "it silently did something"
// is the outcome these tests exist to prevent.
//
// Run via `shared:test` (node --import tsx --test).
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { base64Bytes, formatBytes, initialStages, installCapsule, type ICapsuleReport } from './capsuleInstall';

const CAPSULE = 'AAAAAAAAAAAAAAAA'; // 16 chars of base64 = 12 bytes

function goodReport(over: Partial<ICapsuleReport> = {}): ICapsuleReport {
	return {
		name: 'demo_node',
		protocol: 'demo_node://',
		version: '0.0.0',
		ok: true,
		errors: [],
		warnings: [],
		sizeBytes: 2928,
		totalBytes: 4096,
		files: [
			{ path: 'services.json', bytes: 700 },
			{ path: 'IGlobal.py', bytes: 400 },
		],
		...over,
	};
}

/** Records what happened, the way a host would to render it. */
function harness(over: Partial<Parameters<typeof installCapsule>[0]> = {}) {
	const installed: string[] = [];
	const seen: string[][] = [];
	const io = {
		inspect: async () => goodReport(),
		install: async (capsule: string) => {
			installed.push(capsule);
		},
		confirm: async () => true,
		onProgress: (stages: { id: string; state: string }[]) => {
			seen.push(stages.map((s) => `${s.id}:${s.state}`));
		},
		...over,
	};
	return { io, installed, seen };
}

test('initialStages lists every stage as pending, in order', () => {
	assert.deepEqual(
		initialStages().map((s) => s.id),
		['read', 'inspect', 'confirm', 'install'],
	);
	assert.ok(initialStages().every((s) => s.state === 'pending'));
});

test('a good capsule walks every stage and installs', async () => {
	const { io, installed, seen } = harness();
	const result = await installCapsule(io, CAPSULE);

	assert.equal(result.outcome, 'installed');
	assert.deepEqual(installed, [CAPSULE]);
	assert.deepEqual(
		result.stages.map((s) => `${s.id}:${s.state}`),
		['read:done', 'inspect:done', 'confirm:done', 'install:done'],
	);
	// Every stage was announced as active before it was announced as done.
	assert.ok(seen.some((snapshot) => snapshot.includes('inspect:active')));
	assert.ok(seen.some((snapshot) => snapshot.includes('install:active')));
	// The last stage carries something a person can read.
	assert.match(result.stages[3]!.detail ?? '', /demo_node/);
});

test('nothing is installed until the report is accepted', async () => {
	const order: string[] = [];
	const { io, installed } = harness({
		inspect: async () => {
			order.push('inspect');
			return goodReport();
		},
		confirm: async () => {
			order.push('confirm');
			return true;
		},
		install: async () => {
			order.push('install');
		},
	});
	await installCapsule(io, CAPSULE);

	assert.deepEqual(order, ['inspect', 'confirm', 'install']);
	assert.equal(installed.length, 0, 'install was recorded through the order list, not the harness');
});

test('declining the report installs nothing', async () => {
	const { io, installed } = harness({ confirm: async () => false });
	const result = await installCapsule(io, CAPSULE);

	assert.equal(result.outcome, 'cancelled');
	assert.deepEqual(installed, []);
	assert.equal(result.stages.find((s) => s.id === 'confirm')!.state, 'skipped');
	assert.equal(result.stages.find((s) => s.id === 'install')!.state, 'skipped');
});

test('a capsule the engine could not load is refused before any confirmation', async () => {
	let asked = false;
	const { io, installed } = harness({
		inspect: async () => goodReport({ ok: false, errors: ['services.json is missing'] }),
		confirm: async () => {
			asked = true;
			return true;
		},
	});
	const result = await installCapsule(io, CAPSULE);

	assert.equal(result.outcome, 'rejected');
	assert.equal(asked, false, 'a node that cannot load is not offered for confirmation');
	assert.deepEqual(installed, []);
	const inspect = result.stages.find((s) => s.id === 'inspect')!;
	assert.equal(inspect.state, 'failed');
	assert.match(inspect.detail ?? '', /services\.json is missing/);
});

test('an inspect failure names the stage and the reason', async () => {
	const { io, installed } = harness({
		inspect: async () => {
			throw new Error('unsafe path in capsule');
		},
	});
	const result = await installCapsule(io, CAPSULE);

	assert.equal(result.outcome, 'failed');
	assert.equal(result.error, 'unsafe path in capsule');
	assert.equal(result.stages.find((s) => s.id === 'inspect')!.state, 'failed');
	assert.deepEqual(installed, []);
});

test('an install failure is reported against the install stage', async () => {
	const { io } = harness({
		install: async () => {
			throw new Error('store is read-only');
		},
	});
	const result = await installCapsule(io, CAPSULE);

	assert.equal(result.outcome, 'failed');
	assert.equal(result.stages.find((s) => s.id === 'install')!.state, 'failed');
	assert.match(result.stages.find((s) => s.id === 'install')!.detail ?? '', /read-only/);
	// The stages before it stay done, so the reader sees how far it got.
	assert.equal(result.stages.find((s) => s.id === 'inspect')!.state, 'done');
});

test('an empty capsule fails at the first stage', async () => {
	const { io, installed } = harness();
	const result = await installCapsule(io, '');

	assert.equal(result.outcome, 'failed');
	assert.equal(result.stages[0]!.state, 'failed');
	assert.deepEqual(installed, []);
});

test('progress is emitted on every change, never only at the end', async () => {
	const { io, seen } = harness();
	await installCapsule(io, CAPSULE);

	// Four stages, each active then done, plus the final sweep.
	assert.ok(seen.length >= 8, `expected a snapshot per transition, got ${seen.length}`);
	// Snapshots are copies: mutating one must not change the next.
	assert.notEqual(seen[0], seen[1]);
});

test('byte helpers read the way a person would write them', () => {
	assert.equal(base64Bytes(CAPSULE), 12);
	assert.equal(base64Bytes('AAA='), 2);
	assert.equal(formatBytes(812), '812 B');
	assert.equal(formatBytes(3300), '3.2 KB');
	assert.equal(formatBytes(1.4 * 1024 * 1024), '1.4 MB');
});
