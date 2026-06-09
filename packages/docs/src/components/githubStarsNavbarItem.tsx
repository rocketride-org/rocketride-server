import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { SiGithub } from 'react-icons/si';

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
		<a className={clsx('navbar__item', 'navbar__link', 'github-stars', mobile && 'menu__link', className)} href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
			<span className="github-stars__count">
				<SiGithub className="github-stars__icon" aria-hidden="true" />
				{stars !== null && formatStars(stars)}
			</span>
		</a>
	);
}
