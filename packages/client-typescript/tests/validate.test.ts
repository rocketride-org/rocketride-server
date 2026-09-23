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
 * Unit tests for the `rocketride validate` CLI command.
 *
 * These tests do NOT require a live server: they exercise the pure helpers
 * (glob expansion, file loading, exit-code mapping, JSON report shape) and
 * the cmdValidate wiring with a mocked client.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import { executeValidate, expandFilePatterns, loadPipelineFile, buildValidateReport, validateExitCode, formatValidationIssue, FileValidationResult } from '../src/cli/commands/validate';
import * as common from '../src/cli/common';
import { Output } from '../src/cli/output';

const PIPELINE = {
	project_id: 'test-project',
	components: [
		{
			id: 'webhook_1',
			provider: 'webhook',
			config: { hideForm: true, mode: 'Source', type: 'webhook' },
		},
		{
			id: 'response_1',
			provider: 'response',
			config: { lanes: [] },
			input: [{ lane: 'text', from: 'webhook_1' }],
		},
	],
	source: 'webhook_1',
};

let tmpDir: string;
let validFile: string;
let wrappedFile: string;
let badJsonFile: string;
let arrayFile: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketride-validate-'));
	validFile = path.join(tmpDir, 'valid.pipe');
	wrappedFile = path.join(tmpDir, 'wrapped.pipe');
	badJsonFile = path.join(tmpDir, 'bad.pipe');
	arrayFile = path.join(tmpDir, 'array.pipe');

	fs.writeFileSync(validFile, JSON.stringify(PIPELINE));
	fs.writeFileSync(wrappedFile, JSON.stringify({ pipeline: PIPELINE }));
	fs.writeFileSync(badJsonFile, '{ this is not json');
	fs.writeFileSync(arrayFile, '[1, 2, 3]');
	fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'not a pipeline');
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── expandFilePatterns ───────────────────────────────────────────────────────

describe('expandFilePatterns', () => {
	it('expands a glob pattern to sorted matching files', () => {
		const result = expandFilePatterns([path.join(tmpDir, '*.pipe')]);
		expect(result).toEqual([arrayFile, badJsonFile, validFile, wrappedFile]);
	});

	it('does not match files outside the pattern extension', () => {
		const result = expandFilePatterns([path.join(tmpDir, '*.pipe')]);
		expect(result).not.toContain(path.join(tmpDir, 'notes.txt'));
	});

	it('keeps a literal path with no matches so it can be reported as unreadable', () => {
		const missing = path.join(tmpDir, 'missing.pipe');
		expect(expandFilePatterns([missing])).toEqual([missing]);
	});

	it('deduplicates files matched by multiple patterns', () => {
		const result = expandFilePatterns([validFile, path.join(tmpDir, 'valid.*')]);
		expect(result).toEqual([validFile]);
	});

	it('returns an empty list for no patterns', () => {
		expect(expandFilePatterns([])).toEqual([]);
	});
});

// ── loadPipelineFile ─────────────────────────────────────────────────────────

describe('loadPipelineFile', () => {
	it('parses a flat pipeline object', () => {
		const result = loadPipelineFile(validFile);
		expect(result.error).toBeUndefined();
		expect(result.config).toEqual(PIPELINE);
	});

	it('unwraps the { "pipeline": { ... } } wrapper format', () => {
		const result = loadPipelineFile(wrappedFile);
		expect(result.error).toBeUndefined();
		expect(result.config).toEqual(PIPELINE);
	});

	it('reports invalid JSON as an error', () => {
		const result = loadPipelineFile(badJsonFile);
		expect(result.config).toBeUndefined();
		expect(result.error).toContain('Invalid JSON');
	});

	it('reports non-object JSON as an error', () => {
		const result = loadPipelineFile(arrayFile);
		expect(result.config).toBeUndefined();
		expect(result.error).toContain('expected a JSON object');
	});

	it('reports a missing file as an error', () => {
		const result = loadPipelineFile(path.join(tmpDir, 'missing.pipe'));
		expect(result.config).toBeUndefined();
		expect(result.error).toContain('File not found');
	});
});

// ── validateExitCode ─────────────────────────────────────────────────────────

function makeResult(overrides: Partial<FileValidationResult>): FileValidationResult {
	return { file: 'a.pipe', valid: true, errors: [], warnings: [], processed: true, ...overrides };
}

describe('validateExitCode', () => {
	it('returns 0 when all files are valid', () => {
		expect(validateExitCode([makeResult({}), makeResult({ file: 'b.pipe' })])).toBe(0);
	});

	it('returns 1 when at least one file failed validation', () => {
		expect(validateExitCode([makeResult({}), makeResult({ file: 'b.pipe', valid: false, errors: [{ message: 'bad' }] })])).toBe(1);
	});

	it('returns 1 when one file is unparseable but another was processed', () => {
		expect(validateExitCode([makeResult({}), makeResult({ file: 'b.pipe', valid: false, processed: false })])).toBe(1);
	});

	it('returns 2 when no file could be processed', () => {
		expect(validateExitCode([makeResult({ valid: false, processed: false }), makeResult({ file: 'b.pipe', valid: false, processed: false })])).toBe(2);
	});

	it('returns 2 for an empty result list', () => {
		expect(validateExitCode([])).toBe(2);
	});
});

// ── buildValidateReport ──────────────────────────────────────────────────────

describe('buildValidateReport', () => {
	it('produces the machine-readable report shape', () => {
		const results = [makeResult({}), makeResult({ file: 'b.pipe', valid: false, errors: [{ message: 'bad' }], warnings: [{ message: 'careful' }] })];
		const report = buildValidateReport(results);

		expect(Object.keys(report)).toEqual(['files', 'summary']);
		expect(report.summary).toEqual({ total: 2, valid: 1, invalid: 1 });
		expect(report.files).toHaveLength(2);
		expect(Object.keys(report.files[0])).toEqual(['file', 'valid', 'errors', 'warnings']);
		expect(report.files[0]).toEqual({ file: 'a.pipe', valid: true, errors: [], warnings: [] });
		expect(report.files[1]).toEqual({ file: 'b.pipe', valid: false, errors: [{ message: 'bad' }], warnings: [{ message: 'careful' }] });
	});
});

// ── formatValidationIssue ────────────────────────────────────────────────────

describe('formatValidationIssue', () => {
	it('passes strings through unchanged', () => {
		expect(formatValidationIssue('plain message')).toBe('plain message');
	});

	it('formats { message } objects', () => {
		expect(formatValidationIssue({ message: 'bad component' })).toBe('bad component');
	});

	it('appends the component id when present', () => {
		expect(formatValidationIssue({ message: 'bad component', id: 'chat_1' })).toBe('bad component (chat_1)');
	});

	it('stringifies unexpected values', () => {
		expect(formatValidationIssue(42)).toBe('42');
	});
});

// ── executeValidate wiring (mocked client) ──────────────────────────────────

interface MockValidateResponse {
	errors?: unknown[];
	warnings?: unknown[];
}

type ConnectedClient = Awaited<ReturnType<typeof common.connectClient>>;

// The command binds connectClient at call time through the module object, so
// a spy on the common module intercepts it — the same seam the Python twin
// patches (commands.validate.connect_client).
function mockClient(validateImpl: (options: { pipeline: Record<string, unknown>; source?: string }) => Promise<MockValidateResponse>) {
	const fakeClient = {
		validate: jest.fn(validateImpl),
		disconnect: jest.fn(async () => {}),
	};
	const connectSpy = jest.spyOn(common, 'connectClient').mockImplementation(async () => fakeClient as unknown as ConnectedClient);
	return { fakeClient, connectSpy };
}

function captureConsole(): { logs: string[]; errors: string[]; restore: () => void } {
	const logs: string[] = [];
	const errors: string[] = [];
	const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
		logs.push(args.map(String).join(' '));
	});
	const errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(' '));
	});
	return {
		logs,
		errors,
		restore: () => {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		},
	};
}

// Run in bare-json mode and flush, so the captured stdout is exactly the report.
async function runJson(files: string[], options: Record<string, unknown>, output: ReturnType<typeof captureConsole>): Promise<number> {
	const out = new Output(true);
	try {
		return await executeValidate(files, { ...options, json: true }, out);
	} finally {
		out.finish();
		output.restore();
	}
}

describe('executeValidate', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('returns 0 and prints the JSON report when all files are valid', async () => {
		const { fakeClient } = mockClient(async () => ({ errors: [], warnings: [] }));
		const output = captureConsole();

		const exitCode = await runJson([validFile], {}, output);
		expect(exitCode).toBe(0);

		const report = JSON.parse(output.logs.join('\n'));
		expect(report.summary).toEqual({ total: 1, valid: 1, invalid: 0 });
		expect(report.files).toEqual([{ file: validFile, valid: true, errors: [], warnings: [] }]);
		expect(fakeClient.validate).toHaveBeenCalledTimes(1);
		expect(fakeClient.validate).toHaveBeenCalledWith({ pipeline: PIPELINE, source: undefined });
	});

	it('passes --source through to the client validate call', async () => {
		const { fakeClient } = mockClient(async () => ({ errors: [], warnings: [] }));
		const output = captureConsole();

		const exitCode = await runJson([validFile], { source: 'chat_1' }, output);
		expect(exitCode).toBe(0);

		expect(fakeClient.validate).toHaveBeenCalledWith({ pipeline: PIPELINE, source: 'chat_1' });
	});

	it('returns 1 when the server reports validation errors', async () => {
		mockClient(async () => ({ errors: [{ message: 'unknown provider', id: 'x_1' }], warnings: [] }));
		const output = captureConsole();

		const exitCode = await runJson([validFile], {}, output);
		expect(exitCode).toBe(1);

		const report = JSON.parse(output.logs.join('\n'));
		expect(report.summary).toEqual({ total: 1, valid: 0, invalid: 1 });
		expect(report.files[0].valid).toBe(false);
		expect(report.files[0].errors).toEqual([{ message: 'unknown provider', id: 'x_1' }]);
	});

	it('returns 1 when one file is unparseable but another validates', async () => {
		const { fakeClient } = mockClient(async () => ({ errors: [], warnings: [] }));
		const output = captureConsole();

		const exitCode = await runJson([badJsonFile, validFile], {}, output);
		expect(exitCode).toBe(1);

		const report = JSON.parse(output.logs.join('\n'));
		expect(report.summary).toEqual({ total: 2, valid: 1, invalid: 1 });
		// Only the parseable file reaches the server
		expect(fakeClient.validate).toHaveBeenCalledTimes(1);
	});

	it('returns 2 without connecting when no file can be parsed', async () => {
		const { fakeClient, connectSpy } = mockClient(async () => ({ errors: [], warnings: [] }));
		const output = captureConsole();

		const exitCode = await runJson([badJsonFile], {}, output);
		expect(exitCode).toBe(2);

		const report = JSON.parse(output.logs.join('\n'));
		expect(report.summary).toEqual({ total: 1, valid: 0, invalid: 1 });
		expect(fakeClient.validate).not.toHaveBeenCalled();
		expect(connectSpy).not.toHaveBeenCalled();
	});

	it('returns 2 on connection failure', async () => {
		jest.spyOn(common, 'connectClient').mockImplementation(async () => {
			throw new Error('connection refused');
		});
		const output = captureConsole();

		const exitCode = await runJson([validFile], { uri: 'ws://localhost:5565' }, output);
		expect(exitCode).toBe(2);

		expect(output.errors.join('\n')).toContain('Failed to connect');
	});

	it('prints per-file lines and a summary in human-readable mode', async () => {
		mockClient(async () => ({ errors: [], warnings: [{ message: 'heads up' }] }));
		const output = captureConsole();

		const out = new Output(undefined);
		let exitCode = -1;
		try {
			exitCode = await executeValidate([validFile, badJsonFile], {}, out);
		} finally {
			output.restore();
		}
		expect(exitCode).toBe(1);

		const text = output.logs.join('\n');
		expect(text).toContain(`${validFile}: valid`);
		expect(text).toContain('heads up');
		expect(text).toContain(`${badJsonFile}: invalid`);
		expect(text).toContain('Invalid JSON');
		expect(text).toContain('Summary: 2 file(s), 1 valid, 1 invalid');
	});
});
