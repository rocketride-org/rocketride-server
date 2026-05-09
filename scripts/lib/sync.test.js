/**
 * Tests for incremental directory sync (syncDir).
 */
'use strict';

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const test = require('node:test');
const assert = require('node:assert');

const { syncDir } = require('./sync');

test('syncDir copies all files when destination directory does not exist', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-sync-'));
    try {
        const src = path.join(tmp, 'src');
        const dest = path.join(tmp, 'dest');
        await fs.mkdir(src, { recursive: true });
        await fs.writeFile(path.join(src, 'hello.txt'), 'hello');

        const stats = await syncDir(src, dest);

        assert.strictEqual(stats.added, 1, 'expected one new file');
        assert.strictEqual(stats.changed, 1, 'expected one change');
        assert.strictEqual(stats.updated, 0);
        assert.strictEqual(stats.deleted, 0);

        const content = await fs.readFile(path.join(dest, 'hello.txt'), 'utf8');
        assert.strictEqual(content, 'hello');
    } finally {
        await fs.rm(tmp, { recursive: true, force: true });
    }
});

test('syncDir second run with existing dest marks files unchanged', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-sync-'));
    try {
        const src = path.join(tmp, 'src');
        const dest = path.join(tmp, 'dest');
        await fs.mkdir(src, { recursive: true });
        await fs.writeFile(path.join(src, 'hello.txt'), 'hello');

        const first = await syncDir(src, dest);
        assert.strictEqual(first.added, 1);

        const second = await syncDir(src, dest);
        assert.strictEqual(second.unchanged, 1);
        assert.strictEqual(second.added, 0);
        assert.strictEqual(second.updated, 0);
        assert.strictEqual(second.changed, 0);
    } finally {
        await fs.rm(tmp, { recursive: true, force: true });
    }
});
