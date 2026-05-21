// =============================================================================
// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Pytest runner helper.
 *
 * Wraps the standard ``engine -m pytest <dir> [extra args]`` invocation with a
 * pre-flight check that skips when the target directory does not exist OR
 * contains no test files (matches ``pyproject.toml`` ``[tool.pytest.ini_options]``
 * ``python_files`` patterns).
 *
 * Why: pytest exits with code 5 (``no tests collected``) when invoked on an
 * empty directory. The engine binary surfaces that as ``Python error 5`` and
 * the builder reports the whole task as failed. Refactors that move the last
 * test out of a dir (or soft resets that recreate a dir) trigger this
 * failure repeatedly; centralising the guard means every pytest task gets
 * the same protection.
 */

const fs = require('fs').promises;
const path = require('path');
const { glob } = require('glob');
const { execCommand } = require('./exec');
const { exists } = require('./fs');

/**
 * Run pytest with empty-directory skip.
 *
 * @param {object} opts
 * @param {string} opts.engine          Absolute path to the engine binary (or ``python``).
 * @param {string} opts.testsDir        Absolute path to the directory pytest will target.
 * @param {string[]} [opts.extraArgs]   Extra args appended after ``['-m', 'pytest', testsDir]``
 *                                      (e.g. ``['-v', '--rootdir', ...]``).
 * @param {object} [opts.execOpts]      Forwarded to ``execCommand`` (e.g. ``{ task, cwd, env }``).
 * @returns {Promise<{ skipped: boolean, reason?: string }>}
 *          ``{ skipped: false }`` on a normal pytest run.
 *          ``{ skipped: true, reason: 'missing' | 'empty' }`` when the guard skips.
 */
async function runPytest({ engine, testsDir, extraArgs = [], execOpts = {} }) {
	if (!engine) throw new TypeError('runPytest: engine path is required');
	if (!testsDir) throw new TypeError('runPytest: testsDir is required');

	if (!(await exists(testsDir))) {
		// Single-file targets (paths with an extension, e.g. ``test_contracts.py``)
		// must fail loudly when missing — renaming or moving the file is a real
		// regression that we must not silently mask. Directory targets are
		// treated as optional: a refactor may legitimately remove the last test
		// in a directory without breaking the build.
		if (path.extname(testsDir) !== '') {
			throw new Error(`pytest: target file ${testsDir} not found`);
		}
		if (execOpts.task) {
			execOpts.task.output = `pytest: ${testsDir} not found, skipping`;
		}
		return { skipped: true, reason: 'missing' };
	}

	// Empty-directory guard only applies when ``testsDir`` is a directory.
	// Callers also pass a single file path (e.g. test_contracts.py) — in
	// that case ``exists`` is enough; pytest can run the file directly.
	const stat = await fs.stat(testsDir);
	if (stat.isDirectory()) {
		// Matches pyproject.toml ``python_files = ["test_*.py", "*_test.py"]``.
		const testFiles = [
			...(await glob('**/test_*.py', { cwd: testsDir })),
			...(await glob('**/*_test.py', { cwd: testsDir })),
		];
		if (testFiles.length === 0) {
			if (execOpts.task) {
				execOpts.task.output = `pytest: ${testsDir} has no test files, skipping`;
			}
			return { skipped: true, reason: 'empty' };
		}
	}

	const args = ['-m', 'pytest', testsDir, ...extraArgs];
	await execCommand(engine, args, execOpts);
	return { skipped: false };
}

module.exports = { runPytest };
