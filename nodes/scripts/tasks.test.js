// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * A node packages as its files with its .rrnode marker, without build inputs, into one
 * archive under <name>/, with the digest EaaS computes. Run: node --test nodes/scripts/tasks.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const AdmZip = require('adm-zip');

const { packageNode, contentDigest, syncNodes, NODES_CONTRACT } = require('./tasks');

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
	const { files } = await packageNode('demo', makeNode());
	assert.deepStrictEqual(Object.keys(files).sort(), ['.rrnode', 'IGlobal.py', 'demo.svg', 'services.json']);
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

test('the digest is the one EaaS computes over the same files', () => {
	// The vector test_node_packages.py checks against content_digest
	const files = { 'b.py': Buffer.from('b'), 'a/c.json': Buffer.from('c') };
	assert.strictEqual(contentDigest(files), 'cbd358a9e4e48458634a275f10ca7085f3576d2eba9f9a3d28f224f8d477c200');
});

test('a node packaged on Windows gives the digest built on Linux', async () => {
	const dir = makeNode();
	fs.mkdirSync(path.join(dir, 'util'));
	fs.writeFileSync(path.join(dir, 'util', 'x.py'), '');
	const linux = (await packageNode('demo', dir)).entry.sha256;

	// glob answers with Windows separators; packageNode requires it on each call
	const globPath = require.resolve('glob');
	const { glob } = require('glob');
	const windowsGlob = async (...args) => (await glob(...args)).map((file) => file.split('/').join('\\'));
	const real = require.cache[globPath];
	try {
		require.cache[globPath] = { id: globPath, filename: globPath, loaded: true, exports: { glob: windowsGlob } };
		const windows = (await packageNode('demo', dir)).entry.sha256;
		assert.strictEqual(windows, linux);
	} finally {
		require.cache[globPath] = real;
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
	// What an older build left: another version's archive, a node since removed,
	// and a requirement file llm_x no longer has
	write('dist/nodes/rocketride-nodes-v0.zip');
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
			archiveName: async () => 'rocketride-nodes-v1.zip',
			libraryOf: async (name) => (name === 'cpp_x' ? 'cpp_x.so' : null),
			copyFile: async (src, dest) => copy(src, dest),
			copyNode: async (name, src) => copy(src, path.join(root, 'dist', 'server', 'nodes', name)),
			forget: async () => {},
		},
	};
}

test('the server keeps core, autopipe and the C++ nodes; every other node goes into the archive', async () => {
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
	assert.deepStrictEqual(listed('dist/nodes'), ['index.json', 'rocketride-nodes-v1.zip']);
	const entries = new AdmZip(path.join(root, 'dist', 'nodes', 'rocketride-nodes-v1.zip')).getEntries();
	assert.deepStrictEqual(entries.map((e) => e.entryName).sort(), [
		'embed_y/.rrnode',
		'embed_y/services.json',
		'llm_x/.rrnode',
		'llm_x/IGlobal.py',
		'llm_x/requirements.txt',
		'llm_x/services.json',
	]);
	assert.deepStrictEqual(listed('dist/server/nodes/node-requirements'), ['llm_x']);
	assert.deepStrictEqual(listed('dist/server/nodes/node-requirements/llm_x'), ['requirements.txt']);
});

test('the index names the archive and lists only the packaged nodes, with the digest of their files', async () => {
	const { root, sync } = makeTree();
	await syncNodes({}, sync);

	const index = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'nodes', 'index.json'), 'utf8'));
	assert.strictEqual(index.contract, NODES_CONTRACT);
	assert.strictEqual(index.archive, 'rocketride-nodes-v1.zip');
	assert.deepStrictEqual(Object.keys(index.nodes).sort(), ['embed_y', 'llm_x']);
	const archive = new AdmZip(path.join(root, 'dist', 'nodes', index.archive));
	for (const [name, entry] of Object.entries(index.nodes)) {
		const files = {};
		for (const e of archive.getEntries().filter((e) => e.entryName.startsWith(`${name}/`))) {
			files[e.entryName.slice(name.length + 1)] = e.getData();
		}
		assert.strictEqual(entry.sha256, contentDigest(files));
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
