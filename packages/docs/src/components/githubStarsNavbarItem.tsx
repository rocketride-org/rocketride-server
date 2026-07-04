import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { SiGithub } from 'react-icons/si';
import { formatStars } from '../lib/format.mjs';

type Props = {
	href: string;
	label?: string;
	className?: string;
	mobile?: boolean;
};

const REPO_API = 'https://api.github.com/repos/rocketride-org/rocketride-server';
const CACHE_KEY = 'rr-github-stars';
// Successful counts stay fresh for 6h. Failures (rate limit, offline, non-OK)
// are cached as a null count for a shorter window so we back off rather than
// refetching on every page load — GitHub's unauthenticated API is 60 req/hr/IP.
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const FAILURE_TTL_MS = 30 * 60 * 1000; // 30m
const FETCH_TIMEOUT_MS = 6000;

// A cached count of null is a remembered failure (negative cache), not a miss.
type CacheEntry = { count: number | null; at: number };

function readCachedStars(): CacheEntry | null {
	// localStorage may be unavailable (private mode) and a stale entry may be
	// malformed JSON — treat any failure as a cache miss rather than throwing.
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const entry = JSON.parse(raw) as CacheEntry;
		if (typeof entry?.at !== 'number') return null;
		const ttl = typeof entry.count === 'number' ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
		if (Date.now() - entry.at > ttl) return null;
		return entry;
	} catch {
		return null;
	}
}

function writeCachedStars(count: number | null): void {
	// Best-effort cache write; ignore unavailable storage or quota errors.
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify({ count, at: Date.now() } satisfies CacheEntry));
	} catch {
		/* no-op */
	}
}

/**
 * Navbar GitHub link that appends the repository's live star count.
 *
 * The count is fetched client-side (GitHub's unauthenticated API) and cached in
 * localStorage, so it never blocks render and degrades to a plain link if the
 * request fails (private repo, rate limit, offline).
 *
 * @param props - Navbar item config: the GitHub `href`, optional `label`, and
 *   the `mobile` flag Docusaurus passes when rendering the mobile menu.
 * @return The rendered navbar link, with a star badge once the count loads.
 */
export default function GitHubStarsNavbarItem({ href, label = 'GitHub', className, mobile }: Props): React.ReactNode {
	const [stars, setStars] = useState<number | null>(null);

	useEffect(() => {
		let cancelled = false;

		const cached = readCachedStars();
		if (cached !== null) {
			// Fresh entry (a remembered failure has count null → no badge, no refetch).
			setStars(cached.count);
			return;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

		fetch(REPO_API, { signal: controller.signal, headers: { Accept: 'application/vnd.github+json' } })
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => {
				if (cancelled) return;
				const count = typeof data?.stargazers_count === 'number' ? data.stargazers_count : null;
				setStars(count);
				writeCachedStars(count); // negative-cache failures so we back off
			})
			.catch(() => {
				if (!cancelled) writeCachedStars(null);
			})
			.finally(() => clearTimeout(timeout));

		return () => {
			cancelled = true;
			clearTimeout(timeout);
			controller.abort();
		};
	}, []);

	// The icon is aria-hidden, so fold the count into the accessible name once it
	// loads — otherwise screen readers announce only "GitHub".
	const ariaLabel = stars !== null ? `${label}, ${formatStars(stars)} stars` : label;

	return (
		<a className={clsx('navbar__item', 'navbar__link', 'github-stars', mobile && 'menu__link', className)} href={href} target="_blank" rel="noopener noreferrer" aria-label={ariaLabel}>
			<span className="github-stars__count">
				<SiGithub className="github-stars__icon" aria-hidden="true" />
				{stars !== null && formatStars(stars)}
			</span>
		</a>
	);
}
