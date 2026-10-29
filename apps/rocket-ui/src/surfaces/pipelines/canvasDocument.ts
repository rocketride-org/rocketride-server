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
// CANVAS DOCUMENT — the save state every canvas of one pipeline shares
// =============================================================================

/**
 * A pipeline's version and save state belong to its document, not to one
 * canvas: a save from one split must leave the other at the new version.
 * The document lives while Documents holds the pipeline, so a canvas that
 * mounts again (a tab move, a split) finds it with its saves on their way.
 * When the app tears Documents down (a team switch) it goes with its last
 * canvas, and its saves still land.
 *
 * Each save waits for the one before it. A reload, Overwrite and closing the
 * last tab move the document's generation before they await anything, and a
 * save called in an earlier generation writes nothing and rejects with
 * SaveDroppedError. A reload moves it again when it puts the stored pipeline
 * on screen, since a save called during its read holds the pipeline it
 * replaced, so a save waits for a reload on its way.
 */

import { useEffect, useState } from 'react';
import { SaveDroppedError } from 'shared/modules/agent/host';
import type { IWorkspaceFileSystem } from 'shared/modules/vfs/vfsTypes';
import { registerEditor } from '../../agent/editorControls';
import { loadedVersion, reloadPipeline, savePipeline, type ProjectVfs } from '../workspace/projectVfs';

/** The version of content this page did not read or save (Documents restored it at boot): no version matches it, so its first save asks. */
export const RESTORED = -1;

/** What a pipeline document needs of Documents. */
export interface CanvasDocs {
	getState(): { documents: Record<string, { dirty: boolean; content: unknown; version: number } | undefined> };
	saveDocument(uri: string): Promise<void>;
	revertDocument(uri: string): Promise<void>;
	/** Hears each change: the document goes when Documents drops the pipeline. */
	subscribe(listener: () => void): () => void;
	/** True once the app tore Documents down (a team switch, signing out), which closes no pipeline. */
	readonly destroyed?: boolean;
}

const documents = new WeakMap<IWorkspaceFileSystem, Map<string, CanvasDocument>>();

function shelf(view: IWorkspaceFileSystem): Map<string, CanvasDocument> {
	let shelved = documents.get(view);
	if (!shelved) {
		shelved = new Map();
		documents.set(view, shelved);
	}
	return shelved;
}

/** The save state of one open pipeline document. */
export class CanvasDocument {
	/** The view version the content was loaded at; a save names it. */
	version: number;
	/** True while a save runs or waits its turn, so its own write does not read as an outside change. */
	saving = false;
	reloading = false;
	/** The reload in flight, which a second caller waits for. */
	reload?: Promise<boolean>;
	canvases = 0;
	/** The project VFS the newest canvas saves through. */
	projectVfs: ProjectVfs | null = null;

	/** The mounted canvases' saves, newest last; each shows its own failure. */
	private readonly canvasSaves: Array<() => Promise<void>> = [];
	/** The newest save called; a save called while it runs follows it. */
	private lastSave: { key: string; generation: number; done: Promise<void> } | null = null;
	/** Moves when the pipeline a save was called with is replaced or dropped; a save called before the move writes nothing. */
	private generation = 0;
	/** How many reloads replaced the pipeline on screen; a write's version is the pipeline's only when none did since its save was called. */
	private reloads = 0;
	private unregister: (() => void) | null = null;
	private unwatchView: (() => void) | null = null;
	private unwatchDocs: (() => void) | null = null;
	/** True once the document went (see settle); a canvas that mounts later gets a new one. */
	private released = false;

	constructor(
		readonly view: IWorkspaceFileSystem,
		readonly docs: CanvasDocs,
		readonly path: string,
		readonly uri: string
	) {
		// step: the version the content was read at, not the view's now, which may have moved on while the read was on its way.
		// Content this page never read (typing, or what Documents restored at boot) has none, so its first save asks Reload or Overwrite
		this.version = loadedVersion(docs.getState().documents[uri]?.content) ?? RESTORED;
	}

	/** True while Documents holds the pipeline with changes not saved. */
	documentDirty(): boolean {
		return this.docs.getState().documents[this.uri]?.dirty === true;
	}

	/** A canvas mounts; `save` is its save, which shows its own failure. The returned unmount leaves the document while Documents holds the pipeline. */
	open(save: () => Promise<void>): () => void {
		const shelved = shelf(this.view);
		if (!shelved.has(this.path)) shelved.set(this.path, this);
		this.unregister ??= registerEditor(this.view, this.path, {
			uri: this.uri,
			getContent: () => JSON.stringify(this.docs.getState().documents[this.uri]?.content, null, 2),
			isDirty: () => this.documentDirty(),
			// step: the newest canvas saves, and shows a failure; while a moved canvas mounts again the document saves itself
			save: () => this.canvasSaves[this.canvasSaves.length - 1]?.() ?? this.save(this.docs.getState().documents[this.uri]?.content),
			discard: async () => {
				if (!(await this.reloadStored(false))) throw new Error(`${this.path} could not be loaded again: the stored pipeline is gone, is not valid JSON, or could not be read`);
			},
		});
		this.unwatchDocs ??= this.docs.subscribe(() => this.settle());
		this.canvasSaves.push(save);
		this.canvases += 1;
		this.unwatchView ??= this.view.subscribe(() => this.follow());
		this.follow();
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			const at = this.canvasSaves.lastIndexOf(save);
			if (at >= 0) this.canvasSaves.splice(at, 1);
			this.canvases -= 1;
			if (this.canvases > 0) return;
			this.unwatchView?.();
			this.unwatchView = null;
			// step: a moved tab or a split mounts the canvas again at once; the document and its saves stay
			this.settle();
		};
	}

	/**
	 * Saves a pipeline at the version the document was loaded at. A save
	 * called while another runs is that save when it writes the same pipeline
	 * to the same file in the same generation; another pipeline saves once it
	 * is done, at the version it wrote.
	 *
	 * @returns Rejects with StaleWriteError for a pipeline that moved on, and SaveDroppedError for one the user dropped meanwhile.
	 */
	async save(content: unknown, opts: { overwrite?: boolean; filename?: string } = {}): Promise<void> {
		if (!this.projectVfs) throw new Error(`${this.path} cannot be saved: no canvas has opened it`);
		const key = JSON.stringify([opts.filename ?? this.uri, opts.overwrite === true, content]);
		const ahead = this.lastSave;
		if (ahead?.key === key && ahead.generation === this.generation) return ahead.done;
		if (opts.overwrite) this.generation += 1;
		const [generation, reloads] = [this.generation, this.reloads];
		this.saving = true;
		const mine: { key: string; generation: number; done: Promise<void> } = { key, generation, done: Promise.resolve() };
		this.lastSave = mine;
		mine.done = (async () => {
			try {
				// step: the save before it lands first, or fails; either way this one names the version it left
				if (ahead) await ahead.done.catch(() => undefined);
				// step: a reload on its way may still put the stored pipeline on screen, which drops this one
				while (this.reload) await this.reload.catch(() => false);
				if (this.dropped(generation)) throw new SaveDroppedError(this.path);
				await this.write(content, opts, generation, reloads);
			} catch (err) {
				// step: a write on its way that failed after the user dropped its pipeline did not land either, and is no failure to show
				if (!(err instanceof SaveDroppedError) && this.dropped(generation)) throw new SaveDroppedError(this.path);
				throw err;
			} finally {
				// step: follow() skips a change while a save runs, so the last one catches up
				if (this.lastSave === mine) {
					this.lastSave = null;
					this.saving = false;
					this.follow();
				}
			}
		})();
		return mine.done;
	}

	private async write(content: unknown, opts: { overwrite?: boolean; filename?: string }, generation: number, reloads: number): Promise<void> {
		const projectVfs = this.projectVfs as ProjectVfs;
		if (opts.overwrite) {
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
			// step: a reload or closing the pipeline's last tab during the read dropped this pipeline
			if (this.dropped(generation)) throw new SaveDroppedError(this.path);
			this.version = version;
		}
		const written = await savePipeline(projectVfs, this.docs, opts.filename ?? this.uri, this.uri, content, this.version);
		// step: typing since the call builds on this write; a pipeline a reload put on screen meanwhile has its own version
		if (this.reloads === reloads) this.version = written;
	}

	/**
	 * Drops the unsaved changes and reloads the stored pipeline. The loaded
	 * version moves only when the content did: a pipeline that could not be
	 * loaded leaves both, so the next save is refused instead of overwriting
	 * that change unseen.
	 *
	 * @param fresh - Read the server's copy, past the view's cache, which is older after a refused save (the stale dialog's Reload). False when following a change in this page, and for Discard mine.
	 * @returns True when the stored pipeline was loaded.
	 */
	reloadStored(fresh = true): Promise<boolean> {
		// step: the saves waiting their turn hold the pipeline this reload replaces, so they are dropped before anything awaits
		this.generation += 1;
		// step: a reload already on its way (from another split, or a clean canvas following a change) is the one to wait
		// for. It may have read the cached copy, so a fresh reload then reads again
		if (this.reload) return fresh ? this.reload.then(() => this.reloadStored()) : this.reload;
		if (fresh) this.view.invalidate(this.path);
		this.reloading = true;
		const reload = (async (): Promise<boolean> => {
			try {
				const version = await reloadPipeline(this.docs, this.uri);
				if (version === null) return false;
				// step: a save called during the read holds the pipeline this replaced
				this.version = version;
				this.reloads += 1;
				this.generation += 1;
				return true;
			} finally {
				this.reloading = false;
				this.reload = undefined;
			}
		})();
		this.reload = reload;
		return reload;
	}

	/** A clean document a canvas shows reloads when the stored pipeline moved on; one that failed to load tries again on each change. */
	private follow(): void {
		if (!this.unwatchView || this.documentDirty() || this.saving || this.reloading) return;
		if (this.view.version(this.path) !== this.version) void this.reloadStored(false);
	}

	/** True when a save called in `generation` can no longer write its pipeline: a reload or Overwrite replaced it, or its last tab closed. */
	private dropped(generation: number): boolean {
		return generation !== this.generation || this.closed();
	}

	/** True when Documents, still in use, no longer holds the pipeline: the user closed its last tab. */
	private closed(): boolean {
		return this.docs.destroyed !== true && this.docs.getState().documents[this.uri] === undefined;
	}

	/**
	 * The document goes when Documents drops the pipeline (its last tab
	 * closed), with the saves waiting their turn. When the app tore Documents
	 * down instead (a team switch), it goes with its last canvas, and its
	 * saves still land.
	 */
	private settle(): void {
		if (this.released) return;
		if (this.closed()) this.release(true);
		else if (this.docs.destroyed === true && this.canvases === 0) this.release(false);
	}

	/** Drops the document from the shelf, the agent's editors and Documents' listeners; `drop` drops the waiting saves too. */
	private release(drop: boolean): void {
		this.released = true;
		if (drop) this.generation += 1;
		const shelved = shelf(this.view);
		if (shelved.get(this.path) === this) shelved.delete(this.path);
		this.unregister?.();
		this.unregister = null;
		this.unwatchDocs?.();
		this.unwatchDocs = null;
		this.unwatchView?.();
		this.unwatchView = null;
		this.view.notify();
	}
}

/** The document its canvases share; `shared` false (a new or read-only pipeline, no stored file to check) gets one of its own. */
export function canvasDocument(view: IWorkspaceFileSystem, docs: CanvasDocs, path: string, uri: string, shared = true): CanvasDocument {
	if (!shared) return new CanvasDocument(view, docs, path, uri);
	const shelved = shelf(view);
	let doc = shelved.get(path);
	if (!doc) {
		doc = new CanvasDocument(view, docs, path, uri);
		shelved.set(path, doc);
	}
	return doc;
}

/** Joins the document of a pipeline while the calling canvas is mounted; `tracked` is false for a new or read-only pipeline. */
export function useCanvasDocument(view: IWorkspaceFileSystem, docs: CanvasDocs, path: string, uri: string, save: () => Promise<void>, tracked: boolean): CanvasDocument {
	// step: found at render, so the canvas's callbacks see it from the first render
	const [doc, setDoc] = useState(() => canvasDocument(view, docs, path, uri, tracked));
	useEffect(() => {
		const current = canvasDocument(view, docs, path, uri, tracked);
		setDoc(current);
		return tracked ? current.open(save) : undefined;
	}, [view, docs, path, uri, save, tracked]);
	return doc;
}
