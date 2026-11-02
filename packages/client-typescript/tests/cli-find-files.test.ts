/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * File expansion behind `rocketride upload`.
 *
 * Every path is built with path.join, so on Windows it carries backslashes:
 * the separator glob reads as an escape unless told otherwise.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { findFiles } from '../src/cli/commands/tasks';

let workDir: string;

beforeEach(() => {
	// Resolved, because process.cwd() is after a chdir: on macOS the temp dir
	// sits under /var, a symlink to /private/var
	workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-find-files-')));
	for (const name of ['alpha.txt', 'beta.txt', 'gamma.pdf']) {
		fs.writeFileSync(path.join(workDir, name), name);
	}
	fs.mkdirSync(path.join(workDir, 'nested'));
	fs.writeFileSync(path.join(workDir, 'nested', 'delta.txt'), 'delta');
});

afterEach(() => {
	fs.rmSync(workDir, { recursive: true, force: true });
});

/** The matched files as paths relative to the work dir, sorted. */
function names(files: string[]): string[] {
	return files.map((file) => path.relative(workDir, file)).sort();
}

describe('upload file expansion', () => {
	it('should match a wildcard in a native absolute path', () => {
		expect(names(findFiles([path.join(workDir, '*.txt')]))).toEqual(['alpha.txt', 'beta.txt']);
	});

	it('should match a wildcard in a native relative path', () => {
		const cwd = process.cwd();
		process.chdir(workDir);
		try {
			expect(names(findFiles([path.join('nested', '*.txt')]))).toEqual([path.join('nested', 'delta.txt')]);
		} finally {
			process.chdir(cwd);
		}
	});

	it('should take every file under a directory', () => {
		expect(names(findFiles([workDir]))).toEqual(['alpha.txt', 'beta.txt', 'gamma.pdf', path.join('nested', 'delta.txt')]);
	});

	it('should take a literal file as it is', () => {
		expect(names(findFiles([path.join(workDir, 'gamma.pdf')]))).toEqual(['gamma.pdf']);
	});

	it('should list a file once when patterns overlap', () => {
		expect(names(findFiles([path.join(workDir, '*.txt'), path.join(workDir, 'alpha.txt')]))).toEqual(['alpha.txt', 'beta.txt']);
	});

	it('should match nothing for a pattern nothing fits', () => {
		expect(findFiles([path.join(workDir, 'none-*.txt')])).toEqual([]);
	});
});
