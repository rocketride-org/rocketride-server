// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * A node packages as <name>/... with its .rrnode marker, without build inputs,
 * and with the same digest every time. Run: node --test nodes/scripts/tasks.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const AdmZip = require('adm-zip');

const { packageNode } = require('./tasks');

function makeNode() {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-node-')), 'demo');
	const write = (file, text) => {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), text);
	};
	write('services.json', '{\n\t// a comment\n\t"protocol": "demo://", "icon": "demo.svg", "maximum": 1.0\n}');
	write('demo.svg', '<svg/>');
	write('IGlobal.py', 'class IGlobal: pass\n');
	write('__pycache__/IGlobal.cpython-312.pyc', 'x');
	write('src/main.cpp', 'int main() {}');
	return dir;
}

test('a package holds the node, its marker, and no build inputs', async () => {
	const { data } = await packageNode('demo', makeNode());
	const names = new AdmZip(data).getEntries().map((e) => e.entryName);
	assert.deepStrictEqual(names.sort(), ['demo/.rrnode', 'demo/IGlobal.py', 'demo/demo.svg', 'demo/services.json']);
});

test('the index entry carries each definition as plain JSON text by file, and the icons inline', async () => {
	const { entry } = await packageNode('demo', makeNode());
	const text = entry.services['services.json'];
	assert.deepStrictEqual(Object.keys(entry.services), ['services.json']);
	assert.deepStrictEqual(JSON.parse(text), { protocol: 'demo://', icon: 'demo.svg', maximum: 1 });
	assert.ok(!text.includes('a comment'));
	assert.ok(text.includes('1.0'));
	assert.deepStrictEqual(entry.icons, { 'demo.svg': '<svg/>' });
});

test('the same node gives the same digest on another build', async () => {
	const first = (await packageNode('demo', makeNode())).entry.sha256;
	await new Promise((resolve) => setTimeout(resolve, 2100));
	const second = (await packageNode('demo', makeNode())).entry.sha256;
	assert.strictEqual(first, second);
});
