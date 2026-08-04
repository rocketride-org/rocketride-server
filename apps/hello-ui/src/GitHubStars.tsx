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
// GITHUB STARS — Badge linking to the repo with live star count
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';

/** Module-level cache — fetched once per session regardless of mount/unmount cycles. */
let _starsCache: number | null = null;
let _starsFetch: Promise<void> | null = null;

/**
 * GitHub stars badge — fetches the star count once and caches it for the session.
 */
const GitHubStars: React.FC = () => {
	const [stars, setStars] = useState<number | null>(_starsCache);
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);

	// Fetch star count (once per session)
	useEffect(() => {
		if (_starsCache !== null) { setStars(_starsCache); return; }
		if (!_starsFetch) {
			_starsFetch = fetch('https://api.github.com/repos/rocketride-org/rocketride-server')
				.then((r) => r.json())
				.then((d) => { if (typeof d.stargazers_count === 'number') _starsCache = d.stargazers_count; })
				.catch(() => {});
		}
		_starsFetch.then(() => { if (mounted.current && _starsCache !== null) setStars(_starsCache); });
	}, []);

	const label = stars === null ? '—' : stars >= 1000 ? `${(stars / 1000).toFixed(1)}k` : String(stars);

	return (
		<a
			href="https://github.com/rocketride-org/rocketride-server"
			target="_blank"
			rel="noopener noreferrer"
			style={{
				display: 'flex', alignItems: 'center', gap: 6,
				padding: '7px 16px', borderRadius: 6,
				border: '1px solid var(--rr-border)',
				backgroundColor: 'transparent', color: 'var(--rr-text-secondary)',
				fontSize: 13, fontWeight: 500, textDecoration: 'none',
				cursor: 'pointer',
			}}
		>
			<svg height="16" viewBox="0 0 98 96" xmlns="http://www.w3.org/2000/svg" style={{ fill: 'currentColor', flexShrink: 0 }}>
				<path d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" />
			</svg>
			<svg width="12" height="12" viewBox="0 0 24 24" style={{ fill: 'currentColor', flexShrink: 0 }}>
				<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
			</svg>
			<span>{label}</span>
		</a>
	);
};

export default GitHubStars;
