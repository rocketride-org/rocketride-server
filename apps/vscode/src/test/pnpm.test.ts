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

import test from 'node:test';
import assert from 'node:assert/strict';
import { isPnpmMissingError, checkPnpmInstalled, isWindowsMissingPnpmShellExit } from '../shared/util/pnpm';

test('isPnpmMissingError identifies code ENOENT', () => {
	const err = new Error('spawn ENOENT');
	(err as NodeJS.ErrnoException).code = 'ENOENT';
	assert.equal(isPnpmMissingError(err), true);
});

test('isPnpmMissingError identifies ENOENT in message', () => {
	const err = new Error('spawn pnpm ENOENT');
	assert.equal(isPnpmMissingError(err), true);
});

test('isPnpmMissingError does not identify ENOENT in message if code is present', () => {
	const err = new Error('spawn pnpm ENOENT');
	(err as NodeJS.ErrnoException).code = 'EPERM';
	assert.equal(isPnpmMissingError(err), false);
});

test('isPnpmMissingError returns false for other errors or falsy values', () => {
	assert.equal(isPnpmMissingError(null), false);
	assert.equal(isPnpmMissingError(undefined), false);
	assert.equal(isPnpmMissingError(new Error('Command failed: exit 1')), false);
	const permErr = new Error('permission denied');
	(permErr as NodeJS.ErrnoException).code = 'EPERM';
	assert.equal(isPnpmMissingError(permErr), false);
});

test('checkPnpmInstalled resolves true when exec succeeds', async () => {
	const mockExec = ((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
		cb(null);
	}) as any;
	const installed = await checkPnpmInstalled(mockExec);
	assert.equal(installed, true);
});

test('checkPnpmInstalled resolves false when exec fails', async () => {
	const mockExec = ((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
		cb(new Error('spawn ENOENT'));
	}) as any;
	const installed = await checkPnpmInstalled(mockExec);
	assert.equal(installed, false);
});

test('isWindowsMissingPnpmShellExit identifies missing pnpm on win32', () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
	Object.defineProperty(process, 'platform', { value: 'win32' });
	
	try {
		assert.equal(isWindowsMissingPnpmShellExit(1, "'pnpm' is not recognized as an internal or external command"), true);
		assert.equal(isWindowsMissingPnpmShellExit(0, "'pnpm' is not recognized as an internal or external command"), false);
		assert.equal(isWindowsMissingPnpmShellExit(1, "some other error"), false);
	} finally {
		if (originalPlatform) {
			Object.defineProperty(process, 'platform', originalPlatform);
		}
	}
});
