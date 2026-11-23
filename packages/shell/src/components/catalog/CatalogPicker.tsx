// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CATALOG PICKER — the one catalog-to-desktop picker, both editions
// =============================================================================
//
// The catalog of apps and agents (published pipelines, plan 9.1) the caller
// can reach, each tile in one of three states: ON THE DESKTOP (Open), NOT
// YET (Add), or ADDING (the add is in flight). An agent opens its host app
// bound to its address and adds by that address; its row reads "Agent".
// It reads the catalog through `rrext_public_catalog`, adds through
// `rrext_app desktop_add`, and learns the desktop membership from the live
// identity (`useSubscriptions`), which the server refreshes after every
// desktop write — so the tile flips to Open without a re-fetch. There is no
// edition branch: OSS and SaaS answer the same two verbs with one shape
// (plan 9.1, Step 6b). hello-ui and home-ui both mount this; neither
// hand-rolls a second picker.
//
// The tiles wear the desktop card's visual grammar (52px icon chip, name +
// category, two-line description on the paper surface) so the catalog and
// the desktop read as one product; the bottom row carries the shell Button
// instead of the desktop card's version chip and remove affordance.
//
// A tile opens its entry's DETAIL: the shell's DetailPanel drawer with the
// icon, name and category in its header, the description, the publisher,
// the entry's README (fetched from the entry's `readme` path and rendered
// as markdown, relative images and links resolved against the README's
// folder) and the same Open / Add / Adding action in its footer. Every part
// stands on its own: a blank description hides nothing else.

import React, { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ConnectionManager } from '../../connection/connection';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useSubscriptions } from '../../hooks/useSubscriptions';
import { Button } from '../button/Button';
import { MarkdownRenderer } from '../chat/components/MarkdownRenderer';
import { DetailPanel } from '../detail-panel/DetailPanel';
import { EmptyState } from '../empty-state/EmptyState';
import { InputField } from '../input-field/InputField';
import { LabelValue, Section } from '../section/Section';
import type { AppManifestEntry } from '../workspace/types';
import { launchAgent } from '../../modules/desktop/adapter';
import { AGENT_LABEL, isAgent } from '../../modules/desktop/launch';
import { CATALOG_PAGE_LIMIT, fetchCatalogPages, fetchReadme, isReadmePath, readmeBaseUrl, reconcileAdded } from './catalogLogic';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Honor the OS "reduce motion" setting. */
const REDUCE_MOTION =
	typeof window !== 'undefined' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Max time to wait for the first catalog response before surfacing an error state. */
const CATALOG_TIMEOUT_MS = 5000;

/** Poll cadence while the connection is not yet attached. */
const CATALOG_RETRY_MS = 150;

/** Category ids whose display label is not a simple capitalisation. */
const CATEGORY_LABELS: Record<string, string> = {
	ai: 'AI',
	devtool: 'Dev Tool',
};

/**
 * Format a manifest category id for display.
 *
 * @param cat - Raw category id from the app manifest (e.g. "tools").
 * @returns Display label (e.g. "Tools").
 */
const formatCategory = (cat: string): string =>
	CATEGORY_LABELS[cat.toLowerCase()] ?? cat.charAt(0).toUpperCase() + cat.slice(1);

/**
 * The line under an entry's name: "Agent" for an agent whatever its
 * categories say (plan 9.1), else its first category.
 *
 * @param app - The catalog entry.
 * @returns The line, or null when an app names no category.
 */
const categoryOf = (app: AppManifestEntry): string | null =>
	isAgent(app) ? AGENT_LABEL : app.categories?.[0] ? formatCategory(app.categories[0]) : null;

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link CatalogPicker} component. */
export interface ICatalogPickerProps {
	/**
	 * Shell-compatibility filter sent to the catalog ('saas', 'oss',
	 * 'vscode'); omitted, every app the caller can reach is listed.
	 */
	shell?: string;
	/** App ids never shown (the host launcher itself, e.g. 'rocketride.hello'). */
	excludeIds?: string[];
	/**
	 * Launch handler for an APP tile that is already on the desktop. Default:
	 * emit `shell:switchApp` on the connection manager. An agent tile always
	 * opens its host app bound to its address (`shell:switchApp` with
	 * `params`): an app id alone cannot carry the binding.
	 */
	onLaunch?: (appId: string) => void;
	/** Called once the server accepted an add (the identity push follows). */
	onAdded?: (appId: string) => void;
	/** Heading above the grid (default 'Catalog'); an empty string hides it. */
	title?: string;
	/** Line under the heading (default 'Add apps and agents to your desktop.'). */
	subtitle?: string;
	/** Show the search field (default true). */
	showSearch?: boolean;
	/** Extra styles merged onto the root (padding/width belong to the host). */
	style?: CSSProperties;
}

/** An entry's state: 'desktop' → Open, 'adding' → disabled, 'available' → Add. */
type CatalogEntryState = 'desktop' | 'adding' | 'available';

/** An entry's README as the detail shows it. */
type ReadmeState =
	/** The fetch has not answered yet: the detail says the README is loading. */
	| { kind: 'loading' }
	/** The entry names no README, or its fetch found none. */
	| { kind: 'none' }
	/** The markdown, and the path it was fetched from. */
	| { kind: 'ready'; path: string; markdown: string };

/** One catalog load. */
interface CatalogState {
	apps: AppManifestEntry[];
	total: number;
	/** True until the first catalog response arrives. */
	loading: boolean;
	/** True when nothing arrived within CATALOG_TIMEOUT_MS. */
	timedOut: boolean;
	/**
	 * The catalog request's failure, when it failed — distinct from a
	 * successful empty response. Cleared by a reload.
	 */
	error: string | null;
}

// =============================================================================
// STYLES
// =============================================================================

const S = {
	/** Root column — centred content; the HOST supplies padding/background. */
	root: {
		display: 'flex',
		flexDirection: 'column' as const,
		alignItems: 'center',
		gap: 20,
		width: '100%',
		boxSizing: 'border-box' as const,
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	/** Header row — title/subtitle left, search right. */
	headerRow: {
		display: 'flex',
		width: '100%',
		maxWidth: 1080,
		alignItems: 'flex-end',
		justifyContent: 'space-between',
		gap: 16,
		flexWrap: 'wrap' as const,
	} as CSSProperties,

	title: {
		margin: 0,
		fontSize: 20,
		fontWeight: 800,
		color: 'var(--rr-text-primary)',
		letterSpacing: -0.3,
	} as CSSProperties,

	subtitle: {
		margin: '4px 0 0',
		fontSize: 14,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** The search field's width on the header row. */
	search: {
		width: 260,
		maxWidth: '100%',
	} as CSSProperties,

	/** Status line (loading / count) under the header, full width. */
	status: {
		width: '100%',
		maxWidth: 1080,
	} as CSSProperties,

	/** Tile grid — the desktop's columns. */
	grid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
		gap: 24,
		width: '100%',
		maxWidth: 1080,
	} as CSSProperties,

	/** One tile — the desktop card's surface. */
	card: {
		position: 'relative' as const,
		display: 'flex',
		flexDirection: 'column' as const,
		gap: 14,
		padding: 20,
		borderRadius: 12,
		boxSizing: 'border-box' as const,
		fontFamily: 'var(--rr-font-family)',
		transition: REDUCE_MOTION ? 'none' : 'transform 0.12s ease, background-color 0.12s ease',
	} as CSSProperties,

	/** The details control — a transparent button over the whole tile, under the action. */
	tileOverlay: {
		position: 'absolute' as const,
		inset: 0,
		zIndex: 0,
		margin: 0,
		padding: 0,
		border: 'none',
		borderRadius: 12,
		backgroundColor: 'transparent',
		cursor: 'pointer',
	} as CSSProperties,

	cardTop: {
		display: 'flex',
		flexDirection: 'row' as const,
		alignItems: 'center',
		gap: 14,
	} as CSSProperties,

	/** Borderless icon chip — the surface tint alone frames the icon. */
	iconChip: {
		width: 52,
		height: 52,
		flexShrink: 0,
		borderRadius: 12,
		overflow: 'hidden',
		backgroundColor: 'var(--rr-bg-surface-alt)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--rr-brand)',
		fontSize: 22,
		fontWeight: 800,
	} as CSSProperties,

	iconImage: {
		width: '100%',
		height: '100%',
		objectFit: 'cover' as const,
	} as CSSProperties,

	name: {
		fontSize: 16,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		whiteSpace: 'nowrap' as const,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	} as CSSProperties,

	category: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		marginTop: 2,
		whiteSpace: 'nowrap' as const,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	} as CSSProperties,

	description: {
		fontSize: 14,
		lineHeight: 1.45,
		color: 'var(--rr-text-secondary)',
		display: '-webkit-box',
		WebkitLineClamp: 2,
		WebkitBoxOrient: 'vertical' as const,
		overflow: 'hidden',
	} as CSSProperties,

	/** Bottom row — the state's Button, right-aligned; an error reads left. */
	cardBottom: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 12,
		marginTop: 'auto',
	} as CSSProperties,

	/** The add failure — raised above the details overlay so its tooltip shows. */
	cardError: {
		position: 'relative' as const,
		zIndex: 1,
		fontSize: 12,
		color: 'var(--rr-color-error)',
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap' as const,
	} as CSSProperties,

	/** The action's slot — raised above the details overlay so the Button takes its own clicks. */
	cardAction: {
		position: 'relative' as const,
		zIndex: 1,
		flexShrink: 0,
	} as CSSProperties,

	/** The detail header's icon — fills the drawer's 42px avatar slot. */
	detailIcon: {
		width: 42,
		height: 42,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'var(--rr-bg-surface-alt)',
		color: 'var(--rr-brand)',
		fontSize: 18,
		fontWeight: 800,
	} as CSSProperties,

	/** The detail's description — the whole text, unclamped. */
	detailDescription: {
		margin: '10px 0 0',
		fontSize: 14,
		lineHeight: 1.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** The detail's README — a wide image or code line scrolls inside it, not the drawer. */
	detailReadme: {
		overflowX: 'auto' as const,
	} as CSSProperties,

	/** The detail's placeholder when the entry has neither description nor README. */
	detailEmpty: {
		marginTop: 14,
	} as CSSProperties,

	/** The line shown while the README request is out. */
	detailLoading: {
		marginTop: 14,
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** The add failure in the detail footer — takes the room left of the action. */
	detailError: {
		flex: 1,
		minWidth: 0,
		fontSize: 12,
		color: 'var(--rr-color-error)',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap' as const,
	} as CSSProperties,
};

// =============================================================================
// ACTION
// =============================================================================

/** Props for an entry's action. */
interface CatalogActionProps {
	app: AppManifestEntry;
	state: CatalogEntryState;
	onOpen: (app: AppManifestEntry) => void;
	onAdd: (app: AppManifestEntry) => void;
}

/**
 * An entry's action for its state: Open, Add, or the disabled Adding…. The
 * tile and the detail both draw this one.
 */
const CatalogAction: React.FC<CatalogActionProps> = ({ app, state, onOpen, onAdd }) => {
	if (state === 'desktop') {
		return (
			<Button variant="secondary" small onClick={() => onOpen(app)} title={`Open ${app.name}`}>
				Open
			</Button>
		);
	}
	if (state === 'adding') {
		return (
			<Button variant="primary" small disabled>
				Adding…
			</Button>
		);
	}
	return (
		<Button variant="primary" small onClick={() => onAdd(app)} title={`Add ${app.name} to your desktop`}>
			Add
		</Button>
	);
};

// =============================================================================
// TILE
// =============================================================================

/** Props for one catalog tile. */
interface CatalogTileProps {
	app: AppManifestEntry;
	state: CatalogEntryState;
	/** The last add failure for this app, if any. */
	error?: string;
	onOpen: (app: AppManifestEntry) => void;
	onAdd: (app: AppManifestEntry) => void;
	/** Open the entry's detail. */
	onDetails: (app: AppManifestEntry) => void;
}

/**
 * One catalog tile: the desktop card's chrome with the state's Button. A
 * click anywhere but the action, or Enter / Space on the focused tile, opens
 * the entry's detail.
 */
const CatalogTile: React.FC<CatalogTileProps> = ({ app, state, error, onOpen, onAdd, onDetails }) => {
	const [hover, setHover] = useState(false);
	const category = categoryOf(app);
	const surface = hover ? 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))' : 'var(--rr-bg-paper)';

	return (
		<div
			data-catalog-state={state}
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			style={{
				...S.card,
				backgroundColor: surface,
				transform: hover && !REDUCE_MOTION ? 'translateY(-2px)' : 'none',
			}}
		>
			{/* Details control — a sibling of the action, not its ancestor: the
			    tile itself is inert, and this overlay carries the click and the
			    keyboard activation over the tile's whole area. Raw button: the
			    shell Button has no transparent whole-tile overlay form. */}
			<button type="button" aria-label={`Show details for ${app.name}`} onClick={() => onDetails(app)} style={S.tileOverlay} />

			{/* Top row — icon chip + name/category */}
			<div style={S.cardTop}>
				<div style={S.iconChip}>
					{app.icon
						? <img src={app.icon} alt="" loading="lazy" decoding="async" style={S.iconImage} />
						: app.name[0]}
				</div>
				<div style={{ flex: 1, minWidth: 0 }}>
					<div style={S.name}>{app.name}</div>
					{category && <div style={S.category}>{category}</div>}
				</div>
			</div>

			{/* Description — full width below; a blank one shows nothing */}
			{app.description?.trim() && <div style={S.description}>{app.description}</div>}

			{/* Bottom row — the state's action */}
			<div style={S.cardBottom}>
				<span style={S.cardError} title={error}>{error ?? ''}</span>
				<div style={S.cardAction}>
					<CatalogAction app={app} state={state} onOpen={onOpen} onAdd={onAdd} />
				</div>
			</div>
		</div>
	);
};

// =============================================================================
// DETAIL
// =============================================================================

/**
 * An entry's README, fetched from its `readme` path.
 *
 * The answer is kept with the path it was fetched from, so a README is only
 * ever shown for the entry it belongs to; a request whose detail moved to
 * another entry or closed is aborted and its answer dropped.
 *
 * @param readme - The entry's `readme` as the catalog sent it.
 * @returns The README's state for the detail.
 */
function useReadme(readme: string | undefined): ReadmeState {
	const path = isReadmePath(readme) ? readme : null;
	const [fetched, setFetched] = useState<{ path: string; markdown: string } | null>(null);

	useEffect(() => {
		if (!path) return undefined;
		const controller = new AbortController();
		void fetchReadme((url, init) => fetch(url, init), path, controller.signal).then((markdown) => {
			if (!controller.signal.aborted) setFetched({ path, markdown });
		});
		return () => controller.abort();
	}, [path]);

	if (!path) return { kind: 'none' };
	if (!fetched || fetched.path !== path) return { kind: 'loading' };
	return fetched.markdown.trim() ? { kind: 'ready', path, markdown: fetched.markdown } : { kind: 'none' };
}

/** Props for an entry's detail. */
interface CatalogDetailProps {
	app: AppManifestEntry;
	state: CatalogEntryState;
	/** The last add failure for this app, if any. */
	error?: string;
	onOpen: (app: AppManifestEntry) => void;
	onAdd: (app: AppManifestEntry) => void;
	onClose: () => void;
}

/**
 * One entry's detail, in the shell's slide-over drawer: the icon (or the
 * tile's first-letter chip), the name and the category line in the header;
 * the description, the publisher and the README in the body, each shown
 * when the entry carries it and none depending on another; the state's
 * action, with the tile's error text, in the footer.
 */
const CatalogDetail: React.FC<CatalogDetailProps> = ({ app, state, error, onOpen, onAdd, onClose }) => {
	const readme = useReadme(app.readme);
	// A description of nothing but whitespace is a blank one.
	const description = app.description?.trim();

	return (
		<DetailPanel
			persistKey="panelDetailCatalogWidth"
			open
			onClose={onClose}
			avatar={
				<div style={S.detailIcon}>
					{app.icon ? <img src={app.icon} alt="" decoding="async" style={S.iconImage} /> : app.name[0]}
				</div>
			}
			title={app.name}
			subtitle={categoryOf(app) ?? undefined}
			footer={
				<>
					{error && <span style={S.detailError} title={error}>{error}</span>}
					<CatalogAction app={app} state={state} onOpen={onOpen} onAdd={onAdd} />
				</>
			}
		>
			{description && <div style={S.detailDescription}>{description}</div>}

			{app.publisher && (
				<Section label="Details">
					<LabelValue label="Publisher">{app.publisher}</LabelValue>
				</Section>
			)}

			{/* The README request is out: say so, apart from the ready and the absent states. */}
			{readme.kind === 'loading' && (
				<div role="status" style={S.detailLoading}>
					Loading the README…
				</div>
			)}

			{/* The README stands on its own: shown whenever the entry has one. */}
			{readme.kind === 'ready' && (
				<Section label="README">
					<div style={S.detailReadme}>
						<MarkdownRenderer content={readme.markdown} baseUrl={readmeBaseUrl(readme.path)} />
					</div>
				</Section>
			)}

			{/* Nothing to read at all: say so, once the README fetch has answered. */}
			{readme.kind === 'none' && !description && (
				<div style={S.detailEmpty}>
					<EmptyState title="Nothing to read yet." description={`This ${isAgent(app) ? 'agent' : 'app'} has no description and no README.`} />
				</div>
			)}
		</DetailPanel>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The catalog picker: every reachable app and agent as a tile with Open /
 * Add / Adding, and the detail drawer a tile opens (description, publisher,
 * README, the same action).
 *
 * @param props - {@link ICatalogPickerProps}.
 */
export const CatalogPicker: React.FC<ICatalogPickerProps> = ({
	shell,
	excludeIds,
	onLaunch,
	onAdded,
	title = 'Catalog',
	subtitle = 'Add apps and agents to your desktop.',
	showSearch = true,
	style,
}) => {
	const identity = useAuthUser();
	const { isOnDesktop } = useSubscriptions();
	const [catalog, setCatalog] = useState<CatalogState>({ apps: [], total: 0, loading: true, timedOut: false, error: null });
	const [search, setSearch] = useState('');
	// Bumped by Retry: a failed load re-runs with the same arguments.
	const [reloadSeq, setReloadSeq] = useState(0);
	// Adds in flight, adds the server accepted but the identity push has not
	// yet confirmed, and the last failure per app.
	const [adding, setAdding] = useState<ReadonlySet<string>>(() => new Set());
	const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set());
	const [errors, setErrors] = useState<Record<string, string>>({});
	// The entry whose detail is open, by id (null = closed): the drawer draws
	// the live entry, so its action follows the tile's state.
	const [detailId, setDetailId] = useState<string | null>(null);

	// -- The catalog load ------------------------------------------------------
	// Fire at once; if the connection is not attached yet, poll briefly until
	// it is. Re-run when the signed-in user changes (the reachable set does)
	// and on Retry. The verb pages (offset/limit, max 100 per page): every
	// page is fetched until the accumulated count reaches the server's total,
	// so a catalog past one page is never silently truncated.
	const userId = identity?.userId ?? '';
	useEffect(() => {
		let cancelled = false;
		let stopped = false;
		let inFlight = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		const stopPolling = () => { stopped = true; if (timer) clearInterval(timer); timer = undefined; };

		setCatalog((c) => ({ ...c, loading: true, timedOut: false, error: null }));
		const timeoutId = setTimeout(() => {
			if (cancelled) return;
			stopPolling();
			setCatalog((c) => (c.loading ? { ...c, loading: false, timedOut: true } : c));
		}, CATALOG_TIMEOUT_MS);

		/** One fetch (all pages); false when the connection is not attached yet. */
		const attempt = async (): Promise<boolean> => {
			const client = ConnectionManager.getInstance().getClient();
			if (!client || !client.isAttached()) return false;
			try {
				const { apps, total } = await fetchCatalogPages<AppManifestEntry>(
					(args) => client.call('rrext_public_catalog', args),
					{ action: 'list', ...(shell ? { shell } : {}) },
					CATALOG_PAGE_LIMIT,
				);
				if (cancelled) return true;
				setCatalog({ apps, total, loading: false, timedOut: false, error: null });
			} catch (err) {
				if (!cancelled) {
					const error = err instanceof Error && err.message ? err.message : 'The catalog request failed.';
					setCatalog((c) => ({ ...c, loading: false, timedOut: false, error }));
				}
			}
			return true;
		};

		inFlight = true;
		void attempt().then((ready) => {
			inFlight = false;
			if (ready || cancelled || stopped) return;
			timer = setInterval(async () => {
				if (cancelled || stopped) { stopPolling(); return; }
				if (inFlight) return;
				inFlight = true;
				try {
					if (await attempt()) stopPolling();
				} finally {
					inFlight = false;
				}
			}, CATALOG_RETRY_MS);
		});

		return () => { cancelled = true; stopPolling(); clearTimeout(timeoutId); };
	}, [shell, userId, reloadSeq]);

	// Once the identity confirms an add, the local marker is redundant — drop
	// it so a later desktop remove (from the desktop grid) shows Add again.
	// `added` is a dependency on purpose: when the identity push lands BEFORE
	// desktop_add resolves, the marker is recorded after the identity
	// changed, and only a run on the marker itself clears it.
	useEffect(() => {
		setAdded((prev) => reconcileAdded(prev, isOnDesktop));
	}, [isOnDesktop, added]);

	// -- Actions ---------------------------------------------------------------
	// An agent opens its host app bound to its address (launchAgent); the
	// host's onLaunch takes app ids only, which cannot carry the binding.
	const open = useCallback((app: AppManifestEntry) => {
		if (isAgent(app)) launchAgent(app);
		else if (onLaunch) onLaunch(app.id);
		else ConnectionManager.getInstance().emit('shell:switchApp', { appId: app.id });
	}, [onLaunch]);

	const add = useCallback(async (app: AppManifestEntry) => {
		const cm = ConnectionManager.getInstance();
		// Not signed in: the add needs a session first; the host's sign-in
		// flow answers the request and the catalog reloads on the new identity.
		if (!identity) { cm.emit('shell:loginRequest', {}); return; }
		const client = cm.getClient();
		if (!client) return;
		setErrors((e) => { const { [app.id]: _dropped, ...rest } = e; return rest; });
		setAdding((prev) => new Set(prev).add(app.id));
		try {
			await client.call('rrext_app', { subcommand: 'desktop_add', appId: app.id });
			setAdded((prev) => new Set(prev).add(app.id));
			onAdded?.(app.id);
		} catch (err) {
			setErrors((e) => ({ ...e, [app.id]: err instanceof Error ? err.message : 'Could not add the app' }));
		} finally {
			setAdding((prev) => { const next = new Set(prev); next.delete(app.id); return next; });
		}
	}, [identity, onAdded]);

	// -- The visible list ------------------------------------------------------
	const visible = useMemo(() => {
		const excluded = new Set(excludeIds ?? []);
		const needle = search.trim().toLowerCase();
		return catalog.apps
			.filter((a) => a.id && !excluded.has(a.id))
			.filter((a) => !needle || a.name.toLowerCase().includes(needle) || (a.description ?? '').toLowerCase().includes(needle))
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [catalog.apps, excludeIds, search]);

	/** The entry state: the live identity decides, the local marker bridges the push. */
	const stateOf = (app: AppManifestEntry): CatalogEntryState => {
		if (isOnDesktop(app.id) || added.has(app.id)) return 'desktop';
		if (adding.has(app.id)) return 'adding';
		return 'available';
	};

	// -- The detail ------------------------------------------------------------
	// The drawer shows an entry the grid lists; one that left the list (a
	// reload under another identity) closes it.
	const detailApp = detailId === null ? undefined : visible.find((a) => a.id === detailId);
	useEffect(() => {
		if (detailId !== null && !detailApp) setDetailId(null);
	}, [detailId, detailApp]);

	const showDetail = useCallback((app: AppManifestEntry) => setDetailId(app.id), []);
	const closeDetail = useCallback(() => setDetailId(null), []);

	// Opening from the detail leaves the catalog for the app: the drawer
	// closes first, so it gives back the page scroll and the focus it holds.
	const openFromDetail = useCallback((app: AppManifestEntry) => {
		setDetailId(null);
		open(app);
	}, [open]);

	return (
		<div style={{ ...S.root, ...style }}>
			{/* Header row — title + subtitle, search */}
			{(title || showSearch) && (
				<div style={S.headerRow}>
					<div style={{ minWidth: 0 }}>
						{title && <h2 style={S.title}>{title}</h2>}
						{title && subtitle && <p style={S.subtitle}>{subtitle}</p>}
					</div>
					{showSearch && (
						<InputField
							type="search"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search apps and agents"
							aria-label="Search apps and agents"
							style={S.search}
						/>
					)}
				</div>
			)}

			{/* Body — loading, failed (with Retry), empty, or the grid */}
			{catalog.loading && !catalog.timedOut ? (
				<div style={S.status}><EmptyState title="Loading the catalog…" /></div>
			) : catalog.error !== null || (catalog.timedOut && catalog.apps.length === 0) ? (
				<div style={S.status}>
					<EmptyState
						title="Couldn't load the catalog."
						description={catalog.error ?? 'The connection did not answer in time.'}
						action={<Button onClick={() => setReloadSeq((n) => n + 1)}>Retry</Button>}
					/>
				</div>
			) : visible.length === 0 ? (
				<div style={S.status}>
					<EmptyState
						title={search.trim() ? 'Nothing matches.' : 'Nothing in the catalog yet.'}
						description={search.trim() ? 'Try a different search.' : 'Apps and agents published to this server appear here.'}
					/>
				</div>
			) : (
				<div style={S.grid}>
					{visible.map((app) => (
						<CatalogTile
							key={app.id}
							app={app}
							state={stateOf(app)}
							error={errors[app.id]}
							onOpen={open}
							onAdd={add}
							onDetails={showDetail}
						/>
					))}
				</div>
			)}

			{/* The open entry's detail — mounted only while one is in view */}
			{detailApp && (
				<CatalogDetail
					app={detailApp}
					state={stateOf(detailApp)}
					error={errors[detailApp.id]}
					onOpen={openFromDetail}
					onAdd={add}
					onClose={closeDetail}
				/>
			)}
		</div>
	);
};

export default CatalogPicker;
