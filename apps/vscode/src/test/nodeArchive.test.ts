// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commitStagedRelease, downloadThenRename, missingNodeArchive, nodeArchiveOf, renameRetrying } from '../engine/shared/node-archive';

/** An engine/ folder whose nodes/index.json holds index, or none when index is undefined. */
function engineWith(index?: unknown): string {
	const engineDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-engine-')), 'engine');
	fs.mkdirSync(path.join(engineDir, 'nodes'), { recursive: true });
	if (index !== undefined) fs.writeFileSync(path.join(engineDir, 'nodes', 'index.json'), JSON.stringify(index));
	return engineDir;
}

test('the archive is the one the server index names', () => {
	assert.equal(nodeArchiveOf(engineWith({ contract: 1, archive: 'rocketride-nodes-v1.2.3.zip', nodes: {} })), 'rocketride-nodes-v1.2.3.zip');
});

test('a server without an index, or whose index names no archive, needs none', () => {
	assert.equal(nodeArchiveOf(engineWith()), null);
	assert.equal(nodeArchiveOf(engineWith({ contract: 1, nodes: {} })), null);
});

test('an archive that is not a plain file name is refused', () => {
	for (const archive of ['../rocketride-nodes-v1.zip', 'sub/rocketride-nodes-v1.zip', 'sub\\rocketride-nodes-v1.zip', '..', '.', '', 7]) {
		assert.throws(() => nodeArchiveOf(engineWith({ archive })), /invalid node archive/);
	}
});

test('an install misses its node archive only when its index names one that nodes/ does not hold', () => {
	const engineDir = engineWith({ contract: 1, archive: 'rocketride-nodes-v1.2.3.zip', nodes: {} });
	const nodesDir = path.join(path.dirname(engineDir), 'nodes');
	assert.equal(missingNodeArchive(engineDir, nodesDir), 'rocketride-nodes-v1.2.3.zip');

	fs.mkdirSync(nodesDir);
	fs.writeFileSync(path.join(nodesDir, 'rocketride-nodes-v1.2.3.zip'), 'zip');
	assert.equal(missingNodeArchive(engineDir, nodesDir), null);
	assert.equal(missingNodeArchive(engineWith({ contract: 1, nodes: {} }), nodesDir), null);
});

test('a staged release replaces the server files and the node archive', async () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-install-'));
	const write = (file: string, text = '') => {
		fs.mkdirSync(path.dirname(path.join(parent, file)), { recursive: true });
		fs.writeFileSync(path.join(parent, file), text);
	};
	write('engine/engine.pid', '1');
	write('nodes/rocketride-nodes-v1.zip', 'old');
	write('.staging/engine/engine', 'new');
	write('.staging/engine/ai/eaas.py');
	write('.staging/rocketride-nodes-v1.zip', 'new');

	await commitStagedRelease(path.join(parent, '.staging', 'engine'), path.join(parent, 'engine'), path.join(parent, '.staging', 'rocketride-nodes-v1.zip'), path.join(parent, 'nodes'));

	assert.deepEqual(fs.readdirSync(path.join(parent, 'engine')).sort(), ['ai', 'engine', 'engine.pid']);
	assert.deepEqual(fs.readdirSync(path.join(parent, 'nodes')), ['rocketride-nodes-v1.zip']);
	assert.equal(fs.readFileSync(path.join(parent, 'nodes', 'rocketride-nodes-v1.zip'), 'utf8'), 'new');
});

test('a staged release without a node archive leaves no nodes folder', async () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-install-'));
	fs.mkdirSync(path.join(parent, '.staging', 'engine'), { recursive: true });
	fs.mkdirSync(path.join(parent, 'nodes'));
	fs.writeFileSync(path.join(parent, 'nodes', 'rocketride-nodes-v0.zip'), 'old');

	await commitStagedRelease(path.join(parent, '.staging', 'engine'), path.join(parent, 'engine'), null, path.join(parent, 'nodes'));

	assert.equal(fs.existsSync(path.join(parent, 'nodes')), false);
});

// A rename that fails with code the given number of times, then renames
function failingRename(t: { mock: typeof test.mock }, code: string, times: number) {
	const rename = fs.promises.rename;
	let calls = 0;
	t.mock.method(fs.promises, 'rename', async (src: fs.PathLike, dest: fs.PathLike) => {
		if (++calls <= times) throw Object.assign(new Error(code), { code });
		return rename(src, dest);
	});
	return () => calls;
}

test('a rename Windows holds for a moment is retried until it moves', async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-rename-'));
	fs.writeFileSync(path.join(dir, 'a'), 'a');
	const calls = failingRename(t, 'EBUSY', 2);

	await renameRetrying(path.join(dir, 'a'), path.join(dir, 'b'), 1);

	assert.equal(calls(), 3);
	assert.deepEqual(fs.readdirSync(dir), ['b']);
});

test('a rename that fails for another reason is not retried', async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-rename-'));
	const calls = failingRename(t, 'ENOSPC', 1);

	await assert.rejects(renameRetrying(path.join(dir, 'a'), path.join(dir, 'b'), 1), { code: 'ENOSPC' });
	assert.equal(calls(), 1);
});

test('a rename still held after ten tries fails', async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-rename-'));
	const calls = failingRename(t, 'EPERM', 10);

	await assert.rejects(renameRetrying(path.join(dir, 'a'), path.join(dir, 'b'), 1), { code: 'EPERM' });
	assert.equal(calls(), 10);
});

test('a download Windows holds for a moment after it is written still lands in place', async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-nodes-'));
	const calls = failingRename(t, 'EPERM', 1);

	await downloadThenRename(path.join(dir, 'rocketride-nodes-v1.zip'), path.join(dir, 'rocketride-nodes-v1.zip.download'), async (staging) => fs.writeFileSync(staging, 'zip'));

	assert.equal(calls(), 2);
	assert.deepEqual(fs.readdirSync(dir), ['rocketride-nodes-v1.zip']);
});

test('a download that fails leaves neither the file nor its staging copy', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-nodes-'));

	await assert.rejects(
		downloadThenRename(path.join(dir, 'a.zip'), path.join(dir, 'a.zip.download'), async (staging) => {
			fs.writeFileSync(staging, 'part');
			throw new Error('connection reset');
		}),
		/connection reset/
	);
	assert.deepEqual(fs.readdirSync(dir), []);
});
