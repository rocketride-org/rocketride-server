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
// SETTINGS REGISTRY — flattened index of every contributor's configuration
// =============================================================================
//
// The registry is the single source of setting DECLARATIONS.  It is built by
// flattening the shell's own configuration (the "General" section), then the
// REGISTERED contributions (builtin/dev tools, host blocks — see
// settingsContributions.ts), then the `configuration` (VSCode
// contributes.configuration shape) of every app on the user's desktop.  It is
// rebuilt whenever the manifest changes (connect + shell:accountUpdate) or a
// contribution registers/unregisters.
//
// Values are a separate concern: setting OVERRIDES (deltas only) live in the
// owning contributor's partition file — see each schema's `store` and
// settingStoreOf().  The effective value of a key is
// `override ?? schema.default` — see effectiveSettings().
//
// =============================================================================

import type { AppManifestEntry, AppConfiguration, SettingSchema, SettingStore, SettingValue } from './types';
import type { SettingsContribution } from './settingsContributions';

/** Shell editions a registry build can target (AppManifestEntry.shells
 *  vocabulary). Absent on a setting/contribution = applies to all. */
export type ShellKind = 'saas' | 'oss' | 'vscode';

// =============================================================================
// SHELL SECTION — settings the shell itself contributes
// =============================================================================

/**
 * Reserved pseudo-app id for the shell's own settings section.  Dotted like a
 * real app id so section ids stay uniform; no manifest entry ever carries it.
 */
export const SHELL_SECTION_ID = 'rocketride.shell';

/**
 * The shell's own configuration — seeded into the registry ahead of every
 * app so the "General" section always exists (independent of what is
 * installed), tops the settings nav, and owns its keys (dedup is first-wins).
 */
const SHELL_CONFIGURATION: AppConfiguration = {
	title: 'General',
	properties: {
		'rocketride.general.sidebar': {
			type: 'string',
			default: 'default',
			// The sidebar-layout knob is a cloud-shell concern — the VS Code
			// host's chrome is VS Code's own. A USER setting: the person's own
			// preference, stored in the shell partition (global.json).
			store: 'user',
			shells: ['saas', 'oss'],
			enum: ['default', 'vscode', 'cursor', 'rocketride'],
			enumDescriptions: [
				'Let each app pick its own sidebar layout',
				'Activity rail beside a resizable panel (VS Code style)',
				'Panel with a horizontal tab strip across the top (Cursor style)',
				'Classic single column that iconifies when collapsed',
			],
			description: 'Sidebar layout for every app. Any choice other than Default overrides what the app requests. VS Code and Cursor layouts apply only to apps that declare rail views; apps with a classic sidebar keep the classic column.',
			order: 1,
		},
	},
};

// =============================================================================
// TYPES
// =============================================================================

/** One declared setting: its full dotted key plus its schema. */
export interface RegistryEntry {
	/** Full dotted setting key (e.g. 'rocketride.pipeBuilder.pipelineTraceLevel'). */
	key: string;
	/** The setting's JSON-Schema-style declaration. */
	schema: SettingSchema;
	/** The contributing owner's id (first-wins) — where a workspace-scoped
	 *  value's delta lives ({@link SHELL_SECTION_ID} for shell keys). */
	owner: string;
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
	/** Nav grouping (from the contribution) — sections sharing a group fold
	 *  under one expandable parent entry. Absent = a flat entry. */
	group?: { id: string; label: string };
	/** Top-level nav position (default 100; lower = higher). */
	order?: number;
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
	const spaced = seg
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
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

/** Options for {@link buildSettingsRegistry}. */
export interface RegistryBuildOptions {
	/**
	 * The running shell edition. When given, entries (and whole contributions)
	 * whose `shells` list excludes it are dropped — host-inapplicable settings
	 * never enter the registry. Absent = no filtering (every entry included).
	 */
	shell?: ShellKind;
	/**
	 * Registered non-app contributions (builtin/dev tools, host blocks) — the
	 * caller passes getSettingsContributions() and rebuilds on its change
	 * feed. Folded after the shell's section, before desktop apps (first-wins
	 * dedupe protects shell and contribution keys from app redeclaration).
	 */
	contributions?: readonly SettingsContribution[];
}

/** Whether a shells declaration admits the running edition. */
function servesShell(shells: string[] | undefined, shell: ShellKind | undefined): boolean {
	if (!shell || !shells || shells.length === 0) return true;
	return shells.includes(shell);
}

/**
 * Builds the settings registry from the current app manifest plus the
 * registered contributions.
 *
 * The shell's own configuration seeds the registry first, so "General" always
 * exists, tops the nav, and owns its keys.  Registered contributions follow
 * (builtins and pinned dev tools — see settingsContributions.ts), then only
 * apps on the user's desktop — an uninstalled app's settings never render.
 * Sections group by configuration title so contributors that declare a shared
 * title appear once; duplicate keys are deduplicated first-wins.
 *
 * @param appManifest - All app manifest entries (desktop + store).
 * @param options - Shell-edition filter and registered contributions.
 * @returns The flattened registry.
 */
export function buildSettingsRegistry(appManifest: AppManifestEntry[], options?: RegistryBuildOptions): SettingsRegistry {
	const shell = options?.shell;
	const sections: RegistrySection[] = [];
	const sectionByTitle = new Map<string, RegistrySection>();
	const schemas = new Map<string, SettingSchema>();
	const defaults: Record<string, SettingValue> = {};

	/** Folds one configuration into the registry (shell, contributions, apps).
	 *  `owner` overrides where workspace-scoped VALUES live (defaults to the
	 *  contributor's id) — builtin tools store into the product partition. */
	const addConfiguration = (appId: string, cfg: AppConfiguration, fallbackTitle: string, group?: { id: string; label: string }, owner?: string, order?: number): void => {
		// Drop edition-foreign entries and already-owned keys (first-wins)
		// BEFORE section resolution — a configuration that lands nothing
		// (edition-foreign, or every key stolen by an earlier contributor)
		// creates no empty section.
		const entries = Object.entries(cfg.properties).filter(
			([key, schema]) => servesShell(schema.shells, shell) && !schemas.has(key),
		);
		if (entries.length === 0) return;

		// Resolve (or create) the section for this configuration title
		const title = cfg.title || fallbackTitle;
		let section = sectionByTitle.get(title);
		if (!section) {
			section = { id: appId, title, appIds: [], entries: [], ...(group ? { group } : {}), ...(order !== undefined ? { order } : {}) };
			sectionByTitle.set(title, section);
			sections.push(section);
		}
		section.appIds.push(appId);

		for (const [key, schema] of entries) {
			schemas.set(key, schema);
			if (schema.default !== undefined) defaults[key] = schema.default;
			section.entries.push({ key, schema, owner: owner ?? appId });
		}
	};

	// The shell contributes first — "General" precedes every other section
	// General leads the nav (order 5 — ahead of Account at 10). On VS Code the
	// section vanishes entirely: its only setting today is cloud-shell-only
	// (sidebar layout), and an empty section is dropped by construction.
	addConfiguration(SHELL_SECTION_ID, SHELL_CONFIGURATION, 'General', undefined, undefined, 5);

	// Registered contributions next (builtins, pinned dev tools, host blocks)
	for (const contribution of options?.contributions ?? []) {
		if (!servesShell(contribution.shells, shell)) continue;
		addConfiguration(contribution.appId, contribution.configuration, contribution.name, contribution.group, contribution.storageAppId, contribution.order);
	}

	for (const app of appManifest) {
		// Only surface settings for apps the user has installed on their desktop
		if (!app.onDesktop) continue;
		const cfg = configurationOf(app);
		if (cfg) addConfiguration(app.id, cfg, app.name);
	}

	// Order entries within each section: explicit `order` first, then as declared
	for (const section of sections) {
		section.entries.sort((a, b) => (a.schema.order ?? Number.MAX_SAFE_INTEGER) - (b.schema.order ?? Number.MAX_SAFE_INTEGER));
	}

	return { sections, schemas, defaults };
}

// =============================================================================
// STORE RESOLUTION
// =============================================================================

/**
 * The store a setting's VALUE lives in — `schema.store`, defaulted to
 * `'workspace'`. The partition mapping (user → shell partition, workspace →
 * the entry's `owner` partition) is the VALUE layer's job; this helper only
 * normalizes the declaration.
 *
 * @param schema - The setting's declaration.
 * @returns The declared store, `'workspace'` when absent.
 */
export function settingStoreOf(schema: SettingSchema): SettingStore {
	return schema.store ?? 'workspace';
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
export function effectiveSettings(
	registry: SettingsRegistry,
	overrides: Record<string, SettingValue>,
): Record<string, SettingValue> {
	return { ...registry.defaults, ...overrides };
}
