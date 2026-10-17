// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Utilities for detecting and handling pnpm dependency requirements in App Builder.
 */
import { execFile } from 'child_process';

/** Error message when pnpm cannot be found on PATH. */
export const MISSING_PNPM_MESSAGE =
	'pnpm is required for the App Builder but was not found on PATH. Install it globally with \'npm install -g pnpm@10\'.';

/**
 * Tests whether an error caught when spawning pnpm indicates that the binary is missing (ENOENT).
 *
 * @param err - Caught error to inspect.
 */
export function isPnpmMissingError(err: unknown): boolean {
	if (!err) return false;
	const e = err as NodeJS.ErrnoException;
	if (e.code !== undefined) {
		return e.code === 'ENOENT';
	}
	if (typeof e.message === 'string' && e.message.includes('ENOENT')) return true;
	return false;
}

/**
 * Tests whether a Windows shell exit indicates that pnpm is missing.
 *
 * @param code - Process exit code.
 * @param output - Process stdout/stderr output.
 */
export function isWindowsMissingPnpmShellExit(code: number | null, output: string): boolean {
	if (process.platform !== 'win32' || code === null || code === 0) {
		return false;
	}
	// A pnpm.cmd shim can fail with exit code 9009 if Node itself is missing from PATH.
	// In that case, cmd.exe reports that 'node' is not recognized — do not
	// classify a missing Node runtime as absent pnpm.
	if (output.includes('\'node\'') || output.includes('"node"')) {
		return false;
	}
	const hasPnpm = output.includes('\'pnpm\'') || output.includes('"pnpm"');
	if (code === 9009) {
		// Exit code 9009 is cmd.exe's language-independent "command not found" code.
		// Verify pnpm is the missing command if output was captured.
		return hasPnpm || !output.trim();
	}
	return hasPnpm && output.includes('is not recognized');
}

/**
 * Checks whether `pnpm` is executable and reachable on the system PATH.
 *
 * @param exec - Optional execution function for dependency injection in tests.
 */
export function checkPnpmInstalled(exec: typeof execFile = execFile): Promise<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		exec('pnpm', ['--version'], { shell: process.platform === 'win32', timeout: 10_000 }, (err, stdout, stderr) => {
			if (!err) {
				resolve(true);
				return;
			}
			// When execution times out (e.g. Corepack interactive prompt, slow AV scan),
			// treat as "unknown, proceed" rather than falsely reporting pnpm as missing.
			if (err.killed || (err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
				resolve(true);
				return;
			}
			const code = typeof err.code === 'number' ? err.code : (Number.isInteger(Number(err.code)) ? Number(err.code) : null);
			const combinedOutput = `${stdout || ''} ${stderr || ''} ${err.message || ''}`;
			if (isPnpmMissingError(err) || isWindowsMissingPnpmShellExit(code, combinedOutput)) {
				resolve(false);
				return;
			}
			// Preserve and propagate EPERM and other non-missing execution failures.
			reject(err);
		});
	});
}
