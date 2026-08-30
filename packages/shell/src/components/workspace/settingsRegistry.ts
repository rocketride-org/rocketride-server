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
// SETTINGS REGISTRY — flattened index of all desktop apps' configurations
// =============================================================================
//
// The registry is the single source of setting DECLARATIONS.  It is built by
// flattening the `configuration` (VSCode contributes.configuration shape) of
// every app on the user's desktop, and rebuilt whenever the manifest changes
// (connect + shell:accountUpdate → new appManifest → new registry).
//
// Values are a separate concern: `settings.json` stores per-user OVERRIDES
// only (deltas).  The effective value of a key is `override ?? schema.default`
// — see effectiveSettings().
//
// =============================================================================

import type { AppManifestEntry, AppConfiguration, SettingSchema, SettingValue } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** One declared setting: its full dotted key plus its schema. */
export interface RegistryEntry {
	/** Full dotted setting key (e.g. 'rocketride.pipeBuilder.pipelineTraceLevel'). */
	key: string;
	/** The setting's JSON-Schema-style declaration. */
	schema: SettingSchema;
}

/** A nav section on the settings page — one per configuration title. */
export interface RegistrySection {
	/** Stable section id (the first contributing app's id). */
	id: string;
	/** Display title (configuration.title, falling back to the app name). */
	title: string;
	/** Ids of every app contributing to this section. */
	appIds: string[];
	/** Ordered setting entries (schema `order` first, then declaration order). */
	entries: RegistryEntry[];
}

/** The flattened settings registry consumed by the settings page and context. */
export interface SettingsRegistry {
	/** Nav sections in first-contribution order. */
	sections: RegistrySection[];
	/** Every declared schema keyed by full setting key. */
	schemas: Map<string, SettingSchema>;
	/** Default values for every key that declares one. */
	defaults: Record<string, SettingValue>;
}

// =============================================================================
// LABEL DERIVATION
// =============================================================================

/**
 * Derives the display label from the last segment of a setting key,
 * VSCode-style: 'pipelineTraceLevel' → "Pipeline Trace Level" and
 * 'pipelineTTL' → "Pipeline TTL" (acronym runs are preserved).
 *
 * @param key - Full dotted setting key.
 * @returns Human-readable label for the settings page row.
 */
export function labelFromKey(key: string): string {
	// Take the last dotted segment — the setting name within the app namespace
	const seg = key.split('.').pop() ?? key;
	// Insert spaces at lower→Upper boundaries and between acronym runs and words
	const spaced = seg.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
	// Capitalize the first character
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// =============================================================================
// REGISTRY CONSTRUCTION
// =============================================================================

/**
 * Returns the app's configuration when it is a valid object-shaped
 * contribution ({@link AppConfiguration}), or null when the app declares no
 * settings or the value is malformed.
 *
 * @param app - An app manifest entry.
 * @returns The configuration, or null when absent/invalid.
 */
function configurationOf(app: AppManifestEntry): AppConfiguration | null {
	const cfg = app.configuration;
	if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
	if (!cfg.properties || typeof cfg.properties !== 'object') return null;
	return cfg;
}

/**
 * Builds the settings registry from the current app manifest.
 *
 * Only apps on the user's desktop contribute — an uninstalled app's settings
 * never render.  Sections group by configuration title so app families that
 * declare a shared title (and shared keys) appear once; duplicate keys across
 * apps are deduplicated first-wins.
 *
 * @param appManifest - All app manifest entries (desktop + store).
 * @returns The flattened registry.
 */
export function buildSettingsRegistry(appManifest: AppManifestEntry[]): SettingsRegistry {
	const sections: RegistrySection[] = [];
	const sectionByTitle = new Map<string, RegistrySection>();
	const schemas = new Map<string, SettingSchema>();
	const defaults: Record<string, SettingValue> = {};

	for (const app of appManifest) {
		// Only surface settings for apps the user has installed on their desktop
		if (!app.onDesktop) continue;
		const cfg = configurationOf(app);
		if (!cfg) continue;

		// Resolve (or create) the section for this configuration title
		const title = cfg.title || app.name;
		let section = sectionByTitle.get(title);
		if (!section) {
			section = { id: app.id, title, appIds: [], entries: [] };
			sectionByTitle.set(title, section);
			sections.push(section);
		}
		section.appIds.push(app.id);

		// Add each declared property, deduplicating keys first-wins
		for (const [key, schema] of Object.entries(cfg.properties)) {
			if (schemas.has(key)) continue;
			schemas.set(key, schema);
			if (schema.default !== undefined) defaults[key] = schema.default;
			section.entries.push({ key, schema });
		}
	}

	// Order entries within each section: explicit `order` first, then as declared
	for (const section of sections) {
		section.entries.sort((a, b) => (a.schema.order ?? Number.MAX_SAFE_INTEGER) - (b.schema.order ?? Number.MAX_SAFE_INTEGER));
	}

	return { sections, schemas, defaults };
}

// =============================================================================
// VALUE RESOLUTION
// =============================================================================

/**
 * Computes the effective settings map: every declared default overlaid with
 * the user's stored overrides.  Overrides for keys no longer in the registry
 * (uninstalled apps) pass through untouched so their values survive a
 * reinstall.
 *
 * @param registry  - The current settings registry.
 * @param overrides - The raw contents of settings.json (deltas only).
 * @returns Effective key → value map consumed by apps.
 */
export function effectiveSettings(registry: SettingsRegistry, overrides: Record<string, SettingValue>): Record<string, SettingValue> {
	return { ...registry.defaults, ...overrides };
}
