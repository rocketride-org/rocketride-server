// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppManifestEntry } from 'shell';
import { getShellApi } from 'shell';
import { signedOutEntries } from './agentEntry';

// Shell runtime access flows through the single curated contract accessor.
const { ConnectionManager } = getShellApi();

// =============================================================================
// TYPES
// =============================================================================

/** Catalog query parameters for rrext_public_catalog. */
export interface CatalogQuery {
	/** Pagination offset (default 0). */
	offset?: number;
	/** Page size (default 20, max 100). */
	limit?: number;
	/** Substring filter on name/description. */
	search?: string;
	/** Category filter. */
	category?: string;
	/** Shell compatibility filter ("saas", "oss", "vscode"). */
	shell?: string;
}

/** Result shape from the catalog query. */
interface CatalogResult {
	apps: AppManifestEntry[];
	total: number;
	offset: number;
	limit: number;
	/** True until the first catalog response arrives (drives skeleton state). */
	loading: boolean;
	/** True if no catalog response arrived within CATALOG_TIMEOUT_MS (drives the error state). */
	timedOut: boolean;
	/** Optimistically merge fields into a single catalog entry (e.g. onDesktop after install). */
	patchApp: (appId: string, patch: Partial<AppManifestEntry>) => void;
}

/** Max time to wait for the first catalog response before surfacing an error state. */
const CATALOG_TIMEOUT_MS = 5000;

// =============================================================================
// HOOK
// =============================================================================

/**
 * Fetches the app catalog via the ``rrext_public_catalog`` DAP command.
 *
 * Works on both authenticated and unauthenticated connections. When
 * authenticated, the response includes ``appStatus`` and ``onDesktop`` per app.
 * Retries until the WebSocket connection is ready.
 *
 * @param query - Optional pagination and filter parameters.
 * @returns The catalog result with apps array and total count.
 */
export function useCatalogApps(query?: CatalogQuery): CatalogResult {
	const [result, setResult] = useState<Omit<CatalogResult, 'patchApp'>>({ apps: [], total: 0, offset: 0, limit: 20, loading: true, timedOut: false });

	// Stable query key so useEffect doesn't re-fire on every render
	const queryKey = JSON.stringify(query ?? {});

	// A sign-in changes what the catalog returns: the agents the caller reaches
	// (dropped on logout, never restored by an account update, which only merges
	// into entries already listed) and the per-account enrichment. Counted so the
	// fetch below runs once more per sign-in.
	const [signIns, setSignIns] = useState(0);
	useEffect(() => ConnectionManager.getInstance().on('shell:login', () => setSignIns((count) => count + 1)), []);

	// Logouts so far. A catalog response asked for before a logout is the
	// signed-in catalog: when it lands after, only its signed-out entries are kept.
	const logoutsRef = useRef(0);

	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		// Guards against overlapping in-flight attempts when an attempt() outlives the poll cadence.
		let inFlight = false;
		// Set once the poll should stop for good (timeout fired or attached). Prevents the
		// first-attempt `.then()` from (re)creating the interval after the timeout already ran.
		let stopped = false;

		// Stops the poll. Safe to call before `timer` is assigned (timeout may fire first).
		const stopPolling = () => { stopped = true; if (timer) clearInterval(timer); timer = undefined; };

		// Re-enter the loading state whenever the query changes or the viewer signs in.
		setResult((r) => ({ ...r, loading: true, timedOut: false }));

		// Surface an error state if nothing ever loads (e.g. the connection never attaches),
		// and stop retrying — there's no point continuing on the same cadence after timing out.
		const timeoutId = setTimeout(() => {
			if (cancelled) return;
			stopPolling();
			setResult((r) => (r.loading ? { ...r, loading: false, timedOut: true } : r));
		}, CATALOG_TIMEOUT_MS);

		/**
		 * Attempt one catalog fetch. Returns false if the WebSocket connection
		 * isn't attached yet (so the caller can retry), true once a request was
		 * actually issued (regardless of success).
		 */
		const attempt = async (): Promise<boolean> => {
			const client = ConnectionManager.getInstance().getClient();
			if (!client || !client.isAttached()) return false;

			const logouts = logoutsRef.current;
			try {
				const body = await client.call('rrext_public_catalog', { action: 'list', ...(query ?? {}) });
				if (cancelled) return true;
				if (body && Array.isArray(body.apps)) {
					// The viewer signed out while this was in flight: the response is the
					// signed-in catalog, and only its signed-out entries may land.
					const apps = logouts === logoutsRef.current ? body.apps : signedOutEntries(body.apps);
					setResult({
						apps,
						total: Math.max(0, (body.total ?? body.apps.length) - (body.apps.length - apps.length)),
						offset: body.offset ?? 0,
						limit: body.limit ?? 20,
						loading: false,
						timedOut: false,
					});
				} else {
					setResult((r) => ({ ...r, loading: false, timedOut: false }));
				}
			} catch {
				// DAP failed — stop the skeleton, leave whatever we had.
				if (!cancelled) setResult((r) => ({ ...r, loading: false, timedOut: false }));
			}
			return true;
		};

		// Fire immediately; if the connection isn't ready, poll briefly until it is.
		inFlight = true;
		attempt().then((ready) => {
			inFlight = false;
			// Bail if torn down / timed out / already attached while the first attempt was in
			// flight; otherwise we'd assign `timer` after stop already ran and leak the interval.
			if (ready || cancelled || stopped) return;
			timer = setInterval(async () => {
				// Stop polling if cancelled mid-interval, or skip if an attempt is still pending.
				if (cancelled || stopped) { stopPolling(); return; }
				if (inFlight) return;
				inFlight = true;
				try {
					if (await attempt()) stopPolling();
				} finally {
					inFlight = false;
				}
			}, 150);
		});

		return () => { cancelled = true; stopPolling(); clearTimeout(timeoutId); };
	}, [queryKey, signIns]);

	// Listen for account updates (desktop_add/remove, subscription changes)
	// and merge the fresh onDesktop / appStatus from the ConnectResult apps
	// into the existing catalog without a full re-fetch.
	useEffect(() => {
		const cm = ConnectionManager.getInstance();
		return cm.on('shell:accountUpdate', (connectResult: { apps?: Array<{ id: string; appStatus?: string; onDesktop?: boolean }> }) => {
			const serverApps = connectResult.apps;
			if (!serverApps?.length) return;
			const statusById = new Map(serverApps.map((a) => [a.id, a]));
			setResult((prev) => ({
				...prev,
				apps: prev.apps.map((a) => {
					const fresh = statusById.get(a.id);
					if (!fresh) return a;
					return { ...a, appStatus: fresh.appStatus ?? a.appStatus, onDesktop: fresh.onDesktop ?? a.onDesktop };
				}),
			}));
		});
	}, []);

	// Optimistic merge for a single app — lets the page flip onDesktop/appStatus
	// immediately on user action, before the server round-trip confirms.
	const patchApp = useCallback((appId: string, patch: Partial<AppManifestEntry>) => {
		setResult((prev) => ({
			...prev,
			apps: prev.apps.map((a) => (a.id === appId ? { ...a, ...patch } : a)),
		}));
	}, []);

	// On logout, keep only what an anonymous fetch would return (signedOutEntries):
	// the store's public apps that require no permission, without the per-account
	// enrichment (onDesktop / appStatus), which would otherwise linger as stale
	// "Open"/subscription CTAs. Agents, the caller's own non-public publications
	// and permission-gated apps are listed for a signed-in caller only and must
	// not stay on a signed-out screen. The count also marks every fetch still in
	// flight as asked-for-before-logout (see attempt).
	useEffect(() => {
		const cm = ConnectionManager.getInstance();
		return cm.on('shell:logout', () => {
			logoutsRef.current += 1;
			setResult((prev) => {
				const apps = signedOutEntries(prev.apps);
				return { ...prev, apps, total: Math.max(0, prev.total - (prev.apps.length - apps.length)) };
			});
		});
	}, []);

	return { ...result, patchApp };
}
