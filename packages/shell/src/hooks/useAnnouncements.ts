// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * useAnnouncements — fetches announcements from the RocketRide announcements
 * repo on GitHub, caches for 1 hour, and filters by valid_from / valid_until.
 * Returns an empty array on fetch failure (hides the control).
 */

import { useState, useEffect } from 'react';

// ============================================================================
// TYPES
// ============================================================================

/** Raw announcement entry from the remote JSON. */
export interface Announcement {
	/** Stable identifier for deduplication. */
	id: string;
	/** Short headline (supports inline markdown). */
	title: string;
	/** Longer description (supports inline markdown). */
	body: string;
	/** Visual priority: info (blue), warning (yellow), urgent (red). */
	priority: 'info' | 'warning' | 'urgent';
	/** ISO-8601 UTC — announcement is hidden before this time. */
	valid_from?: string;
	/** ISO-8601 UTC — announcement is hidden after this time. */
	valid_until?: string;
	/** Optional URL rendered as a "Learn more" link. */
	link?: string;
	/** Whether the user can dismiss this announcement. Default true. */
	dismissable?: boolean;
}

interface AnnouncementsPayload {
	schema_version: number;
	announcements: Announcement[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

const FETCH_URL =
	'https://raw.githubusercontent.com/rocketride-org/announcements/main/announcements.json';

/** Base URL for resolving relative image/asset paths in markdown. */
const ASSETS_BASE =
	'https://raw.githubusercontent.com/rocketride-org/announcements/main/';

/** Cache TTL — 1 hour in milliseconds. */
const CACHE_TTL = 60 * 60 * 1000;

// ============================================================================
// MODULE-LEVEL CACHE
// ============================================================================

let cachedAnnouncements: Announcement[] = [];
let cacheTimestamp = 0;
let fetchPromise: Promise<Announcement[]> | null = null;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Rewrite relative image paths in markdown to absolute GitHub raw URLs.
 * Matches `![alt](relative/path)` but skips already-absolute URLs.
 */
function resolveImagePaths(md: string): string {
	return md.replace(
		/!\[([^\]]*)\]\((?!https?:\/\/)([^)]+)\)/g,
		(_match, alt, path) => `![${alt}](${ASSETS_BASE}${path})`,
	);
}

/**
 * Filter announcements whose valid_from/valid_until window includes now.
 */
function filterByWindow(items: Announcement[]): Announcement[] {
	const now = Date.now();
	return items.filter((a) => {
		if (a.valid_from && new Date(a.valid_from).getTime() > now) return false;
		if (a.valid_until && new Date(a.valid_until).getTime() < now) return false;
		return true;
	});
}

/**
 * Fetch, validate, and cache announcements from GitHub.
 * Deduplicates concurrent calls via a shared promise.
 */
async function fetchAnnouncements(): Promise<Announcement[]> {
	// Return cache if still fresh
	if (cachedAnnouncements.length > 0 && Date.now() - cacheTimestamp < CACHE_TTL) {
		return cachedAnnouncements;
	}

	// Deduplicate concurrent fetches
	if (fetchPromise) return fetchPromise;

	fetchPromise = (async () => {
		try {
			const res = await fetch(FETCH_URL, { signal: AbortSignal.timeout(10_000) });
			if (!res.ok) return cachedAnnouncements;

			const data: AnnouncementsPayload = await res.json();
			if (data.schema_version !== 1 || !Array.isArray(data.announcements)) {
				return cachedAnnouncements;
			}

			// Resolve relative image paths in title and body
			const resolved = data.announcements.map((a) => ({
				...a,
				title: resolveImagePaths(a.title),
				body: resolveImagePaths(a.body),
			}));

			cachedAnnouncements = resolved;
			cacheTimestamp = Date.now();
			return resolved;
		} catch {
			// Fetch failure — return whatever we have (empty on first failure)
			return cachedAnnouncements;
		} finally {
			fetchPromise = null;
		}
	})();

	return fetchPromise;
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * useAnnouncements — returns the current list of active announcements.
 * Fetches on mount (if cache is stale) and re-fetches every hour.
 */
export function useAnnouncements(): Announcement[] {
	const [announcements, setAnnouncements] = useState<Announcement[]>(() =>
		filterByWindow(cachedAnnouncements),
	);

	useEffect(() => {
		let mounted = true;

		// Initial fetch
		fetchAnnouncements().then((items) => {
			if (mounted) setAnnouncements(filterByWindow(items));
		});

		// Hourly refresh
		const interval = setInterval(() => {
			fetchAnnouncements().then((items) => {
				if (mounted) setAnnouncements(filterByWindow(items));
			});
		}, CACHE_TTL);

		return () => {
			mounted = false;
			clearInterval(interval);
		};
	}, []);

	return announcements;
}
