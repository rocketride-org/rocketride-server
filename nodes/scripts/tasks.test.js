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

const crypto = require('node:crypto');

const { packageNode, syncNodes, NODES_CONTRACT } = require('./tasks');

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

test('a node packaged on Windows gives the digest built on Linux', async () => {
	const dir = makeNode();
	// '\\' and '/' sort differently against digits: util/x.py and util2.py swap if sorted unconverted
	fs.mkdirSync(path.join(dir, 'util'));
	fs.writeFileSync(path.join(dir, 'util', 'x.py'), '');
	fs.writeFileSync(path.join(dir, 'util2.py'), '');
	const linux = (await packageNode('demo', dir)).entry.sha256;

	// adm-zip reads the platform once, when it loads; load it again as Windows
	const platform = Object.getOwnPropertyDescriptor(process, 'platform');
	const fresh = () => {
		for (const key of Object.keys(require.cache)) {
			if (key.includes('adm-zip') || key.endsWith(path.join('scripts', 'tasks.js'))) delete require.cache[key];
		}
	};
	// And glob answers with Windows separators
	const globPath = require.resolve('glob');
	const { glob } = require('glob');
	const windowsGlob = async (...args) => (await glob(...args)).map((file) => file.split('/').join('\\'));
	try {
		Object.defineProperty(process, 'platform', { value: 'win32' });
		fresh();
		require.cache[globPath] = { id: globPath, filename: globPath, loaded: true, exports: { glob: windowsGlob } };
		const windows = (await require('./tasks').packageNode('demo', dir)).entry.sha256;
		assert.strictEqual(windows, linux);
	} finally {
		Object.defineProperty(process, 'platform', platform);
		delete require.cache[globPath];
		fresh();
	}
});

test('a node that imports another node lists it, but not itself', async () => {
	const dir = makeNode();
	fs.writeFileSync(
		path.join(dir, 'IGlobal.py'),
		'from nodes.demo.x import y\nclass IGlobal:\n    def f(self):\n        from nodes.embed_y.embedding import E\n'
	);
	assert.deepStrictEqual((await packageNode('demo', dir)).entry.requires, ['embed_y']);
});

function makeTree() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-sync-'));
	const write = (file, text = '') => {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), text);
	};
	write('src/core/IGlobal.py');
	write('src/autopipe/IGlobal.py');
	write('src/cpp_x/CMakeLists.txt');
	write('src/llm_x/services.json', '{"protocol": "provider_x://"}');
	write(
		'src/llm_x/IGlobal.py',
		'from nodes.core import a\nfrom nodes.autopipe import b\nfrom nodes.embed_y import c\n'
	);
	write('src/llm_x/requirements.txt', 'requests\n');
	write('src/embed_y/services.json', '{"protocol": "embed_y://"}');
	write('src/__init__.py');
	// What an older build left: a node since removed, and a requirement file llm_x no longer has
	write('dist/nodes/gone.rrnode');
	write('dist/server/nodes/node-requirements/gone/requirements.txt');
	write('dist/server/nodes/node-requirements/llm_x/requirements_gpu.txt');
	const names = ['core', 'autopipe', 'cpp_x', 'llm_x', 'embed_y', '__init__.py'];
	const copy = (src, dest) => fs.cpSync(src, dest, { recursive: true });
	return {
		root,
		sync: {
			srcNodeDirs: new Map(names.map((name) => [name, path.join(root, 'src')])),
			distDir: path.join(root, 'dist', 'server', 'nodes'),
			packagesDir: path.join(root, 'dist', 'nodes'),
			libraryOf: async (name) => (name === 'cpp_x' ? 'cpp_x.so' : null),
			copyFile: async (src, dest) => copy(src, dest),
			copyNode: async (name, src) => copy(src, path.join(root, 'dist', 'server', 'nodes', name)),
			forget: async () => {},
		},
	};
}

test('the server keeps core, autopipe and the C++ nodes; every other node becomes a package', async () => {
	const { root, sync } = makeTree();
	await syncNodes({}, sync);

	const listed = (dir) => fs.readdirSync(path.join(root, dir)).sort();
	assert.deepStrictEqual(listed('dist/server/nodes'), [
		'__init__.py',
		'autopipe',
		'core',
		'cpp_x',
		'index.json',
		'node-requirements',
	]);
	assert.deepStrictEqual(listed('dist/nodes'), ['embed_y.rrnode', 'index.json', 'llm_x.rrnode']);
	assert.deepStrictEqual(listed('dist/server/nodes/node-requirements'), ['llm_x']);
	assert.deepStrictEqual(listed('dist/server/nodes/node-requirements/llm_x'), ['requirements.txt']);
});

test('the index lists only the packaged nodes, with the digest of the file beside it', async () => {
	const { root, sync } = makeTree();
	await syncNodes({}, sync);

	const index = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'nodes', 'index.json'), 'utf8'));
	assert.strictEqual(index.contract, NODES_CONTRACT);
	assert.deepStrictEqual(Object.keys(index.nodes).sort(), ['embed_y', 'llm_x']);
	for (const [name, entry] of Object.entries(index.nodes)) {
		const data = fs.readFileSync(path.join(root, 'dist', 'nodes', `${name}.rrnode`));
		assert.strictEqual(entry.sha256, crypto.createHash('sha256').update(data).digest('hex'));
	}
	// core and autopipe stay in the server, so only the packaged node it imports is required
	assert.deepStrictEqual(index.nodes.llm_x.requires, ['embed_y']);
	assert.deepStrictEqual(
		fs.readFileSync(path.join(root, 'dist', 'server', 'nodes', 'index.json')),
		fs.readFileSync(path.join(root, 'dist', 'nodes', 'index.json'))
	);
});

test('the index contract is the one the engine reads', () => {
	const constants = fs.readFileSync(path.join(__dirname, '../../packages/ai/src/ai/constants.py'), 'utf8');
	assert.strictEqual(Number(/^CONST_NODES_CONTRACT = (\d+)$/m.exec(constants)[1]), NODES_CONTRACT);
});
