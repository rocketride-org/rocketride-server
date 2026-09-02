// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Regression tests for --overlay-root on a symlinked checkout.
 *
 * The bug: the overlay root was only path.resolve'd, while the sync's
 * destination went through realpath. On macOS a checkout is commonly reached
 * through a symlink (~/rocketride -> /Volumes/...), so the two sides held two
 * spellings of the same directory and the "is the overlay inside SERVER_DIR"
 * check rejected a perfectly valid overlay.
 *
 * These tests pin the fix: a path reached through a symlink canonicalizes to
 * the same string as the real one, and a root that does not exist yet still
 * resolves rather than throwing — building into a not-yet-created overlay is
 * legitimate.
 *
 * Run: node --test scripts/overlayRoot.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { resolveOverlayRoot } = require('./build');

/** A real directory plus a symlink pointing at it, cleaned up by the caller. */
function symlinkedDir() {
	const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'overlay-'));
	const real = path.join(base, 'real');
	const link = path.join(base, 'link');
	fs.mkdirSync(real);
	fs.symlinkSync(real, link);
	return { base, real, link };
}

test('a path reached through a symlink resolves to the real directory', () => {
	const { base, real, link } = symlinkedDir();
	try {
		assert.equal(resolveOverlayRoot(link), real);
		// Both spellings agree, which is the whole point.
		assert.equal(resolveOverlayRoot(link), resolveOverlayRoot(real));
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

test('a real path is returned unchanged', () => {
	const { base, real } = symlinkedDir();
	try {
		assert.equal(resolveOverlayRoot(real), real);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

test('a relative path becomes absolute', () => {
	const resolved = resolveOverlayRoot('.');
	assert.ok(path.isAbsolute(resolved), `expected an absolute path, got ${resolved}`);
});

test('a root that does not exist yet still resolves', () => {
	// realpath cannot canonicalize what is not there, and building into a
	// not-yet-created overlay root is a legitimate thing to ask for.
	const missing = path.join(os.tmpdir(), 'overlay-does-not-exist-1a2b3c', 'nested');
	assert.equal(resolveOverlayRoot(missing), path.resolve(missing));
});

test('requiring the build script does not run a build', () => {
	// The export exists only for these tests; main() stays behind the
	// require.main guard, or `node --test` would kick off a real build.
	const mod = require('./build');
	assert.equal(typeof mod.resolveOverlayRoot, 'function');
	assert.equal(Object.keys(mod).length, 1);
});
