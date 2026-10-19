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
// WIRE MAPPING — SDK/RPC row shapes -> the shared view vocabulary
// =============================================================================

/**
 * The publish-ladder wire shapes (mirrors of the SDK's return rows) and the
 * projections that turn them into the shared view types. Both hosts consume
 * these: the VSCode webview maps rows that rode its RPC bridge, the web host
 * maps the SDK's rows directly — one implementation, no drift.
 */

import type { AppHistoryEntry, AppVersionInfo, RungPin } from './types';

// =============================================================================
// WIRE SHAPES
// =============================================================================

/** One version-rail row as the SDK returns it (client.listDeployments). */
export interface WireRailEntry {
	/** Registry version int — the wire identity. */
	registryVersion: number;
	/** Display semver from the packed package.json ('' on legacy rows). */
	appVersion: string;
	/** Content hash of the packed source. */
	sha256: string;
	/** Unix seconds of the deploy. */
	publishedAt: number;
	/** Publisher display name (denormalized). */
	author: string;
	/** Deploy comment. */
	message: string;
	/** Rung names this version is pinned to. */
	rungs?: string[];
	/** Review state (private|submit|ready|rejected|failed). */
	state?: string;
	/** Server build status ('', 'ok', 'failed', or a ticker word). */
	buildStatus?: string;
}

/** One where-live pin as the SDK returns it (client.whereApp). */
export interface WirePin {
	/** Rung name ('personal' | 'team' | 'public'). */
	rung: string;
	/** Wire handle ('@me' | '@team/<name>' | '@public'). */
	handle: string;
	/** Pinned registry version int. */
	version: number;
	/** Pinned display semver ('' on legacy rows). */
	appVersion: string;
	/** The bound deployment's review state. */
	state: string;
	/** Unix seconds of the pin move. */
	deployedAt?: number;
	// Serving truth (#2461) — absent from older servers.
	enabled?: boolean;
	serving?: boolean;
	reason?: string;
	servesYou?: boolean;
}

/** One deployment-history row as the SDK returns it (client.deploy.history). */
export interface WireHistoryRow {
	/** Stable append-order key. */
	seq: number;
	/** Unix seconds. */
	at: number;
	/** Machine action or the human row 'reply'. */
	action: string;
	/** Team scope of the row, when any. */
	teamId?: string | null;
	/** Registry version the row refers to. */
	version?: number | null;
	/** Denormalized actor record. */
	actor?: { userId?: string; display?: string; email?: string } | null;
	/** Self-describing row payload (see AppHistoryEntry.data). */
	data?: {
		side?: string;
		message?: string;
		audience?: { type?: string; id?: string; name?: string; handle?: string };
		previousVersion?: number;
		comment?: string;
		from?: string;
		to?: string;
	} | null;
}

// =============================================================================
// PROJECTIONS
// =============================================================================

/**
 * Maps version-rail rows to the shared {@link AppVersionInfo} shape.
 *
 * @param rail - Raw rail rows, newest first as the SDK returns them.
 * @returns The Deploy view's version entries.
 */
export function toVersionInfos(rail: WireRailEntry[]): AppVersionInfo[] {
	return rail.map((v) => ({
		// The registry int is the row identity end-to-end; the semver is
		// display-only (may repeat across deploys, '' on legacy rows).
		registryVersion: v.registryVersion,
		version: v.appVersion || '',
		author: v.author,
		publishedAt: v.publishedAt,
		sha: v.sha256,
		message: v.message,
		rungs: (v.rungs ?? []).filter((r): r is 'personal' | 'team' | 'public' => r === 'personal' || r === 'team' || r === 'public'),
		state: (v.state || undefined) as AppVersionInfo['state'],
		buildStatus: v.buildStatus,
	}));
}

/**
 * Maps where-live pins to the shared {@link RungPin} shape.
 *
 * @param pins - Raw pin rows from the SDK.
 * @param hasReviewLadder - Whether the server runs the review ladder (SaaS).
 * @returns The Where-live panel's rows.
 */
export function toRungPins(pins: WirePin[], hasReviewLadder: boolean): RungPin[] {
	return pins.map((p) => {
		const rung = (p.rung === 'personal' || p.rung === 'team' || p.rung === 'public' ? p.rung : 'personal') as 'personal' | 'team' | 'public';
		// p.state is the bound DEPLOYMENT's review state
		// (private|submit|ready|rejected). Internal rungs serve live;
		// on a review-ladder server the public rung shows the gate —
		// 'ready' = approved, anything else = still in review. Without
		// the ladder (OSS) a public pin serves as soon as it exists.
		const state: 'enabled' | 'approved' | 'pending' =
			rung !== 'public' ? 'enabled' : !hasReviewLadder || p.state === 'ready' ? 'approved' : 'pending';
		return {
			rung,
			label: rung.charAt(0).toUpperCase() + rung.slice(1),
			handle: p.handle,
			registryVersion: p.version,
			// RAW semver only ('' on legacy rows) — the view composes the
			// shared v<registry> + semver-pill format itself, so any
			// fallback text here would render as a bogus pill.
			version: p.appVersion || '',
			state,
			audience: rung === 'personal' ? 'on your desktop' : rung === 'public' ? 'the app store' : 'team members',
			deployedAt: p.deployedAt,
			// The server's serving truth (#2461): whether a browser in this
			// audience is actually served, why not, and whether this is the
			// pin the caller's own resolution picks.
			serving: p.serving,
			reason: p.reason,
			servesYou: p.servesYou,
		};
	});
}

/**
 * Walks the deployment-history pages into one oldest-first stream — the
 * server clamps page_size to 100 and pages NEWEST-FIRST, so both hosts
 * page through it with the same rules: 50-page defensive ceiling, a
 * short/empty page ends the walk even if `total` disagrees (rows deleted
 * between requests must not spin the loop), and the collected rows are
 * reversed into the oldest-first order the views render.
 *
 * @param fetchPage - Host page fetch (1-based page, pageSize 100).
 * @returns The full history projection, oldest first.
 */
export async function walkDeploymentHistory(fetchPage: (page: number, pageSize: number) => Promise<{ rows?: WireHistoryRow[]; total?: number } | undefined>): Promise<AppHistoryEntry[]> {
	const rows: WireHistoryRow[] = [];
	let total = Number.POSITIVE_INFINITY;
	for (let page = 1; rows.length < total && page <= 50; page += 1) {
		const envelope = await fetchPage(page, 100);
		const chunk = envelope?.rows ?? [];
		total = typeof envelope?.total === 'number' ? envelope.total : rows.length + chunk.length;
		if (chunk.length === 0) break;
		rows.push(...chunk);
		if (chunk.length < 100) break;
	}
	return toHistoryEntries(rows.reverse());
}

/**
 * Normalizes raw history rows (oldest-first) into the shared AppHistoryEntry
 * shape — SQL nulls become absent fields so the views only deal in one
 * vocabulary.
 *
 * @param rows - Raw rows, oldest first.
 * @returns The Dashboard's history entries, oldest first.
 */
export function toHistoryEntries(rows: WireHistoryRow[]): AppHistoryEntry[] {
	return rows.map((r) => ({
		seq: r.seq,
		at: r.at,
		action: r.action,
		version: r.version ?? undefined,
		actor: r.actor ?? undefined,
		data: r.data
			? {
					side: r.data.side === 'admin' || r.data.side === 'developer' ? r.data.side : undefined,
					// The audience marker is what separates a PUBLISH row (bind
					// to a rung) from the bare registry-write DEPLOY row.
					audience: r.data.audience,
					message: r.data.message,
					previousVersion: r.data.previousVersion,
					comment: r.data.comment,
					from: r.data.from,
					to: r.data.to,
				}
			: undefined,
	}));
}
