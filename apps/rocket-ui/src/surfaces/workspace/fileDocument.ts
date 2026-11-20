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
// FILE DOCUMENT — the text, version and save state every tab of one file shares
// =============================================================================

/**
 * Every Monaco tab of one path binds to the same Monaco model, which outlives the tab, so the text,
 * its loaded view version and its unsaved flag belong to the file: splits share them, and unsaved
 * text that outlives its last tab keeps its version, so a later save is refused if the file moved
 * on. A document lives while a tab shows it or its text is unsaved. Saves run one after another.
 * Discard mine, Reload and Overwrite move the generation before awaiting anything; a save from an
 * earlier generation writes nothing and rejects with SaveDroppedError.
 */

import { SaveDroppedError } from 'shared/modules/agent/host';
import { StaleWriteError } from 'shared/modules/vfs/stagedFileSystem';
import type { IWorkspaceFileSystem } from 'shared/modules/vfs/vfsTypes';
import { registerEditor } from '../../agent/editorControls';

const documents = new WeakMap<IWorkspaceFileSystem, Map<string, FileDocument>>();

function shelf(view: IWorkspaceFileSystem): Map<string, FileDocument> {
	let shelved = documents.get(view);
	if (!shelved) {
		shelved = new Map();
		documents.set(view, shelved);
	}
	return shelved;
}

/** One workspace text file as its tabs show it. */
export class FileDocument {
	/** The stored file while clean, the user's typing while dirty; null until loaded. */
	text: string | null = null;
	/** The view version the text was loaded or last saved at; a save names it. */
	version = 0;
	dirty = false;
	/** True when the stored file moved on while the text was dirty, or a save was refused for it. */
	stale = false;
	/** Why the stored file could not be read, while the text is clean. */
	error: string | null = null;
	/** Why the last save failed, when the failure was not a newer file. */
	saveError: string | null = null;
	/** True while a save runs or waits its turn; its own write is not an outside change. */
	saving = false;
	/** True while the document sets the editors' text itself, which is not typing. */
	applying = false;
	tabs = 0;
	/** How many loads were started; only the newest one's result applies. */
	private loads = 0;
	/** The stored text the text was loaded from or saved as; null until loaded. */
	private base: string | null = null;
	/** The newest save called; a save called while it runs follows it. */
	private lastSave: { text: string; overwrite: boolean; generation: number; done: Promise<void> } | null = null;
	/** Moves on Discard mine, Reload and Overwrite; a save called before the move writes nothing. */
	private generation = 0;
	/** Puts text into this path's Monaco model; each tab's editor sets it as it mounts, and it goes with the last tab. */
	sync?: (text: string) => void;

	private readonly listeners = new Set<() => void>();
	private unregister: (() => void) | null = null;
	private unwatch: (() => void) | null = null;

	constructor(
		readonly view: IWorkspaceFileSystem,
		readonly path: string
	) {}

	/** A tab opens on the document. The returned close drops the document with its last tab unless its text is unsaved. */
	open(): () => void {
		const shelved = shelf(this.view);
		if (!shelved.has(this.path)) shelved.set(this.path, this);
		this.unregister ??= registerEditor(this.view, this.path, {
			uri: `file:${this.path}`,
			getContent: () => this.text ?? undefined,
			isDirty: () => this.dirty,
			save: () => this.save(),
			discard: () => this.discard(),
		});
		this.tabs += 1;
		this.unwatch ??= this.view.subscribe(() => void this.load());
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			this.tabs -= 1;
			if (this.tabs > 0) return;
			this.unwatch?.();
			this.unwatch = null;
			// step: the model is keyed by the path alone, so after a team switch a tab of another team's
			// document may show it. The next tab's editor binds this document again (FileProvider's beforeMount)
			this.sync = undefined;
			this.releaseIfIdle();
		};
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Reads the stored file into a clean document, past every editor's
	 * unsaved buffer (a canvas's unsaved pipeline on the same file stays the
	 * canvas's). Unsaved text is never replaced; when the file moved on under
	 * it, the document turns stale instead. A read never takes the document
	 * back to an older version.
	 */
	async load(): Promise<void> {
		const busy = (): boolean => {
			if (this.saving) return true;
			if (!this.dirty) return false;
			if (!this.stale && this.view.version(this.path) !== this.version) {
				this.stale = true;
				this.changed();
			}
			return true;
		};
		if (busy()) return;
		const mine = ++this.loads;
		try {
			const { content, version } = await this.view.readVersioned(this.path, { stored: true });
			const stored = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
			if (mine !== this.loads || busy()) return;
			this.version = version;
			this.base = stored;
			this.apply(stored);
			this.stale = false;
			this.error = null;
		} catch (err) {
			if (mine !== this.loads || this.dirty) return;
			this.text = null;
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			if (this.tabs === 0) this.releaseIfIdle();
		}
		this.changed();
	}

	/** The user typed the editor's whole `text`. The same text, or the editors echoing the document's own change, is not typing. */
	type(text: string): void {
		if (this.applying || text === this.text) return;
		this.text = text;
		this.markDirty(true);
		this.changed();
	}

	/**
	 * Saves the text at the version it was loaded at. A file that moved on
	 * refuses it and turns the document stale. A save called while another
	 * runs is that save when the text and generation are the same; newer
	 * typing saves once it is done, at the version it wrote.
	 *
	 * @returns Rejects with StaleWriteError for a file that moved on, and SaveDroppedError for text the user dropped meanwhile.
	 */
	save(overwrite = false): Promise<void> {
		const text = this.text ?? '';
		const ahead = this.lastSave;
		if (ahead && ahead.generation === this.generation && ahead.text === text && ahead.overwrite === overwrite) return ahead.done;
		if (!ahead && !this.dirty) return Promise.resolve();
		if (overwrite) this.generation += 1;
		const generation = this.generation;
		this.saving = true;
		this.changed();
		const mine: { text: string; overwrite: boolean; generation: number; done: Promise<void> } = { text, overwrite, generation, done: Promise.resolve() };
		this.lastSave = mine;
		mine.done = (async () => {
			let failed = false;
			try {
				// step: the save before it lands first, or fails; either way this one names the version it left
				if (ahead) await ahead.done.catch(() => undefined);
				// step: Discard mine, Reload or Overwrite since the call dropped this text
				if (generation !== this.generation) throw new SaveDroppedError(this.path);
				await this.write(overwrite, generation);
			} catch (err) {
				// step: a write on its way that failed after the user dropped its text did not land either, and is no failure to show
				if (!(err instanceof SaveDroppedError) && generation !== this.generation) throw new SaveDroppedError(this.path);
				failed = !(err instanceof SaveDroppedError);
				throw err;
			} finally {
				if (this.lastSave === mine) {
					this.lastSave = null;
					this.saving = false;
				}
				this.changed();
				// step: after a save that landed or was dropped, catch up on anything that changed while the saves ran
				if (!failed && !this.saving && this.tabs > 0) void this.load();
			}
		})();
		return mine.done;
	}

	private async write(overwrite: boolean, generation: number): Promise<void> {
		if (!this.dirty) return;
		const text = this.text ?? '';
		try {
			if (overwrite) {
				// step: adopt the version this read returns, which counts the server's copy it takes in, and that
				// copy as the freshness baseline. The view reads the copy again, so a read that a change overtook
				// is not adopted, and a change that lands during the read moves the file past it, so the save asks again
				let version = this.view.version(this.path);
				this.view.invalidate(this.path);
				try {
					({ version } = await this.view.readVersioned(this.path, { stored: true }));
				} catch {
					/* not on the server yet: nothing to adopt */
				}
				// step: Discard mine or Reload during the read dropped this text
				if (generation !== this.generation) throw new SaveDroppedError(this.path);
				this.version = version;
			}
			const writing = this.view.write(this.path, text, 'editor', this.version);
			const mine = this.view.version(this.path);
			await writing;
			// step: text dropped while the write was on its way shows the stored text it had, which is not at the version written
			if (generation !== this.generation && this.text !== text) return;
			this.version = mine;
			this.base = text;
			this.stale = false;
			this.saveError = null;
			if (this.text === text) this.markDirty(false);
		} catch (err) {
			if (generation === this.generation) {
				if (err instanceof StaleWriteError) this.stale = true;
				else this.saveError = err instanceof Error ? err.message : String(err);
			}
			throw err;
		}
	}

	/**
	 * Drops the unsaved text (the banner's Reload, or Discard mine). With a
	 * tab open it shows the stored text it had at once, so typing during the
	 * load starts from it. A stale document reads the server's copy, not the
	 * view's cached copy, which is older when another tab or a teammate
	 * changed the file.
	 */
	async discard(): Promise<void> {
		// step: before anything awaits
		this.generation += 1;
		const fresh = this.stale;
		this.stale = false;
		if (fresh) this.view.invalidate(this.path);
		if (this.tabs === 0) {
			this.markDirty(false);
			this.changed();
			return;
		}
		this.markDirty(false);
		if (this.base !== null) this.apply(this.base);
		await this.load();
	}

	/** Brings this path's Monaco model to the document's text, before an editor binds to it. */
	syncModel(): void {
		if (this.text !== null) this.apply(this.text);
	}

	/** Sets the text, and the Monaco model with it; the editors' change events meanwhile are not typing. */
	private apply(text: string): void {
		this.text = text;
		this.applying = true;
		try {
			this.sync?.(text);
		} finally {
			this.applying = false;
		}
	}

	/** Marks the text unsaved or saved. The view hears each flip, since the agent reads the overlay. */
	private markDirty(next: boolean): void {
		if (this.dirty === next) return;
		this.dirty = next;
		this.view.notify();
		if (!next && this.tabs === 0) this.releaseIfIdle();
	}

	/**
	 * Drops a document no tab shows and no unsaved text keeps. A save of it
	 * waiting its turn finds nothing unsaved and resolves: the stored file
	 * holds the text.
	 */
	private releaseIfIdle(): void {
		if (this.tabs > 0 || this.dirty) return;
		const shelved = shelf(this.view);
		if (shelved.get(this.path) === this) shelved.delete(this.path);
		this.unregister?.();
		this.unregister = null;
		this.view.notify();
	}

	private changed(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

/** The document a path's tabs share, made on first use; a tab joins it with open(). */
export function fileDocument(view: IWorkspaceFileSystem, path: string): FileDocument {
	const shelved = shelf(view);
	let doc = shelved.get(path);
	if (!doc) {
		doc = new FileDocument(view, path);
		shelved.set(path, doc);
	}
	return doc;
}
