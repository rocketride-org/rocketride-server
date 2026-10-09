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
	"pnpm is required for the App Builder but was not found on PATH. Install it globally with 'npm install -g pnpm'.";

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
	return process.platform === 'win32' && code !== 0 && code !== null && output.includes('\'pnpm\' is not recognized');
}

/**
 * Checks whether `pnpm` is executable and reachable on the system PATH.
 *
 * @param exec - Optional execution function for dependency injection in tests.
 */
export function checkPnpmInstalled(exec: typeof execFile = execFile): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		exec('pnpm', ['--version'], { shell: process.platform === 'win32' }, (err) => {
			resolve(!err);
		});
	});
}
