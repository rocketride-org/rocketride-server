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
// FILE TRACKER — what one run read and wrote, and at which version
// =============================================================================

/** One file the run read or wrote: the view's version and the content's SHA-256 at that moment. */
export interface TrackedFile {
	path: string;
	readVersion: number;
	readHash: string;
	/** The SHA-256 of the stored copy at that moment, which a delete is based on. Under unsaved typing it is the copy Discard mine brings back. */
	storedHash: string;
}

/** The files one run read or wrote. It keeps no file content. */
export class FileTracker {
	/** Each tracked file, by path, in the order first seen. */
	private readonly files = new Map<string, TrackedFile>();

	get(path: string): TrackedFile | undefined {
		return this.files.get(path);
	}

	/** The paths the run read or wrote, in the order first seen. */
	seen(): string[] {
		return [...this.files.keys()];
	}

	/** The run read or wrote a file at `version`. */
	saw(path: string, version: number, hash: string, stored = hash): void {
		const file = this.files.get(path);
		if (file) Object.assign(file, { readVersion: version, readHash: hash, storedHash: stored });
		else this.files.set(path, { path, readVersion: version, readHash: hash, storedHash: stored });
	}

	/** The run deleted a file or a folder: what it held needs a read again before an edit. */
	deleted(path: string): void {
		for (const file of this.within(path)) this.files.delete(file.path);
	}

	/**
	 * The run renamed a file or a folder. Each moved file takes its version
	 * after the rename, so the run's own move is not someone else's change.
	 */
	renamed(from: string, to: string, version: (path: string) => number): void {
		for (const file of this.within(from)) {
			const target = to + file.path.slice(from.length);
			this.files.delete(file.path);
			this.files.set(target, { ...file, path: target, readVersion: version(target) });
		}
	}

	/** The tracked files someone else changed since the run last read or wrote them. */
	changedSince(vfs: { version(path: string): number }): TrackedFile[] {
		return [...this.files.values()].filter((file) => file.readVersion < vfs.version(file.path));
	}

	/** The tracked files at or under a path. */
	private within(path: string): TrackedFile[] {
		return [...this.files.values()].filter((file) => file.path === path || file.path.startsWith(`${path}/`));
	}
}
