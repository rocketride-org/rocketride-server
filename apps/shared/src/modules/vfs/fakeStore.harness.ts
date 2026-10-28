// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// FAKE STORE
// =============================================================================

/**
 * install() makes this the client the shell stub's getClient() hands out
 * (scripts/stub-shell.cjs). A read or write of a watched path waits in `held`
 * until the test releases it, and sees the store as it is at the release. A
 * read of a path in `heldAnswers` is answered at once, and the answer waits
 * in `held`. While `holdsPersists` is set, every JSON write (the staging
 * store's manifest) waits in `held` too. A held call's `fail` makes it fail
 * with a network error instead.
 */

export interface Held {
	label: string;
	release: () => void;
	fail: () => void;
}

export interface Landed {
	path: string;
	before: string | undefined;
	content: string;
}

export class FakeStore {
	readonly files: Map<string, string>;
	readonly landed: Landed[] = [];
	readonly held: Held[] = [];
	readonly watched = new Set<string>();
	readonly heldAnswers = new Set<string>();
	holdsPersists = false;
	private readonly waiting: Array<() => void> = [];

	constructor(files: Record<string, string> = {}) {
		this.files = new Map(Object.entries(files));
	}

	install(): this {
		(globalThis as { __shellTestClient?: unknown }).__shellTestClient = this.client;
		return this;
	}

	async next(): Promise<Held> {
		while (this.held.length === 0) await new Promise<void>((wake) => this.waiting.push(wake));
		return this.held.shift() as Held;
	}

	private hold(label: string, path: string): Promise<void> {
		return new Promise((release, reject) => {
			this.held.push({ label: `${label} ${path}`, release, fail: () => reject(new Error('network failure')) });
			for (const wake of this.waiting.splice(0)) wake();
		});
	}

	private read(path: string): string {
		const content = this.files.get(path);
		// the store's own wording, which StagingStore reads as proof of absence
		if (content === undefined) throw new Error(`File not found: ${path}`);
		return content;
	}

	private children(dir: string): Array<{ name: string; type: 'file' | 'dir' }> {
		const prefix = `${dir.replace(/\/+$/, '')}/`;
		const names = new Map<string, 'file' | 'dir'>();
		for (const path of this.files.keys()) {
			if (!path.startsWith(prefix)) continue;
			const [name, ...below] = path.slice(prefix.length).split('/');
			names.set(name, below.length ? 'dir' : 'file');
		}
		return [...names].map(([name, type]) => ({ name, type }));
	}

	readonly client = {
		fsReadString: async (path: string): Promise<string> => {
			if (this.heldAnswers.has(path)) {
				const content = this.read(path);
				await this.hold('answer to the read of', path);
				return content;
			}
			if (this.watched.has(path)) await this.hold('read', path);
			return this.read(path);
		},
		fsWriteString: async (path: string, content: string): Promise<void> => {
			if (this.watched.has(path)) await this.hold('write', path);
			this.landed.push({ path, before: this.files.get(path), content });
			this.files.set(path, content);
		},
		fsReadJson: async (path: string): Promise<unknown> => JSON.parse(this.read(path)),
		fsWriteJson: async (path: string, value: unknown): Promise<void> => {
			if (this.holdsPersists) await this.hold('persist', path);
			this.files.set(path, JSON.stringify(value));
		},
		fsReadMany: async (paths: string[]) => paths.map((path) => (this.files.has(path) ? { ok: true, data: new TextEncoder().encode(this.files.get(path)) } : { ok: false, error: 'File not found' })),
		fsListDir: async (path: string) => ({ entries: this.children(path) }),
		fsStat: async (path: string) => ({ type: this.files.has(path) ? 'file' : 'dir' }),
		fsDelete: async (path: string): Promise<void> => {
			this.files.delete(path);
		},
		fsRename: async (from: string, to: string): Promise<void> => {
			const content = this.read(from);
			this.landed.push({ path: to, before: this.files.get(to), content });
			this.files.set(to, content);
			this.files.delete(from);
		},
		fsRmdir: async (): Promise<void> => undefined,
		fsMkdir: async (): Promise<void> => undefined,
	};
}
