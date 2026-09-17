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
const os = require('os');
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

/**
 * Split `--pytest` option values into argv tokens.
 *
 * @param {string|string[]|undefined} opts  CLI passes an array like ["-v -s"].
 * @returns {string[]}
 */
function splitPytestOpts(opts) {
	if (!opts) return [];
	const values = Array.isArray(opts) ? opts : [opts];
	return values.flatMap((value) => String(value).split(/\s+/).filter(Boolean));
}

// xdist options that take a separate value when not written as `--opt=value`.
const XDIST_VALUE_OPTS = new Set(['-n', '--numprocesses', '--maxprocesses', '--dist', '--tx']);

function isXdistToken(token) {
	const name = token.split('=')[0];
	return XDIST_VALUE_OPTS.has(name) || token === '-d' || /^-n\S+$/.test(token);
}

/**
 * Drop xdist arguments (and their values), for passes that must run in one process.
 *
 * @param {string[]} tokens
 * @returns {string[]}
 */
function withoutXdistArgs(tokens) {
	const out = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!isXdistToken(token)) {
			out.push(token);
		} else if (XDIST_VALUE_OPTS.has(token)) {
			i++;
		}
	}
	return out;
}

/**
 * Whether the tokens start xdist workers (`-n N` / `--numprocesses N`, N not 0).
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function requestsXdistWorkers(tokens) {
	let value;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === '-n' || token === '--numprocesses') value = tokens[i + 1];
		else if (token.startsWith('--numprocesses=')) value = token.slice('--numprocesses='.length);
		else if (/^-n\S+$/.test(token)) value = token.slice(2).replace(/^=/, '');
	}
	return value !== undefined && !['0', 'off', ''].includes(String(value).toLowerCase());
}

/**
 * Whether the tokens choose an xdist distribution mode.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function hasDistMode(tokens) {
	return tokens.some((t) => t === '--dist' || t.startsWith('--dist=') || t === '-d');
}

/**
 * Run a pytest pass that writes a report (`--rocketride-report=<file>`, see
 * nodes/test/conftest.py) and queue it on `ctx.reports`. The default renderer
 * drops task output on success, so TaskRunner prints queued reports at the end.
 *
 * @param {object} ctx                   Builder context.
 * @param {(reportArg: string) => Promise<any>} run  Runs pytest with the extra argument.
 * @returns {Promise<void>}
 */
async function collectPytestReport(ctx, run) {
	const file = path.join(os.tmpdir(), `rocketride-report-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
	try {
		await run(`--rocketride-report=${file}`);
		const text = await fs.readFile(file, 'utf8').catch(() => '');
		if (text.trim()) {
			ctx.reports = ctx.reports || [];
			ctx.reports.push(text.trimEnd());
		}
	} finally {
		await fs.rm(file, { force: true });
	}
}

module.exports = { runPytest, splitPytestOpts, withoutXdistArgs, requestsXdistWorkers, hasDistMode, collectPytestReport };
