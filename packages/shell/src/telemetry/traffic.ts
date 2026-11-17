// =============================================================================
// TRAFFIC CLASS - init-time load classification.
//
// Tags prerendered, hidden and zero-viewport loads as a super property so the
// ad-network and background loads can be separated in analysis without ever
// dropping an event. Pure: unit-tested under node:test.
// =============================================================================

export type TrafficClass = 'visible' | 'hidden' | 'prerender' | 'zero_viewport';

export interface TrafficEnv {
	prerendering?: boolean;
	visibilityState?: string;
	innerWidth?: number;
	innerHeight?: number;
}

/** prerender wins, then a hidden document, then a zero innerWidth or innerHeight, else visible. */
export function classifyTraffic(env: TrafficEnv): TrafficClass {
	try {
		if (env.prerendering === true) return 'prerender';
		if (env.visibilityState === 'hidden') return 'hidden';
		const w = Number(env.innerWidth);
		const h = Number(env.innerHeight);
		if ((Number.isFinite(w) && w <= 0) || (Number.isFinite(h) && h <= 0)) return 'zero_viewport';
		return 'visible';
	} catch {
		return 'visible';
	}
}

/** Local and test hosts only: the rr_test super property is stamped for these. */
export function isTestHost(hostname: string): boolean {
	if (typeof hostname !== 'string' || hostname === '') return false;
	const h = hostname.toLowerCase();
	if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1') return true;
	return h.endsWith('.localhost') || h.endsWith('.test');
}
