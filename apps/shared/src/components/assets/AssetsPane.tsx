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
// ASSETS PANE — PACKAGE › Assets, one pane for pipelines and apps
// =============================================================================

/**
 * The PACKAGE › Assets pane (assets-pane mockup r2, frames A.1–A.3): the
 * icon tile is the control, the README is edited in place with a store
 * preview, images are inserted by button, drop or paste (rasters scaled to
 * fit 1024 x 800, written as `<img>` tags with no width) and land in
 * `assets/` beside the README, and the files the README references show as
 * thumbnails, each with a Width field that rewrites its reference. Nothing
 * here is a path field: the pane writes the files
 * through its {@link IAssetsHost} and hands the icon/readme PATHS to the
 * caller's setter, which stores them (the pipe's store block, the app's
 * manifest).
 *
 * The README text goes to the file as it is typed (debounced), so the
 * footer's Unsaved/Saved is the file's state, not the document's.
 */

import React, { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, commonStyles, InputField, MarkdownRenderer, TabControl } from 'shell';
import type { ViewMenu } from 'shell';
import type { IAssetsHost, IReadmeReference } from './assetsModel';
import { downscaleImage } from './assetsDownscale';
import { admitIcon, ASSETS_DIR, assetMarkdown, dataUriByteLength, extensionForMediaType, formatBytes, iconPathFor, inlineImageReferences, insertAtCaret, lineCount, pastedImageName, posixBasename, posixDirname, posixJoin, README_WRITE_DEBOUNCE_MS, readmeReferences, referenceWidth, removeReference, safeAssetName, setReferenceWidth, uniqueAssetName } from './assetsModel';

// =============================================================================
// TYPES
// =============================================================================

/** The kind of document the pane describes — the wording differs by kind. */
export type AssetsKind = 'pipeline' | 'app';

/** The two paths the pane manages; '' clears one. */
export interface IAssetPaths {
	/** The icon path as declared (`./icon.svg`), '' or absent when none. */
	icon?: string;
	/** The README path as declared (`./README.md`), '' or absent when none. */
	readme?: string;
}

/** Props for {@link AssetsPane}. */
export interface IAssetsPaneProps {
	/** Pipeline or app — the help sentences and the empty-state glyph note. */
	kind: AssetsKind;
	/** The file operations beside the document. */
	host: IAssetsHost;
	/** The document's stem (pipeline id, app slug) — pasted images are named after it. */
	docStem: string;
	/** The declared icon and README paths. */
	paths: IAssetPaths;
	/**
	 * Receives a path change: a new path, or '' to clear it. A host that
	 * stores the path asynchronously returns the promise: the pane awaits
	 * it and reports a failure as its notice (the file is on disk either way).
	 */
	onPathsChange: (patch: IAssetPaths) => void | Promise<void>;
	/** The README written by "Write the README" (the kind's scaffold stub). */
	readmeStub: string;
	/** Read-only hosts: the pane shows, never writes. */
	readonly?: boolean;
}

/** The editor tabs, in the order they are drawn: Preview first. */
type EditorTab = 'preview' | 'edit';

/** What the pane knows about the icon file, once read. */
interface IIconState {
	/** The tile's image (a data: URI), null when the declared file is missing. */
	src: string | null;
	/** The file's size in bytes (0 when missing). */
	bytes: number;
}

/** One README reference with its thumbnail (or its absence). */
interface IReferenceTile extends IReadmeReference {
	/** The thumbnail (a data: URI) for an image that exists. */
	src: string | null;
	/** Whether the file is missing beside the document. */
	missing: boolean;
}

/** The README path a pane without a declared one writes. */
const DEFAULT_README_PATH = './README.md';

/** The README strip: Preview first, the tab a README opens on. */
const README_TABS: ViewMenu = { entries: [{ id: 'preview', label: 'Preview' }, { id: 'edit', label: 'Edit' }] };

/** The wording that differs by kind. */
const KIND_WORDS: Record<AssetsKind, { noun: string; glyph: string; packedNote: (referenced: number, missing: number) => string }> = {
	pipeline: {
		noun: 'pipeline',
		glyph: 'the generic pipeline glyph',
		packedNote: (referenced, missing) => {
			const count = referenced === 0 ? 'No files referenced yet' : `${referenced} file${referenced === 1 ? '' : 's'} referenced`;
			const gap = missing === 0 ? '' : `; ${missing === 1 ? 'one is' : `${missing} are`} missing — fix the link or drop the file in`;
			return `${count}${gap}. The pipeline, the icon and the README are always packed.`;
		},
	},
	app: {
		noun: 'app',
		glyph: 'the generic app glyph',
		packedNote: () => 'Apps pack their whole folder plus appManifest.include; this list shows the images the README uses.',
	},
};

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	label: {
		...commonStyles.labelUppercase,
		color: 'var(--rr-text-secondary)',
		marginBottom: 8,
	} as CSSProperties,
	help: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		marginTop: 6,
		lineHeight: 1.5,
	} as CSSProperties,
	problem: {
		fontSize: 12,
		color: 'var(--rr-color-error)',
		marginTop: 6,
	} as CSSProperties,
	mono: {
		...commonStyles.fontMono,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	// ── Icon tile ─────────────────────────────────────────────────────────
	iconRow: {
		display: 'flex',
		gap: 16,
		alignItems: 'center',
		marginBottom: 22,
	} as CSSProperties,
	tile: {
		width: 72,
		height: 72,
		flexShrink: 0,
		position: 'relative',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		overflow: 'hidden',
		border: '1px solid var(--rr-border)',
		borderRadius: 10,
		background: 'var(--rr-bg-paper)',
		cursor: 'pointer',
		outline: 'none',
	} as CSSProperties,
	tileEmpty: {
		borderStyle: 'dashed',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	tileFocus: {
		boxShadow: '0 0 0 2px var(--rr-brand)',
	} as CSSProperties,
	tileDrop: {
		borderColor: 'var(--rr-brand)',
		background: 'var(--rr-bg-widget)',
	} as CSSProperties,
	tileImage: {
		width: 42,
		height: 42,
		objectFit: 'contain',
	} as CSSProperties,
	tileHover: {
		position: 'absolute',
		left: 0,
		right: 0,
		bottom: 0,
		padding: '3px 0',
		fontSize: 11,
		textAlign: 'center',
		color: '#fff',
		background: 'rgba(31,35,40,0.78)',
	} as CSSProperties,
	iconMeta: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.5,
	} as CSSProperties,
	// ── README editor ─────────────────────────────────────────────────────
	editor: {
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		overflow: 'hidden',
	} as CSSProperties,
	tools: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		paddingRight: 8,
	} as CSSProperties,
	sourceWrap: {
		position: 'relative',
	} as CSSProperties,
	textarea: {
		...commonStyles.fontMono,
		display: 'block',
		width: '100%',
		minHeight: 260,
		padding: '14px 16px',
		fontSize: 13,
		lineHeight: 1.55,
		color: 'var(--rr-text-primary)',
		background: 'var(--rr-bg-paper)',
		border: 'none',
		outline: 'none',
		resize: 'vertical',
		boxSizing: 'border-box',
		whiteSpace: 'pre',
	} as CSSProperties,
	textareaDrop: {
		background: 'var(--rr-bg-widget)',
	} as CSSProperties,
	dropHint: {
		position: 'absolute',
		right: 16,
		bottom: 12,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		border: '1px dashed var(--rr-border)',
		borderRadius: 4,
		padding: '6px 10px',
		background: 'var(--rr-bg-surface-alt)',
		pointerEvents: 'none',
	} as CSSProperties,
	preview: {
		padding: '16px 20px',
		minHeight: 260,
		background: 'var(--rr-bg-paper)',
	} as CSSProperties,
	foot: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '8px 12px',
		borderTop: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-surface-alt)',
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	footDirty: {
		color: 'var(--rr-text-link)',
	} as CSSProperties,
	footRight: {
		marginLeft: 'auto',
	} as CSSProperties,
	emptyReadme: {
		border: '1px dashed var(--rr-border)',
		borderRadius: 4,
		padding: 28,
		textAlign: 'center',
		color: 'var(--rr-text-secondary)',
		fontSize: 13,
		lineHeight: 1.5,
	} as CSSProperties,
	emptyAction: {
		marginTop: 10,
	} as CSSProperties,
	// ── Files packed ──────────────────────────────────────────────────────
	files: {
		marginTop: 22,
	} as CSSProperties,
	thumbs: {
		display: 'flex',
		gap: 12,
		flexWrap: 'wrap',
	} as CSSProperties,
	thumb: {
		width: 150,
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		overflow: 'hidden',
		fontSize: 12,
	} as CSSProperties,
	thumbPic: {
		height: 90,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--rr-text-secondary)',
		background: 'var(--rr-bg-widget)',
		overflow: 'hidden',
	} as CSSProperties,
	thumbPicMissing: {
		color: 'var(--rr-color-error)',
		background: 'var(--rr-bg-surface-alt)',
	} as CSSProperties,
	thumbImage: {
		maxWidth: '100%',
		maxHeight: '100%',
		objectFit: 'contain',
	} as CSSProperties,
	thumbName: {
		...commonStyles.fontMono,
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: 6,
		padding: '6px 8px',
		fontSize: 11.5,
		borderTop: '1px solid var(--rr-border)',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	thumbNameMissing: {
		color: 'var(--rr-color-error)',
	} as CSSProperties,
	thumbPath: {
		...commonStyles.textEllipsis,
		minWidth: 0,
	} as CSSProperties,
	thumbWidth: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '4px 8px 6px',
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		borderTop: '1px solid var(--rr-border)',
	} as CSSProperties,
	thumbWidthInput: {
		...commonStyles.inputField,
		width: 64,
		padding: '2px 6px',
		fontSize: 11,
	} as CSSProperties,
	note: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		marginTop: 6,
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/** How many names running the host may fail to check before the import gives up (a host that cannot answer, not a run of taken names). */
const NAME_CHECK_FAILURE_LIMIT = 3;

/** The bytes of a browser File. */
async function fileBytes(file: File): Promise<Uint8Array> {
	return new Uint8Array(await file.arrayBuffer());
}

/** The files a drop or paste carries, image-first for pastes (the clipboard's own order otherwise). */
function transferFiles(transfer: DataTransfer | null): File[] {
	return transfer ? Array.from(transfer.files) : [];
}

/** Hands an error's message to a setter. */
function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Assets pane. See the module doc.
 *
 * @param props - {@link IAssetsPaneProps}.
 * @returns The pane.
 */
export const AssetsPane: React.FC<IAssetsPaneProps> = ({ kind, host, docStem, paths, onPathsChange, readmeStub, readonly = false }) => {
	const words = KIND_WORDS[kind];
	const iconPath = paths.icon || '';
	const readmePath = paths.readme || '';
	const readmeDir = useMemo(() => posixDirname(readmePath || DEFAULT_README_PATH), [readmePath]);
	const [notice, setNotice] = useState('');

	// ── Icon ─────────────────────────────────────────────────────────────
	const [icon, setIcon] = useState<IIconState | null>(null);
	// Bumped after a write so a replacement at the SAME path reloads the tile.
	const [iconVersion, setIconVersion] = useState(0);
	const [iconHover, setIconHover] = useState(false);
	const [iconFocus, setIconFocus] = useState(false);
	const [iconDrop, setIconDrop] = useState(false);

	useEffect(() => {
		let cancelled = false;
		if (!iconPath) {
			setIcon({ src: null, bytes: 0 });
			return;
		}
		setIcon(null);
		void host
			.readImageDataUri(iconPath)
			.catch(() => null)
			.then((src) => {
				if (!cancelled) setIcon({ src, bytes: src ? dataUriByteLength(src) : 0 });
			});
		return () => {
			cancelled = true;
		};
	}, [host, iconPath, iconVersion]);

	/** Admits a candidate icon, writes it beside the document and declares its path. */
	const applyIcon = useCallback(
		async (file: { name: string; type?: string; data: Uint8Array }): Promise<void> => {
			const verdict = admitIcon({ name: file.name, type: file.type, size: file.data.byteLength });
			if ('error' in verdict) {
				setNotice(verdict.error);
				return;
			}
			setNotice('');
			try {
				// Step 1: the file, as icon.svg or icon.png beside the document
				const declared = iconPathFor(verdict.kind);
				await host.writeFile(declared, file.data);
				setIconVersion((v) => v + 1);
				// Step 2: the path, through the caller's store — awaited, so a host that cannot store it says so here
				if (declared !== iconPath) await onPathsChange({ icon: declared });
			} catch (err) {
				setNotice(`Could not set the icon: ${messageOf(err)}`);
			}
		},
		[host, iconPath, onPathsChange]
	);

	/** The bytes of a dropped or pasted file; a read the browser refuses names the file in the notice and answers null. */
	const readTransferFile = useCallback(async (file: File): Promise<Uint8Array | null> => {
		try {
			return await fileBytes(file);
		} catch (err) {
			setNotice(`Could not read ${file.name || 'the file'}: ${messageOf(err)}`);
			return null;
		}
	}, []);

	const pickIcon = useCallback(async (): Promise<void> => {
		if (readonly) return;
		try {
			const picked = await host.pickFile('image');
			if (picked) await applyIcon(picked);
		} catch (err) {
			setNotice(messageOf(err));
		}
	}, [host, readonly, applyIcon]);

	const onIconDrop = useCallback(
		async (event: React.DragEvent): Promise<void> => {
			event.preventDefault();
			setIconDrop(false);
			if (readonly) return;
			const [file] = transferFiles(event.dataTransfer);
			if (!file) return;
			const data = await readTransferFile(file);
			if (data) await applyIcon({ name: file.name, type: file.type, data });
		},
		[readonly, applyIcon, readTransferFile]
	);

	const onIconPaste = useCallback(
		async (event: React.ClipboardEvent): Promise<void> => {
			if (readonly) return;
			const file = transferFiles(event.clipboardData).find((f) => f.type.startsWith('image/'));
			if (!file) return;
			event.preventDefault();
			const data = await readTransferFile(file);
			if (data) await applyIcon({ name: file.name || `pasted.${extensionForMediaType(file.type)}`, type: file.type, data });
		},
		[readonly, applyIcon, readTransferFile]
	);

	const removeIcon = useCallback((): void => {
		setNotice('');
		onPathsChange({ icon: '' });
	}, [onPathsChange]);

	// ── README ───────────────────────────────────────────────────────────
	// null = the file does not exist (or nothing is declared); undefined = reading.
	const [text, setText] = useState<string | null | undefined>(undefined);
	// A read that failed for a reason other than absence: the empty state names it and offers no stub over the file.
	const [readProblem, setReadProblem] = useState<string | null>(null);
	const [tab, setTab] = useState<EditorTab>('preview');
	const [dirty, setDirty] = useState(false);
	// A write that failed: the footer offers Retry, the text still in the editor.
	const [saveFailed, setSaveFailed] = useState(false);
	const [previewText, setPreviewText] = useState('');
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	// The draft as it is NOW, for work that completes after a render (an insertion behind a file write).
	const textRef = useRef<string | null | undefined>(undefined);
	textRef.current = text;
	const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingText = useRef<string | null>(null);
	// Bumped by every edit: a write that finishes behind a newer edit leaves Unsaved standing.
	const revision = useRef(0);
	// Writes queue in order, so an older write can never land after a newer one.
	const writeChain = useRef<Promise<void>>(Promise.resolve());
	const pasteCount = useRef(0);
	const caretAfterInsert = useRef<number | null>(null);
	// Bumped when the README this pane edits changes or the pane unmounts: an
	// asset import that finishes behind that bump never inserts its link.
	const documentGeneration = useRef(0);
	// Set by "Write the README": the reload its path change triggers opens on Edit, not Preview.
	const openOnEdit = useRef(false);
	const [textDrop, setTextDrop] = useState(false);
	// The thumbnails already read, by document-relative path — a reference
	// typed twice or re-rendered never re-reads its file. A MISSING image is
	// not kept: a file added later (Explorer, a drop) shows at the next look.
	const imageCache = useRef(new Map<string, Promise<string | null>>());

	/** Reads an image beside the document once; a write to its path or a miss drops the cached read. */
	const readImage = useCallback(
		(relPath: string): Promise<string | null> => {
			let pending = imageCache.current.get(relPath);
			if (!pending) {
				const read = host.readImageDataUri(relPath).catch(() => null);
				pending = read;
				imageCache.current.set(relPath, read);
				void read.then((uri) => {
					if (uri === null && imageCache.current.get(relPath) === read) imageCache.current.delete(relPath);
				});
			}
			return pending;
		},
		[host]
	);

	useEffect(() => {
		let cancelled = false;
		pendingText.current = null;
		setDirty(false);
		setSaveFailed(false);
		setReadProblem(null);
		if (!readmePath) {
			setText(null);
			return () => {
				documentGeneration.current += 1;
			};
		}
		setText(undefined);
		void host.readFile(readmePath).then(
			(loaded) => {
				if (cancelled) return;
				setText(loaded);
				// A README that exists opens on Preview; one just written opens on Edit (see writeReadme).
				if (loaded !== null) setTab(openOnEdit.current ? 'edit' : 'preview');
				openOnEdit.current = false;
			},
			(err: unknown) => {
				// Not absence: the file is there and could not be read (over a cap, unreadable)
				if (cancelled) return;
				setReadProblem(messageOf(err));
				setText(null);
				openOnEdit.current = false;
			}
		);
		return () => {
			cancelled = true;
			// The document this pane edited is gone (another README, or the pane
			// closed): an import still writing its file must not link into it
			documentGeneration.current += 1;
		};
	}, [host, readmePath]);

	/** Writes the README now — the debounce's target, the flush and Retry. Writes queue in order. */
	const writeNow = useCallback(
		async (content: string): Promise<void> => {
			if (writeTimer.current) {
				clearTimeout(writeTimer.current);
				writeTimer.current = null;
			}
			pendingText.current = null;
			const rev = revision.current;
			const target = readmePath || DEFAULT_README_PATH;
			const write = writeChain.current.then(() => host.writeFile(target, content));
			writeChain.current = write.catch(() => undefined);
			try {
				await write;
				// Step: only the latest revision's write clears Unsaved — an older one landed behind a newer edit
				if (rev === revision.current) {
					setDirty(false);
					setSaveFailed(false);
				}
			} catch (err) {
				// The text stays in the editor; Retry and the unmount flush take it again
				if (rev === revision.current && pendingText.current === null) pendingText.current = content;
				setSaveFailed(true);
				setNotice(`Could not save the README: ${messageOf(err)}`);
			}
		},
		[host, readmePath]
	);

	/** Takes an edit: the text now, the file after the debounce. */
	const editText = useCallback(
		(next: string): void => {
			textRef.current = next;
			setText(next);
			setDirty(true);
			revision.current += 1;
			pendingText.current = next;
			if (writeTimer.current) clearTimeout(writeTimer.current);
			writeTimer.current = setTimeout(() => {
				writeTimer.current = null;
				const content = pendingText.current;
				if (content !== null) void writeNow(content);
			}, README_WRITE_DEBOUNCE_MS);
		},
		[writeNow]
	);

	/** Retry after a failed save: the unacknowledged text, or the draft as it stands. */
	const retrySave = useCallback((): void => {
		const content = pendingText.current ?? (typeof textRef.current === 'string' ? textRef.current : null);
		if (content !== null) void writeNow(content);
	}, [writeNow]);

	// An edit still waiting when the pane unmounts reaches the file anyway, in
	// order behind the writes in flight. Nothing is mounted to show a failure,
	// so the console carries it.
	useEffect(
		() => () => {
			if (writeTimer.current) clearTimeout(writeTimer.current);
			const content = pendingText.current;
			if (content === null) return;
			const target = readmePath || DEFAULT_README_PATH;
			writeChain.current = writeChain.current
				.then(() => host.writeFile(target, content))
				.catch((err: unknown) => {
					console.error(`[AssetsPane] Could not save ${target} on close: ${messageOf(err)}`);
				});
		},
		[host, readmePath]
	);

	// The caret lands after an inserted snippet once the textarea re-renders.
	useEffect(() => {
		const caret = caretAfterInsert.current;
		const area = textareaRef.current;
		if (caret !== null && area) {
			caretAfterInsert.current = null;
			area.focus();
			area.setSelectionRange(caret, caret);
		}
	}, [text]);

	/** "Write the README": the stub beside the document, declared, opened on Edit. */
	const writeReadme = useCallback(async (): Promise<void> => {
		const target = readmePath || DEFAULT_README_PATH;
		setNotice('');
		try {
			// Step 1: the stub beside the document
			await host.writeFile(target, readmeStub);
			// Step 2: the declaration, awaited — the reload it triggers opens on Edit.
			// A host that cannot store the path says so here and the empty state
			// stays, so the next click retries it (the same stub over the same stub).
			if (target !== readmePath) {
				openOnEdit.current = true;
				await onPathsChange({ readme: target });
				return;
			}
			setText(readmeStub);
			setDirty(false);
			setTab('edit');
		} catch (err) {
			openOnEdit.current = false;
			setNotice(`Could not write the README: ${messageOf(err)}`);
		}
	}, [host, readmePath, readmeStub, onPathsChange]);

	/** Writes a dropped, pasted or picked file to assets/ beside the README and links it at the caret. */
	const insertAsset = useCallback(
		async (file: { name: string; type?: string; data: Uint8Array }, pasted: boolean): Promise<void> => {
			if (typeof textRef.current !== 'string') return;
			const generation = documentGeneration.current;
			setNotice('');
			try {
				// Step 1: the name — pasted images are numbered after the document in the
				// clipboard's format; collisions get -2, -3, ... A name the host cannot
				// read is taken, not free: only a confirmed absence is reused. A host
				// that fails several names running is a host that cannot answer (the
				// connection gone, say), not a run of files: the search stops there.
				const wanted = pasted ? pastedImageName(docStem, ++pasteCount.current, file.type) : safeAssetName(file.name);
				const assetsDir = posixJoin(readmeDir, ASSETS_DIR);
				let failedChecks = 0;
				const name = await uniqueAssetName(wanted, async (candidate) => {
					try {
						const taken = (await host.readFile(posixJoin(assetsDir, candidate))) !== null;
						failedChecks = 0;
						return taken;
					} catch (err) {
						if (++failedChecks >= NAME_CHECK_FAILURE_LIMIT) throw new Error(`could not check ${ASSETS_DIR}/ for a free name (${messageOf(err)})`);
						return true;
					}
				});
				// Step 2: the file — rasters scaled to fit 1024 x 800 first (SVG and GIF pass through)
				const relPath = posixJoin(assetsDir, name);
				await host.writeFile(relPath, await downscaleImage(name, file.data));
				imageCache.current.delete(relPath);
				// Step 3: the link at the caret, into the draft as it is NOW (edits and
				// other insertions landed while the file was written), through the same
				// ordered save path as typing — unless that draft is no longer this
				// document's (the pane closed or moved on): the file stays, the link does not
				if (generation !== documentGeneration.current) return;
				const current = textRef.current;
				if (typeof current !== 'string') return;
				const caret = textareaRef.current?.selectionStart ?? current.length;
				const next = insertAtCaret(current, caret, assetMarkdown(`${ASSETS_DIR}/${name}`));
				caretAfterInsert.current = next.caret;
				setTab('edit');
				editText(next.text);
			} catch (err) {
				setNotice(`Could not add the file: ${messageOf(err)}`);
			}
		},
		[docStem, readmeDir, host, editText]
	);

	const insertImage = useCallback(async (): Promise<void> => {
		try {
			const picked = await host.pickFile('image');
			if (picked) await insertAsset(picked, false);
		} catch (err) {
			setNotice(messageOf(err));
		}
	}, [host, insertAsset]);

	const onTextDrop = useCallback(
		async (event: React.DragEvent<HTMLTextAreaElement>): Promise<void> => {
			event.preventDefault();
			setTextDrop(false);
			if (readonly) return;
			// Step 1: one file at a time; a file the browser cannot read is skipped
			// and the rest still land
			const skipped: string[] = [];
			for (const file of transferFiles(event.dataTransfer)) {
				let data: Uint8Array;
				try {
					data = await fileBytes(file);
				} catch (err) {
					skipped.push(`Could not read ${file.name || 'the file'}: ${messageOf(err)}`);
					continue;
				}
				await insertAsset({ name: file.name, type: file.type, data }, false);
			}
			// Step 2: the skipped files are named once the drop is done, behind
			// whatever the last import left — an import after a skip clears the
			// notice, so naming them as they fail would lose them
			if (skipped.length > 0) setNotice((current) => [current, ...skipped].filter((line) => line !== '').join(' '));
		},
		[readonly, insertAsset]
	);

	const onTextPaste = useCallback(
		async (event: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
			if (readonly) return;
			const file = transferFiles(event.clipboardData).find((f) => f.type.startsWith('image/'));
			if (!file) return;
			event.preventDefault();
			const data = await readTransferFile(file);
			if (data) await insertAsset({ name: file.name, type: file.type, data }, true);
		},
		[readonly, insertAsset, readTransferFile]
	);

	const openInEditor = useCallback((): void => {
		if (!host.openFile || !readmePath) return;
		void host.openFile(readmePath).catch((err) => setNotice(messageOf(err)));
	}, [host, readmePath]);

	// The store preview: the same text, its local images inlined as data: URIs.
	useEffect(() => {
		if (tab !== 'preview' || typeof text !== 'string') return;
		let cancelled = false;
		void inlineImageReferences(text, (ref) => readImage(posixJoin(readmeDir, ref))).then((rendered) => {
			if (!cancelled) setPreviewText(rendered);
		});
		return () => {
			cancelled = true;
		};
	}, [tab, text, readmeDir, readImage]);

	// ── Files packed ─────────────────────────────────────────────────────
	const references = useMemo(() => (typeof text === 'string' && readmePath ? readmeReferences(text, readmePath) : []), [text, readmePath]);
	const [tiles, setTiles] = useState<IReferenceTile[]>([]);

	useEffect(() => {
		let cancelled = false;
		void Promise.all(
			references.map(async (reference): Promise<IReferenceTile> => {
				// An image answers through the thumbnail read; anything else through the
				// text read, where only a null is absence (a read that fails is a file that is there).
				const src = reference.isImage ? await readImage(reference.relPath) : null;
				const present = src !== null || (await host.readFile(reference.relPath).catch(() => '')) !== null;
				return { ...reference, src, missing: !present };
			})
		).then((resolved) => {
			if (!cancelled) setTiles(resolved);
		});
		return () => {
			cancelled = true;
		};
	}, [references, host, readImage]);

	const dropReference = useCallback(
		(reference: IReadmeReference): void => {
			if (typeof text !== 'string') return;
			const next = removeReference(text, reference.ref);
			if (next !== text) editText(next);
		},
		[text, editText]
	);

	/** The Width field: a number rewrites that reference to an `<img>` with `width="N"`; empty removes the attribute. */
	const setWidth = useCallback(
		(reference: IReadmeReference, raw: string): void => {
			if (typeof text !== 'string') return;
			const parsed = raw.trim() === '' ? null : Number(raw);
			if (parsed !== null && !(Number.isFinite(parsed) && parsed > 0)) return;
			const next = setReferenceWidth(text, reference.ref, parsed);
			if (next !== text) editText(next);
		},
		[text, editText]
	);

	const missingCount = tiles.filter((tile) => tile.missing).length;

	// =====================================================================
	// RENDER
	// =====================================================================

	const iconMeta = icon === null ? (
		<div style={styles.iconMeta}>Reading the icon…</div>
	) : icon.src ? (
		<div style={styles.iconMeta}>
			<span style={styles.mono}>{posixBasename(iconPath)}</span> · {formatBytes(icon.bytes)}
			<br />
			Shown on the store card and the sidebar. SVG or PNG, square, up to 256 KB.
			{!readonly && (
				<>
					{' '}
					<Button variant="ghost" small onClick={() => void pickIcon()}>Change</Button>
					{' · '}
					<Button variant="ghost" small onClick={removeIcon}>Remove</Button>
				</>
			)}
		</div>
	) : iconPath ? (
		<div style={styles.iconMeta}>
			<span style={styles.mono}>{posixBasename(iconPath)}</span> is declared but missing beside the {words.noun}: the store card shows {words.glyph}.
			{!readonly && (
				<>
					{' '}Click the tile or drop an SVG or PNG on it. <Button variant="ghost" small onClick={removeIcon}>Remove</Button>
				</>
			)}
		</div>
	) : (
		<div style={styles.iconMeta}>No icon yet: the store card shows {words.glyph}.{!readonly && ' Click the tile or drop an SVG or PNG on it.'}</div>
	);

	const tileStyle: CSSProperties = {
		...styles.tile,
		...(icon?.src ? {} : styles.tileEmpty),
		...(iconFocus ? styles.tileFocus : {}),
		...(iconDrop ? styles.tileDrop : {}),
		...(readonly ? { cursor: 'default' } : {}),
	};

	const editor =
		text === undefined ? (
			<div style={styles.help}>Reading the README…</div>
		) : text === null && readProblem !== null ? (
			<div style={styles.emptyReadme}>
				<span style={styles.mono}>{posixBasename(readmePath)}</span> is declared but could not be read: {readProblem}
			</div>
		) : text === null ? (
			<div style={styles.emptyReadme}>
				No README yet. The store page is empty until there is one.
				{!readonly && (
					<>
						<div style={styles.emptyAction}>
							<Button variant="primary" small onClick={() => void writeReadme()}>Write the README</Button>
						</div>
						<div style={styles.note}>
							Creates <span style={styles.mono}>{posixBasename(readmePath || DEFAULT_README_PATH)}</span> with the {words.noun}&rsquo;s name as the title and opens it here.
						</div>
					</>
				)}
			</div>
		) : (
			<div style={styles.editor}>
				<TabControl
					menu={README_TABS}
					activeId={tab}
					onSelect={(id) => setTab(id === 'edit' ? 'edit' : 'preview')}
					trailing={
						<div style={styles.tools}>
							{!readonly && <Button variant="secondary" small onClick={() => void insertImage()}>Insert image</Button>}
							{host.openFile && <Button variant="ghost" small onClick={openInEditor}>Open in editor</Button>}
						</div>
					}
				/>
				{tab === 'edit' ? (
					<div style={styles.sourceWrap}>
						{/* Raw element: the shell has no textarea control (rule: shell controls first). */}
						<textarea
							ref={textareaRef}
							style={{ ...styles.textarea, ...(textDrop ? styles.textareaDrop : {}) }}
							value={text}
							readOnly={readonly}
							spellCheck={false}
							aria-label="README source"
							onChange={(event) => editText(event.target.value)}
							onDragOver={(event) => {
								event.preventDefault();
								if (!textDrop) setTextDrop(true);
							}}
							onDragLeave={() => setTextDrop(false)}
							onDrop={(event) => void onTextDrop(event)}
							onPaste={(event) => void onTextPaste(event)}
						/>
						{!readonly && <div style={styles.dropHint}>Drop an image here to insert it</div>}
					</div>
				) : (
					<div style={styles.preview}>
						<MarkdownRenderer content={previewText} />
					</div>
				)}
				<div style={styles.foot}>
					{dirty ? <span style={styles.footDirty}>● Unsaved</span> : <span>Saved</span>}
					{saveFailed && !readonly && (
						<Button variant="ghost" small onClick={retrySave}>Retry</Button>
					)}
					<span>·</span>
					<span>
						{posixBasename(readmePath || DEFAULT_README_PATH)} · {lineCount(text)} {lineCount(text) === 1 ? 'line' : 'lines'}
					</span>
					<span style={styles.footRight}>{tab === 'edit' ? `Saved to ${posixBasename(readmePath || DEFAULT_README_PATH)} as you type` : 'This is what the store page shows'}</span>
				</div>
			</div>
		);

	return (
		<div>
			<div style={styles.label}>Icon</div>
			<div style={styles.iconRow}>
				<div
					role="button"
					tabIndex={readonly ? -1 : 0}
					aria-label={icon?.src ? 'Change the icon' : 'Add an icon'}
					title={readonly ? undefined : 'Click to choose an SVG or PNG; drop or paste one here'}
					style={tileStyle}
					onClick={() => void pickIcon()}
					onKeyDown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							void pickIcon();
						}
					}}
					onMouseEnter={() => setIconHover(true)}
					onMouseLeave={() => setIconHover(false)}
					onFocus={() => setIconFocus(true)}
					onBlur={() => setIconFocus(false)}
					onDragOver={(event) => {
						event.preventDefault();
						if (!iconDrop) setIconDrop(true);
					}}
					onDragLeave={() => setIconDrop(false)}
					onDrop={(event) => void onIconDrop(event)}
					onPaste={(event) => void onIconPaste(event)}
				>
					{icon?.src ? <img src={icon.src} alt="" style={styles.tileImage} /> : <span>{readonly ? 'No icon' : 'Add icon'}</span>}
					{icon?.src && iconHover && !readonly && <div style={styles.tileHover}>Change</div>}
				</div>
				{iconMeta}
			</div>

			<div style={styles.label}>README</div>
			{editor}
			{notice && <div style={styles.problem}>{notice}</div>}

			{typeof text === 'string' && (
				<div style={styles.files}>
					<div style={styles.label}>Images</div>
					{tiles.length > 0 && (
						<div style={styles.thumbs}>
							{tiles.map((tile) => (
								<div key={tile.relPath} style={styles.thumb}>
									<div style={{ ...styles.thumbPic, ...(tile.missing ? styles.thumbPicMissing : {}) }}>{tile.missing ? 'missing' : tile.src ? <img src={tile.src} alt="" style={styles.thumbImage} /> : posixBasename(tile.relPath)}</div>
									<div style={{ ...styles.thumbName, ...(tile.missing ? styles.thumbNameMissing : {}) }}>
										<span style={styles.thumbPath} title={tile.relPath}>{tile.relPath}</span>
										{!readonly && (
											<Button variant="ghost" small title={`Remove the reference to ${tile.relPath} from the README (the file stays)`} ariaLabel={`Remove the reference to ${tile.relPath} from the README`} onClick={() => dropReference(tile)}>
												✕
											</Button>
										)}
									</div>
									{tile.isImage && (
										<label style={styles.thumbWidth}>
											<span>Width</span>
											<InputField
												type="number"
												min={1}
												step={1}
												placeholder="auto"
												readOnly={readonly}
												aria-label={`Display width of ${tile.relPath} in pixels`}
												style={styles.thumbWidthInput}
												value={typeof text === 'string' ? (referenceWidth(text, tile.ref) ?? '') : ''}
												onChange={(event) => setWidth(tile, event.target.value)}
											/>
											<span>px</span>
										</label>
									)}
								</div>
							))}
						</div>
					)}
					<div style={styles.note}>{words.packedNote(tiles.length, missingCount)}</div>
				</div>
			)}
		</div>
	);
};

AssetsPane.displayName = 'AssetsPane';
