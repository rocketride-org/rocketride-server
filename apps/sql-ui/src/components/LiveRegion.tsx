// =============================================================================
// MIT License
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
// SQL-UI — LIVE REGION (one polite announcer per realm)
// =============================================================================
//
// The component itself is shared (shared/explorer/a11y/LiveRegion); this binds
// it to SQL Explorer's own announcer, which is one per realm (a module).
//
// ONE REGION PER REALM. In-shell, every dev-tool frame (and the full app, when
// it is open too) lives in one realm and shares the announcer: a region in
// each mount would speak every sentence once per open document. Every mount
// renders `<LiveRegion />`; only the first alive one renders the region, and
// the claim passes on when it unmounts. The region goes to `document.body`
// through a portal: the host hides background tabs with `display: none`, which
// would silence a region inside one.
// =============================================================================

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { createLiveRegion } from 'shared/explorer/a11y/LiveRegion';
import { sqlAnnouncer } from '../a11y/announce';

/** The region itself, bound to SQL Explorer's announcer. */
const Region = createLiveRegion(sqlAnnouncer);

/** Which mount renders the realm's one region. */
export interface RegionClaims {
	/**
	 * Ask to render the region (idempotent per id).
	 *
	 * @returns Give the claim up (idempotent).
	 */
	claim(id: symbol): () => void;
	/** The mount that renders it: the first alive claim, or null. */
	holder(): symbol | null;
	/** Told whenever the holder may have changed. */
	subscribe(listener: () => void): () => void;
}

/**
 * Create a set of claims (one per realm; tests make their own).
 *
 * @returns The claims.
 */
export function createRegionClaims(): RegionClaims {
	const claims: symbol[] = [];
	const listeners = new Set<() => void>();
	const notify = (): void => listeners.forEach((listener) => listener());
	return {
		claim(id) {
			if (!claims.includes(id)) {
				claims.push(id);
				notify();
			}
			return () => {
				const at = claims.indexOf(id);
				if (at < 0) return;
				claims.splice(at, 1);
				notify();
			};
		},
		holder: () => claims[0] ?? null,
		subscribe(listener) {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
	};
}

/** This realm's claims. */
const realmClaims = createRegionClaims();

/**
 * The realm's single polite live region: mount it in every root (the full
 * app, each dev-tool frame); every `announce()` lands in the one region the
 * first alive root renders.
 */
export const LiveRegion: React.FC = () => {
	const [id] = useState(() => Symbol('sql-live-region'));
	useEffect(() => realmClaims.claim(id), [id]);
	const holder = useSyncExternalStore(realmClaims.subscribe, realmClaims.holder, realmClaims.holder);
	if (holder !== id || typeof document === 'undefined') return null;
	return createPortal(<Region />, document.body);
};

export default LiveRegion;
