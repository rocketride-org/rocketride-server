// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CATALOG PICKER — the one catalog of apps and agents, for every host
// =============================================================================
//
// The category pills, the entries as a grid of cards or a list of rows, and
// the detail panel an entry opens (README, API, parameters, a source's
// endpoint dialog). home-ui's store and hello-ui's catalog both mount this;
// neither draws a second one.
//
// What the picker owns: the catalog read (`rrext_public_catalog`), the
// category filter, an entry's action (sign in, open, subscribe, add to the
// desktop) and the detail panel. What the HOST owns: everything around it
// (navigation, a heading, the grid/list toggle, a footer), the colours
// (`palette`; none = the shell theme), how a sign-in is asked for, and what
// it records of the viewer's actions (`onEvent`).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getShellApi } from 'shell';
import type { AppManifestEntry } from 'shell';
import { AppDetailPanel } from './AppDetailPanel';
import { AppListRowSkeleton } from './AppListRowSkeleton';
import { CatalogBody } from './CatalogBody';
import { CategoryFilter } from './CategoryFilter';
import { isAgentEntry, isAnonymousEntry, launchEntry, type LaunchSurface } from './agentEntry';
import { formatCategory } from './formatCategory';
import { SHELL_PALETTE, type CatalogView, type ICatalogPalette } from './palette';
import { useCatalogApps } from './useCatalogApps';

// Shell runtime access flows through the single curated contract accessor.
// The launch rule (switchAppRequestOf) postdates the shell contract a host
// may run: an optional capability, read by agentEntry.launchEntry.
const shellApi = getShellApi() as ReturnType<typeof getShellApi> & LaunchSurface;
const { ConnectionManager } = shellApi;

// =============================================================================
// CONSTANTS
// =============================================================================

/** The entrance of the catalog body, defined here so the picker needs no host stylesheet. */
const KEYFRAMES =
	'@keyframes rr-fade-up{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}' +
	'@keyframes rr-placeholder-pulse{from{opacity:0.14}to{opacity:0.30}}';

// =============================================================================
// TYPES
// =============================================================================

/** What the viewer did, for a host that records it. */
export type CatalogEvent =
	/** An entry's detail was opened. */
	| { type: 'view'; appId: string }
	/** A signed-out viewer asked for an entry: the host's sign-in follows. */
	| { type: 'signin'; appId: string }
	/** The viewer asked to subscribe to an entry. */
	| { type: 'subscribe'; appId: string }
	/** The viewer added an entry to the desktop. */
	| { type: 'add'; appId: string };

/** Props for the {@link CatalogPicker}. */
export interface ICatalogPickerProps {
	/** The signed-in viewer; null or undefined while browsing signed out. */
	identity: unknown;
	/** Shell-compatibility filter sent to the catalog ('saas', 'oss', 'vscode'); omitted, every reachable entry is listed. */
	shell?: string;
	/** Grid of cards or list of rows (default 'grid'). The host owns the toggle. */
	view?: CatalogView;
	/** The colours and faces to draw with; omitted, the shell's theme. */
	palette?: ICatalogPalette;
	/** Entry ids never shown (the host launcher itself). */
	excludeIds?: readonly string[];
	/** Asks for a sign-in on behalf of an entry. Omitted, the shell's login request is emitted. */
	onSignIn?: (app: AppManifestEntry) => void;
	/** Told what the viewer did, for a host that records it. */
	onEvent?: (event: CatalogEvent) => void;
	/** Told when the first load settles and when it starts again, so a host can hold its own controls (the toggle) until then. */
	onReadyChange?: (ready: boolean) => void;
	/** Drawn under the entries once the first load settles (a host's own section). */
	footer?: React.ReactNode;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The catalog picker: the category pills, the entries in the host's view and
 * the detail panel an entry opens.
 *
 * @param props - {@link ICatalogPickerProps}.
 */
export const CatalogPicker: React.FC<ICatalogPickerProps> = ({ identity, shell, view = 'grid', palette, excludeIds, onSignIn, onEvent, onReadyChange, footer }) => {
	const t = palette ?? SHELL_PALETTE;
	const query = useMemo(() => (shell ? { shell } : undefined), [shell]);
	const { apps: catalogApps, loading, timedOut, failed, patchApp } = useCatalogApps(query);
	const cm = ConnectionManager.getInstance();

	const [activeCategory, setActiveCategory] = useState('all');

	// The width, only to tell the detail panel when it is the whole screen
	// (the body itself is one responsive grid at every width).
	const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 768);
	useEffect(() => {
		const onResize = () => setIsMobile(window.innerWidth <= 768);
		window.addEventListener('resize', onResize, { passive: true });
		return () => window.removeEventListener('resize', onResize);
	}, []);

	// Detail panel state
	// The entry the panel shows is the CATALOG's entry of that id, so a
	// subscription or a desktop change that lands while the panel is open
	// shows in it; the snapshot stands in once the entry has left the catalog
	// (the slide-out, a sign-out).
	const [detailSnapshot, setDetailApp] = useState<AppManifestEntry | null>(null);
	const detailApp = useMemo(() => (detailSnapshot ? (catalogApps.find((a) => a.id === detailSnapshot.id) ?? detailSnapshot) : null), [detailSnapshot, catalogApps]);
	const [panelOpen, setPanelOpen] = useState(false);
	// The clear that follows a close, so opening another entry inside the slide-out cancels it
	const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => { if (clearTimer.current) clearTimeout(clearTimer.current); }, []);
	// The entry just added, so the panel plays its one-shot success on the action
	const [justAddedId, setJustAddedId] = useState<string | null>(null);

	// -- Reveal gate ------------------------------------------------------------
	// The entries are shown once the catalog AND the first screenful of icons
	// AND the web font have arrived, in one cascade, instead of cards whose
	// icons and face settle a beat later. Each wait has a cap, so a slow or
	// missing asset never holds the picker on its placeholder.
	const [iconsReady, setIconsReady] = useState(false);
	const [fontReady, setFontReady] = useState(false);

	useEffect(() => {
		if (catalogApps.length === 0) return;
		let done = false;
		const finish = () => { if (!done) { done = true; setIconsReady(true); } };
		const urls = catalogApps.slice(0, 24).map((a) => a.icon).filter(Boolean) as string[];
		if (urls.length === 0) { finish(); return; }
		let remaining = urls.length;
		const tick = () => { remaining -= 1; if (remaining <= 0) finish(); };
		urls.forEach((src) => { const img = new Image(); img.onload = tick; img.onerror = tick; img.src = src; });
		const safety = setTimeout(finish, 600);
		return () => clearTimeout(safety);
	}, [catalogApps]);

	useEffect(() => {
		const ready = typeof document !== 'undefined' ? (document as Document).fonts?.ready : undefined;
		if (!ready || typeof ready.then !== 'function') { setFontReady(true); return; }
		let cancelled = false;
		void ready.then(() => { if (!cancelled) setFontReady(true); });
		const safety = setTimeout(() => { if (!cancelled) setFontReady(true); }, 800);
		return () => { cancelled = true; clearTimeout(safety); };
	}, []);

	// An empty catalog has no icons to wait for: the face alone unblocks the message
	const contentReady = !loading && fontReady && (catalogApps.length === 0 || iconsReady);
	const isInitialLoad = !timedOut && !contentReady;

	// The placeholder rows show only when the wait passes 160ms; a fast load skips them
	const [showSkeleton, setShowSkeleton] = useState(false);
	useEffect(() => {
		if (!isInitialLoad) { setShowSkeleton(false); return; }
		const id = setTimeout(() => setShowSkeleton(true), 160);
		return () => clearTimeout(id);
	}, [isInitialLoad]);

	useEffect(() => { onReadyChange?.(!isInitialLoad); }, [isInitialLoad, onReadyChange]);

	// -- The entries shown --------------------------------------------------------
	const shownApps = useMemo(() => {
		const excluded = new Set(excludeIds ?? []);
		return catalogApps.filter((a) => !excluded.has(a.id));
	}, [catalogApps, excludeIds]);

	// The categories the entries carry, by label
	const categories = useMemo(() => {
		const seen = new Map<string, string>();
		for (const a of shownApps) {
			for (const c of a.categories ?? []) {
				if (!seen.has(c)) seen.set(c, formatCategory(c));
			}
		}
		return [...seen.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
	}, [shownApps]);

	// A selected category no entry carries any more falls back to 'all' (a
	// sign-out drops entries, and with them possibly the only ones in it)
	useEffect(() => {
		if (activeCategory !== 'all' && !categories.some((c) => c.key === activeCategory)) setActiveCategory('all');
	}, [categories, activeCategory]);

	const filteredApps = useMemo(() => {
		if (activeCategory === 'all') return shownApps;
		return shownApps.filter((a) => a.categories?.includes(activeCategory));
	}, [shownApps, activeCategory]);

	// A signed-out viewer keeps only what an anonymous read answers: the panel
	// showing anything else closes with the session
	useEffect(() => {
		if (identity || !detailApp || isAnonymousEntry(detailApp)) return;
		setPanelOpen(false);
		setDetailApp(null);
	}, [identity, detailApp]);

	// -- Actions ---------------------------------------------------------------------
	const handleAppClick = useCallback((app: AppManifestEntry) => {
		onEvent?.({ type: 'view', appId: app.id });
		if (clearTimer.current) { clearTimeout(clearTimer.current); clearTimer.current = null; }
		setDetailApp(app);
		requestAnimationFrame(() => setPanelOpen(true));
	}, [onEvent]);

	const handleDetailClose = useCallback(() => {
		setPanelOpen(false);
		// The entry is cleared once the slide-out has played
		if (clearTimer.current) clearTimeout(clearTimer.current);
		clearTimer.current = setTimeout(() => { clearTimer.current = null; setDetailApp(null); }, 350);
	}, []);

	/** The action's label for an entry. Signed out, account flags left from an earlier session are ignored. */
	const getCtaLabel = useCallback((app: AppManifestEntry): string => {
		if (!identity) return 'Get App';
		if (app.onDesktop) return 'Open';
		const status = app.appStatus ?? 'free';
		if (status === 'unsubscribed') return 'Subscribe';
		return isAgentEntry(app) ? 'Get Agent' : 'Get App';
	}, [identity]);

	const handleCta = useCallback((app: AppManifestEntry) => {
		// Signed out: the click asks for a sign-in, whatever flags the entry carries
		const status = identity ? (app.appStatus ?? 'free') : 'auth';
		if (status === 'auth') {
			onEvent?.({ type: 'signin', appId: app.id });
			if (onSignIn) onSignIn(app);
			else cm.emit('shell:loginRequest', {});
			return;
		}
		if (status === 'past_due' || status === 'canceled') return;
		if (identity && app.onDesktop) {
			// An app opens by its id; an agent opens its host app bound to its address
			launchEntry(cm, shellApi, app);
			return;
		}
		if (status === 'unsubscribed') {
			onEvent?.({ type: 'subscribe', appId: app.id });
			cm.emit('shell:subscribe', { app });
			return;
		}
		// free, subscribed, trialing: onto the desktop. The flip is shown at once
		// (the entry drives the badge, the panel's snapshot its action) and
		// taken back when the server refuses.
		const client = cm.getClient();
		if (!client) return;
		onEvent?.({ type: 'add', appId: app.id });
		patchApp(app.id, { onDesktop: true });
		setDetailApp((prev) => (prev && prev.id === app.id ? { ...prev, onDesktop: true } : prev));
		setJustAddedId(app.id);
		window.setTimeout(() => setJustAddedId((id) => (id === app.id ? null : id)), 1800);
		client.call('rrext_app', { subcommand: 'desktop_add', appId: app.id }).catch((err: unknown) => {
			console.log('[CatalogPicker] desktop_add failed:', err);
			patchApp(app.id, { onDesktop: false });
			setDetailApp((prev) => (prev && prev.id === app.id ? { ...prev, onDesktop: false } : prev));
			setJustAddedId((id) => (id === app.id ? null : id));
		});
	}, [cm, patchApp, identity, onSignIn, onEvent]);

	return (
		<div style={{ fontFamily: t.font, color: t.textPri }}>
			<style>{KEYFRAMES}</style>

			{/* Category pills */}
			{!isInitialLoad && categories.length > 0 && (
				<div style={{ margin: '0 0 4px' }}>
					<CategoryFilter t={t} categories={categories} active={activeCategory} onChange={setActiveCategory} />
				</div>
			)}

			{/* The entries: placeholder rows on a slow load, a message when there are none */}
			{isInitialLoad ? (
				showSkeleton ? (
					<div style={{ paddingTop: 20 }}>
						{Array.from({ length: 6 }).map((_, i) => (
							<AppListRowSkeleton key={`skeleton-${i}`} t={t} index={i} />
						))}
					</div>
				) : null
			) : filteredApps.length === 0 ? (
				<p style={{ padding: '40px 0', color: t.textMuted, fontSize: 14, textAlign: 'center' }}>
					{(timedOut || failed) && catalogApps.length === 0 ? "Couldn't load the catalog." : activeCategory !== 'all' ? 'Nothing in this category.' : 'Nothing in the catalog yet.'}
				</p>
			) : (
				<CatalogBody apps={filteredApps} t={t} view={view} onOpen={handleAppClick} getCtaLabel={getCtaLabel} onCta={handleCta} />
			)}

			{!isInitialLoad && footer}

			{/* The detail panel: slides in from the right, the whole screen when narrow */}
			<AppDetailPanel
				app={detailApp}
				t={t}
				open={panelOpen}
				onClose={handleDetailClose}
				ctaLabel={detailApp ? getCtaLabel(detailApp) : ''}
				justAdded={detailApp ? justAddedId === detailApp.id : false}
				onCta={handleCta}
				isMobile={isMobile}
			/>
		</div>
	);
};

export default CatalogPicker;
