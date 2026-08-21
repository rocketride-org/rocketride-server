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
// PACKAGE VIEW — is my app complete and buildable?
// =============================================================================

/**
 * The PACKAGE view: everything EVERY app needs regardless of the store —
 * identity (name, description), the icon and README assets (typed or
 * browsed, with preview), the include paths that make the build work (typed
 * or browsed), and the readiness box narrating whether the app is ready to
 * deploy and publish personally.
 * Commerce (mode, pricing, review) lives on the STORE tab; nothing here is
 * store-specific.
 *
 * Storage is the app's package.json appManifest via the same
 * loadListing/saveListing round-trip the STORE tab uses — files are truth.
 *
 * The whole view is ONE form (the record-panel footer pattern): edits stage
 * into a draft, and an anchored Save/Cancel bar materializes at the bottom
 * only while the draft diverges from the saved manifest. Cancel routes
 * through the stock discard confirm before reverting to the baseline.
 */

import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Banner } from 'shell';
import { Button } from 'shell';
import { Card } from 'shell';
import { ConfirmDialog } from 'shell';
import { EmptyState } from 'shell';
import { InputField } from 'shell';
import { Modal } from 'shell';
import type { AppSummary, IAppBuilderHost, ListingDraft, PreflightCheck } from './types';

// Lazy markdown renderer — the gallery's exact pattern (the renderer pulls
// syntax highlighting; loading it eagerly would bloat every tab switch).
const LazyMarkdown = React.lazy(() => import('shell').then((mod) => ({ default: mod.MarkdownRenderer })));

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link PackageView} component. */
export interface IPackageViewProps {
	/** The host adapter (data + actions). */
	host: IAppBuilderHost;
	/** The app being shown. */
	app: AppSummary;
}

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	// The view is one flex column: a scrolling content region above an
	// anchored footer bar — the footer never scrolls out of reach.
	wrap: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minHeight: 0,
	},
	scroll: {
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
	},
	head: {
		padding: '18px 26px 0',
	},
	h1: {
		fontSize: 20,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	},
	sub: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 3,
		lineHeight: 1.5,
	},
	grid: {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: 16,
		alignItems: 'start',
		margin: '16px 26px 30px',
		maxWidth: 1060,
	},
	col: {
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	},
	formRow: {
		marginBottom: 11,
	},
	formLabel: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		marginBottom: 4,
		textTransform: 'uppercase',
		letterSpacing: '0.03em',
	},
	formStatic: {
		background: 'var(--rr-bg-input)',
		border: '1px solid var(--rr-border)',
		borderRadius: 3,
		padding: '6px 10px',
		fontSize: 12,
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		color: 'var(--rr-text-primary)',
	},
	formArea: {
		background: 'var(--rr-bg-input)',
		border: '1px solid var(--rr-border)',
		borderRadius: 3,
		padding: '6px 10px',
		fontSize: 12.5,
		color: 'var(--rr-text-primary)',
		width: '100%',
		minHeight: 64,
		lineHeight: 1.5,
		resize: 'vertical',
		fontFamily: 'inherit',
	},
	actions: {
		display: 'flex',
		gap: 10,
		marginTop: 14,
		alignItems: 'center',
	},
	// The typecheck waiver checkbox: box + explanatory sentence in one label.
	checkRowLabel: {
		display: 'flex',
		gap: 8,
		alignItems: 'flex-start',
		cursor: 'pointer',
		fontSize: 12.5,
	},
	checkRowText: {
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.5,
	},
	actionNote: {
		fontSize: 11.5,
		color: 'var(--rr-text-disabled)',
	},
	// ── Anchored form footer (DetailPanel's footer grammar, view gutters) ──
	// Materializes only while the draft diverges from the saved manifest:
	// note left, verbs right, divided from the scrolling content above.
	footer: {
		flex: 'none',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		gap: 8,
		padding: '12px 26px',
		borderTop: '1px solid var(--rr-border)',
	},
	footerNote: {
		marginRight: 'auto',
		fontSize: 11.5,
		color: 'var(--rr-text-disabled)',
	},
	// ── Asset rows (icon / readme) ─────────────────────────────────────────
	assetRow: {
		display: 'flex',
		gap: 8,
		alignItems: 'center',
	},
	// The flex slot every editable path input sits in (asset + include rows).
	pathInput: {
		flex: 1,
	},
	// Asset paths are typed directly — mono type, matching the App ID box.
	assetInput: {
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		fontSize: 12,
	},
	iconPreview: {
		width: 44,
		height: 44,
		borderRadius: 9,
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-surface-alt)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		overflow: 'hidden',
		flexShrink: 0,
	},
	iconImg: {
		width: 36,
		height: 36,
		objectFit: 'contain',
	},
	iconGlyph: {
		fontSize: 10,
		color: 'var(--rr-text-disabled)',
	},
	// ── Include paths editor ───────────────────────────────────────────────
	includeRow: {
		display: 'flex',
		gap: 8,
		alignItems: 'center',
		marginBottom: 6,
	},
	includeHint: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.5,
		marginBottom: 8,
	},
	// ── Readiness ──────────────────────────────────────────────────────────
	readyLead: {
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		lineHeight: 1.6,
		marginBottom: 8,
	},
	checkRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '6px 0',
		fontSize: 12.5,
		borderTop: '1px solid var(--rr-bg-widget-header)',
	},
	checkRowFirst: {
		borderTop: 'none',
	},
	checkMark: {
		width: 16,
		height: 16,
		borderRadius: '50%',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 10,
		fontWeight: 800,
		flexShrink: 0,
	},
	checkText: {
		flex: 1,
		color: 'var(--rr-text-primary)',
	},
	checkNote: {
		color: 'var(--rr-text-disabled)',
		fontSize: 11.5,
		maxWidth: '55%',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	// README modal body.
	readmeBody: {
		maxHeight: '60vh',
		overflowY: 'auto',
	},
};

// Check-mark palettes per state (StoreView's exact grammar).
const CHECK_PALETTE: Record<PreflightCheck['state'], { bg: string; fg: string; glyph: string }> = {
	pass: { bg: 'rgba(34,153,84,0.14)', fg: 'var(--rr-color-success)', glyph: '✓' },
	warn: { bg: 'rgba(232,185,49,0.18)', fg: 'var(--rr-color-warning)', glyph: '!' },
	fail: { bg: 'rgba(244,67,54,0.14)', fg: 'var(--rr-color-error)', glyph: '✕' },
};

// =============================================================================
// README IMAGE RESOLUTION
// =============================================================================

/**
 * POSIX dirname of an app-relative path ('' for a root-level file).
 *
 * @param relPath - The './'-prefixed app-relative path.
 * @returns The containing directory, app-relative, without a trailing slash.
 */
function relDirname(relPath: string): string {
	const clean = relPath.replace(/^\.\//, '');
	const idx = clean.lastIndexOf('/');
	return idx === -1 ? '' : clean.slice(0, idx);
}

/**
 * Resolve a document-relative reference against the README's own directory,
 * collapsing '.'/'..' segments — always returning an app-relative path.
 *
 * @param dir - The README's directory (app-relative, '' for root).
 * @param ref - The reference as written in the markdown.
 * @returns The app-relative path of the referenced file.
 */
function resolveAgainst(dir: string, ref: string): string {
	const parts = `${dir}/${ref}`.split('/').filter((p) => p && p !== '.');
	const out: string[] = [];
	for (const part of parts) {
		if (part === '..') out.pop();
		else out.push(part);
	}
	return out.join('/');
}

/**
 * Whether a markdown reference is relative to the document — external URLs,
 * absolute paths, anchors, and already-inline data: URIs pass through.
 *
 * @param ref - The reference as written in the markdown.
 * @returns True when the reference should resolve against the README's dir.
 */
function isRelativeRef(ref: string): boolean {
	return !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(ref);
}

/** Total inlined-image characters one README render may produce. Base64 is
 *  about 1.37x the raw bytes, so this admits roughly 17 MiB of images. */
const MAX_INLINED_README_CHARS = 24 * 1024 * 1024;

/**
 * Inline every document-relative image in the markdown as a data: URI.
 * The webview has no filesystem, so a relative src would resolve against
 * the WEBVIEW origin and 404 — references must resolve against where the
 * README actually lives (e.g. `./assets/x.png` beside `./src/README.md`
 * is `src/assets/x.png` in the app folder).
 *
 * @param text - The raw markdown.
 * @param readmeRel - The README's app-relative path (the resolution base).
 * @param readImage - Host reader returning a data: URI (null = unservable).
 * @returns The markdown with resolvable relative images inlined; images
 *          that cannot be read keep their original reference.
 */
async function inlineReadmeImages(
	text: string,
	readmeRel: string,
	readImage: (relPath: string) => Promise<string | null>,
): Promise<string> {
	const dir = relDirname(readmeRel);
	// Collect the unique relative refs from both image syntaxes (markdown
	// and raw HTML — the renderer accepts both).
	const refs = new Set<string>();
	for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) refs.add(match[1]);
	for (const match of text.matchAll(/<img[^>]*\ssrc=["']([^"']+)["']/gi)) refs.add(match[1]);
	// Resolve each through the host, bounded — a pathological README must
	// not fan out unbounded RPCs.
	const inlined = new Map<string, string>();
	let budget = 24;
	// Cumulative size budget for ONE render. The host's per-image cap bounds
	// a single screenshot; it does not stop a README with several large ones
	// from producing tens of MiB of base64 that crosses the message channel
	// and stays resident in the rendered markdown. Once this is spent the
	// remaining refs keep their original src (renders broken, which is
	// honest) rather than growing the payload further.
	let spent = 0;
	for (const ref of refs) {
		if (!isRelativeRef(ref) || budget-- <= 0) continue;
		try {
			const uri = await readImage(resolveAgainst(dir, ref));
			if (uri) {
				if (spent + uri.length > MAX_INLINED_README_CHARS) break;
				spent += uri.length;
				inlined.set(ref, uri);
			}
		} catch {
			// Unreadable image: the original reference stays (renders broken,
			// which is honest — the file is genuinely missing).
		}
	}
	if (inlined.size === 0) return text;
	// Swap the refs in place, syntax-aware so titles/attributes survive.
	return text
		.replace(/(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (m, pre: string, ref: string, post: string) => (inlined.has(ref) ? `${pre}${inlined.get(ref)}${post}` : m))
		.replace(/(<img[^>]*\ssrc=["'])([^"']+)(["'])/gi, (m, pre: string, ref: string, post: string) => (inlined.has(ref) ? `${pre}${inlined.get(ref)}${post}` : m));
}

// =============================================================================
// DIRTY COMPARE
// =============================================================================

/**
 * Canonical compare form of the fields THIS view edits, defaults applied —
 * so a toggle round-trip (undefined -> true) never reads as a change and
 * store-only fields (mode, plans) never dirty the package form.
 *
 * @param d - The draft to canonicalize.
 * @returns A stable JSON string for equality comparison.
 */
function packageFields(d: ListingDraft): string {
	return JSON.stringify({
		name: d.name ?? '',
		description: d.description ?? '',
		typecheck: d.typecheck !== false,
		icon: d.icon ?? '',
		readme: d.readme ?? '',
		include: d.include ?? [],
	});
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the PACKAGE view: identity + assets + include paths + readiness.
 *
 * @param props - See {@link IPackageViewProps}.
 */
export const PackageView: React.FC<IPackageViewProps> = ({ host, app }) => {
	// ── Data — loaded through the host adapter ───────────────────────────
	const [draft, setDraft] = useState<ListingDraft | null>(null);
	// The saved manifest the draft was seeded from — the dirty compare's
	// baseline and Cancel's revert target (ProfilePanel's exact model).
	const [saved, setSaved] = useState<ListingDraft | null>(null);
	const [checks, setChecks] = useState<PreflightCheck[]>([]);
	// SVG markup (text path) or a complete data: URI (raster path).
	const [iconPreview, setIconPreview] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	// Footer-Cancel discard confirm (the standard's guard before reverting).
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	// README viewer: null = closed; string = the file's content, which may
	// legitimately be empty — loading is tracked separately so an empty
	// README does not read as the loading sentinel and hang the modal.
	const [readmeText, setReadmeText] = useState<string | null>(null);
	const [readmeLoading, setReadmeLoading] = useState(false);

	/** Load the icon preview for a manifest-relative icon path (null on any
	 *  failure — the preview slot then shows its 'none' glyph).
	 *
	 *  Raster icons (png/jpg/gif/webp — the picker and the platform accept
	 *  all of them) go through the IMAGE reader, which returns a complete
	 *  data: URI; the text reader would corrupt their bytes. SVG stays on
	 *  the text path so the markup can be inlined verbatim. */
	const loadIcon = useCallback(
		async (rel: string | undefined): Promise<void> => {
			if (rel) {
				const isSvg = rel.toLowerCase().endsWith('.svg');
				const read = isSvg ? host.readAppTextFile : host.readAppImageDataUri;
				if (read) {
					try {
						setIconPreview(await read(rel));
						return;
					} catch {
						// Unreadable icon: fall through to the empty preview.
					}
				}
			}
			setIconPreview(null);
		},
		[host]
	);

	/** Load the manifest draft + readiness checks, then the icon preview.
	 *  Seeds BOTH the draft and the dirty baseline from the saved manifest. */
	const refresh = useCallback(async (): Promise<void> => {
		setError('');
		try {
			const [d, c] = await Promise.all([
				host.loadListing?.() ?? Promise.resolve(null),
				host.runPreflight?.() ?? Promise.resolve([]),
			]);
			const loaded = d ?? { appId: app.id, mode: 'free' as const, name: app.name, description: app.description ?? '', plans: [], icon: '', readme: '', include: [] };
			setDraft(loaded);
			setSaved(loaded);
			setChecks(c);
			// Icon preview: SVG is text — read it and render as a data URI.
			await loadIcon(d?.icon);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [host, app.id, app.name, app.description, loadIcon]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	/** Persist the WHOLE form (identity + assets + include), then re-check —
	 *  the refresh re-seeds the baseline, so the footer dematerializes. */
	const onSave = useCallback(async (): Promise<void> => {
		if (!draft || !host.saveListing) return;
		setSaving(true);
		setError('');
		try {
			await host.saveListing(draft);
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}, [draft, host, refresh]);

	/** Confirmed discard: revert the draft to the saved baseline, restoring
	 *  the icon preview to the baseline's icon. */
	const onDiscard = useCallback((): void => {
		setConfirmDiscard(false);
		if (!saved) return;
		setDraft(saved);
		setError('');
		void loadIcon(saved.icon);
	}, [saved, loadIcon]);

	/** Browse for an asset and stage the picked app-relative path. */
	const onPick = useCallback(
		async (kind: 'icon' | 'readme'): Promise<void> => {
			if (!host.pickAppFile) return;
			setError('');
			try {
				const rel = await host.pickAppFile(kind);
				if (rel === null) return; // canceled
				setDraft((d) => (d ? { ...d, [kind]: rel } : d));
				if (kind === 'icon') await loadIcon(rel);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[host, loadIcon]
	);

	/** Browse for an include folder or file and stage the workspace-relative
	 *  pick into the given row. */
	const onPickInclude = useCallback(
		async (idx: number): Promise<void> => {
			if (!host.pickIncludePath) return;
			setError('');
			try {
				const rel = await host.pickIncludePath();
				if (rel === null) return; // canceled
				setDraft((d) => (d ? { ...d, include: (d.include ?? []).map((p, i) => (i === idx ? rel : p)) } : d));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[host]
	);

	/** Open the README viewer with the file's rendered markdown — relative
	 * images resolved against the README's OWN directory and inlined. */
	const onViewReadme = useCallback(async (): Promise<void> => {
		if (!draft?.readme || !host.readAppTextFile) return;
		setReadmeText('');
		setReadmeLoading(true);
		try {
			const raw = await host.readAppTextFile(draft.readme);
			setReadmeText(host.readAppImageDataUri ? await inlineReadmeImages(raw, draft.readme, host.readAppImageDataUri) : raw);
		} catch (e) {
			setReadmeText(`Could not read ${draft.readme}: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setReadmeLoading(false);
		}
	}, [draft, host]);

	// ── Readiness: the package tier narrated ─────────────────────────────
	const packageChecks = useMemo(() => checks.filter((c) => (c.tier ?? 'package') === 'package'), [checks]);
	const failing = packageChecks.filter((c) => c.state === 'fail').length;
	const warning = packageChecks.filter((c) => c.state === 'warn').length;
	const readyLead =
		failing > 0
			? `${failing} item${failing === 1 ? ' needs' : 's need'} fixing before this app is complete — the build or publish would refuse it as-is.`
			: warning > 0
				? `Everything required is in place — you can deploy and publish this app to your desktop or a team. ${warning} optional item${warning === 1 ? '' : 's'} would polish it.`
				: 'Everything is in place — deploy it and publish to your desktop or a team whenever you like.';

	// Icon preview source: the raster reader already returns a data: URI;
	// SVG arrives as markup and is inlined here.
	const iconUri = iconPreview ? (iconPreview.startsWith('data:') ? iconPreview : `data:image/svg+xml;utf8,${encodeURIComponent(iconPreview)}`) : null;

	// Dirty flag: any edited field differs from the saved baseline. Drives
	// the materializing footer bar and gates the discard confirm.
	const dirty = draft !== null && saved !== null && packageFields(draft) !== packageFields(saved);

	// =====================================================================
	// RENDER
	// =====================================================================

	return (
		<div style={styles.wrap}>
			{/* Scrolling content region — every card lives here; only the
			    footer bar below stays anchored. */}
			<div style={styles.scroll}>
				{/* View header — title + one-line purpose */}
				<div style={styles.head}>
					<div style={styles.h1}>{app.name}</div>
					<div style={styles.sub}>Package — everything this app needs to build, deploy, and publish personally: identity, icon, README, and the workspace paths it ships with. Store-only concerns (pricing, review) live on the Store tab.</div>
				</div>

				{error ? (
					<div style={{ margin: '16px 26px 0', maxWidth: 1060 }}>
						<Banner variant="error">{error}</Banner>
					</div>
				) : null}

				<div style={styles.grid}>
					{/* ── Left: identity + assets ─────────────────────────────── */}
					<div style={styles.col}>
						<Card header="Identity">
							<div style={styles.formRow}>
								<div style={styles.formLabel}>App ID</div>
								<div style={styles.formStatic}>{draft?.appId ?? app.id}</div>
							</div>
							<div style={styles.formRow}>
								<div style={styles.formLabel}>Display name</div>
								<InputField value={draft?.name ?? ''} onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))} />
							</div>
							<div style={styles.formRow}>
								<div style={styles.formLabel}>Description</div>
								<textarea style={styles.formArea} value={draft?.description ?? ''} onChange={(e) => setDraft((d) => (d ? { ...d, description: e.target.value } : d))} />
							</div>
							<div style={styles.formRow}>
								<div style={styles.formLabel}>Strict type checking</div>
								<label style={styles.checkRowLabel}>
									<input
										type="checkbox"
										checked={draft?.typecheck !== false}
										onChange={(e) => setDraft((d) => (d ? { ...d, typecheck: e.target.checked } : d))}
									/>
									<span style={styles.checkRowText}>The server verifies the app with your own tsconfig before building — turning this off deploys even with type errors.</span>
								</label>
							</div>
						</Card>

						<Card header="Assets">
							<div style={styles.formRow}>
								<div style={styles.formLabel}>Icon (SVG)</div>
								<div style={styles.assetRow}>
									<div style={styles.iconPreview}>
										{iconUri ? <img style={styles.iconImg} src={iconUri} alt="App icon" /> : <span style={styles.iconGlyph}>none</span>}
									</div>
									<div style={styles.pathInput}>
										{/* Typed path, app-folder-relative; the preview reloads
										    once the field settles (blur), not per keystroke. */}
										<InputField
											style={styles.assetInput}
											value={draft?.icon ?? ''}
											placeholder="./src/icon.svg"
											onChange={(e) => setDraft((d) => (d ? { ...d, icon: e.target.value } : d))}
											onBlur={() => void loadIcon(draft?.icon)}
										/>
									</div>
									{host.pickAppFile && (
										<Button variant="secondary" small onClick={() => void onPick('icon')}>Browse</Button>
									)}
								</div>
							</div>
							<div style={styles.formRow}>
								<div style={styles.formLabel}>README (Markdown)</div>
								<div style={styles.assetRow}>
									<div style={styles.pathInput}>
										<InputField
											style={styles.assetInput}
											value={draft?.readme ?? ''}
											placeholder="./src/README.md"
											onChange={(e) => setDraft((d) => (d ? { ...d, readme: e.target.value } : d))}
										/>
									</div>
									{host.pickAppFile && (
										<Button variant="secondary" small onClick={() => void onPick('readme')}>Browse</Button>
									)}
									{draft?.readme && host.readAppTextFile ? (
										<Button variant="secondary" small onClick={() => void onViewReadme()}>View</Button>
									) : null}
								</div>
							</div>
						</Card>
					</div>

					{/* ── Right: readiness + include paths ───────────────────── */}
					<div style={styles.col}>
						<Card header="Readiness">
							{packageChecks.length === 0 ? (
								<EmptyState title="No checks yet" description="Readiness runs against the app's manifest once it loads." />
							) : (
								<>
									<div style={styles.readyLead}>{readyLead}</div>
									{packageChecks.map((c, i) => (
										<div key={c.id} style={i === 0 ? { ...styles.checkRow, ...styles.checkRowFirst } : styles.checkRow}>
											<div style={{ ...styles.checkMark, background: CHECK_PALETTE[c.state].bg, color: CHECK_PALETTE[c.state].fg }}>{CHECK_PALETTE[c.state].glyph}</div>
											<div style={styles.checkText}>{c.label}</div>
											{c.note ? <div style={styles.checkNote} title={c.note}>{c.note}</div> : null}
										</div>
									))}
								</>
							)}
						</Card>

						<Card header="Include paths">
							<div style={styles.includeHint}>Workspace directories or files your app imports beyond its own folder (for example <code>apps/shared</code>). They are packed into every deploy and installed by the server build — a missing one fails the build.</div>
							{(draft?.include ?? []).map((entry, idx) => (
								<div key={idx} style={styles.includeRow}>
									<div style={styles.pathInput}>
										<InputField
											value={entry}
											placeholder="apps/shared"
											onChange={(e) => setDraft((d) => (d ? { ...d, include: (d.include ?? []).map((p, i) => (i === idx ? e.target.value : p)) } : d))}
										/>
									</div>
									{host.pickIncludePath && (
										<Button variant="secondary" small onClick={() => void onPickInclude(idx)}>Browse</Button>
									)}
									<Button variant="secondary" small onClick={() => setDraft((d) => (d ? { ...d, include: (d.include ?? []).filter((_, i) => i !== idx) } : d))}>Remove</Button>
								</div>
							))}
							<div style={styles.actions}>
								<Button variant="secondary" small onClick={() => setDraft((d) => (d ? { ...d, include: [...(d.include ?? []), ''] } : d))}>Add path</Button>
								<span style={styles.actionNote}>workspace-relative</span>
							</div>
						</Card>
					</div>
				</div>
			</div>

			{/* ── Anchored form footer (record-panel standard): materializes
			      only while the draft diverges from the saved manifest — Save
			      persists the WHOLE form, Cancel reverts via the discard
			      confirm. ─────────────────────────────────────────────────── */}
			{dirty && host.saveListing && (
				<div style={styles.footer}>
					<span style={styles.footerNote}>Saved to the app&rsquo;s package.json — the manifest is the truth; every deploy packs it.</span>
					<Button variant="primary" small onClick={() => void onSave()} disabled={saving}>
						{saving ? 'Saving…' : 'Save Package'}
					</Button>
					<Button variant="ghost" small onClick={() => setConfirmDiscard(true)} disabled={saving}>
						Cancel
					</Button>
				</div>
			)}

			{/* ── README viewer — rendered markdown in a wide modal ───────── */}
			{readmeText !== null && (
				<Modal
					title={`${draft?.readme ?? 'README'}`}
					width={Math.floor(window.innerWidth * 0.7)}
					onClose={() => setReadmeText(null)}
					footer={
						<Button variant="secondary" onClick={() => setReadmeText(null)}>Close</Button>
					}
				>
					<div style={styles.readmeBody}>
						{readmeLoading ? (
							'Loading…'
						) : (
							<Suspense fallback="Rendering…">
								<LazyMarkdown content={readmeText} />
							</Suspense>
						)}
					</div>
				</Modal>
			)}

			{/* ── Footer-Cancel discard guard — the stock confirm before the
			      draft reverts to the saved baseline. ───────────────────────── */}
			{confirmDiscard && (
				<ConfirmDialog
					title="Discard changes?"
					message="Your unsaved changes will be lost."
					confirmLabel="Discard"
					cancelLabel="Keep Editing"
					destructive
					onConfirm={onDiscard}
					onCancel={() => setConfirmDiscard(false)}
				/>
			)}
		</div>
	);
};
