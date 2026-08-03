// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * Builder Self-Update
 *
 * Replaces the local `scripts/` directory with the copy from the upstream
 * rocketride-server repository at a given branch (`builder update <branch>`).
 *
 * Intentionally depends only on Node built-ins (fs, path, child_process):
 * the whole point of the command is to repair a scripts/ tree that may be
 * broken or out of date, so it must not require any scripts/lib machinery
 * or installed node_modules to run.
 *
 * Usage:
 *   const { selfUpdate } = require('./lib/self-update');
 *   await selfUpdate(ROOT, 'main');
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// =============================================================================
// CONSTANTS
// =============================================================================

// Upstream repository that owns the canonical scripts/ tree.
const UPSTREAM_URL = 'https://github.com/rocketride-org/rocketride-server.git';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Runs a git command, streaming its output to the console.
 *
 * @param {string[]} args - Arguments passed to git.
 * @param {string} [cwd] - Working directory for the command.
 */
function runGit(args, cwd) {
	execFileSync('git', args, { cwd, stdio: 'inherit' });
}

// =============================================================================
// SELF-UPDATE
// =============================================================================

/**
 * Deletes the local `scripts/` directory and replaces it with the one from
 * the upstream repository at the requested branch.
 *
 * The fetch uses a depth-1, blobless, sparse clone so only the scripts/
 * tree is actually downloaded. The old directory is kept as a backup until
 * the new one is in place, so a failed fetch or swap leaves the builder
 * usable.
 *
 * When root is the running builder's own repository, the caller must exit
 * the process immediately after this returns: the builder's un-required
 * modules live in the directory that was just replaced, so any further
 * lazy require() would load mismatched code.
 *
 * A root without an existing scripts/ directory is allowed — the fetched
 * copy is simply moved into place, so the command can also bootstrap a
 * repository that carries a copy of the builder.
 *
 * @param {string} root - Repository root (the directory containing scripts/).
 * @param {string} branch - Upstream branch to fetch scripts/ from.
 */
async function selfUpdate(root, branch) {
	// Fail before cloning if the target root itself is missing (a typoed
	// --path would otherwise surface as a confusing rename error).
	if (!fs.existsSync(root)) {
		throw new Error(`target path '${root}' does not exist`);
	}

	const scriptsDir = path.join(root, 'scripts');
	const tmpDir = path.join(root, '.builder-update-tmp');
	const backupDir = path.join(root, '.builder-update-backup');

	// Clear leftovers from a previously interrupted update so the clone and
	// the rename below start from a clean slate.
	fs.rmSync(tmpDir, { recursive: true, force: true });
	fs.rmSync(backupDir, { recursive: true, force: true });

	try {
		// Fetch only the scripts/ tree: depth-1 avoids history, blobless +
		// sparse avoids downloading the rest of the working tree.
		console.log(`Fetching scripts/ from ${UPSTREAM_URL} @ ${branch}\n`);
		runGit([
			'clone',
			'--depth', '1',
			'--filter=blob:none',
			'--sparse',
			'--branch', branch,
			'--single-branch',
			UPSTREAM_URL,
			tmpDir,
		]);
		runGit(['sparse-checkout', 'set', 'scripts'], tmpDir);

		// Sanity check before touching anything local: the fetched tree must
		// look like a builder scripts/ directory.
		const fetched = path.join(tmpDir, 'scripts');
		if (!fs.existsSync(path.join(fetched, 'build.js'))) {
			throw new Error(`upstream branch '${branch}' has no scripts/build.js — refusing to replace the local scripts/`);
		}

		// Swap: move the old directory aside as a backup (a fresh target may
		// have no scripts/ yet), then move the new one into place. Renames
		// stay on the same volume (both paths are under root), so each step
		// is atomic.
		const hadScripts = fs.existsSync(scriptsDir);
		if (hadScripts) {
			fs.renameSync(scriptsDir, backupDir);
		}
		try {
			fs.renameSync(fetched, scriptsDir);
		} catch (err) {
			// Restore the original scripts/ so the builder still works.
			if (hadScripts) {
				fs.renameSync(backupDir, scriptsDir);
			}
			throw err;
		}
		fs.rmSync(backupDir, { recursive: true, force: true });

		console.log(`\n${scriptsDir} updated from ${branch}`);
	} finally {
		// The clone directory is transient in every outcome.
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

module.exports = { selfUpdate };
