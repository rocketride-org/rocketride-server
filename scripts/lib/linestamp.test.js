/**
 * Tests for the log line stamper (linestamp.js).
 *
 * Run:
 *     node --test scripts/lib/linestamp.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { createLineStamper } = require('./linestamp');

const fixed = () => new Date('2026-11-06T01:02:03.456Z');
const T = '2026-11-06T01:02:03.456Z';

function collect() {
	const out = [];
	return { out, write: (text) => out.push(text) };
}

test('stamps every line of a chunk', () => {
	const sink = collect();
	const stamper = createLineStamper(sink, fixed);
	stamper.write(Buffer.from('a\r\nb\n'));
	assert.deepStrictEqual(sink.out, [`${T} a\n${T} b\n`]);
});

test('holds a partial line until its newline arrives', () => {
	const sink = collect();
	const stamper = createLineStamper(sink, fixed);
	stamper.write('par');
	assert.deepStrictEqual(sink.out, []);
	stamper.write('tial\nnext');
	assert.deepStrictEqual(sink.out, [`${T} partial\n`]);
	stamper.end();
	assert.deepStrictEqual(sink.out, [`${T} partial\n`, `${T} next\n`]);
});

test('end() with nothing held writes nothing', () => {
	const sink = collect();
	const stamper = createLineStamper(sink, fixed);
	stamper.write('x\n');
	stamper.end();
	assert.strictEqual(sink.out.length, 1);
});
