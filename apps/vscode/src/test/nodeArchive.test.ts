// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nodeArchiveOf } from '../engine/shared/node-archive';

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
