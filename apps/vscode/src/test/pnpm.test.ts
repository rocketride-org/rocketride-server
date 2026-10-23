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
import type { execFile } from 'child_process';
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
	}) as unknown as typeof execFile;
	const installed = await checkPnpmInstalled(mockExec);
	assert.equal(installed, true);
});

test('checkPnpmInstalled resolves false when exec fails with ENOENT', async () => {
	const mockExec = ((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
		const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
		err.code = 'ENOENT';
		cb(err);
	}) as unknown as typeof execFile;
	const installed = await checkPnpmInstalled(mockExec);
	assert.equal(installed, false);
});

test('checkPnpmInstalled resolves true when exec times out (treated as unknown / proceed)', async () => {
	const mockExec = ((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
		const err = new Error('timed out') as NodeJS.ErrnoException & { killed?: boolean };
		err.killed = true;
		err.code = 'ETIMEDOUT';
		cb(err);
	}) as unknown as typeof execFile;
	const installed = await checkPnpmInstalled(mockExec);
	assert.equal(installed, true);
});

test('checkPnpmInstalled rejects when exec fails with EPERM or other non-missing error', async () => {
	const mockExec = ((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
		const err = new Error('permission denied') as NodeJS.ErrnoException;
		err.code = 'EPERM';
		cb(err);
	}) as unknown as typeof execFile;
	await assert.rejects(checkPnpmInstalled(mockExec), /permission denied/);
});

test('checkPnpmInstalled resolves false on Windows shell exit code 9009', async () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
	Object.defineProperty(process, 'platform', { value: 'win32' });
	try {
		const mockExec = ((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
			const err = new Error('Command failed') as NodeJS.ErrnoException;
			err.code = 9009 as unknown as string;
			cb(err, '', '\'pnpm\' is not recognized as an internal or external command');
		}) as unknown as typeof execFile;
		const installed = await checkPnpmInstalled(mockExec);
		assert.equal(installed, false);
	} finally {
		if (originalPlatform) {
			Object.defineProperty(process, 'platform', originalPlatform);
		}
	}
});

test('isWindowsMissingPnpmShellExit identifies missing pnpm on win32', () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
	Object.defineProperty(process, 'platform', { value: 'win32' });

	try {
		assert.equal(isWindowsMissingPnpmShellExit(1, '\'pnpm\' is not recognized as an internal or external command'), true);
		assert.equal(isWindowsMissingPnpmShellExit(9009, '\'pnpm\' is not recognized as an internal or external command'), true);
		assert.equal(isWindowsMissingPnpmShellExit(9009, 'Der Befehl "pnpm" ist entweder falsch geschrieben oder konnte nicht gefunden werden.'), true);
		assert.equal(isWindowsMissingPnpmShellExit(9009, ''), true);
		// A pnpm shim failing because Node is missing must NOT be treated as missing pnpm
		assert.equal(isWindowsMissingPnpmShellExit(9009, '\'node\' is not recognized as an internal or external command'), false);
		assert.equal(isWindowsMissingPnpmShellExit(9009, 'Der Befehl "node" ist entweder falsch geschrieben oder konnte nicht gefunden werden.'), false);
		assert.equal(isWindowsMissingPnpmShellExit(0, '\'pnpm\' is not recognized as an internal or external command'), false);
		assert.equal(isWindowsMissingPnpmShellExit(1, 'some other error'), false);
		assert.equal(isWindowsMissingPnpmShellExit(null, '\'pnpm\' is not recognized'), false);
	} finally {
		if (originalPlatform) {
			Object.defineProperty(process, 'platform', originalPlatform);
		}
	}
});
