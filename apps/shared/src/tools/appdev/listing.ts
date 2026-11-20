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
// LISTING PROJECTION — package.json appManifest <-> ListingDraft
// =============================================================================

/**
 * The store listing IS the app's package.json appManifest — these pure
 * projections read the draft out of a parsed package.json object and write
 * it back in, so every host (VSCode over native files, web over the store
 * VFS) shares one round-trip contract. The caller owns the read/parse and
 * serialize/write halves.
 */

import type { BillingPlan, ListingDraft } from './types';

/** A parsed package.json object carrying an appManifest block. */
export interface PackageJsonLike {
	/** npm package name (display-name fallback). */
	name?: string;
	/** Top-level semver — the control-plane version of a deploy. */
	version?: string;
	/** The appManifest block (created empty when absent). */
	appManifest?: Record<string, unknown>;
	/** Everything else rides along untouched. */
	[key: string]: unknown;
}

/**
 * Projects the listing draft out of a parsed package.json.
 *
 * @param pkg - The parsed package.json object.
 * @returns The listing projection (mode defaults to 'free').
 */
export function projectListing(pkg: PackageJsonLike): ListingDraft {
	const m = (pkg.appManifest ?? {}) as Record<string, unknown>;
	const mode = m.mode === 'subscription' || m.mode === 'paywall' ? m.mode : 'free';
	const billing = (m.billing ?? {}) as Record<string, unknown>;
	return {
		appId: typeof m.id === 'string' ? m.id : '',
		mode,
		name: typeof m.name === 'string' ? m.name : (pkg.name ?? ''),
		description: typeof m.description === 'string' ? m.description : '',
		plans: Array.isArray(billing.plans) ? (billing.plans as BillingPlan[]) : [],
		icon: typeof m.icon === 'string' ? m.icon : '',
		readme: typeof m.readme === 'string' ? m.readme : '',
		include: Array.isArray(m.include) ? m.include.filter((p): p is string => typeof p === 'string' && p.length > 0) : [],
		// Normalized: only an explicit false disables the gate.
		typecheck: m.typecheck !== false,
	};
}

/**
 * Writes the draft back into the parsed package.json's appManifest — name,
 * description, mode, billing.plans, and the packaging fields (icon, readme,
 * include, typecheck). Plan metadata rides along verbatim; other billing
 * keys are preserved. Empty values DELETE their key (an empty plan list
 * removes billing.plans and an emptied billing block entirely; '' icon or
 * readme and an empty include list drop the manifest key) so the manifest
 * never accumulates dead fields. Packaging fields are only touched when the
 * draft carries them (the STORE tab's save omits them; the PACKAGE tab's
 * save owns them).
 *
 * @param pkg - The parsed package.json object (mutated in place).
 * @param listing - The draft to persist.
 */
export function applyListing(pkg: PackageJsonLike, listing: ListingDraft): void {
	if (!pkg.appManifest) pkg.appManifest = {};
	const manifest = pkg.appManifest as Record<string, unknown>;
	manifest.name = listing.name;
	manifest.description = listing.description;
	manifest.mode = listing.mode;
	const billing = manifest.billing as Record<string, unknown> | undefined;
	if (listing.plans.length > 0) {
		manifest.billing = { ...(billing ?? {}), plans: listing.plans };
	} else if (billing) {
		delete billing.plans;
		if (Object.keys(billing).length === 0) delete manifest.billing;
	}
	if (listing.icon !== undefined) {
		if (listing.icon) manifest.icon = listing.icon;
		else delete manifest.icon;
	}
	if (listing.readme !== undefined) {
		if (listing.readme) manifest.readme = listing.readme;
		else delete manifest.readme;
	}
	if (listing.include !== undefined) {
		const entries = listing.include.map((p) => p.trim()).filter(Boolean);
		if (entries.length > 0) manifest.include = entries;
		else delete manifest.include;
	}
	if (listing.typecheck !== undefined) {
		// Only the non-default is stored: absent = strict (true).
		if (listing.typecheck) delete manifest.typecheck;
		else manifest.typecheck = false;
	}
}
