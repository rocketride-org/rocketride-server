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
import { changedPipePaths, commitTurn, initGit, listTurns, phaseBody, revertTo, saveBack, saveBackOne, seedWorkspace, workspaceSize } from '../src/workspace';
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
	/** Directory listing derived from the flat `files` map — lets `listStorePipes` walk the tree. */
	async fsListDir(p: string) {
		const prefix = p.endsWith('/') ? p : `${p}/`;
		const files = new Set<string>();
		const dirs = new Set<string>();
		for (const key of this.files.keys()) {
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			const slash = rest.indexOf('/');
			if (slash === -1) files.add(rest);
			else dirs.add(rest.slice(0, slash));
		}
		return {
			entries: [
				...[...dirs].map((name) => ({ name, type: 'dir' as const })),
				...[...files].map((name) => ({ name, type: 'file' as const })),
			],
		};
	}
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
		// The mirror PRESERVES the store's folder — `.projects/demo/qa.pipe` seeds at `demo/qa.pipe`,
		// not flattened to the workspace root (the old flat-mirror bug).
		expect(fs.readFileSync(path.join(workspaceDir, 'demo', 'qa.pipe'), 'utf8')).toBe(PIPE); // byte-identical
		expect(fs.existsSync(path.join(workspaceDir, 'AGENTS.md'))).toBe(true);
		expect(fs.existsSync(path.join(workspaceDir, 'docs', 'ROCKETRIDE_PIPELINE_RULES.md'))).toBe(true);
		expect(fs.existsSync(path.join(workspaceDir, '.opencode', 'agent', 'rr-builder.md'))).toBe(true);
	});

	test('mirrors the WHOLE project store — prior pipes and nested folders, not just the opened one', async () => {
		const store = new FakeStore();
		store.files.set('.projects/demo/qa.pipe', PIPE);        // the opened pipe
		store.files.set('.projects/prior.pipe', PIPE);          // a previously-created pipe at the root
		store.files.set('.projects/examples/nested.pipe', PIPE); // one in a subfolder
		store.files.set('.projects/notes.txt', 'ignored');      // non-pipeline files are not mirrored
		const workspaceDir = path.join(tmp(), 'workspace');
		await seedWorkspace({ workspaceDir, pipePath: 'demo/qa.pipe', store, docsDir: cfg.docsDir, assetsDir: cfg.assetsDir });
		expect(fs.existsSync(path.join(workspaceDir, 'demo', 'qa.pipe'))).toBe(true);
		expect(fs.existsSync(path.join(workspaceDir, 'prior.pipe'))).toBe(true);
		expect(fs.existsSync(path.join(workspaceDir, 'examples', 'nested.pipe'))).toBe(true);
		expect(fs.existsSync(path.join(workspaceDir, 'notes.txt'))).toBe(false);
	});

	it('seeds the skill corpus and reads a phase body with a base-dir prefix', async () => {
		const { workspaceDir } = await seeded();
		const p = path.join(workspaceDir, 'skills/rocketride-designing-pipelines/SKILL.md');
		expect(fs.existsSync(p)).toBe(true);
		const body = phaseBody('designing', path.join(workspaceDir, 'skills'));
		expect(body).toContain('Base directory:');
		expect(body).toContain(fs.readFileSync(p, 'utf8').slice(0, 40));
	});

	it('throws a clear error for an unknown phase name', () => {
		expect(() => phaseBody('nonexistent', path.join(tmp(), 'skills'))).toThrow(/unknown phase/i);
	});
});

describe('saveBack', () => {
	test('round-trips unchanged pipe content byte-stable, preserving the folder', async () => {
		const { store, workspaceDir } = await seeded();
		const { written } = await saveBack({ workspaceDir, store, files: ['demo/qa.pipe'] });
		expect(written).toEqual(['.projects/demo/qa.pipe']);
		expect(store.files.get('.projects/demo/qa.pipe')).toBe(PIPE);
	});

	test('saves agent-created pipes (incl. nested) and skips broken ones (never fatal, per-file)', async () => {
		const { store, workspaceDir } = await seeded();
		await fsp.mkdir(path.join(workspaceDir, 'examples'), { recursive: true });
		await fsp.writeFile(path.join(workspaceDir, 'examples', 'new.pipe'), '{"pipeline":{"components":[]}}');
		await fsp.writeFile(path.join(workspaceDir, 'broken.pipe'), '{oops');
		const { written, skipped } = await saveBack({ workspaceDir, store, files: ['demo/qa.pipe', 'examples/new.pipe', 'broken.pipe'] });
		expect(skipped).toEqual(['broken.pipe']);
		// the nested pipe round-trips to its nested store path (not flattened)
		expect(written).toEqual(expect.arrayContaining(['.projects/examples/new.pipe', '.projects/demo/qa.pipe']));
		expect(store.files.get('.projects/examples/new.pipe')).toBeDefined();
		expect(store.files.has('.projects/broken.pipe')).toBe(false); // the invalid file never reaches the store
	});
});

describe('changedPipePaths', () => {
	it('reports only the pipes the agent touched since the session baseline', async () => {
		// Seed a store with two pipes; the mirror places them at demo/qa.pipe and prior.pipe.
		const store = new FakeStore();
		store.files.set('.projects/demo/qa.pipe', PIPE);
		store.files.set('.projects/prior.pipe', PIPE);
		const workspaceDir = path.join(tmp(), 'workspace');
		await seedWorkspace({ workspaceDir, pipePath: 'demo/qa.pipe', store, docsDir: cfg.docsDir, assetsDir: cfg.assetsDir });
		await initGit(workspaceDir); // baseline: root commit with everything seeded

		// The agent edits one pipe and creates a nested one; leaves prior.pipe untouched.
		await fsp.writeFile(path.join(workspaceDir, 'demo', 'qa.pipe'), PIPE.replace('[]', '[{"id":"n1"}]'));
		await fsp.mkdir(path.join(workspaceDir, 'examples'), { recursive: true });
		await fsp.writeFile(path.join(workspaceDir, 'examples', 'made.pipe'), PIPE);
		await commitTurn(workspaceDir, 'agent edit');

		const changed = await changedPipePaths(workspaceDir);
		expect(changed.sort()).toEqual(['demo/qa.pipe', 'examples/made.pipe']);
		expect(changed).not.toContain('prior.pipe'); // untouched → never re-written on idle
	});
});

/** Small fixtures for the `saveBackOne` write-through tests below, modeled on `seeded()` above. */
function withPosition(x: number, y: number): string {
	return JSON.stringify({ components: [{ id: 'n1', ui: { position: { x, y } } }] });
}

function strippedOfUi(): string {
	return JSON.stringify({ components: [{ id: 'n1' }] });
}

async function makeMirror(storeFiles: Record<string, string>): Promise<{ store: FakeStore; workspaceDir: string; storeRoot: string }> {
	const store = new FakeStore();
	const storeRoot = '.projects/demo';
	for (const [file, content] of Object.entries(storeFiles)) store.files.set(`${storeRoot}/${file}`, content);
	const workspaceDir = path.join(tmp(), 'workspace');
	await fsp.mkdir(workspaceDir, { recursive: true });
	return { store, workspaceDir, storeRoot };
}

async function writeWorkspacePipe(workspaceDir: string, file: string, content: string): Promise<void> {
	await fsp.writeFile(path.join(workspaceDir, file), content, 'utf8');
}

describe('saveBackOne', () => {
	it('propagates one pipe and preserves hand-placed positions', async () => {
		// store has old.pipe with a hand-placed node at {999,111}; workspace rewrites it stripping ui
		const { store, workspaceDir, storeRoot } = await makeMirror({ 'old.pipe': withPosition(999, 111) });
		await writeWorkspacePipe(workspaceDir, 'old.pipe', strippedOfUi());
		const r = await saveBackOne({ store, workspaceDir, storeRoot, file: 'old.pipe' });
		expect(r.written).toBe(true);
		const saved = JSON.parse(await store.fsReadString(`${storeRoot}/old.pipe`));
		expect(saved.components[0].ui.position).toEqual({ x: 999, y: 111 }); // restored, not zeroed
	});

	it('skips invalid JSON without throwing', async () => {
		const { store, workspaceDir, storeRoot } = await makeMirror({});
		await writeWorkspacePipe(workspaceDir, 'broken.pipe', '{ not json');
		const r = await saveBackOne({ store, workspaceDir, storeRoot, file: 'broken.pipe' });
		expect(r.written).toBe(false);
		expect(r.skipped).toBe('broken.pipe');
	});
});

describe('per-turn snapshots', () => {
	test('each file change lands one commit; revert restores any turn', async () => {
		const { workspaceDir } = await seeded();
		await initGit(workspaceDir);
		const pipe = path.join(workspaceDir, 'demo', 'qa.pipe');

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
