import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe } from './probe.ts';

const g = globalThis as { __rrTelemetryProbe?: unknown };

test('without an installed probe (production) a step reports nothing and logs nothing', () => {
	delete g.__rrTelemetryProbe;
	const logged: unknown[] = [];
	const original = console.debug;
	console.debug = (...args: unknown[]) => { logged.push(args); };
	try {
		probe('replay', 'started');
	} finally {
		console.debug = original;
	}
	assert.deepEqual(logged, []);
});

test('an installed probe receives each step, and one that throws never breaks the caller', () => {
	const seen: string[] = [];
	g.__rrTelemetryProbe = (step: string, detail: string) => { seen.push(`${step} ${detail}`); };
	probe('replay', 'skipped lowmem');
	probe('web vitals', 'started');
	assert.deepEqual(seen, ['replay skipped lowmem', 'web vitals started']);
	g.__rrTelemetryProbe = () => { throw new Error('probe failed'); };
	assert.doesNotThrow(() => probe('replay', 'started'));
	delete g.__rrTelemetryProbe;
});
