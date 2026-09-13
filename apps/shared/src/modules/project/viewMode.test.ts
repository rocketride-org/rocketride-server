import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveViewMode, initialViewMode } from './viewMode';

test('remember a saved evaluation page while its host capability loads', () => {
	const remembered = initialViewMode('evaluations', false);
	assert.equal(remembered, 'evaluations');
	assert.equal(resolveViewMode(remembered, false, false), 'design');
	assert.equal(resolveViewMode(remembered, false, true), 'evaluations');
	assert.equal(initialViewMode('evaluations', true), 'design');
});

test('evaluation page restores only when its host supplies the capability', () => {
	assert.equal(resolveViewMode('evaluations', false, true), 'evaluations');
	assert.equal(resolveViewMode('evaluations', false, false), 'design');
	assert.equal(resolveViewMode('evaluations', true, true), 'design');
});

test('existing deployment and historical monitoring modes keep their semantics', () => {
	assert.equal(resolveViewMode('deploy', false, false), 'deploy');
	assert.equal(resolveViewMode('deploy', true, false), 'development');
	for (const mode of ['status', 'tokens', 'flow', 'trace', 'errors']) {
		assert.equal(resolveViewMode(mode, false, false), 'development');
	}
	assert.equal(resolveViewMode(undefined, false, false), 'design');
});
