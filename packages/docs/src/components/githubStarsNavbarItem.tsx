import React, { useEffect, useState } from 'react';
import clsx from 'clsx';

type Props = {
	href: string;
	label?: string;
	className?: string;
	mobile?: boolean;
};

const REPO_API = 'https://api.github.com/repos/rocketride-org/rocketride-server';
const CACHE_KEY = 'rr-github-stars';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — keep the count fresh without hammering the API.

type CacheEntry = { count: number; at: number };

function readCachedStars(): number | null {
	const raw = localStorage.getItem(CACHE_KEY);
	if (!raw) return null;
	const entry = JSON.parse(raw) as CacheEntry;
	if (typeof entry?.count !== 'number' || Date.now() - entry.at > CACHE_TTL_MS) return null;
	return entry.count;
}

function writeCachedStars(count: number): void {
	localStorage.setItem(CACHE_KEY, JSON.stringify({ count, at: Date.now() } satisfies CacheEntry));
}

function formatStars(count: number): string {
	if (count < 1000) return String(count);
	return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
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
			setStars(cached);
			return;
		}

		fetch(REPO_API)
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => {
				if (cancelled || typeof data?.stargazers_count !== 'number') return;
				setStars(data.stargazers_count);
				writeCachedStars(data.stargazers_count);
			})
			.catch(() => {});

		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<a className={clsx('navbar__item', 'navbar__link', 'github-stars', mobile && 'menu__link', className)} href={href} target="_blank" rel="noopener noreferrer">
			<svg className="github-stars__mark" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
				<path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
			</svg>
			<span>{label}</span>
			{stars !== null && <span className="github-stars__count">{formatStars(stars)}</span>}
		</a>
	);
}
