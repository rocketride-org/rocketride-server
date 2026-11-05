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
// PREFLIGHT — the tiered readiness checks, ONE implementation for every host
// =============================================================================

/**
 * The App Builder's readiness bar, host-agnostic. 'package' rows are the
 * complete-and-buildable bar (all green = a personal @me/@team publish
 * just works); 'store' rows are the ADDITIONAL public-submission bar the
 * STORE tab gates its Submit button on. Hosts supply only their IO
 * (fileExists over native fs or the store VFS, the dependency probe) —
 * the check semantics live here so the two hosts can never drift.
 *
 * No dist/ check by design: deployment packs SOURCE and the server builds
 * the bundle itself, so a local build is never read or uploaded.
 */

import type { CompatVerdict } from './compatProbe';
import type { ListingDraft, PreflightCheck } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** The host IO the checks run against. */
export interface PreflightIO {
	/** Whether an APP-FOLDER-relative file exists. */
	fileExists: (rel: string) => Promise<boolean>;
	/** Whether a WORKSPACE-relative include entry exists (omit = skip rows). */
	includeExists?: (entry: string) => Promise<boolean>;
	/** Declared runtime dependencies (package.json), platform names included
	 * (they are filtered here). Omit = skip dependency rows. */
	dependencies?: Record<string, string>;
	/** The browser-compat probe (omit = skip dependency rows). */
	probeDependency?: (name: string, range: string) => Promise<CompatVerdict>;
}

/** Names the platform provides at runtime — never probed. */
const PLATFORM_DEPENDENCIES = new Set(['react', 'react-dom', 'shell', 'rocketride']);

// =============================================================================
// CHECKS
// =============================================================================

/**
 * Runs the tiered readiness checks.
 *
 * @param listing - The listing projection (null = no manifest at all).
 * @param io - The host IO.
 * @returns The check rows, package tier first.
 */
export async function runListingPreflight(listing: ListingDraft | null, io: PreflightIO): Promise<PreflightCheck[]> {
	const checks: PreflightCheck[] = [];
	if (!listing) {
		checks.push({ id: 'manifest', state: 'fail', label: 'App manifest', note: 'No package.json appManifest found for this app.', tier: 'package' });
		return checks;
	}

	// ── package tier — the personal-publish bar ──────────────────────────
	checks.push(listing.appId.includes('.') ? { id: 'appid', state: 'pass', label: 'App id namespaced', note: listing.appId, tier: 'package' } : { id: 'appid', state: 'fail', label: 'App id namespaced', note: `"${listing.appId}" must be <developerId>.<name>`, tier: 'package' });
	checks.push(listing.name ? { id: 'name', state: 'pass', label: 'Display name', note: listing.name, tier: 'package' } : { id: 'name', state: 'fail', label: 'Display name', note: 'appManifest.name is required.', tier: 'package' });

	// Icon/readme: a DECLARED path that does not resolve is a fail (the
	// manifest lies); undeclared is only a warn.
	if (listing.icon) {
		checks.push((await io.fileExists(listing.icon)) ? { id: 'icon', state: 'pass', label: 'Icon', note: listing.icon, tier: 'package' } : { id: 'icon', state: 'fail', label: 'Icon', note: `${listing.icon} does not exist in the app folder.`, tier: 'package' });
	} else {
		checks.push({ id: 'icon', state: 'warn', label: 'Icon', note: 'No icon declared, so tiles show a generic glyph.', tier: 'package' });
	}
	if (listing.readme) {
		checks.push((await io.fileExists(listing.readme)) ? { id: 'readme', state: 'pass', label: 'README', note: listing.readme, tier: 'package' } : { id: 'readme', state: 'fail', label: 'README', note: `${listing.readme} does not exist in the app folder.`, tier: 'package' });
	} else {
		checks.push({ id: 'readme', state: 'warn', label: 'README', note: 'No README declared. Recommended so users know what the app does.', tier: 'package' });
	}

	// Include paths are WORKSPACE-relative; a missing one fails the deploy
	// pack, so it fails here first, by name.
	const includeEntries = listing.include ?? [];
	if (includeEntries.length > 0 && io.includeExists) {
		const missing: string[] = [];
		for (const entry of includeEntries) {
			if (!(await io.includeExists(entry))) missing.push(entry);
		}
		checks.push(missing.length === 0 ? { id: 'include', state: 'pass', label: 'Include paths', note: `${includeEntries.length} path${includeEntries.length === 1 ? '' : 's'} resolve`, tier: 'package' } : { id: 'include', state: 'fail', label: 'Include paths', note: `Missing in the workspace: ${missing.join(', ')}`, tier: 'package' });
	}

	// The typecheck waiver is always VISIBLE, never silent — a deploy that
	// skips verification should read as a choice.
	if (listing.typecheck === false) {
		checks.push({ id: 'typecheck', state: 'warn', label: 'Strict type checking', note: 'Off, so the server builds without verifying types.', tier: 'package' });
	}

	// Dependency compat — the hard deploy gate for Node-only packages (a
	// typed Node dep typechecks fine and dies at import time; the probe is
	// what catches it, in BOTH hosts).
	if (io.dependencies && io.probeDependency) {
		const declared = Object.entries(io.dependencies).filter(([name]) => !PLATFORM_DEPENDENCIES.has(name));
		for (const [name, range] of declared) {
			try {
				const verdict = await io.probeDependency(name, range);
				if (verdict.verdict === 'incompatible') {
					checks.push({ id: `dep:${name}`, state: 'fail', label: `Dependency ${name}`, note: verdict.reasons.join(' '), tier: 'package' });
				} else if (verdict.verdict === 'degraded') {
					checks.push({ id: `dep:${name}`, state: 'warn', label: `Dependency ${name}`, note: verdict.reasons.join(' '), tier: 'package' });
				} else {
					checks.push({ id: `dep:${name}`, state: 'pass', label: `Dependency ${name}`, note: range || 'latest', tier: 'package' });
				}
			} catch (err) {
				checks.push({ id: `dep:${name}`, state: 'warn', label: `Dependency ${name}`, note: `Probe unavailable: ${err instanceof Error ? err.message : String(err)}`, tier: 'package' });
			}
		}
	}

	// ── store tier — the additional public-submission bar ────────────────
	checks.push(listing.description ? { id: 'desc', state: 'pass', label: 'Description', tier: 'store' } : { id: 'desc', state: 'fail', label: 'Description', note: 'A store listing needs a description.', tier: 'store' });
	if (listing.mode !== 'free') {
		checks.push(listing.plans.length > 0 ? { id: 'pricing', state: 'pass', label: 'Pricing plans', note: `${listing.plans.length} plan${listing.plans.length === 1 ? '' : 's'}`, tier: 'store' } : { id: 'pricing', state: 'fail', label: 'Pricing plans', note: `Mode "${listing.mode}" needs at least one plan.`, tier: 'store' });
	}

	return checks;
}
