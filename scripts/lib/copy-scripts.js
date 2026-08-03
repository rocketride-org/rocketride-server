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
 * Scripts copy (builder:scripts) — pushes THIS builder's scripts/ tree
 * into another repository that carries a copy of the builder (e.g. a
 * standalone app repo), replacing its scripts/ wholesale.
 *
 * The source is always the running builder's own tree — the local
 * working copy, including uncommitted changes — never a remote: what you
 * test here is exactly what the target repo gets.
 *
 * The swap is staged: the tree is copied beside the target first, the
 * old scripts/ is renamed aside as a backup, and only removed once the
 * new tree is in place — a failed copy or swap leaves the target's
 * builder usable.
 *
 * Usage:
 *   const { copyScripts } = require('./lib/copy-scripts');
 *   await copyScripts('C:/Projects/rocketride-apps');
 */
const fs = require('fs');
const path = require('path');
const { renameWithRetry } = require('./vendor-shell');

// =============================================================================
// CONSTANTS
// =============================================================================

// The running builder's scripts/ directory (this file lives in scripts/lib).
const SOURCE_SCRIPTS = path.join(__dirname, '..');

// Transient junk that must not travel with the tree.
const EXCLUDED_DIRS = new Set(['__pycache__', 'node_modules']);

// =============================================================================
// COPY
// =============================================================================

/**
 * Replaces <targetRoot>/scripts with a copy of this builder's scripts/.
 *
 * A target without an existing scripts/ directory is allowed — the copy
 * is simply moved into place, so the command can also bootstrap a repo
 * that never had the builder.
 *
 * @param {string} targetRoot - Root of the repository to receive the tree.
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log=console.log] - Progress sink
 *   (the builder:scripts task routes this into its listr output).
 */
async function copyScripts(targetRoot, opts = {}) {
	const { log = console.log } = opts;

	// step: fail before touching anything on a bad target
	if (!fs.existsSync(targetRoot)) {
		throw new Error(`target path '${targetRoot}' does not exist`);
	}
	if (path.resolve(targetRoot) === path.resolve(SOURCE_SCRIPTS, '..')) {
		throw new Error('target is this repository — builder:scripts copies the local scripts/ to ANOTHER repo (--path=<repo root>)');
	}

	const scriptsDir = path.join(targetRoot, 'scripts');
	const stagingDir = path.join(targetRoot, '.scripts-copy-tmp');
	const backupDir = path.join(targetRoot, '.scripts-copy-backup');

	// Clear leftovers from a previously interrupted copy.
	fs.rmSync(stagingDir, { recursive: true, force: true });
	fs.rmSync(backupDir, { recursive: true, force: true });

	try {
		// step: stage the copy beside the target so the final swap is a
		// same-volume rename
		log(`Copying ${SOURCE_SCRIPTS} -> ${scriptsDir} ...`);
		fs.cpSync(SOURCE_SCRIPTS, stagingDir, {
			recursive: true,
			filter: (src) => !EXCLUDED_DIRS.has(path.basename(src)),
		});

		// step: swap — keep the old tree as a backup until the new one is
		// in place (a fresh target may have no scripts/ yet)
		const hadScripts = fs.existsSync(scriptsDir);
		if (hadScripts) {
			await renameWithRetry(scriptsDir, backupDir);
		}
		try {
			await renameWithRetry(stagingDir, scriptsDir);
		} catch (err) {
			// Restore the original scripts/ so the target's builder still works.
			if (hadScripts) {
				await renameWithRetry(backupDir, scriptsDir);
			}
			throw err;
		}
		fs.rmSync(backupDir, { recursive: true, force: true });

		log(`${scriptsDir} updated from the local builder`);
	} finally {
		// The staging directory is transient in every outcome.
		fs.rmSync(stagingDir, { recursive: true, force: true });
	}
}

module.exports = { copyScripts };
