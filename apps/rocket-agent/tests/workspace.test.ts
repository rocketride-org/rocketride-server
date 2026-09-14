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

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/config';
import { commitTurn, initGit, listTurns, revertTo, saveBack, seedWorkspace, workspaceSize } from '../src/workspace';
import type { StoreFs } from '../src/types';

class FakeStore implements StoreFs {
	files = new Map<string, string>();
	async fsReadString(p: string) {
		const v = this.files.get(p);
		if (v === undefined) throw new Error(`ENOENT ${p}`);
		return v;
	}
	async fsWriteString(p: string, text: string) { this.files.set(p, text); }
	async close() { /* no-op */ }
}

const cfg = loadConfig({ RR_MCP_UPSTREAM: 'http://localhost:8080/mcp' });
const PIPE = '{\n  "pipeline": {\n    "components": []\n  }\n}';

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'ra-ws-'));
}

async function seeded() {
	const store = new FakeStore();
	store.files.set('.projects/demo/qa.pipe', PIPE);
	const workspaceDir = path.join(tmp(), 'workspace');
	await seedWorkspace({ workspaceDir, pipePath: 'demo/qa.pipe', store, docsDir: cfg.docsDir, assetsDir: cfg.assetsDir });
	return { store, workspaceDir };
}

describe('seedWorkspace', () => {
	test('produces the four artifact groups', async () => {
		const { workspaceDir } = await seeded();
		expect(fs.readFileSync(path.join(workspaceDir, 'qa.pipe'), 'utf8')).toBe(PIPE); // byte-identical
		expect(fs.existsSync(path.join(workspaceDir, 'AGENTS.md'))).toBe(true);
		expect(fs.existsSync(path.join(workspaceDir, 'docs', 'ROCKETRIDE_PIPELINE_RULES.md'))).toBe(true);
		expect(fs.existsSync(path.join(workspaceDir, '.opencode', 'agent', 'rr-builder.md'))).toBe(true);
	});
});

describe('saveBack', () => {
	test('round-trips unchanged pipe content byte-stable', async () => {
		const { store, workspaceDir } = await seeded();
		const written = await saveBack({ workspaceDir, store, storeDirFor: () => 'demo' });
		expect(written).toEqual(['.projects/demo/qa.pipe']);
		expect(store.files.get('.projects/demo/qa.pipe')).toBe(PIPE);
	});

	test('saves agent-created pipes and refuses syntactically broken ones', async () => {
		const { store, workspaceDir } = await seeded();
		await fsp.writeFile(path.join(workspaceDir, 'new.pipe'), '{"pipeline":{"components":[]}}');
		await fsp.writeFile(path.join(workspaceDir, 'broken.pipe'), '{oops');
		await expect(saveBack({ workspaceDir, store, storeDirFor: () => 'demo' })).rejects.toThrow(/broken\.pipe/);
		expect(store.files.has('.projects/demo/new.pipe')).toBe(false); // all-or-nothing per call
	});
});

describe('per-turn snapshots', () => {
	test('each file change lands one commit; revert restores any turn', async () => {
		const { workspaceDir } = await seeded();
		await initGit(workspaceDir);
		const pipe = path.join(workspaceDir, 'qa.pipe');

		await fsp.writeFile(pipe, PIPE.replace('[]', '[{"id":"n1"}]'));
		const turn1 = await commitTurn(workspaceDir, 'edit qa.pipe (turn 1)');
		expect(turn1).toMatch(/^[0-9a-f]{40}$/);

		await fsp.writeFile(pipe, PIPE.replace('[]', '[{"id":"n1"},{"id":"n2"}]'));
		const turn2 = await commitTurn(workspaceDir, 'edit qa.pipe (turn 2)');
		expect(turn2).not.toBe(turn1);

		expect(await commitTurn(workspaceDir, 'noop')).toBeNull(); // no change → no commit

		const turns = await listTurns(workspaceDir);
		expect(turns.map((t) => t.label)).toEqual(['edit qa.pipe (turn 2)', 'edit qa.pipe (turn 1)', 'session start']);

		await revertTo(workspaceDir, turn1!);
		expect(fs.readFileSync(pipe, 'utf8')).toContain('"n1"');
		expect(fs.readFileSync(pipe, 'utf8')).not.toContain('"n2"');
		// revert itself is a turn — the audit trail never loses history
		expect((await listTurns(workspaceDir))[0].label).toContain('revert');
	});
});

test('workspaceSize sums the tree', async () => {
	const { workspaceDir } = await seeded();
	expect(await workspaceSize(workspaceDir)).toBeGreaterThan(PIPE.length);
});
