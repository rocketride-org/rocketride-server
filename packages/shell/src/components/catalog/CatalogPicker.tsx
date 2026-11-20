// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CATALOG PICKER — the one catalog-to-desktop picker, both editions
// =============================================================================
//
// The catalog of apps the caller can reach, each tile in one of three states:
// ON THE DESKTOP (Open), NOT YET (Add), or ADDING (the add is in flight).
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

import React, { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ConnectionManager } from '../../connection/connection';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useSubscriptions } from '../../hooks/useSubscriptions';
import { Button } from '../button/Button';
import { EmptyState } from '../empty-state/EmptyState';
import { InputField } from '../input-field/InputField';
import type { AppManifestEntry } from '../workspace/types';

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

/** The largest page the catalog verb serves. */
const CATALOG_PAGE_LIMIT = 100;

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
	 * Launch handler for a tile that is already on the desktop. Default:
	 * emit `shell:switchApp` on the connection manager.
	 */
	onLaunch?: (appId: string) => void;
	/** Called once the server accepted an add (the identity push follows). */
	onAdded?: (appId: string) => void;
	/** Heading above the grid (default 'Catalog'); an empty string hides it. */
	title?: string;
	/** Line under the heading (default 'Add apps to your desktop.'). */
	subtitle?: string;
	/** Show the search field (default true). */
	showSearch?: boolean;
	/** Extra styles merged onto the root (padding/width belong to the host). */
	style?: CSSProperties;
}

/** One catalog load. */
interface CatalogState {
	apps: AppManifestEntry[];
	total: number;
	/** True until the first catalog response arrives. */
	loading: boolean;
	/** True when nothing arrived within CATALOG_TIMEOUT_MS. */
	timedOut: boolean;
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

	cardError: {
		fontSize: 12,
		color: 'var(--rr-color-error)',
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap' as const,
	} as CSSProperties,
};

// =============================================================================
// TILE
// =============================================================================

/** Props for one catalog tile. */
interface CatalogTileProps {
	app: AppManifestEntry;
	/** 'desktop' → Open, 'adding' → disabled, 'available' → Add. */
	state: 'desktop' | 'adding' | 'available';
	/** The last add failure for this app, if any. */
	error?: string;
	onOpen: (appId: string) => void;
	onAdd: (app: AppManifestEntry) => void;
}

/**
 * One catalog tile: the desktop card's chrome with the state's Button.
 */
const CatalogTile: React.FC<CatalogTileProps> = ({ app, state, error, onOpen, onAdd }) => {
	const [hover, setHover] = useState(false);
	const category = app.categories?.[0] ? formatCategory(app.categories[0]) : null;
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

			{/* Description — full width below */}
			<div style={S.description}>{app.description || 'No description'}</div>

			{/* Bottom row — the state's action */}
			<div style={S.cardBottom}>
				<span style={S.cardError} title={error}>{error ?? ''}</span>
				{state === 'desktop' && (
					<Button variant="secondary" small onClick={() => onOpen(app.id)} title={`Open ${app.name}`}>
						Open
					</Button>
				)}
				{state === 'adding' && (
					<Button variant="primary" small disabled>
						Adding…
					</Button>
				)}
				{state === 'available' && (
					<Button variant="primary" small onClick={() => onAdd(app)} title={`Add ${app.name} to your desktop`}>
						Add
					</Button>
				)}
			</div>
		</div>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The catalog picker: every reachable app as a tile with Open / Add / Adding.
 *
 * @param props - {@link ICatalogPickerProps}.
 */
export const CatalogPicker: React.FC<ICatalogPickerProps> = ({
	shell,
	excludeIds,
	onLaunch,
	onAdded,
	title = 'Catalog',
	subtitle = 'Add apps to your desktop.',
	showSearch = true,
	style,
}) => {
	const identity = useAuthUser();
	const { isOnDesktop } = useSubscriptions();
	const [catalog, setCatalog] = useState<CatalogState>({ apps: [], total: 0, loading: true, timedOut: false });
	const [search, setSearch] = useState('');
	// Adds in flight, adds the server accepted but the identity push has not
	// yet confirmed, and the last failure per app.
	const [adding, setAdding] = useState<ReadonlySet<string>>(() => new Set());
	const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set());
	const [errors, setErrors] = useState<Record<string, string>>({});

	// -- The catalog load ------------------------------------------------------
	// Fire at once; if the connection is not attached yet, poll briefly until
	// it is. Re-run when the signed-in user changes: the reachable set does.
	const userId = identity?.userId ?? '';
	useEffect(() => {
		let cancelled = false;
		let stopped = false;
		let inFlight = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		const stopPolling = () => { stopped = true; if (timer) clearInterval(timer); timer = undefined; };

		setCatalog((c) => ({ ...c, loading: true, timedOut: false }));
		const timeoutId = setTimeout(() => {
			if (cancelled) return;
			stopPolling();
			setCatalog((c) => (c.loading ? { ...c, loading: false, timedOut: true } : c));
		}, CATALOG_TIMEOUT_MS);

		/** One fetch; false when the connection is not attached yet. */
		const attempt = async (): Promise<boolean> => {
			const client = ConnectionManager.getInstance().getClient();
			if (!client || !client.isAttached()) return false;
			try {
				const body = await client.call('rrext_public_catalog', {
					action: 'list',
					limit: CATALOG_PAGE_LIMIT,
					...(shell ? { shell } : {}),
				}) as { apps?: AppManifestEntry[]; total?: number } | null;
				if (cancelled) return true;
				const apps = Array.isArray(body?.apps) ? body!.apps! : [];
				setCatalog({ apps, total: body?.total ?? apps.length, loading: false, timedOut: false });
			} catch {
				if (!cancelled) setCatalog((c) => ({ ...c, loading: false, timedOut: false }));
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
	}, [shell, userId]);

	// Once the identity confirms an add, the local marker is redundant — drop
	// it so a later desktop remove (from the desktop grid) shows Add again.
	useEffect(() => {
		setAdded((prev) => {
			const next = new Set([...prev].filter((id) => !isOnDesktop(id)));
			return next.size === prev.size ? prev : next;
		});
	}, [isOnDesktop]);

	// -- Actions ---------------------------------------------------------------
	const open = useCallback((appId: string) => {
		if (onLaunch) onLaunch(appId);
		else ConnectionManager.getInstance().emit('shell:switchApp', { appId });
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

	/** The tile state: the live identity decides, the local marker bridges the push. */
	const stateOf = (app: AppManifestEntry): CatalogTileProps['state'] => {
		if (isOnDesktop(app.id) || added.has(app.id)) return 'desktop';
		if (adding.has(app.id)) return 'adding';
		return 'available';
	};

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
							placeholder="Search apps"
							aria-label="Search apps"
							style={S.search}
						/>
					)}
				</div>
			)}

			{/* Body — loading, failed, empty, or the grid */}
			{catalog.loading && !catalog.timedOut ? (
				<div style={S.status}><EmptyState title="Loading the catalog…" /></div>
			) : catalog.timedOut && catalog.apps.length === 0 ? (
				<div style={S.status}><EmptyState title="Couldn't load the catalog." description="Check the connection and try again." /></div>
			) : visible.length === 0 ? (
				<div style={S.status}>
					<EmptyState
						title={search.trim() ? 'No apps match.' : 'No apps in the catalog.'}
						description={search.trim() ? 'Try a different search.' : 'Apps published to this server appear here.'}
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
						/>
					))}
				</div>
			)}
		</div>
	);
};

export default CatalogPicker;
