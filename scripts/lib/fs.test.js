/**
 * Regression tests for safe replacement of read-only destinations.
 * Run: node --test scripts/lib/fs.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { copyFileEnsure } = require('./fs');
const fsp = fs.promises;
const copy = fsp.copyFile;
const remove = fsp.rm;

function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-copy-test-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const src = path.join(dir, 'src');
	const dest = path.join(dir, 'dest');
	fs.writeFileSync(src, 'new contents');
	fs.writeFileSync(dest, 'existing contents');
	return { dir, src, dest };
}

for (const code of ['EACCES', 'EPERM']) {
	test(`copyFileEnsure: ${code} replacement uses the staged source and cleans up`, async (t) => {
		const { dir, src, dest } = fixture(t);
		let staged;
		t.mock.method(fsp, 'copyFile', async (from, to) => {
			if (from === src && to === dest) throw Object.assign(new Error('read-only destination'), { code });
			if (from === src) staged = to;
			return copy(from, to);
		});
		t.mock.method(fsp, 'rm', async (file, options) => {
			if (file === dest) {
				assert.equal(fs.readFileSync(staged, 'utf8'), 'new contents');
				// Once staged, replacing the destination must no longer depend on src.
				fs.unlinkSync(src);
			}
			return remove(file, options);
		});

		await copyFileEnsure(src, dest);

		assert.equal(fs.readFileSync(dest, 'utf8'), 'new contents');
		assert.deepEqual(fs.readdirSync(dir), ['dest']);
	});

	for (const failureAt of ['source copy', 'destination removal', 'retry']) {
		test(`copyFileEnsure: ${code} cleans up after failed ${failureAt}`, async (t) => {
			const { dir, src, dest } = fixture(t);
			const failure = Object.assign(new Error(failureAt), { code: 'EIO' });
			t.mock.method(fsp, 'copyFile', async (from, to) => {
				if (from === src && to === dest) throw Object.assign(new Error('read-only destination'), { code });
				if (failureAt === 'retry' && to === dest) throw failure;
				await copy(from, to);
				// Simulate a source read failure that leaves a partial temporary file.
				if (failureAt === 'source copy') throw failure;
			});
			t.mock.method(fsp, 'rm', async (file, options) => {
				if (failureAt === 'destination removal' && file === dest) throw failure;
				return remove(file, options);
			});

			await assert.rejects(copyFileEnsure(src, dest), (err) => err === failure);

			if (failureAt !== 'retry') {
				assert.equal(fs.readFileSync(dest, 'utf8'), 'existing contents');
			}
			const expected = failureAt === 'retry' ? ['src'] : ['dest', 'src'];
			assert.deepEqual(fs.readdirSync(dir).sort(), expected);
		});
	}
}
