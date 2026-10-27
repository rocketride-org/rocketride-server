// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// EXPORT WORDING: each reason for "no image" has its own sentence
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportFailureText, exportOutcome } from '../src/graph/exportWording';

test('an answer is read in the new shape and the old one', () => {
	const blob = new Blob(['x']);
	assert.deepEqual(exportOutcome(blob), { blob, reason: null });
	assert.deepEqual(exportOutcome({ blob }), { blob, reason: null });
	assert.deepEqual(exportOutcome({ blob: null, reason: 'too-large' }), { blob: null, reason: 'too-large' });
	assert.deepEqual(exportOutcome({ blob: null, reason: 'not-ready' }), { blob: null, reason: 'not-ready' });
	assert.deepEqual(exportOutcome(null), { blob: null, reason: 'render-failed' });
	assert.deepEqual(exportOutcome({ blob: null, reason: 'something else' }), { blob: null, reason: 'render-failed' });
});

test('"too large" is said only for too large', () => {
	assert.match(exportFailureText('too-large', 'png'), /Too large for a PNG/);
	assert.doesNotMatch(exportFailureText('not-ready', 'png'), /large/);
	assert.doesNotMatch(exportFailureText('render-failed', 'png'), /large/);
	assert.match(exportFailureText('render-failed', 'png'), /try SVG/);
	assert.match(exportFailureText('not-ready', 'svg'), /still loading/);
});
