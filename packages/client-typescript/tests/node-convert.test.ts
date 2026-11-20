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
 * `rocketride node convert` — parity with the Python CLI.
 *
 * The TypeScript converter is a port of the Python one; both suites read the
 * SAME fixtures (`packages/client-python/tests/fixtures/node_convert`, one
 * home, never copied) and must turn each `<case>.old.json` into exactly
 * `<case>.expected.json`: the definition, the `legacy` block and the
 * warnings. The Python suite additionally holds the block to
 * `tools/legacy_blocks.py`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { executeNodeConvert } from '../src/cli/commands/node';
import { conversionText, convertDefinition, isOldFormat, loadJson } from '../src/cli/node_convert';
import { Output } from '../src/cli/output';

// =============================================================================
// FIXTURES
// =============================================================================

const FIXTURES = path.resolve(__dirname, '../../client-python/tests/fixtures/node_convert');
const CASES: { case: string; node: string | null }[] = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cases.json'), 'utf8')).cases;

/** The old input of a case, parsed the way the CLI parses it. */
const oldOf = (name: string) => loadJson(fs.readFileSync(path.join(FIXTURES, `${name}.old.json`), 'utf8'));

/** The expected `{definition, warnings, legacy}` of a case. */
const expectedOf = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.expected.json`), 'utf8'));

let logs: string[];
let errors: string[];
let workDir: string;

beforeEach(() => {
	logs = [];
	errors = [];
	jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
		logs.push(args.map(String).join(' '));
	});
	jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(' '));
	});
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-node-convert-'));
});

afterEach(() => {
	jest.restoreAllMocks();
	fs.rmSync(workDir, { recursive: true, force: true });
});

// =============================================================================
// THE FIXTURE CASES (the parity contract with the Python CLI)
// =============================================================================

describe('node convert fixtures', () => {
	it('has cases to check', () => {
		expect(CASES.length).toBeGreaterThan(0);
	});

	for (const { case: name } of CASES) {
		it(`converts ${name} exactly as the Python CLI does`, () => {
			const result = convertDefinition(oldOf(name));
			const expected = expectedOf(name);
			expect(result.definition).toEqual(expected.definition);
			expect(result.warnings).toEqual(expected.warnings);
			expect(result.legacy).toBe(expected.legacy);
		});

		it(`writes ${name} as text that parses back`, () => {
			const result = convertDefinition(oldOf(name));
			const text = conversionText(result);
			expect(JSON.parse(text)).toEqual(result.definition);
			expect(text.endsWith('}\n')).toBe(true);
			expect(isOldFormat(result.definition)).toBe(false);
		});
	}

	it('refuses a definition already in the current format', () => {
		expect(() => convertDefinition({ title: 'x', protocol: 'x://', properties: [] })).toThrow('not an old-format node definition');
	});
});

// =============================================================================
// THE COMMAND
// =============================================================================

describe('rocketride node convert', () => {
	/** A copy of a fixture's old input in the scratch directory. */
	const stage = (name: string): string => {
		const target = path.join(workDir, 'services.json');
		fs.copyFileSync(path.join(FIXTURES, `${name}.old.json`), target);
		return target;
	};

	it('converts in place', async () => {
		const target = stage('store_qdrant');
		expect(await executeNodeConvert([target], {}, new Output(undefined))).toBe(0);
		expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(expectedOf('store_qdrant').definition);
		expect(logs.join('\n')).toContain('(legacy block added)');
		expect(errors.join('\n')).toContain('Transform');
	});

	it('writes nothing under --dry-run', async () => {
		const target = stage('tool_gcs');
		const original = fs.readFileSync(target, 'utf8');
		expect(await executeNodeConvert([target], { dryRun: true }, new Output(undefined))).toBe(0);
		expect(fs.readFileSync(target, 'utf8')).toBe(original);
		expect(JSON.parse(logs.join('\n'))).toEqual(expectedOf('tool_gcs').definition);
	});

	it('carries the definition in the --dry-run --json result', async () => {
		const out = new Output(true);
		expect(await executeNodeConvert([path.join(FIXTURES, 'tool_gcs.old.json')], { dryRun: true }, out)).toBe(0);
		out.finish();
		const entry = JSON.parse(logs.join('\n')).files[0];
		expect(entry.out).toBeNull();
		expect(entry.definition).toEqual(expectedOf('tool_gcs').definition);
	});

	it('writes to --out', async () => {
		const target = path.join(workDir, 'out', 'services.json');
		expect(await executeNodeConvert([path.join(FIXTURES, 'azure.old.json')], { out: target }, new Output(undefined))).toBe(0);
		expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(expectedOf('azure').definition);
	});

	it('takes one file with --out', async () => {
		const out = new Output(undefined);
		expect(await executeNodeConvert(['a.json', 'b.json'], { out: path.join(workDir, 'x.json') }, out)).toBe(1);
		expect(errors.join('\n')).toContain('--out takes exactly one input file');
	});

	it('reports a current-format file and exits 1', async () => {
		const target = path.join(workDir, 'services.json');
		fs.writeFileSync(target, '{"title": "x", "protocol": "x://", "properties": []}');
		const out = new Output(true);
		expect(await executeNodeConvert([target], {}, out)).toBe(1);
		out.finish();
		expect(errors.join('\n')).toContain('not an old-format node definition');
		expect(JSON.parse(logs.join('\n')).files[0].error).toMatch(/^not an old-format/);
	});
});
