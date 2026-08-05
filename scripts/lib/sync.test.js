/**
 * Regression tests for content-based incremental sync (#1477).
 *
 * The bug: syncDir/syncFile skipped a copy when `size === size && srcMtime <=
 * destMtime`. A rebuilt index.html kept the same byte length but swapped its
 * bundle-hash string, and its source mtime was older than the already-present
 * destination — so the changed file was silently skipped and shipped stale.
 *
 * These tests pin the fix: a same-size file whose bytes changed is always
 * copied, regardless of mtime ordering, while a byte-identical file is skipped.
 *
 * No test runner is wired into this repo's build scripts yet, so this uses the
 * zero-dependency built-in runner. Run:
 *     node --test scripts/lib/sync.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { filesEqual } = require('./fs');
const { syncFile, syncDir } = require('./sync');

/**
 * Create a fresh, empty temp directory for a single test case.
 * @returns {string} Absolute path to the new directory
 */
function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-sync-test-'));
}

/**
 * Write a file and force its mtime to a fixed epoch-second value, so tests can
 * reproduce the exact "source older than destination" trigger deterministically.
 * @param {string} file - File path to write
 * @param {string|Buffer} content - File contents
 * @param {number} mtimeSec - Modification time, seconds since the epoch
 */
function writeWithMtime(file, content, mtimeSec) {
    fs.writeFileSync(file, content);
    fs.utimesSync(file, mtimeSec, mtimeSec);
}

// --- filesEqual ------------------------------------------------------------

test('filesEqual: same length, different bytes -> false', async () => {
    const dir = tmpDir();
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    // Same 15-byte length, one differing character (the exact bug shape).
    fs.writeFileSync(a, 'index.<AAAA>.js');
    fs.writeFileSync(b, 'index.<BBBB>.js');
    assert.equal(fs.statSync(a).size, fs.statSync(b).size);
    assert.equal(await filesEqual(a, b), false);
});

test('filesEqual: identical bytes -> true', async () => {
    const dir = tmpDir();
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    fs.writeFileSync(a, 'index.<AAAA>.js');
    fs.writeFileSync(b, 'index.<AAAA>.js');
    assert.equal(await filesEqual(a, b), true);
});

test('filesEqual: multi-chunk files differing only in the final chunk -> false', async () => {
    const dir = tmpDir();
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    // Larger than the 64 KiB read window so the chunk loop runs more than once.
    const base = Buffer.alloc(200 * 1024, 0x61);
    const other = Buffer.from(base);
    other[other.length - 1] = 0x62; // flip the very last byte
    fs.writeFileSync(a, base);
    fs.writeFileSync(b, other);
    assert.equal(base.length, other.length);
    assert.equal(await filesEqual(a, b), false);
    // And identical large files still compare equal across chunks.
    fs.writeFileSync(b, base);
    assert.equal(await filesEqual(a, b), true);
});

// --- syncFile --------------------------------------------------------------

test('syncFile: same-size changed bytes with OLDER source mtime -> copied', async () => {
    const dir = tmpDir();
    const src = path.join(dir, 'src.html');
    const dest = path.join(dir, 'dest.html');
    // Destination is the newer file on disk; source is older but has new bytes.
    writeWithMtime(dest, 'index.<OLD0>.js', 2_000_000_000);
    writeWithMtime(src, 'index.<NEW0>.js', 1_000_000_000);
    assert.equal(fs.statSync(src).size, fs.statSync(dest).size);

    const stats = await syncFile(src, dest);

    assert.equal(stats.updated, 1);
    assert.equal(stats.unchanged, 0);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'index.<NEW0>.js');
});

test('syncFile: byte-identical file -> skipped (no perpetual recopy)', async () => {
    const dir = tmpDir();
    const src = path.join(dir, 'src.html');
    const dest = path.join(dir, 'dest.html');
    writeWithMtime(dest, 'index.<SAME>.js', 2_000_000_000);
    writeWithMtime(src, 'index.<SAME>.js', 1_000_000_000);

    const stats = await syncFile(src, dest);

    assert.equal(stats.unchanged, 1);
    assert.equal(stats.updated, 0);
});

test('syncFile: differently sized file -> copied', async () => {
    const dir = tmpDir();
    const src = path.join(dir, 'src.html');
    const dest = path.join(dir, 'dest.html');
    writeWithMtime(dest, 'short', 2_000_000_000);
    writeWithMtime(src, 'a much longer body', 1_000_000_000);

    const stats = await syncFile(src, dest);

    assert.equal(stats.updated, 1);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'a much longer body');
});

// --- syncDir ---------------------------------------------------------------

test('syncDir: same-size changed file with older mtime is updated; identical file is skipped', async () => {
    const root = tmpDir();
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src);
    fs.mkdirSync(dest);

    // changed.js: same length, different bytes, source mtime OLDER than dest.
    writeWithMtime(path.join(dest, 'changed.js'), 'v=<AAAA>', 2_000_000_000);
    writeWithMtime(path.join(src, 'changed.js'), 'v=<BBBB>', 1_000_000_000);
    // same.js: byte-identical, source mtime OLDER than dest.
    writeWithMtime(path.join(dest, 'same.js'), 'unchanged', 2_000_000_000);
    writeWithMtime(path.join(src, 'same.js'), 'unchanged', 1_000_000_000);

    const stats = await syncDir(src, dest);

    assert.equal(stats.updated, 1);
    assert.equal(stats.unchanged, 1);
    assert.equal(fs.readFileSync(path.join(dest, 'changed.js'), 'utf8'), 'v=<BBBB>');
});
