/**
 * Tests for the pytest argument helpers (pytest.js).
 *
 * Run:
 *     node --test scripts/lib/pytest.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { splitPytestOpts, withoutXdistArgs, requestsXdistWorkers, hasDistMode, collectPytestReport } = require('./pytest');

test('collectPytestReport queues the written report and removes the file', async () => {
    const ctx = {};
    let file;
    await collectPytestReport(ctx, async (arg) => {
        file = arg.slice('--rocketride-report='.length);
        fs.writeFileSync(file, 'Tests that will be skipped\n[hardware] 1\n');
    });
    assert.deepStrictEqual(ctx.reports, ['Tests that will be skipped\n[hardware] 1']);
    assert.strictEqual(fs.existsSync(file), false);
});

test('collectPytestReport queues nothing without a report and still cleans up on failure', async () => {
    const ctx = {};
    await collectPytestReport(ctx, async () => {});
    assert.strictEqual(ctx.reports, undefined);

    let file;
    await assert.rejects(collectPytestReport(ctx, async (arg) => {
        file = arg.slice('--rocketride-report='.length);
        fs.writeFileSync(file, 'partial');
        throw new Error('pytest failed');
    }), /pytest failed/);
    assert.strictEqual(fs.existsSync(file), false);
});

test('splitPytestOpts accepts strings, arrays and nothing', () => {
    assert.deepStrictEqual(splitPytestOpts(undefined), []);
    assert.deepStrictEqual(splitPytestOpts('-v  -s'), ['-v', '-s']);
    assert.deepStrictEqual(splitPytestOpts(['-n 4', '-k caption']), ['-n', '4', '-k', 'caption']);
});

test('withoutXdistArgs drops every xdist form and keeps the rest', () => {
    const tokens = [
        '-v', '-n', '4', '-n4', '-nauto', '--numprocesses', 'auto', '--numprocesses=2',
        '--dist', 'load', '--dist=loadscope', '-d', '--tx', 'popen', '--maxprocesses=3',
        '-k', 'caption', '-m', 'not slow', '--timeout=900',
    ];
    assert.deepStrictEqual(withoutXdistArgs(tokens), ['-v', '-k', 'caption', '-m', 'not slow', '--timeout=900']);
});

test('requestsXdistWorkers reads the last worker count', () => {
    assert.strictEqual(requestsXdistWorkers(['-v']), false);
    assert.strictEqual(requestsXdistWorkers(['-n', '4']), true);
    assert.strictEqual(requestsXdistWorkers(['-n4']), true);
    assert.strictEqual(requestsXdistWorkers(['--numprocesses=auto']), true);
    assert.strictEqual(requestsXdistWorkers(['-n', '0']), false);
    assert.strictEqual(requestsXdistWorkers(['-n', '4', '-n', '0']), false);
});

test('hasDistMode sees both spellings', () => {
    assert.strictEqual(hasDistMode(['-n', '4']), false);
    assert.strictEqual(hasDistMode(['--dist', 'load']), true);
    assert.strictEqual(hasDistMode(['--dist=loadgroup']), true);
    assert.strictEqual(hasDistMode(['-d']), true);
});
