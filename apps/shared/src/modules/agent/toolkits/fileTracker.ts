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
// FILE TRACKER — what one run read and changed, and at which version
// =============================================================================

/** What the run did to a file. */
export type FileChange = 'added' | 'modified' | 'deleted' | 'renamed';

/** One file the run read or changed: the view's version and the content's SHA-256 at the run's last read or write. */
export interface TrackedFile {
	path: string;
	readVersion?: number;
	readHash?: string;
	/** The SHA-256 of the stored copy at that moment, which a delete is based on. Under unsaved typing it is the copy Discard mine brings back. */
	storedHash?: string;
	/** Unset when the run only read the file. */
	change?: FileChange;
	/** The path a renamed file came from. */
	from?: string;
}

/** The files one run read or changed. It keeps no file content. */
export class FileTracker {
	/** Each tracked file, by path, in the order first seen. */
	private readonly files = new Map<string, TrackedFile>();

	get(path: string): TrackedFile | undefined {
		return this.files.get(path);
	}

	/** The paths whose content the run read or wrote, in the order first seen; a file the run only deleted is left out. */
	seen(): string[] {
		return [...this.files.values()].filter((file) => file.readHash !== undefined).map((file) => file.path);
	}

	/** The run read a file at `version`. */
	read(path: string, version: number, hash: string, stored = hash): void {
		const file = this.entry(path);
		file.readVersion = version;
		file.readHash = hash;
		file.storedHash = stored;
	}

	/** The run wrote a file at `version`; `existed` is whether it was there before. */
	wrote(path: string, version: number, hash: string, existed: boolean): void {
		this.folderBack(path);
		const file = this.entry(path);
		file.readVersion = version;
		file.readHash = hash;
		file.storedHash = hash;
		// step: an added or renamed file keeps its change; one deleted and written again is modified
		if (file.change === undefined) file.change = existed ? 'modified' : 'added';
		else if (file.change === 'deleted') file.change = 'modified';
	}

	/**
	 * Another tool of the run created a file, as create_app's scaffold does.
	 * The run has not read it, so an edit still needs a read first.
	 *
	 * @param path - Canonical path.
	 */
	created(path: string): void {
		this.folderBack(path);
		const file = this.entry(path);
		// step: as for a write, a file the run deleted and made again is modified
		if (file.change === undefined) file.change = 'added';
		else if (file.change === 'deleted') file.change = 'modified';
	}

	/** The run deleted a file or a folder at `version`; every tracked file under it goes too. `held` lists every file a folder held, read or not. */
	deleted(path: string, version: number, held: readonly string[] = []): void {
		let existed = true;
		const created = new Set<string>();
		for (const file of this.within(path)) {
			// step: a file the run created and then deleted was never a change
			if (file.change === 'added') {
				this.files.delete(file.path);
				created.add(file.path);
				if (file.path === path) existed = false;
				continue;
			}
			file.change = 'deleted';
			file.readVersion = version;
			file.readHash = undefined;
			file.storedHash = undefined;
			file.from = undefined;
		}
		// step: a file the folder held that the run never read is deleted too, with a row of its own, so the folder coming back does not hide it
		for (const file of held) if (!this.files.has(file) && !created.has(file)) this.files.set(file, { path: file, change: 'deleted', readVersion: version });
		if (existed && !this.files.has(path)) this.files.set(path, { path, change: 'deleted', readVersion: version });
	}

	/**
	 * The run renamed a file or a folder. Each moved file takes its version
	 * after the rename, so the run's own move is not someone else's change.
	 */
	renamed(from: string, to: string, version: (path: string) => number): void {
		const moving = this.within(from);
		if (moving.length === 0) moving.push({ path: from });
		for (const file of moving) {
			const target = to + file.path.slice(from.length);
			// step: a file renamed into a folder the run deleted brings the folder back, as a write does
			this.folderBack(target);
			this.files.delete(file.path);
			const origin = file.change === 'renamed' ? file.from : file.path;
			this.files.set(target, {
				...file,
				path: target,
				readVersion: version(target),
				change: file.change === 'added' ? 'added' : 'renamed',
				from: file.change === 'added' ? undefined : origin,
			});
		}
	}

	/** The tracked files someone else changed since the run last read or wrote them; deleted ones are left out. */
	changedSince(vfs: { version(path: string): number }): TrackedFile[] {
		return [...this.files.values()].filter((file) => file.change !== 'deleted' && file.readVersion !== undefined && file.readVersion < vfs.version(file.path));
	}

	/** What the run changed, one row per file, in the order first seen. */
	changes(): Array<{ path: string; change: FileChange; from?: string }> {
		const out: Array<{ path: string; change: FileChange; from?: string }> = [];
		for (const { path, change, from } of this.files.values()) {
			if (change !== undefined) out.push(from === undefined ? { path, change } : { path, change, from });
		}
		return out;
	}

	/**
	 * A file now exists under a folder the run deleted, so the folder is back:
	 * its own deleted row goes. Rows of files under it that stay deleted are kept.
	 *
	 * @param path - Canonical path of the file written or created.
	 */
	private folderBack(path: string): void {
		for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
			const folder = path.slice(0, cut);
			if (this.files.get(folder)?.change === 'deleted') this.files.delete(folder);
		}
	}

	/** The record of a path, made on first use. */
	private entry(path: string): TrackedFile {
		let file = this.files.get(path);
		if (!file) {
			file = { path };
			this.files.set(path, file);
		}
		return file;
	}

	/** The tracked files at or under a path. */
	private within(path: string): TrackedFile[] {
		return [...this.files.values()].filter((file) => file.path === path || file.path.startsWith(`${path}/`));
	}
}
