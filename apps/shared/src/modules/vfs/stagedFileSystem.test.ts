// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { IWorkspaceFileSystem, VfsEntry, VfsOverlay } from './vfsTypes';
import { StagedFileSystem } from './stagedFileSystem';
import type { IStagingStore, Layer } from './stagedFileSystem';

// =============================================================================
// MOCKS — an in-memory base view and a recording staging store
// =============================================================================

/** In-memory IWorkspaceFileSystem used as the base (server truth). */
class MockBase implements IWorkspaceFileSystem {
	files = new Map<string, string>();
	dirs = new Set<string>();
	overlays = new Map<string, VfsOverlay>();
	private listeners = new Set<() => void>();

	async list(dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]> {
		const prefix = dir ? `${dir}/` : '';
		if (dir && !this.dirs.has(dir) && ![...this.files.keys()].some((p) => p.startsWith(prefix))) {
			throw new Error(`No such directory: ${dir}`);
		}
		const names = new Map<string, 'file' | 'dir'>();
		for (const p of this.files.keys()) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length);
			const name = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest;
			names.set(name, rest.includes('/') ? 'dir' : 'file');
		}
		for (const d of this.dirs) {
			if (!d.startsWith(prefix) || d === dir) continue;
			const rest = d.slice(prefix.length);
			const name = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest;
			if (!names.has(name)) names.set(name, 'dir');
		}
		return [...names.entries()].map(([name, type]) => ({ name, type }));
	}

	async read(path: string): Promise<unknown> {
		const overlay = this.overlays.get(path);
		if (overlay?.isDirty()) return overlay.getContent();
		if (!this.files.has(path)) throw new Error(`No such file: ${path}`);
		return this.files.get(path);
	}

	async readMany(paths: string[]): Promise<Record<string, unknown>> {
		const out: Record<string, unknown> = {};
		for (const p of paths) {
			try { out[p] = await this.read(p); } catch { /* omitted */ }
		}
		return out;
	}

	async stat(path: string): Promise<'file' | 'dir' | null> {
		return this.entryType(path);
	}

	async write(path: string, content: unknown): Promise<void> {
		this.files.set(path, String(content));
		this.notify();
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		const content = this.files.get(oldPath);
		if (content === undefined) throw new Error(`No such file: ${oldPath}`);
		this.files.delete(oldPath);
		this.files.set(newPath, content);
		this.notify();
	}

	async delete(path: string): Promise<void> {
		if (this.files.delete(path)) { this.notify(); return; }
		if (this.dirs.has(path)) {
			this.dirs.delete(path);
			for (const p of [...this.files.keys()]) if (p.startsWith(`${path}/`)) this.files.delete(p);
			this.notify();
			return;
		}
		throw new Error(`No such path: ${path}`);
	}

	async mkdir(path: string): Promise<void> {
		this.dirs.add(path);
		this.notify();
	}

	async refresh(): Promise<void> { this.notify(); }

	listEntries(): VfsEntry[] {
		const out: VfsEntry[] = [];
		for (const p of this.files.keys()) out.push({ path: p, type: 'file' });
		for (const d of this.dirs) out.push({ path: d, type: 'dir' });
		return out.sort((a, b) => a.path.localeCompare(b.path));
	}

	entryType(path: string): 'file' | 'dir' | null {
		if (this.files.has(path)) return 'file';
		if (this.dirs.has(path)) return 'dir';
		if ([...this.files.keys()].some((p) => p.startsWith(`${path}/`))) return 'dir';
		return null;
	}

	upsert(path: string, type: 'file' | 'dir'): void {
		if (type === 'dir') this.dirs.add(path);
	}

	prime(): void { /* content cache is the files map itself */ }
	invalidate(): void { /* no separate cache */ }

	/**
	 * Baseline the freshness gate compares against. The mock's "cache" IS
	 * the files map unless a test plants a divergent baseline to simulate
	 * "opened earlier, then the base moved" (see `baselines`).
	 */
	baselines = new Map<string, string>();
	cachedContent(path: string): unknown {
		if (this.baselines.has(path)) return this.baselines.get(path);
		return this.files.get(path);
	}

	async peekBase(path: string): Promise<unknown> {
		if (!this.files.has(path)) throw new Error(`No such file: ${path}`);
		return this.files.get(path);
	}

	registerOverlay(path: string, overlay: VfsOverlay): () => void {
		this.overlays.set(path, overlay);
		return () => this.overlays.delete(path);
	}

	isDirty(path: string): boolean {
		return this.overlays.get(path)?.isDirty() === true;
	}

	dirtyPaths(): Set<string> {
		const out = new Set<string>();
		for (const [p, o] of this.overlays) if (o.isDirty()) out.add(p);
		return out;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	notify(): void {
		for (const l of [...this.listeners]) l();
	}
}

/** Recording staging store — verifies persist-before-notify and rehydrate. */
class MockStaging implements IStagingStore {
	persisted: Layer[] | null = null;
	persistCount = 0;
	swept = false;
	gcRuns = 0;
	initial: Layer[] | null = null;

	async load(): Promise<Layer[] | null> { return this.initial; }

	async persist(layers: readonly Layer[]): Promise<void> {
		this.persistCount++;
		this.persisted = layers.map((l) => ({ ...l, entries: new Map(l.entries) }));
	}

	async sweep(): Promise<void> { this.swept = true; this.persisted = null; }
	async gc(): Promise<void> { this.gcRuns++; }
}

/** A staged view over a seeded base. */
function makeStaged(seed?: Record<string, string>, staging: IStagingStore | null = null): { base: MockBase; fs: StagedFileSystem } {
	const base = new MockBase();
	for (const [p, c] of Object.entries(seed ?? {})) base.files.set(p, c);
	return { base, fs: new StagedFileSystem(base, staging) };
}

// =============================================================================
// UNION READS
// =============================================================================

test('staged write wins over base; misses fall through', async () => {
	const { fs } = makeStaged({ 'pipelines/a.pipe': 'original' });
	await fs.write('pipelines/a.pipe', 'staged');
	assert.equal(await fs.read('pipelines/a.pipe'), 'staged');
	await fs.write('pipelines/new.pipe', 'fresh');
	assert.equal(await fs.read('pipelines/new.pipe'), 'fresh');
	// untouched paths come from the base
	const other = makeStaged({ 'x.txt': 'base' });
	assert.equal(await other.fs.read('x.txt'), 'base');
});

test('tombstones hide base files from read and list', async () => {
	const { fs } = makeStaged({ 'apps/x/a.ts': 'A', 'apps/x/b.ts': 'B' });
	await fs.delete('apps/x/a.ts');
	await assert.rejects(() => fs.read('apps/x/a.ts'));
	const names = (await fs.list('apps/x')).map((e) => e.name);
	assert.deepEqual(names, ['b.ts']);
});

test('ancestor tombstone shadows deeper base paths; recreate resurrects', async () => {
	const { fs } = makeStaged({ 'apps/x/src/deep.ts': 'D' });
	await fs.delete('apps/x');
	await assert.rejects(() => fs.read('apps/x/src/deep.ts'));
	assert.equal(fs.entryType('apps/x'), null);
	// a later write beneath the tombstone recreates the subtree
	await fs.write('apps/x/src/deep.ts', 'reborn');
	assert.equal(await fs.read('apps/x/src/deep.ts'), 'reborn');
});

test('dirty editor overlay wins over staged content', async () => {
	const { base, fs } = makeStaged({ 'f.ts': 'committed' });
	await fs.write('f.ts', 'staged');
	let dirty = false;
	base.registerOverlay('f.ts', { getContent: () => 'typing...', isDirty: () => dirty });
	assert.equal(await fs.read('f.ts'), 'staged');
	dirty = true;
	assert.equal(await fs.read('f.ts'), 'typing...');
});

test('staging a dirty buffer captures base truth, not the overlay', async () => {
	// The base view serves a dirty overlay from read() — "before" must still
	// be the BASE content, or staging the buffer itself becomes a no-op.
	const { base, fs } = makeStaged({ 'f.ts': 'committed' });
	base.registerOverlay('f.ts', { getContent: () => 'edited', isDirty: () => true });
	await fs.write('f.ts', 'edited');
	assert.equal(fs.changedPaths().get('f.ts'), 'modified');
	const result = await fs.commit();
	assert.equal(result.committed, 1);
	assert.equal(base.files.get('f.ts'), 'edited');
});

// =============================================================================
// UNION LISTINGS + INVENTORY
// =============================================================================

test('list unions staged creations with implicit parent dirs', async () => {
	const { fs } = makeStaged({ 'pipelines/a.pipe': 'A' });
	await fs.write('apps/newapp/src/App.tsx', 'code');
	const root = await fs.list('');
	assert.ok(root.some((e) => e.name === 'apps' && e.type === 'dir'));
	const apps = await fs.list('apps');
	assert.deepEqual(apps, [{ name: 'newapp', type: 'dir' }]);
	const src = await fs.list('apps/newapp/src');
	assert.deepEqual(src, [{ name: 'App.tsx', type: 'file' }]);
});

test('listEntries merges base and staged, minus staged-gone', async () => {
	const { fs } = makeStaged({ 'a.ts': 'A', 'b.ts': 'B' });
	await fs.delete('a.ts');
	await fs.write('c/d.ts', 'D');
	const paths = fs.listEntries().map((e) => e.path);
	assert.ok(!paths.includes('a.ts'));
	assert.ok(paths.includes('b.ts'));
	assert.ok(paths.includes('c'));
	assert.ok(paths.includes('c/d.ts'));
});

test('entryType reflects staged state', async () => {
	const { fs } = makeStaged({ 'x.ts': 'X' });
	await fs.write('n/file.ts', 'F');
	await fs.mkdir('empty');
	await fs.delete('x.ts');
	assert.equal(fs.entryType('n/file.ts'), 'file');
	assert.equal(fs.entryType('n'), 'dir');
	assert.equal(fs.entryType('empty'), 'dir');
	assert.equal(fs.entryType('x.ts'), null);
});

// =============================================================================
// CHECKPOINT / ROLLBACK / CHANGED PATHS
// =============================================================================

test('checkpoint freezes; rollback truncates back to it', async () => {
	const { fs } = makeStaged({});
	await fs.write('one.ts', '1');
	const ckpt = await fs.checkpoint('turn 1');
	assert.ok(ckpt);
	await fs.write('two.ts', '2');
	assert.equal(await fs.read('two.ts'), '2');
	await fs.rollback(ckpt!);
	assert.equal(await fs.read('one.ts'), '1');
	await assert.rejects(() => fs.read('two.ts'));
});

test('changedPaths classifies added/modified/deleted', async () => {
	const { fs } = makeStaged({ 'mod.ts': 'old', 'del.ts': 'bye' });
	await fs.write('mod.ts', 'new');
	await fs.write('add.ts', 'hello');
	await fs.delete('del.ts');
	const changes = fs.changedPaths();
	assert.equal(changes.get('mod.ts'), 'modified');
	assert.equal(changes.get('add.ts'), 'added');
	assert.equal(changes.get('del.ts'), 'deleted');
});

test('a write landing back on the original erases the staged entry (git-clean round trip)', async () => {
	const { base, fs } = makeStaged({ 'f.ts': 'original' });
	await fs.write('f.ts', 'edited');
	assert.equal(fs.changedPaths().get('f.ts'), 'modified');
	// save the ORIGINAL content again — the change list must empty out
	await fs.write('f.ts', 'original');
	assert.equal(fs.changedPaths().has('f.ts'), false);
	assert.equal(fs.hasPendingChanges(), false);
	assert.equal(await fs.read('f.ts'), 'original');
	// and the base was never touched (still staged-mode: no write-through)
	assert.equal(base.files.get('f.ts'), 'original');
});

test('a no-op save of unchanged content stages nothing', async () => {
	const { fs } = makeStaged({ 'f.ts': 'same' });
	await fs.write('f.ts', 'same');
	assert.equal(fs.hasPendingChanges(), false);
	assert.equal(fs.changedPaths().size, 0);
});

test('revert across a checkpoint reports clean and commits nothing', async () => {
	const { base, fs } = makeStaged({ 'f.ts': 'original' });
	await fs.write('f.ts', 'edited');
	await fs.checkpoint('turn');
	// the frozen checkpoint keeps its entry; the working layer reverts it
	await fs.write('f.ts', 'original');
	assert.equal(fs.changedPaths().has('f.ts'), false);
	assert.equal(await fs.read('f.ts'), 'original');
	// commit replays the NET ops — identity writes are not replayed
	const result = await fs.commit();
	assert.equal(result.committed, 0);
	assert.deepEqual(result.conflicts, []);
	assert.equal(base.files.get('f.ts'), 'original');
});

test('discardPath reverts one path and leaves the rest staged', async () => {
	const { fs } = makeStaged({ 'mod.ts': 'old', 'del.ts': 'bye' });
	await fs.write('mod.ts', 'new');
	await fs.write('add.ts', 'hello');
	await fs.delete('del.ts');
	await fs.discardPath('mod.ts');
	// the reverted path reads base again; the others stay staged
	assert.equal(await fs.read('mod.ts'), 'old');
	const changes = fs.changedPaths();
	assert.equal(changes.has('mod.ts'), false);
	assert.equal(changes.get('add.ts'), 'added');
	assert.equal(changes.get('del.ts'), 'deleted');
	// a staged-only add reverts to nonexistence
	await fs.discardPath('add.ts');
	await assert.rejects(() => fs.read('add.ts'));
	// spans checkpoints: entries for the path vanish from EVERY pending layer
	await fs.write('span.ts', 'a');
	await fs.checkpoint('turn');
	await fs.write('span.ts', 'b');
	await fs.discardPath('span.ts');
	assert.equal(fs.changedPaths().has('span.ts'), false);
});

test('diff exposes first-touch before and effective after', async () => {
	const { fs } = makeStaged({ 'f.ts': 'v1' });
	await fs.write('f.ts', 'v2');
	await fs.write('f.ts', 'v3');
	const { before, after } = await fs.diff('f.ts');
	assert.equal(before, 'v1');
	assert.equal(after, 'v3');
});

// =============================================================================
// COMMIT
// =============================================================================

test('commit replays net ops onto the base and sweeps', async () => {
	const staging = new MockStaging();
	const { base, fs } = makeStaged({ 'mod.ts': 'old', 'del.ts': 'bye' }, staging);
	await fs.write('mod.ts', 'new');
	await fs.write('deep/add.ts', 'A');
	await fs.delete('del.ts');
	const result = await fs.commit();
	assert.deepEqual(result.conflicts, []);
	assert.equal(result.committed, 3);
	assert.equal(base.files.get('mod.ts'), 'new');
	assert.equal(base.files.get('deep/add.ts'), 'A');
	assert.ok(!base.files.has('del.ts'));
	assert.ok(staging.swept);
	assert.equal(fs.hasPendingChanges(), false);
	// second commit is a no-op
	assert.equal((await fs.commit()).committed, 0);
});

test('commit refuses when the base changed underneath (all-or-nothing)', async () => {
	const { base, fs } = makeStaged({ 'f.ts': 'v1', 'g.ts': 'g1' });
	await fs.write('f.ts', 'staged-f');
	await fs.write('g.ts', 'staged-g');
	// the base moves after the capture
	base.files.set('f.ts', 'someone-else');
	const result = await fs.commit();
	assert.equal(result.committed, 0);
	assert.deepEqual(result.conflicts, [{ path: 'f.ts', reason: 'changed' }]);
	// nothing was written, not even the clean path
	assert.equal(base.files.get('g.ts'), 'g1');
	assert.equal(fs.hasPendingChanges(), true);
});

test('commit detects resurrection and disappearance', async () => {
	const { base, fs } = makeStaged({ 'gone.ts': 'here' });
	await fs.write('new.ts', 'N');     // captured as not-existing
	await fs.write('gone.ts', 'G');    // captured as existing
	base.files.set('new.ts', 'squatter');
	base.files.delete('gone.ts');
	const result = await fs.commit();
	const reasons = new Map(result.conflicts.map((c) => [c.path, c.reason]));
	assert.equal(reasons.get('new.ts'), 'resurrected');
	assert.equal(reasons.get('gone.ts'), 'missing');
});

// =============================================================================
// UNDO (auto mode)
// =============================================================================

test('undoTurn inverse-replays a retained committed checkpoint', async () => {
	const { base, fs } = makeStaged({ 'mod.ts': 'original' });
	await fs.write('mod.ts', 'turn1');
	await fs.write('created.ts', 'fresh');
	const ckpt = await fs.checkpoint('turn 1');
	const committed = await fs.commit({ retain: true });
	assert.equal(committed.conflicts.length, 0);
	assert.equal(base.files.get('mod.ts'), 'turn1');

	const result = await fs.undoTurn(ckpt!);
	assert.deepEqual(result.conflicts, []);
	assert.equal(base.files.get('mod.ts'), 'original');
	assert.ok(!base.files.has('created.ts'));
});

test('undoTurn refuses when the base moved since the commit', async () => {
	const { base, fs } = makeStaged({ 'f.ts': 'original' });
	await fs.write('f.ts', 'turn1');
	const ckpt = await fs.checkpoint('turn 1');
	await fs.commit({ retain: true });
	// the user hand-edits after the auto-commit
	base.files.set('f.ts', 'hand-edited');
	const result = await fs.undoTurn(ckpt!);
	assert.equal(result.committed, 0);
	assert.deepEqual(result.conflicts, [{ path: 'f.ts', reason: 'changed' }]);
	assert.equal(base.files.get('f.ts'), 'hand-edited');
});

// =============================================================================
// STAGING PERSISTENCE + MODES
// =============================================================================

test('persistence completes before the change tick fires', async () => {
	const staging = new MockStaging();
	const { fs } = makeStaged({}, staging);
	let persistedAtTick = -1;
	fs.subscribe(() => { persistedAtTick = staging.persistCount; });
	await fs.write('f.ts', 'content');
	assert.ok(persistedAtTick >= 1, 'tick fired before persist completed');
	assert.equal(staging.persisted?.some((l) => l.entries.has('f.ts')), true);
});

test('rehydrates persisted layers on construction', async () => {
	const staging = new MockStaging();
	staging.initial = [{
		id: 'ckpt-1',
		label: 'restored',
		entries: new Map([['f.ts', { kind: 'write', content: 'from-staging', before: null, baseHash: null, stamp: 1 }]]),
	}];
	const base = new MockBase();
	const fs = new StagedFileSystem(base, staging);
	assert.equal(await fs.read('f.ts'), 'from-staging');
	assert.equal(fs.hasPendingChanges(), true);
});

test('write-through mode passes mutations to the base', async () => {
	const base = new MockBase();
	const fs = new StagedFileSystem(base, null, { writeThrough: true });
	await fs.write('f.ts', 'direct');
	assert.equal(base.files.get('f.ts'), 'direct');
	assert.equal(fs.hasPendingChanges(), false);
	// and refuses to re-enter write-through with pending changes
	// (async per the WorkspaceFs contract — a refusal is a rejection)
	await fs.setWriteThrough(false);
	await fs.write('g.ts', 'staged');
	await assert.rejects(() => fs.setWriteThrough(true));
});

test('onMutate announces staged mutations with their origin; write-through and no-ops stay silent', async () => {
	const fired: Array<{ path: string; origin?: string }> = [];
	const base = new MockBase();
	base.files.set('apps/x/a.ts', 'A');
	base.files.set('apps/x/gone.ts', 'G');
	const fs = new StagedFileSystem(base, null, { onMutate: (path, origin) => fired.push({ path, origin }) });

	// Staged write → one announcement, origin preserved.
	await fs.write('apps/x/a.ts', 'edited', 'editor');
	assert.deepEqual(fired, [{ path: 'apps/x/a.ts', origin: 'editor' }]);

	// Round-trip back to the below-state erases the entry AND announces
	// (the view's content changed back); a pure no-op save stays silent.
	fired.length = 0;
	await fs.write('apps/x/a.ts', 'A', 'editor');
	assert.deepEqual(fired, [{ path: 'apps/x/a.ts', origin: 'editor' }]);
	fired.length = 0;
	await fs.write('apps/x/a.ts', 'A', 'editor');
	assert.deepEqual(fired, []);

	// Delete and mkdir announce.
	await fs.delete('apps/x/gone.ts', 'editor');
	await fs.mkdir('apps/x/sub');
	assert.deepEqual(fired, [{ path: 'apps/x/gone.ts', origin: 'editor' }, { path: 'apps/x/sub', origin: undefined }]);

	// Rename announces BOTH ends, origin riding each half.
	fired.length = 0;
	await fs.write('apps/x/from.ts', 'F');
	fired.length = 0;
	await fs.rename('apps/x/from.ts', 'apps/x/to.ts', 'editor');
	assert.deepEqual(fired, [{ path: 'apps/x/from.ts', origin: 'editor' }, { path: 'apps/x/to.ts', origin: 'editor' }]);

	// Discard announces every path the dropped layers touched — the
	// effective content reverted with NO base write, so this is the only
	// signal per-path consumers (editor models) get. (Clear the layer
	// first: discard-all announces EVERYTHING staged above, by design.)
	await fs.discard();
	fired.length = 0;
	await fs.write('apps/x/one.ts', '1');
	await fs.write('apps/x/two.ts', '2');
	fired.length = 0;
	await fs.discard();
	assert.deepEqual(fired.map((f) => f.path).sort(), ['apps/x/one.ts', 'apps/x/two.ts']);

	// discard(path) announces just that path; rollback announces the
	// dropped layers' paths.
	fired.length = 0;
	await fs.write('apps/x/keep.ts', 'K');
	const cp = await fs.checkpoint('cp');
	assert.ok(cp);
	await fs.write('apps/x/later.ts', 'L');
	fired.length = 0;
	await fs.rollback(cp as string);
	assert.deepEqual(fired.map((f) => f.path), ['apps/x/later.ts']);
	fired.length = 0;
	await fs.discard('apps/x/keep.ts');
	assert.deepEqual(fired.map((f) => f.path), ['apps/x/keep.ts']);

	// Write-through mode delegates to the base (the backend announces
	// physical writes itself) — the hook stays silent.
	await fs.discard();
	await fs.setWriteThrough(true);
	fired.length = 0;
	await fs.write('apps/x/a.ts', 'direct');
	assert.deepEqual(fired, []);
});

test('write-through save is freshness-gated: a moved base refuses the save', async () => {
	const base = new MockBase();
	base.files.set('f.ts', 'opened-from');
	const fs = new StagedFileSystem(base, null, { writeThrough: true });

	// Baseline matches the base — the save passes (the normal case).
	await fs.write('f.ts', 'edited');
	assert.equal(base.files.get('f.ts'), 'edited');

	// The base moves under an older baseline (teammate committed since
	// this buffer was opened) — the save REFUSES and writes nothing.
	base.baselines.set('f.ts', 'edited');
	base.files.set('f.ts', 'teammate-version');
	await assert.rejects(() => fs.write('f.ts', 'mine'), (err: Error) => err.name === 'StaleWriteError');
	assert.equal(base.files.get('f.ts'), 'teammate-version');

	// A blind retry refuses again — the baseline is NOT silently adopted.
	await assert.rejects(() => fs.write('f.ts', 'mine-again'), (err: Error) => err.name === 'StaleWriteError');

	// Re-reading adopts the new base as the baseline; the next save passes
	// (the deliberate-overwrite path after Compare).
	base.baselines.delete('f.ts');
	await fs.write('f.ts', 'merged');
	assert.equal(base.files.get('f.ts'), 'merged');

	// A NEW file (no baseline, nothing on the base) saves cleanly.
	await fs.write('new.ts', 'fresh');
	assert.equal(base.files.get('new.ts'), 'fresh');
});

test('delete of a staged directory swallows its staged children', async () => {
	const { fs } = makeStaged({});
	await fs.write('dir/a.ts', 'A');
	await fs.write('dir/b.ts', 'B');
	await fs.delete('dir');
	assert.equal(fs.entryType('dir'), null);
	await assert.rejects(() => fs.read('dir/a.ts'));
	// the net effect against an empty base is nothing to commit
	const result = await fs.commit();
	assert.equal(result.committed, 0);
});

test('delete of a BASE directory commits as a dir tombstone', async () => {
	const { base, fs } = makeStaged({ 'apps/x/a.ts': 'A' });
	base.dirs.add('apps/x');
	await fs.delete('apps/x');
	assert.equal(fs.changedPaths().get('apps/x'), 'deleted');
	const result = await fs.commit();
	assert.equal(result.conflicts.length, 0);
	assert.ok(result.committed > 0);
	assert.equal(base.dirs.has('apps/x'), false);
	assert.equal(base.files.has('apps/x/a.ts'), false);
});

test('delete of a missing path is refused up front', async () => {
	const { fs } = makeStaged({});
	await assert.rejects(() => fs.delete('nope.ts'), /No such path/);
	assert.equal(fs.hasPendingChanges(), false);
});
