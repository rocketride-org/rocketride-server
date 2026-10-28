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

import type { IWorkspaceBaseView, VfsEntry, VfsOverlay } from './vfsTypes';
import { StagedFileSystem, StaleVersionError } from './stagedFileSystem';
import type { IStagingStore, Layer } from './stagedFileSystem';

// =============================================================================
// MOCKS — an in-memory base view and a recording staging store
// =============================================================================

/** In-memory base view (server truth). */
class MockBase implements IWorkspaceBaseView {
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
	/** Paths the page holds no copy of, so a staged write's capture asks the server (peekBase) for them. */
	uncached = new Set<string>();
	cachedContent(path: string): unknown {
		if (this.uncached.has(path)) return undefined;
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

test('the writable rule refuses every mutation before anything is staged, in both modes', async () => {
	const base = new MockBase();
	base.files.set('.rocketride/docs/A.md', 'guide');
	base.files.set('apps/x/a.ts', 'A');
	const readOnly = /^Error: \.rocketride\/ is read-only reference\.$/;
	const fs = new StagedFileSystem(base, null, {
		assertWritable: (path) => {
			if (path === '.rocketride' || path.startsWith('.rocketride/')) throw new Error('.rocketride/ is read-only reference.');
		},
	});

	await assert.rejects(fs.write('.rocketride/docs/A.md', 'x'), readOnly);
	await assert.rejects(fs.delete('.rocketride/docs/A.md'), readOnly);
	await assert.rejects(fs.mkdir('.rocketride/mine'), readOnly);
	await assert.rejects(fs.rename('.rocketride/docs/A.md', 'apps/x/A.md'), readOnly);
	await assert.rejects(fs.rename('apps/x/a.ts', '.rocketride/a.ts'), readOnly);
	assert.equal(fs.hasPendingChanges(), false, 'nothing was staged');

	await fs.setWriteThrough(true);
	await assert.rejects(fs.write('.rocketride/docs/A.md', 'x'), readOnly);
	assert.deepEqual(Object.fromEntries(base.files), { '.rocketride/docs/A.md': 'guide', 'apps/x/a.ts': 'A' }, 'the base is unchanged');
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

// =============================================================================
// PATH VERSIONS — counted at the call, checked by `expect`, waited on by reads
// =============================================================================

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

test('a write that fails counts again, since what it left is unknown', async () => {
	const base = new MockBase();
	base.write = async () => {
		throw new Error('store down');
	};
	const fs = new StagedFileSystem(base, null, { writeThrough: true });
	await assert.rejects(fs.write('f.ts', 'x', 'agent'), /store down/);
	assert.equal(fs.version('f.ts'), 2);
});

test('deleting or renaming a folder changes every path under it', async () => {
	const { base, fs } = makeStaged({ 'apps/x/a.ts': 'A', 'apps/x/sub/b.ts': 'B', 'apps/y.ts': 'Y' });
	base.dirs.add('apps/x');
	await fs.delete('apps/x', 'editor');
	assert.deepEqual([fs.version('apps/x/a.ts'), fs.version('apps/x/sub/b.ts'), fs.version('apps/y.ts')], [1, 1, 0]);
	assert.equal(fs.lastWriter('apps/x/a.ts'), 'editor');
	await fs.mkdir('apps/z', 'agent');
	assert.equal(fs.version('apps/z/c.ts'), 0, 'a new folder changes nothing under it');
});

test('a write that found its path empty is refused once a folder moves onto it', async () => {
	const base = new MockBase();
	base.files.set('src/f.txt', 'moved');
	base.rename = async (from, to) => {
		for (const [path, content] of [...base.files]) {
			if (!path.startsWith(`${from}/`)) continue;
			base.files.delete(path);
			base.files.set(to + path.slice(from.length), content);
		}
	};
	const fs = new StagedFileSystem(base, null, { writeThrough: true });
	// step: the agent's write_file finds dest/f.txt missing, so it writes a new file at the version it saw
	const expect = fs.version('dest/f.txt');
	await fs.rename('src', 'dest', 'editor');
	await assert.rejects(fs.write('dest/f.txt', 'agent', 'agent', expect), StaleVersionError);
	assert.equal(base.files.get('dest/f.txt'), 'moved');
});

test('commit counts no version, since the view serves the same content; undo and discard count the paths they change', async () => {
	const { base, fs } = makeStaged({ 'f.ts': 'v0' });
	await fs.write('f.ts', 'v1', 'agent');
	await fs.write('g.ts', 'g', 'agent');
	const staged = fs.version('f.ts');
	await fs.commit({ retain: true });
	assert.equal(fs.version('f.ts'), staged, 'an editor that saved f.ts and kept typing is not made stale by the commit');
	assert.equal(fs.lastWriter('f.ts'), 'agent');
	assert.equal(base.files.get('f.ts'), 'v1');

	await fs.undoTurn(fs.getLayers()[0].id);
	assert.equal(fs.version('f.ts'), staged + 1);
	assert.equal(fs.lastWriter('f.ts'), 'undo');
	assert.equal(base.files.get('f.ts'), 'v0');

	await fs.write('f.ts', 'v2', 'agent');
	const before = fs.version('f.ts');
	await fs.discard();
	assert.equal(fs.version('f.ts'), before + 1);
	assert.equal(fs.lastWriter('f.ts'), 'discard');
	assert.equal(await fs.read('f.ts'), 'v0');
});

test('an undo counts and holds its paths from its call, so a save called after it lands after it or is refused', async () => {
	const { base, fs } = makeStaged({ 'f.ts': 'v0', 'g.ts': 'g0' });
	await fs.write('f.ts', 'turn', 'agent');
	const turn = await fs.checkpoint('turn 1');
	await fs.commit({ retain: true });
	await fs.setWriteThrough(true);
	const loaded = await fs.readVersioned('f.ts');
	// step: a write of g.ts is slow, so the undo called after it waits its turn
	const slow = deferred();
	const write = base.write.bind(base);
	base.write = async (path, content) => {
		if (path === 'g.ts') await slow.promise;
		return write(path, content);
	};
	const writingG = fs.write('g.ts', 'g1', 'agent');
	const undoing = fs.undoTurn(turn!);
	// step: an editor that loaded the turn's text saves while the undo waits; so does one at the version after the call
	const stale = assert.rejects(fs.write('f.ts', 'turn + editor', 'editor', loaded.version), StaleVersionError);
	const after = fs.write('f.ts', 'v0 + editor', 'editor', fs.version('f.ts'));
	slow.resolve();
	await writingG;
	await stale;
	assert.deepEqual(await undoing, { committed: 1, conflicts: [] });
	await after;
	assert.equal(base.files.get('f.ts'), 'v0 + editor');
});

test("an undo called while the commit that retains its turn waits counts and holds that turn's paths from its call", async () => {
	const { base, fs } = makeStaged({ 'h.ts': 'h0', 'g.ts': 'g0' });
	await fs.write('h.ts', 'turn', 'agent');
	const loaded = fs.version('h.ts');
	const turn = await fs.checkpoint('turn 1');
	// step: the agent's write of g.ts is still on its way; the commit that retains both waits for it, and the undo is called behind it
	const capturing = deferred();
	const peek = base.peekBase.bind(base);
	base.peekBase = async (path) => {
		if (path === 'g.ts') await capturing.promise;
		return peek(path);
	};
	const writingG = fs.write('g.ts', 'g1', 'agent');
	const loadedG = fs.version('g.ts');
	const committing = fs.commit({ retain: true });
	const undoing = fs.undoTurn(turn!);
	capturing.resolve();
	await Promise.all([writingG, committing]);
	// step: the commit is done and the undo not started; the view writes through, and an editor saves h.ts at the version it loaded and at the version now
	void fs.setWriteThrough(true);
	const stale = assert.rejects(fs.write('h.ts', 'turn + editor', 'editor', loaded), StaleVersionError);
	const after = fs.write('h.ts', 'h0 + editor', 'editor', fs.version('h.ts'));
	await stale;
	assert.deepEqual(await undoing, { committed: 2, conflicts: [] });
	await after;
	assert.equal(base.files.get('h.ts'), 'h0 + editor');
	await assert.rejects(fs.write('g.ts', 'g1 + editor', 'editor', loadedG), StaleVersionError);
});

test('a checkpoint waits for the writes called before it and holds the ones called after it, so a rollback to it keeps the first and drops the second', async () => {
	const { base, fs } = makeStaged({ 'f.ts': 'F0', 'g.ts': 'G0', 'x.ts': 'X0' });
	await fs.write('g.ts', 'G1', 'agent');
	const capturing = deferred();
	const peek = base.peekBase.bind(base);
	base.peekBase = async (path) => {
		if (path === 'f.ts') await capturing.promise;
		return peek(path);
	};
	const saving = fs.write('f.ts', 'F1', 'editor');
	const checkpointing = fs.checkpoint('turn 1');
	const later = fs.write('x.ts', 'X1', 'editor');
	capturing.resolve();
	const turn = await checkpointing;
	await Promise.all([saving, later]);
	await fs.rollback(turn!);
	assert.deepEqual([await fs.read('f.ts'), await fs.read('x.ts')], ['F1', 'X0']);
});

test('a staged write on its way counts as pending, so the view does not switch to write-through under it', async () => {
	const { base, fs } = makeStaged({ 'f.ts': 'F0' });
	const capturing = deferred();
	const peek = base.peekBase.bind(base);
	base.peekBase = async (path) => {
		await capturing.promise;
		return peek(path);
	};
	const saving = fs.write('f.ts', 'F1', 'editor');
	await assert.rejects(fs.setWriteThrough(true), /uncommitted changes/);
	capturing.resolve();
	await saving;
	assert.equal(base.files.get('f.ts'), 'F0', 'the save stays staged');
	// step: after Commit all, a save on its way to the server is not an uncommitted change
	await fs.commit();
	await fs.setWriteThrough(true);
	const through = fs.write('f.ts', 'F2', 'editor');
	assert.equal(fs.hasPendingChanges(), false);
	await through;
	assert.equal(base.files.get('f.ts'), 'F2');
});

test('a staged write to a folder is refused, so it cannot hide the files under it', async () => {
	const { fs } = makeStaged({ 'd/f.txt': 'F0' });
	await assert.rejects(fs.write('d', 'a file now', 'agent'), /^Error: Not a file: d$/);
	assert.equal(await fs.read('d/f.txt'), 'F0');
});

test('a rename onto a folder is refused before it deletes the source, so Commit all keeps the file', async () => {
	const { base, fs } = makeStaged({ 'original.txt': 'O', 'd/f.txt': 'F0' });
	await assert.rejects(fs.rename('original.txt', 'd', 'agent'), /^Error: Not a file: d$/);
	assert.equal(await fs.read('original.txt'), 'O');
	assert.equal(await fs.stat('d'), 'dir');
	await fs.commit();
	assert.deepEqual(Object.fromEntries(base.files), { 'original.txt': 'O', 'd/f.txt': 'F0' });
});

test('a rename stages its delete and its write together, so a folder that appears at the destination meanwhile leaves the source on the server', async () => {
	const staging = new MockStaging();
	const { base, fs } = makeStaged({ 'original.txt': 'O' }, staging);
	const write = base.write.bind(base);
	base.write = async (p, c) => {
		if (base.entryType(p) === 'dir') throw new Error(`Is a folder: ${p}`);
		return write(p, c);
	};
	// step: a teammate's folder appears at the destination while the store saves the rename
	staging.persist = async () => void base.files.set('d/f.txt', 'F0');
	await fs.rename('original.txt', 'd', 'agent');
	await assert.rejects(fs.commit(), /^Error: Is a folder: d$/);
	assert.deepEqual(Object.fromEntries(base.files), { 'original.txt': 'O', 'd/f.txt': 'F0' });
});

test('a read waits for the queue only up to its time limit, then fails with a clear error', async () => {
	const base = new MockBase();
	base.files.set('f.ts', 'old');
	base.write = () => new Promise(() => undefined);
	const fs = new StagedFileSystem(base, null, { writeThrough: true, waitMs: 20 });
	void fs.write('f.ts', 'new', 'agent');
	await assert.rejects(fs.read('f.ts'), /Could not read f\.ts: a change to it is still on its way to the server after 0\.02 s/);
	await assert.rejects(fs.stat('f.ts'), /Could not read f\.ts/);
	assert.equal(await fs.read('g.ts').catch(() => 'missing'), 'missing', 'other paths do not wait');
});

test('a read does not wait for a commit: the view serves the same content before, during and after it', async () => {
	const base = new MockBase();
	base.files.set('a.ts', 'A0');
	const fs = new StagedFileSystem(base, null, { waitMs: 20 });
	await fs.write('a.ts', 'A1', 'editor');
	const saved = fs.version('a.ts');
	// step: hold the commit inside its replay, longer than the wait limit
	const replaying = deferred();
	const write = base.write.bind(base);
	base.write = async (path, content) => {
		await replaying.promise;
		return write(path, content);
	};
	const committing = fs.commit();
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.deepEqual(await fs.readVersioned('a.ts'), { content: 'A1', version: saved }, 'a read during the commit is served at once');
	assert.deepEqual(Object.entries(await fs.readMany(['a.ts'])), [['a.ts', 'A1']]);
	assert.equal(await fs.stat('a.ts'), 'file');
	// step: a write of a committed path still lands after the commit
	const writing = fs.write('a.ts', 'A2', 'editor', saved);
	replaying.resolve();
	assert.deepEqual(await committing, { committed: 1, conflicts: [] });
	await writing;
	assert.equal(base.files.get('a.ts'), 'A1');
	assert.equal(await fs.read('a.ts'), 'A2');
});

test('a write that never lands cannot freeze the workspace: Discard all and Commit all wait for it only up to the time limit', async () => {
	const base = new MockBase();
	base.files.set('a/x.ts', 'x');
	base.files.set('b/y.ts', 'y');
	// step: the agent's write of x.ts is held forever in its capture of the base (the page holds no copy of it, so the capture asks the server)
	const peek = base.peekBase.bind(base);
	base.uncached.add('a/x.ts');
	base.peekBase = (path) => (path === 'a/x.ts' ? new Promise(() => undefined) : peek(path));
	const fs = new StagedFileSystem(base, null, { waitMs: 20 });
	void fs.write('a/x.ts', 'x2', 'agent');
	const discarding = fs.discard();
	const writingY = fs.write('b/y.ts', 'y2', 'editor');
	const readingY = fs.read('b/y.ts');
	await assert.rejects(discarding, /^Error: Could not discard the changes: a change to a\/x\.ts is still on its way to the server after 0\.02 s\. Try again later; if this keeps happening, the server is not answering\.$/);
	// step: the write and the read called after the failed discard go ahead (the read's limit starts once the discard gave up)
	await writingY;
	assert.equal(await readingY, 'y2');
	await assert.rejects(fs.commit(), /^Error: Could not commit: a change to a\/x\.ts is still on its way to the server after 0\.02 s/);
	await assert.rejects(fs.checkpoint('turn 1'), /^Error: Could not take a checkpoint: a change to a\/x\.ts is still on its way to the server after 0\.02 s/);
	await fs.discardPath('b/y.ts');
	assert.equal(await fs.read('b/y.ts'), 'y', 'a per-file discard of another path does not wait for x.ts');
	await assert.rejects(fs.discardPath('a/x.ts'), /^Error: Could not discard the changes in a\/x\.ts: a change to a\/x\.ts is still on its way to the server after 0\.02 s/);
	// step: a discard after a staging operation that never ends names that operation
	const fresh = new StagedFileSystem(base, null, { waitMs: 20 });
	await fresh.write('b/y.ts', 'y3', 'editor');
	base.peekBase = () => new Promise(() => undefined);
	void fresh.commit();
	await assert.rejects(fresh.discard(), /^Error: Could not discard the changes: a commit, undo or discard called before it is still running after 0\.02 s/);
});

test('a folder deleted while Commit all waits stays staged: the commit does not carry it', async () => {
	const { base, fs } = makeStaged({ 'x.ts': 'X0', 'a/c.ts': 'C0' });
	base.dirs.add('a');
	const capturing = deferred();
	const peek = base.peekBase.bind(base);
	base.peekBase = async (path) => {
		if (path === 'x.ts') await capturing.promise;
		return peek(path);
	};
	const writingX = fs.write('x.ts', 'X1', 'agent');
	const committing = fs.commit();
	await fs.delete('a', 'agent');
	capturing.resolve();
	await Promise.all([writingX, committing]);
	assert.equal(base.files.get('x.ts'), 'X1');
	assert.equal(base.files.get('a/c.ts'), 'C0', 'the commit did not carry the delete');
	assert.equal(await fs.stat('a/c.ts'), null, 'the delete stays staged');
});

test('a save called after Discard all is refused when the Commit all before the discard meets a conflict, so the discard drops the path only once it runs', async () => {
	const { base, fs } = makeStaged({ 'a.ts': 'A0' });
	await fs.write('a.ts', 'A1', 'editor');
	// step: a teammate changes a.ts on the server, and the commit's check of it is slow
	base.files.set('a.ts', 'A-teammate');
	const verifying = deferred();
	const peek = base.peekBase.bind(base);
	base.peekBase = async (path) => {
		await verifying.promise;
		return peek(path);
	};
	const committing = fs.commit();
	await new Promise((resolve) => setImmediate(resolve));
	// step: Discard all expects the commit to carry a.ts, so it counts nothing; the editor's next save passes its check and waits behind it
	const discarding = fs.discard();
	const saving = fs.write('a.ts', 'A1 then A2', 'editor', fs.version('a.ts'));
	base.peekBase = peek;
	verifying.resolve();
	assert.equal((await committing).conflicts.length, 1);
	await discarding;
	await assert.rejects(saving, (err: unknown) => err instanceof StaleVersionError && err.lastWriter === 'discard');
	assert.equal(base.files.get('a.ts'), 'A-teammate');
	assert.equal(await fs.read('a.ts'), 'A-teammate', 'nothing of the dropped save comes back');
});
