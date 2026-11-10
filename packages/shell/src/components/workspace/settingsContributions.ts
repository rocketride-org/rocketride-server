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
// SETTINGS CONTRIBUTIONS — registration, not discovery
// =============================================================================
//
// Anything that is NOT a desktop app contributes its settings by REGISTERING
// them here: builtin dev tools register when the tool registers (registering
// the tool IS registering its settings), store dev tools register on pin and
// unregister on unpin, and a host registers its host-specific blocks. The
// settings page never hunts for contributors — only the hosts know concepts
// like "dev tool" exist; this module keeps the shell blind to them.
//
// Registration lifetime follows the FUNCTIONALITY's lifetime, not a tab's:
// a builtin's machinery is resident in the bundle (pipeline runs honor its
// settings even while its strip tab is disabled), so builtins register once
// per realm and never unregister; a store tool's functionality leaves on
// unpin, so its registration leaves with it. Values are untouched either
// way — a departed contributor's deltas stay in its partition file and
// revive on re-registration.
//
// Per-realm module state, like the builtin tool registry: each realm
// registers what IT serves.
// =============================================================================

import type { AppConfiguration } from './types';

/** One registered settings contribution (a non-app contributor's section). */
export interface SettingsContribution {
	/** The contributor's app/tool id (also the section's stable id and the
	 *  OWNER of its keys — the partition workspace-scoped values route to). */
	appId: string;
	/** Display name — the section-title fallback when the configuration
	 *  declares none. */
	name: string;
	/** Shell editions this contribution serves (AppManifestEntry.shells
	 *  vocabulary); absent = every shell. Entry-level `schema.shells` filters
	 *  further within a contribution. */
	shells?: string[];
	/**
	 * Nav grouping: sections sharing a group fold as children under one
	 * expandable parent entry in the settings nav (dev tools group under
	 * "Rocket Builder"). Absent = a flat top-level entry.
	 */
	group?: { id: string; label: string };
	/**
	 * STORAGE owner override: the app id whose partition file holds this
	 * contribution's workspace-scoped values. Absent = `appId`. Builtin tools
	 * route here to the product partition (`rocketride.pipeBuilder`) — they
	 * are host-resident and deliberately mint no partition files of their own.
	 */
	storageAppId?: string;
	/** Top-level nav position (default 100; lower = higher). */
	order?: number;
	/** The contributed settings (contributes.configuration shape). */
	configuration: AppConfiguration;
}

const contributions: SettingsContribution[] = [];
const listeners = new Set<() => void>();

function notify(): void {
	for (const cb of [...listeners]) cb();
}

/**
 * Registers a settings contribution. Re-registering an appId replaces the
 * previous contribution (idempotent for builtins that register at module
 * scope across remounts).
 *
 * @param contribution - The contributor's section.
 * @returns Unregister function — removes the contribution (store tools call
 *          it on unpin; builtins never do).
 */
export function registerSettings(contribution: SettingsContribution): () => void {
	const existing = contributions.findIndex((c) => c.appId === contribution.appId);
	if (existing >= 0) contributions.splice(existing, 1, contribution);
	else contributions.push(contribution);
	notify();
	return () => {
		const index = contributions.indexOf(contribution);
		if (index < 0) return; // already replaced or removed
		contributions.splice(index, 1);
		notify();
	};
}

/**
 * The registered contributions, in registration order.
 *
 * @returns A snapshot array (safe to hold across registrations).
 */
export function getSettingsContributions(): readonly SettingsContribution[] {
	return [...contributions];
}

/**
 * Subscribes to contribution changes (register/replace/unregister).
 *
 * @param cb - Change callback.
 * @returns Unsubscribe function.
 */
export function onSettingsContributionsChanged(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}
