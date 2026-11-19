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
 * The PACKAGE view (named-pipes mockups 1.3–1.8b): how the app is described,
 * built, listed and reviewed, as SIDE TABS — Identity (name, description),
 * Assets (the shared {@link AssetsPane}: the icon tile, the README edited in
 * place, the files it references — saved to the manifest as the pane
 * declares them, outside the form draft), Build (strict
 * type checking, the include paths that make the build work), Store (the
 * commerce card: mode, plans, requirements — {@link StoreView} embedded),
 * Requirements (the readiness checklist), and Review (the conversation with
 * the store review team, {@link ReviewView}). STORE stopped being a top-level
 * tab and DASHBOARD was retired on 2026-11-16.
 *
 * Storage is the app's package.json appManifest via the same
 * loadListing/saveListing round-trip the STORE tab uses — files are truth.
 *
 * The whole view is ONE form (the record-panel footer pattern): edits stage
 * into a draft, and an anchored Save/Cancel bar materializes at the bottom
 * only while the draft diverges from the saved manifest. Cancel routes
 * through the stock discard confirm before reverting to the baseline.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ViewMenu } from 'shell';
import { Banner } from 'shell';
import { Button } from 'shell';
import { Card } from 'shell';
import { ConfirmDialog } from 'shell';
import { EmptyState } from 'shell';
import { InputField } from 'shell';
import { SidebarMenu } from 'shell';
import { AssetsPane } from '../../../../../../components/assets';
import type { IAssetPaths, IAssetsHost } from '../../../../../../components/assets';
import { renderTemplate } from '../../../../templates';
import type { AppBuilderStage, AppSummary, IAppBuilderHost, ListingDraft, PreflightCheck } from '../../../../types';
import { ReviewView } from '../review/ReviewView';
import { StoreView } from '../store/StoreView';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link PackageView} component. */
export interface IPackageViewProps {
	/** The host adapter (data + actions). */
	host: IAppBuilderHost;
	/** The app being shown. */
	app: AppSummary;
	/** Namespace mismatch: the Store and Review side tabs render read-only. */
	readOnly?: boolean;
	/** Switch the builder to another stage — the Store tab's deploy handoff. */
	onNavigate?: (stage: AppBuilderStage) => void;
}

/** The PACKAGE side tabs, in page order (named-pipes mockups 1.3–1.8b). */
export type PackageSection = 'identity' | 'assets' | 'build' | 'store' | 'requirements' | 'review';

/** The side-tab menu. */
const SECTION_MENU: ViewMenu = {
	entries: [
		{ id: 'identity', label: 'Identity' },
		{ id: 'assets', label: 'Assets' },
		{ id: 'build', label: 'Build' },
		{ id: 'store', label: 'Store' },
		{ id: 'requirements', label: 'Requirements' },
		{ id: 'review', label: 'Review' },
	],
};

/** The prefs key holding the active side tab. */
const SECTION_PREF_KEY = 'packageSection';

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
	// The side-tab shell under the header: SidebarMenu left, the active
	// section's pane right (the Settings page's two-column idiom).
	body: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		alignItems: 'stretch',
	},
	nav: {
		width: 200,
		flexShrink: 0,
		borderRight: '1px solid var(--rr-border)',
		padding: '12px 8px',
		backgroundColor: 'var(--rr-bg-surface-alt)',
		overflowY: 'auto',
	},
	pane: {
		flex: 1,
		minWidth: 0,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
		overflowY: 'auto',
	},
	paneBody: {
		padding: '16px 26px 30px',
		maxWidth: 1060,
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	},
	paneFill: {
		flex: 1,
		minHeight: 0,
		padding: '16px 26px 20px',
		display: 'flex',
		flexDirection: 'column',
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
	// The flex slot the include-path input sits in.
	pathInput: {
		flex: 1,
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
};

// Check-mark palettes per state (StoreView's exact grammar).
const CHECK_PALETTE: Record<PreflightCheck['state'], { bg: string; fg: string; glyph: string }> = {
	pass: { bg: 'rgba(34,153,84,0.14)', fg: 'var(--rr-color-success)', glyph: '✓' },
	warn: { bg: 'rgba(232,185,49,0.18)', fg: 'var(--rr-color-warning)', glyph: '!' },
	fail: { bg: 'rgba(244,67,54,0.14)', fg: 'var(--rr-color-error)', glyph: '✕' },
};

// =============================================================================
// DIRTY COMPARE
// =============================================================================

/**
 * Canonical compare form of the fields THIS view edits, defaults applied —
 * so a toggle round-trip (undefined -> true) never reads as a change and
 * fields other panes own (mode, plans; the Assets pane's icon and readme)
 * never dirty the package form.
 *
 * @param d - The draft to canonicalize.
 * @returns A stable JSON string for equality comparison.
 */
function packageFields(d: ListingDraft): string {
	return JSON.stringify({
		name: d.name ?? '',
		description: d.description ?? '',
		typecheck: d.typecheck !== false,
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
export const PackageView: React.FC<IPackageViewProps> = ({ host, app, readOnly = false, onNavigate }) => {
	// ── Side tab — persisted like the stage, so the page reopens where it was ──
	const [section, setSection] = useState<PackageSection>(() => {
		const raw = host.getPref?.(SECTION_PREF_KEY);
		return SECTION_MENU.entries.some((e) => e.id === raw) ? (raw as PackageSection) : 'identity';
	});
	// Store mounts on its first visit and stays mounted (see the render).
	const [storeMounted, setStoreMounted] = useState(() => section === 'store');
	/** Switch side tabs and persist the selection. */
	const selectSection = (id: string): void => {
		setSection(id as PackageSection);
		if (id === 'store') setStoreMounted(true);
		host.setPref?.(SECTION_PREF_KEY, id);
	};

	// ── Data — loaded through the host adapter ───────────────────────────
	const [draft, setDraft] = useState<ListingDraft | null>(null);
	// The saved manifest the draft was seeded from — the dirty compare's
	// baseline and Cancel's revert target (ProfilePanel's exact model).
	const [saved, setSaved] = useState<ListingDraft | null>(null);
	const [checks, setChecks] = useState<PreflightCheck[]>([]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	// Footer-Cancel discard confirm (the standard's guard before reverting).
	const [confirmDiscard, setConfirmDiscard] = useState(false);

	/** Load the manifest draft + readiness checks. Seeds BOTH the draft and
	 *  the dirty baseline from the saved manifest. */
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
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [host, app.id, app.name, app.description]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	/** Persist the package form (identity + build), then re-check — the
	 *  refresh re-seeds the baseline, so the footer dematerializes. The Store
	 *  side tab saves the SAME listing (mode, plans) and the Assets pane its
	 *  paths (icon, readme), each through its own write, so this save sends
	 *  ONLY the form-owned fields and the writer leaves the rest as it is on
	 *  disk: a Store or Assets save made since this pane loaded survives an
	 *  Identity save, with no read-modify-write here. */
	const onSave = useCallback(async (): Promise<void> => {
		if (!draft || !host.saveListing) return;
		setSaving(true);
		setError('');
		try {
			// ONLY this form's fields: the writer leaves what the patch omits
			// (mode, plans, icon, readme) as it is on disk.
			await host.saveListing({ name: draft.name, description: draft.description, typecheck: draft.typecheck, include: draft.include });
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}, [draft, host, refresh]);

	/** Confirmed discard: revert the draft to the saved baseline. */
	const onDiscard = useCallback((): void => {
		setConfirmDiscard(false);
		if (!saved) return;
		setDraft(saved);
		setError('');
	}, [saved]);

	// ── Assets: the shared pane over the host's file ops ─────────────────
	// The pane needs the four file ops together; a host missing any of them
	// gets the empty state, never a half-working pane.
	const { readAppTextFile, readAppImageDataUri, writeAppFile, pickAssetFile, openAppFile } = host;
	const assetsHost = useMemo<IAssetsHost | undefined>(
		() =>
			readAppTextFile && readAppImageDataUri && writeAppFile && pickAssetFile
				? {
						// The text reader answers null for a missing file and rejects for
						// any other failure: the pane offers its stub only over a confirmed
						// absence, never over a file it could not read.
						readFile: readAppTextFile,
						readImageDataUri: readAppImageDataUri,
						writeFile: writeAppFile,
						pickFile: pickAssetFile,
						...(openAppFile ? { openFile: openAppFile } : {}),
					}
				: undefined,
		[readAppTextFile, readAppImageDataUri, writeAppFile, pickAssetFile, openAppFile]
	);

	/** The pane declared an icon or README path ('' = none): saved to the
	 *  manifest at once — the files are already on disk — through the same
	 *  patch path the form uses, then the draft AND its baseline take the
	 *  paths so an in-progress Identity edit is neither lost nor dirtied.
	 *  The save is awaited by the pane: a failure is the pane's notice, and
	 *  the pane keeps its state so the declaration can be retried. */
	const onAssetPaths = useCallback(
		async (patch: IAssetPaths): Promise<void> => {
			if (!host.saveListing) return;
			setError('');
			await host.saveListing(patch);
			setDraft((d) => (d ? { ...d, ...patch } : d));
			setSaved((s) => (s ? { ...s, ...patch } : s));
			try {
				setChecks(await (host.runPreflight?.() ?? Promise.resolve([])));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[host]
	);

	// "Write the README" writes the scaffold's own README; only its name
	// varies, so the template vars beyond it are placeholders.
	const appReadmeStub = useMemo(() => {
		const appName = draft?.name || app.name;
		return renderTemplate('Blank', { appId: app.id, appName, moduleId: app.moduleId, port: 0, previewUrl: '' }).find((file) => file.path === 'README.md')?.content ?? `# ${appName}\n`;
	}, [draft?.name, app.id, app.name, app.moduleId]);

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

	// ── Readiness: the package tier narrated ─────────────────────────────
	const packageChecks = useMemo(() => checks.filter((c) => (c.tier ?? 'package') === 'package'), [checks]);
	const failing = packageChecks.filter((c) => c.state === 'fail').length;
	const warning = packageChecks.filter((c) => c.state === 'warn').length;
	const readyLead =
		failing > 0
			? `${failing} item${failing === 1 ? ' needs' : 's need'} fixing before this app is complete. The build or publish would refuse it as-is.`
			: warning > 0
				? `Everything required is in place. You can deploy and publish this app to your desktop or a team. ${warning} optional item${warning === 1 ? '' : 's'} would polish it.`
				: 'Everything is in place. Deploy it and publish to your desktop or a team whenever you like.';

	// Dirty flag: any edited field differs from the saved baseline. Drives
	// the materializing footer bar and gates the discard confirm.
	const dirty = draft !== null && saved !== null && packageFields(draft) !== packageFields(saved);

	// =====================================================================
	// RENDER
	// =====================================================================

	// ── The side tabs' panes ─────────────────────────────────────────────
	// Identity and Build are two pages over ONE draft (the saved manifest):
	// the anchored Save/Cancel footer below serves both. Assets saves itself.
	const identityPane = (
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
		</Card>
	);

	const buildPane = (
		<>
			<Card header="Build">
				<div style={styles.formRow}>
					<div style={styles.formLabel}>Strict type checking</div>
					<label style={styles.checkRowLabel}>
						<input
							type="checkbox"
							checked={draft?.typecheck !== false}
							onChange={(e) => setDraft((d) => (d ? { ...d, typecheck: e.target.checked } : d))}
						/>
						<span style={styles.checkRowText}>The server verifies the app with your own tsconfig before building. Turning this off deploys even with type errors.</span>
					</label>
				</div>
			</Card>
			<Card header="Include paths">
				<div style={styles.includeHint}>Workspace directories or files your app imports beyond its own folder (for example <code>apps/shared</code>). They are packed into every deploy and installed by the server build. A missing one fails the build.</div>
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
						{/* ✕ ends a row of an editable list: nothing happens until Save. */}
						<Button variant="ghost" small title="Remove this path" aria-label={`Remove ${entry || 'this path'}`} onClick={() => setDraft((d) => (d ? { ...d, include: (d.include ?? []).filter((_, i) => i !== idx) } : d))}>✕</Button>
					</div>
				))}
				<div style={styles.actions}>
					<Button variant="secondary" small onClick={() => setDraft((d) => (d ? { ...d, include: [...(d.include ?? []), ''] } : d))}>Add path</Button>
					<span style={styles.actionNote}>workspace-relative</span>
				</div>
			</Card>
		</>
	);

	const requirementsPane = (
		<Card header="Requirements">
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
	);

	return (
		<div style={styles.wrap}>
			{/* View header — title + one-line purpose */}
			<div style={styles.head}>
				<div style={styles.h1}>{app.name}</div>
				<div style={styles.sub}>Package: how this app is described, built, listed and reviewed — its identity, assets and build settings, the store listing, the requirements checklist, and the conversation with the review team.</div>
			</div>

			{error ? (
				<div style={{ margin: '16px 26px 0', maxWidth: 1060 }}>
					<Banner variant="error">{error}</Banner>
				</div>
			) : null}

			{/* Side tabs left, the active pane right */}
			<div style={styles.body}>
				<nav style={styles.nav} aria-label="Package sections">
					<SidebarMenu menu={SECTION_MENU} activeId={section} onSelect={selectSection} collapsed={false} />
				</nav>
				<div style={styles.pane}>
					{section === 'identity' && <div style={styles.paneBody}>{identityPane}</div>}
					{section === 'build' && <div style={styles.paneBody}>{buildPane}</div>}
					{section === 'requirements' && <div style={styles.paneBody}>{requirementsPane}</div>}
					{/* Store is mounted on its first visit and KEPT mounted (hidden)
					    afterwards: its own draft (mode, staged plans) survives a
					    trip to another side tab instead of reloading the saved
					    listing and discarding the edits. */}
					{storeMounted && (
						<div style={{ display: section === 'store' ? 'contents' : 'none' }}>
							<StoreView host={host} app={app} readOnly={readOnly} onNavigate={onNavigate} embedded />
						</div>
					)}
					{section === 'review' && <div style={styles.paneFill}><ReviewView host={host} app={app} readOnly={readOnly} /></div>}
					{section === 'assets' && (
						<div style={styles.paneBody}>
							<Card header="Assets">
								{assetsHost && draft ? (
									<AssetsPane kind="app" host={assetsHost} docStem={app.id.split('.').pop() || 'app'} paths={{ icon: draft.icon ?? '', readme: draft.readme ?? '' }} onPathsChange={(patch) => void onAssetPaths(patch)} readmeStub={appReadmeStub} readonly={!host.saveListing} />
								) : (
									<EmptyState title="No files on this host" description="This host cannot reach the app folder, so the icon and README cannot be shown or edited here." />
								)}
							</Card>
						</div>
					)}
				</div>
			</div>

			{/* ── Anchored form footer (record-panel standard): materializes
			      only while the draft diverges from the saved manifest — Save
			      persists the WHOLE form, Cancel reverts via the discard
			      confirm. ─────────────────────────────────────────────────── */}
			{dirty && host.saveListing && (
				<div style={styles.footer}>
					<span style={styles.footerNote}>Saved to the app&rsquo;s package.json. The manifest is the truth; every deploy packs it.</span>
					<Button variant="primary" small onClick={() => void onSave()} disabled={saving}>
						{saving ? 'Saving…' : 'Save Package'}
					</Button>
					<Button variant="ghost" small onClick={() => setConfirmDiscard(true)} disabled={saving}>
						Cancel
					</Button>
				</div>
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
