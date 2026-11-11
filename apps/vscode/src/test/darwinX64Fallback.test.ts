// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
	DARWIN_X64_UNSUPPORTED_MESSAGE,
	isArchMismatchSpawnError,
	isUnsupportedDarwinX64,
} from '../engine/shared/darwinX64Fallback';

test('isUnsupportedDarwinX64 is true only for darwin + x64', () => {
	assert.equal(isUnsupportedDarwinX64('darwin', 'x64'), true);
	assert.equal(isUnsupportedDarwinX64('darwin', 'arm64'), false);
	assert.equal(isUnsupportedDarwinX64('linux', 'x64'), false);
	assert.equal(isUnsupportedDarwinX64('win32', 'x64'), false);
});

test('isArchMismatchSpawnError detects ENOEXEC and EBADARCH codes', () => {
	assert.equal(isArchMismatchSpawnError(Object.assign(new Error('spawn failed'), { code: 'ENOEXEC' })), true);
	assert.equal(isArchMismatchSpawnError(Object.assign(new Error('spawn failed'), { code: 'EBADARCH' })), true);
	assert.equal(isArchMismatchSpawnError(Object.assign(new Error('spawn failed'), { code: 'ENOENT' })), false);
});

test('isArchMismatchSpawnError detects bad CPU type messages', () => {
	assert.equal(isArchMismatchSpawnError(new Error('bad CPU type in executable')), true);
	assert.equal(isArchMismatchSpawnError('posix_spawn: Bad CPU type in executable'), true);
	assert.equal(isArchMismatchSpawnError(new Error('connection refused')), false);
	assert.equal(isArchMismatchSpawnError(null), false);
});

test('DARWIN_X64_UNSUPPORTED_MESSAGE points users at Docker connection mode', () => {
	assert.match(DARWIN_X64_UNSUPPORTED_MESSAGE, /docker/i);
	assert.match(DARWIN_X64_UNSUPPORTED_MESSAGE, /darwin-x64/i);
});
