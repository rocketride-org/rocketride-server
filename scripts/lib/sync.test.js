/**
 * Tests for incremental directory sync (syncDir).
 */
'use strict';

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { syncDir, syncFile, formatSyncStats, syncDryRunEffective } = require('./sync');

beforeEach(() => {
    delete process.env.ROCKETRIDE_SYNC_DRY_RUN;
});

test('syncDryRunEffective respects env and explicit dryRun: false', () => {
    const prev = process.env.ROCKETRIDE_SYNC_DRY_RUN;
    try {
        delete process.env.ROCKETRIDE_SYNC_DRY_RUN;
        assert.strictEqual(syncDryRunEffective({}), false);
        assert.strictEqual(syncDryRunEffective({ dryRun: true }), true);
        assert.strictEqual(syncDryRunEffective({ dryRun: false }), false);

        process.env.ROCKETRIDE_SYNC_DRY_RUN = 'yes';
        assert.strictEqual(syncDryRunEffective({}), true);
        assert.strictEqual(syncDryRunEffective({ dryRun: false }), false);
    } finally {
        if (prev === undefined) {
            delete process.env.ROCKETRIDE_SYNC_DRY_RUN;
        } else {
            process.env.ROCKETRIDE_SYNC_DRY_RUN = prev;
        }
    }
});

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

test('syncDir dryRun reports work but does not copy or delete', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-sync-'));
    try {
        const src = path.join(tmp, 'src');
        const dest = path.join(tmp, 'dest');
        await fs.mkdir(src, { recursive: true });
        await fs.mkdir(dest, { recursive: true });
        await fs.writeFile(path.join(src, 'a.txt'), 'a');
        await fs.writeFile(path.join(dest, 'orphan.txt'), 'stay');

        const stats = await syncDir(src, dest, { dryRun: true });

        assert.strictEqual(stats.added, 1);
        assert.strictEqual(stats.deleted, 1);
        assert.strictEqual(stats.changed, 2);
        await assert.rejects(
            () => fs.access(path.join(dest, 'a.txt')),
            /ENOENT/u,
            'dry run must not create dest copy of a.txt'
        );
        const orphan = await fs.readFile(path.join(dest, 'orphan.txt'), 'utf8');
        assert.strictEqual(orphan, 'stay', 'dry run must not remove mirror orphans');
    } finally {
        await fs.rm(tmp, { recursive: true, force: true });
    }
});

test('syncFile dryRun does not write', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-sync-'));
    try {
        const src = path.join(tmp, 'in.bin');
        const dest = path.join(tmp, 'out.bin');
        await fs.writeFile(src, 'x');

        const stats = await syncFile(src, dest, { dryRun: true });
        assert.strictEqual(stats.added, 1);
        await assert.rejects(() => fs.access(dest), /ENOENT/u);
    } finally {
        await fs.rm(tmp, { recursive: true, force: true });
    }
});

test('formatSyncStats optional dryRun prefix', () => {
    assert.strictEqual(
        formatSyncStats({ added: 0, updated: 0, deleted: 0, changed: 0, unchanged: 3 }),
        'No changes (3 files up to date)'
    );
    assert.strictEqual(
        formatSyncStats({ added: 0, updated: 0, deleted: 0, changed: 0, unchanged: 3 }, { dryRun: true }),
        '(dry run) No changes (3 files up to date)'
    );
    assert.strictEqual(
        formatSyncStats({ added: 2, updated: 1, deleted: 0, changed: 3, unchanged: 0 }, { dryRun: true }),
        '(dry run) +2 added, ~1 updated'
    );
});

test('ROCKETRIDE_SYNC_DRY_RUN enables dry run and formatSyncStats label', async () => {
    const prev = process.env.ROCKETRIDE_SYNC_DRY_RUN;
    try {
        process.env.ROCKETRIDE_SYNC_DRY_RUN = '1';
        assert.strictEqual(
            formatSyncStats({ added: 1, updated: 0, deleted: 0, changed: 1, unchanged: 0 }),
            '(dry run) +1 added'
        );

        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-sync-'));
        try {
            const src = path.join(tmp, 'src');
            const dest = path.join(tmp, 'dest');
            await fs.mkdir(src, { recursive: true });
            await fs.mkdir(dest, { recursive: true });
            await fs.writeFile(path.join(src, 'a.txt'), 'a');

            const stats = await syncDir(src, dest);
            assert.strictEqual(stats.added, 1);
            await assert.rejects(() => fs.access(path.join(dest, 'a.txt')), /ENOENT/u);
        } finally {
            await fs.rm(tmp, { recursive: true, force: true });
        }
    } finally {
        if (prev === undefined) {
            delete process.env.ROCKETRIDE_SYNC_DRY_RUN;
        } else {
            process.env.ROCKETRIDE_SYNC_DRY_RUN = prev;
        }
    }
});

test('syncDir dryRun: false overrides ROCKETRIDE_SYNC_DRY_RUN', async () => {
    const prev = process.env.ROCKETRIDE_SYNC_DRY_RUN;
    try {
        process.env.ROCKETRIDE_SYNC_DRY_RUN = 'true';
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-sync-'));
        try {
            const src = path.join(tmp, 'src');
            const dest = path.join(tmp, 'dest');
            await fs.mkdir(src, { recursive: true });
            await fs.writeFile(path.join(src, 'a.txt'), 'a');

            await syncDir(src, dest, { dryRun: false });
            const content = await fs.readFile(path.join(dest, 'a.txt'), 'utf8');
            assert.strictEqual(content, 'a');
        } finally {
            await fs.rm(tmp, { recursive: true, force: true });
        }
    } finally {
        if (prev === undefined) {
            delete process.env.ROCKETRIDE_SYNC_DRY_RUN;
        } else {
            process.env.ROCKETRIDE_SYNC_DRY_RUN = prev;
        }
    }
});
