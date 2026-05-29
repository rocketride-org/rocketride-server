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

import { describe, it, expect, afterAll } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resolveAgents, runInit, InitDeps } from '../src/cli/init';

/** Temp workspaces created by mkTempCwd, removed in afterAll. */
const tmpDirs: string[] = [];

async function mkTempCwd(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-init-'));
	tmpDirs.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function exists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

/** Deps for offline tests: silent logger, catalog disabled via runInit opts. */
function offlineDeps(cwd: string): InitDeps {
	return {
		cwd,
		log: () => undefined,
		fetchCatalog: async () => null,
	};
}

describe('resolveAgents', () => {
	it('returns null when no slugs are given', () => {
		expect(resolveAgents(undefined)).toBeNull();
		expect(resolveAgents([])).toBeNull();
	});

	it('maps slugs to canonical names (case-insensitive)', () => {
		expect(resolveAgents(['claude-code', 'CURSOR', 'Windsurf'])).toEqual(['Claude Code', 'Cursor', 'Windsurf']);
		expect(resolveAgents(['copilot', 'claude-md', 'agents-md'])).toEqual(['Copilot', 'CLAUDE.md', 'AGENTS.md']);
	});

	it('throws naming the bad slug and listing valid slugs', () => {
		expect(() => resolveAgents(['bogus'])).toThrow(/bogus/);
		expect(() => resolveAgents(['bogus'])).toThrow(/claude-code/);
	});
});

const DOC = 'ROCKETRIDE_README.md';

describe('runInit (offline)', () => {
	it('scaffolds docs, gitignore, all six stubs, and .env when no --agent and --no-catalog', async () => {
		const cwd = await mkTempCwd();
		const code = await runInit({ catalog: false }, offlineDeps(cwd));
		expect(code).toBe(0);

		expect(await exists(path.join(cwd, '.rocketride/docs', DOC))).toBe(true);
		expect(await exists(path.join(cwd, '.claude/rules/rocketride.md'))).toBe(true);
		expect(await exists(path.join(cwd, '.cursor/rules/rocketride.mdc'))).toBe(true);
		expect(await exists(path.join(cwd, '.windsurf/rules/rocketride.md'))).toBe(true);
		expect(await exists(path.join(cwd, '.github/copilot-instructions.md'))).toBe(true);
		expect(await exists(path.join(cwd, 'CLAUDE.md'))).toBe(true);
		expect(await exists(path.join(cwd, 'AGENTS.md'))).toBe(true);

		// .env template created with prefilled URI
		const env = await fs.readFile(path.join(cwd, '.env'), 'utf8');
		expect(env).toContain('ROCKETRIDE_APIKEY=');
		expect(env).toContain('ROCKETRIDE_URI=http://localhost:5565');

		// .gitignore has both .rocketride/ (from agents-core) and .env (from init)
		const gi = await fs.readFile(path.join(cwd, '.gitignore'), 'utf8');
		const lines = gi.split('\n').map((l) => l.trim());
		expect(lines).toContain('.rocketride/');
		expect(lines).toContain('.env');

		// catalog disabled -> no services-catalog.json
		expect(await exists(path.join(cwd, '.rocketride/services-catalog.json'))).toBe(false);
	});

	it('installs only the named agent with --agent claude-code', async () => {
		const cwd = await mkTempCwd();
		await runInit({ agent: ['claude-code'], catalog: false }, offlineDeps(cwd));
		expect(await exists(path.join(cwd, '.claude/rules/rocketride.md'))).toBe(true);
		expect(await exists(path.join(cwd, '.cursor/rules/rocketride.mdc'))).toBe(false);
	});

	it('does not overwrite an existing .env and is idempotent on re-run', async () => {
		const cwd = await mkTempCwd();
		await fs.writeFile(path.join(cwd, '.env'), 'ROCKETRIDE_APIKEY=secret123\n', 'utf8');
		await runInit({ catalog: false }, offlineDeps(cwd));
		const first = await fs.readFile(path.join(cwd, '.env'), 'utf8');
		expect(first).toBe('ROCKETRIDE_APIKEY=secret123\n'); // untouched

		await runInit({ catalog: false }, offlineDeps(cwd)); // second run must not throw
		const second = await fs.readFile(path.join(cwd, '.env'), 'utf8');
		expect(second).toBe('ROCKETRIDE_APIKEY=secret123\n');
		// .env appears only once in .gitignore after two runs
		const gi = await fs.readFile(path.join(cwd, '.gitignore'), 'utf8');
		const envCount = gi.split('\n').filter((l) => l.trim() === '.env').length;
		expect(envCount).toBe(1);
	});

	it('rejects an unknown agent slug before writing anything', async () => {
		const cwd = await mkTempCwd();
		await expect(runInit({ agent: ['nope'], catalog: false }, offlineDeps(cwd))).rejects.toThrow(/nope/);
		expect(await exists(path.join(cwd, '.rocketride/docs', DOC))).toBe(false);
	});
});
