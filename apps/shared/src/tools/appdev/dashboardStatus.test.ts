// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveStatus, statusActionOf } from './dashboardStatus';
import type { AppVersionInfo } from './types';

const failedV3: AppVersionInfo = { registryVersion: 3, version: '1.2.0', author: 'dev', publishedAt: 1_793_900_000, rungs: [], state: 'private', buildStatus: 'failed' };

function failedBuildLine() {
	const line = deriveStatus([failedV3], [], [], null, []).find((l) => l.text.startsWith('v3 failed its server build'));
	assert.ok(line, 'a failed newest version gets a failed-build line');
	return line;
}

test("the failed-build line opens that version's build log", () => {
	assert.equal(failedBuildLine().buildLog, 3);
});

test('a host that can read logs gets View build log on the failed-build line', () => {
	assert.deepEqual(statusActionOf(failedBuildLine(), true, true), { kind: 'buildLog', version: 3 });
});

test('a host that cannot read logs keeps Open Deploy on the failed-build line', () => {
	assert.deepEqual(statusActionOf(failedBuildLine(), false, true), { kind: 'stage', stage: 'deploy' });
});
