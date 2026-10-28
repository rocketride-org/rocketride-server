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
		const file = this.entry(path);
		file.readVersion = version;
		file.readHash = hash;
		file.storedHash = hash;
		// step: an added or renamed file keeps its change; one deleted and written again is modified
		if (file.change === undefined) file.change = existed ? 'modified' : 'added';
		else if (file.change === 'deleted') file.change = 'modified';
	}

	/** The run deleted a file or a folder at `version`; every tracked file under it goes too. */
	deleted(path: string, version: number): void {
		let existed = true;
		for (const file of this.within(path)) {
			// step: a file the run created and then deleted was never a change
			if (file.change === 'added') {
				this.files.delete(file.path);
				if (file.path === path) existed = false;
				continue;
			}
			file.change = 'deleted';
			file.readVersion = version;
			file.readHash = undefined;
			file.storedHash = undefined;
			file.from = undefined;
		}
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
