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
// SETTINGS PAGE — VS Code-style settings with sidebar nav and search
// =============================================================================
//
// Layout: sidebar category nav on the left, scrollable settings on the right.
// Search bar filters settings across all sections.  Each section renders as
// a card.
//
// Pipeline secrets (ROCKETRIDE_* keys) are managed in Account → Profile.
// This page handles UI-only settings (trace level, preferences, etc.).
//
// Shell owns settings.json persistence via Workspace (updateSetting).
// =============================================================================

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shared/themes/styles';
import { useWorkspace } from '../../workspace/WorkspaceContext';
import { useShellConnection } from '../../connection/ConnectionContext';
import { ConnectionManager } from '../../connection/connection';
import type { AppSettingDefinition } from '../../workspace/types';

// =============================================================================
// SHELL SETTINGS — general settings owned by the shell, not any specific app
// =============================================================================

/** Settings definitions for the shell's "General" section. */
const SHELL_SETTINGS: AppSettingDefinition[] = [
	{
		key: 'ROCKETRIDE_TRACE_LEVEL',
		label: 'Pipeline Trace Level',
		description: 'Controls tracing verbosity for pipeline execution.',
		type: 'select',
		options: [
			{ value: 'none', label: 'None' },
			{ value: 'full', label: 'Full — step-by-step tracing' },
		],
		default: 'none',
	},
];

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	root: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		backgroundColor: 'var(--rr-bg-default)',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
	topBar: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		padding: '12px 20px',
		borderBottom: '1px solid var(--rr-border)',
		flexShrink: 0,
	} as CSSProperties,
	searchInput: {
		...commonStyles.inputField,
		flex: 1,
		maxWidth: 400,
	} as CSSProperties,
	body: {
		display: 'flex',
		flex: 1,
		overflow: 'hidden',
	} as CSSProperties,
	sidebar: {
		width: 200,
		flexShrink: 0,
		borderRight: '1px solid var(--rr-border)',
		overflowY: 'auto',
		padding: '12px 0',
	} as CSSProperties,
	navItem: (active: boolean): CSSProperties => ({
		display: 'block',
		width: '100%',
		padding: '6px 20px',
		fontSize: 13,
		color: active ? 'var(--rr-text-primary)' : 'var(--rr-text-secondary)',
		fontWeight: active ? 600 : 400,
		background: active ? 'var(--rr-bg-surface-alt)' : 'transparent',
		border: 'none',
		textAlign: 'left',
		cursor: 'pointer',
		borderLeft: active ? '2px solid var(--rr-brand)' : '2px solid transparent',
	}),
	content: {
		flex: 1,
		overflowY: 'auto',
		padding: '20px 0 64px',
	} as CSSProperties,
	contentInner: {
		maxWidth: 700,
		margin: '0 auto',
		padding: '0 24px',
	} as CSSProperties,
	sectionCard: {
		backgroundColor: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 10,
		overflow: 'hidden',
		marginBottom: 24,
	} as CSSProperties,
	sectionHeader: {
		padding: '14px 20px',
		borderBottom: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-surface-alt)',
		fontSize: 13,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	sectionBody: {
		padding: 20,
		display: 'flex',
		flexDirection: 'column',
		gap: 24,
	} as CSSProperties,
	settingRow: {
		display: 'flex',
		flexDirection: 'column',
		gap: 4,
	} as CSSProperties,
	settingLabel: {
		fontSize: 13,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	settingCategory: {
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	settingBold: {
		fontWeight: 600,
	} as CSSProperties,
	settingDesc: {
		margin: 0,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.5,
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Returns true if a setting key looks like it contains a secret value.
 *
 * @param key - The setting key to check.
 */
function isSensitive(key: string): boolean {
	return /key|secret|token|password|apikey/i.test(key);
}

/**
 * Returns true if a setting definition matches the search query.
 *
 * @param def   - The setting definition.
 * @param query - Lowercase search string.
 */
function matchesSearch(def: AppSettingDefinition, query: string): boolean {
	if (!query) return true;
	return (
		def.key.toLowerCase().includes(query) ||
		def.label.toLowerCase().includes(query) ||
		(def.description ?? '').toLowerCase().includes(query)
	);
}

// =============================================================================
// SETTING FIELD
// =============================================================================

/**
 * Renders a single setting in VS Code style: Category: **Label**, description, input.
 *
 * Supports four field types:
 * - `'text'`    — standard text / password input (default)
 * - `'select'`  — dropdown with fixed options
 * - `'service'` — dropdown populated from the cached service catalog
 * - `'envkey'`  — dropdown of server-side env key names, or free-text entry
 */
const SettingField: React.FC<{
	category: string;
	def: AppSettingDefinition;
	value: string;
	onChange: (key: string, value: string) => void;
	services: Record<string, unknown>;
	envKeys: string[];
}> = ({ category, def, value, onChange, services, envKeys }) => {
	const sensitive = def.type !== 'service' && def.type !== 'envkey' && isSensitive(def.key);
	const [revealed, setRevealed] = React.useState(false);

	// ── Header (shared by all types) ──────────────────────────────────────
	const header = (
		<>
			<div style={styles.settingLabel}>
				<span style={styles.settingCategory}>{category}: </span>
				<span style={styles.settingBold}>{def.label}</span>
				{def.required && !value && (
					<span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: 'var(--rr-color-error)' }}>Required</span>
				)}
			</div>
			{def.description && <p style={styles.settingDesc}>{def.description}</p>}
		</>
	);

	// ── type: select ──────────────────────────────────────────────────────
	if (def.type === 'select' && def.options) {
		return (
			<div style={styles.settingRow as CSSProperties}>
				{header}
				<select
					value={value || def.default || ''}
					onChange={(e) => onChange(def.key, e.target.value)}
					style={{ ...commonStyles.inputField, cursor: 'pointer', maxWidth: 400 } as CSSProperties}
				>
					{def.options.map((opt) => (
						<option key={opt.value} value={opt.value}>{opt.label}</option>
					))}
				</select>
			</div>
		);
	}

	// ── type: service — dropdown from cached service catalog ──────────────
	if (def.type === 'service') {
		// Filter services by classType when specified
		const filtered = Object.entries(services).filter(([, svc]) => {
			if (!def.classType) return true;
			const ct = (svc as any)?.classType;
			if (Array.isArray(ct)) return ct.includes(def.classType);
			return ct === def.classType;
		});

		return (
			<div style={styles.settingRow as CSSProperties}>
				{header}
				<select
					value={value || def.default || ''}
					onChange={(e) => onChange(def.key, e.target.value)}
					style={{ ...commonStyles.inputField, cursor: 'pointer', maxWidth: 400 } as CSSProperties}
				>
					{filtered.length === 0 && (
						<option value="">No services available</option>
					)}
					{filtered.map(([key, svc]) => (
						<option key={key} value={key}>
							{(svc as any)?.title ?? key}
						</option>
					))}
				</select>
			</div>
		);
	}

	// ── type: envkey — dropdown of env key names + free-text entry ────────
	if (def.type === 'envkey') {
		// Value is either a ${VAR_NAME} reference or a raw key string
		const isEnvRef = value.startsWith('${') && value.endsWith('}');
		const envRefName = isEnvRef ? value.slice(2, -1) : '';
		// "custom" when the user is typing a raw key, otherwise the env var name
		const mode = isEnvRef ? envRefName : (value ? 'custom' : '');

		return (
			<div style={styles.settingRow as CSSProperties}>
				{header}
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 400 } as CSSProperties}>
					<select
						value={mode}
						onChange={(e) => {
							const selected = e.target.value;
							if (selected === 'custom') {
								// Switch to free-text — clear value so user can type
								onChange(def.key, '');
							} else {
								// Wrap in ${} to mark as env key reference
								onChange(def.key, `\${${selected}}`);
							}
						}}
						style={{ ...commonStyles.inputField, cursor: 'pointer' } as CSSProperties}
					>
						<option value="">Select an option…</option>
						{envKeys.map((k) => (
							<option key={k} value={k}>{k}</option>
						))}
						<option value="custom">Enter key manually…</option>
					</select>
					{mode === 'custom' && (
						<input
							type={revealed ? 'text' : 'password'}
							value={isEnvRef ? '' : value}
							onChange={(e) => onChange(def.key, e.target.value)}
							placeholder="Paste your API key"
							style={{
								...commonStyles.inputField,
								fontFamily: 'var(--rr-font-mono, monospace)',
								border: `1px solid ${def.required && !value ? 'var(--rr-color-error)' : 'var(--rr-border-input)'}`,
							} as CSSProperties}
						/>
					)}
				</div>
			</div>
		);
	}

	// ── type: text (default) ──────────────────────────────────────────────
	return (
		<div style={styles.settingRow as CSSProperties}>
			{header}
			<div style={{ display: 'flex', gap: 8, alignItems: 'center', maxWidth: 400 }}>
				<input
					type={sensitive && !revealed ? 'password' : 'text'}
					value={value}
					onChange={(e) => onChange(def.key, e.target.value)}
					placeholder={sensitive ? '••••••••••••' : `Enter ${def.label}`}
					style={{
						...commonStyles.inputField,
						flex: 1,
						border: `1px solid ${def.required && !value ? 'var(--rr-color-error)' : 'var(--rr-border-input)'}`,
						fontFamily: sensitive ? 'var(--rr-font-mono, monospace)' : 'var(--rr-font-family)',
					} as CSSProperties}
				/>
				{sensitive && (
					<button
						onClick={() => setRevealed((v) => !v)}
						style={{
							padding: '8px 12px', borderRadius: 6, border: '1px solid var(--rr-border)',
							backgroundColor: 'transparent', color: 'var(--rr-text-secondary)',
							fontSize: 12, cursor: 'pointer', fontFamily: 'var(--rr-font-family)', whiteSpace: 'nowrap',
						}}
					>
						{revealed ? 'Hide' : 'Show'}
					</button>
				)}
			</div>
		</div>
	);
};

// =============================================================================
// SETTINGS PAGE
// =============================================================================

/** A section in the settings page (sidebar nav + content). */
interface SettingsSection {
	id: string;
	label: string;
	defs: AppSettingDefinition[];
}

/**
 * Shell-owned settings overlay with VS Code-style layout:
 * sidebar nav on the left, searchable settings on the right.
 *
 * Pipeline secrets (ROCKETRIDE_* API keys) are managed in Account → Profile.
 * This page handles UI-only settings (trace level, preferences).
 *
 */
const PIPE_BUILDER_APP_ID = 'rocketride.pipeBuilder';

const SettingsPage: React.FC = () => {
	const { appManifest, settings, updateSetting } = useWorkspace();
	const { client, isConnected } = useShellConnection();
	const [draft, setDraft] = useState<Record<string, string>>({});
	const [saved, setSaved] = useState(false);
	const [search, setSearch] = useState('');
	const [selectedNav, setSelectedNav] = useState<string | null>(null);

	// ── Subscription status ─────────────────────────────────────────────
	const info = client?.getAccountInfo();
	const pipeBuilderApp = (info?.apps ?? []).find((a: any) => a.id === PIPE_BUILDER_APP_ID);
	const isSubscribed = pipeBuilderApp?.appStatus === 'subscribed' || pipeBuilderApp?.appStatus === 'trialing';

	/** Opens the checkout modal via the shell:subscribe event. */
	const handleSubscribe = useCallback(() => {
		if (!pipeBuilderApp) return;
		ConnectionManager.getInstance().emit('shell:subscribe', { app: pipeBuilderApp });
	}, [pipeBuilderApp]);

	// ── Services from cached catalog ─────────────────────────────────────
	const [services, setServices] = useState<Record<string, unknown>>({});

	useEffect(() => {
		// Read initial cached value
		const cached = ConnectionManager.getInstance().getCachedServices();
		setServices(cached.services);
		// Subscribe to updates (lazy fetch fires if cache was empty)
		const unsub = ConnectionManager.getInstance().on('shell:servicesUpdated', ({ services: s }) => {
			setServices(s);
		});
		return unsub;
	}, []);

	// ── Environment key names from account ───────────────────────────────
	const [envKeys, setEnvKeys] = useState<string[]>([]);

	useEffect(() => {
		if (!client || !isConnected) return;
		client.account.getEnvironmentKeys()
			.then((keys: string[]) => setEnvKeys(keys))
			.catch(() => {});
	}, [client, isConnected]);

	// Build all sections for nav + rendering.
	// Settings with identical keys across multiple apps are deduplicated —
	// shown once under a combined label (e.g. "Games") rather than repeated
	// in each app's section.
	const sections = useMemo<SettingsSection[]>(() => {
		const result: SettingsSection[] = [];

		// General (shell)
		if (SHELL_SETTINGS.length > 0) {
			result.push({ id: 'general', label: 'General', defs: SHELL_SETTINGS });
		}

		// Track which setting keys have already been placed in a section
		const seenKeys = new Set<string>();
		// Group apps by their exact set of setting keys to detect shared settings
		const keySignature = (defs: AppSettingDefinition[]) => defs.map((d) => d.key).sort().join(',');
		const groups = new Map<string, { apps: typeof appManifest; defs: AppSettingDefinition[] }>();

		for (const app of appManifest) {
			// appManifest is the full catalog; only surface settings for apps the user has
			// actually installed (on their desktop). Without this, an uninstalled app's
			// settings (e.g. Aparavi AQL) would appear for everyone. Shell "General"
			// settings above are unaffected and always shown.
			if (!app.onDesktop) continue;
			const appSettings = app.settings ?? [];
			if (appSettings.length === 0) continue;
			const sig = keySignature(appSettings);
			const existing = groups.get(sig);
			if (existing) {
				existing.apps.push(app);
			} else {
				groups.set(sig, { apps: [app], defs: appSettings });
			}
		}

		for (const { apps, defs } of groups.values()) {
			// Deduplicate: skip settings already shown in a prior group
			const uniqueDefs = defs.filter((d) => !seenKeys.has(d.key));
			if (uniqueDefs.length === 0) continue;
			uniqueDefs.forEach((d) => seenKeys.add(d.key));

			// Use a combined label when multiple apps share the same settings
			const label = apps.length > 1
				? (apps[0].categories?.includes('games') ? 'Games' : apps.map((a) => a.name).join(', '))
				: apps[0].name;
			const id = apps.length > 1 ? `group:${apps[0].id}` : apps[0].id;
			result.push({ id, label, defs: uniqueDefs });
		}

		return result;
	}, [appManifest]);

	// Filter sections by search query and sidebar selection
	const query = search.toLowerCase().trim();

	// The selected settings "page". Defaults to the first section (General) and falls
	// back to it if a previously-selected app section is no longer present.
	const effectiveNav = useMemo(() => {
		if (selectedNav && sections.some((s) => s.id === selectedNav)) return selectedNav;
		return sections[0]?.id ?? null;
	}, [selectedNav, sections]);

	const visibleSections = useMemo(() => {
		// Search spans every section so matches aren't hidden by the current page.
		if (query) {
			return sections
				.map((sec) => ({
					...sec,
					defs: sec.defs.filter((d) => matchesSearch(d, query)),
				}))
				.filter((sec) => sec.defs.length > 0);
		}

		// Otherwise show only the selected section — each nav button is its own page.
		return sections.filter((sec) => sec.id === effectiveNav);
	}, [sections, effectiveNav, query]);

	/**
	 * Returns the current value for any settings key, preferring draft over saved.
	 */
	const getValue = useCallback(
		(key: string) => draft[key] ?? settings[key] ?? '',
		[draft, settings],
	);

	/**
	 * Handles a setting value change — stores in draft until Save is clicked.
	 */
	const handleChange = useCallback((key: string, value: string) => {
		setDraft((prev) => ({ ...prev, [key]: value }));
		setSaved(false);
	}, []);

	/**
	 * Persists all draft changes to the workspace settings store.
	 */
	const handleSave = useCallback(() => {
		for (const [key, value] of Object.entries(draft)) {
			updateSetting(key, value);
		}
		setDraft({});
		setSaved(true);
		setTimeout(() => setSaved(false), 3000);
	}, [draft, updateSetting]);

	const isDirty = Object.keys(draft).length > 0;
	const hasAny = visibleSections.length > 0;

	return (
		<div style={styles.root}>
			{/* ── Top bar: search + save + close ─────────────────── */}
			<div style={styles.topBar}>
				<input
					type="text"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search settings…"
					style={styles.searchInput as CSSProperties}
				/>
				{saved && (
					<span style={{ fontSize: 13, color: 'var(--rr-color-success)' }}>Saved</span>
				)}
				{isDirty && (
					<>
						<button
							onClick={() => { setDraft({}); setSaved(false); }}
							style={{
								...commonStyles.buttonSecondary,
								fontFamily: 'var(--rr-font-family)',
							} as CSSProperties}
						>
							Cancel
						</button>
						<button
							onClick={handleSave}
							style={{
								...commonStyles.buttonPrimary,
								fontWeight: 600,
								fontFamily: 'var(--rr-font-family)',
							} as CSSProperties}
						>
							Save
						</button>
					</>
				)}
			</div>

			{/* ── Body: sidebar + content ─────────────────────────── */}
			<div style={styles.body}>
				{/* ── Sidebar nav ─────────────────────────────────── */}
				<nav style={styles.sidebar as CSSProperties}>
					{sections.map((sec) => (
						<button
							key={sec.id}
							style={styles.navItem(sec.id === effectiveNav)}
							onClick={() => setSelectedNav(sec.id)}
						>
							{sec.label}
						</button>
					))}
				</nav>

				{/* ── Content area ────────────────────────────────── */}
				<div style={styles.content as CSSProperties}>
					<div style={styles.contentInner}>
						{/* Subscribe prompt for unsubscribed users */}
						{info && pipeBuilderApp && !isSubscribed && (
							<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', marginBottom: 16, borderRadius: 10, border: '1px solid var(--rr-border)', background: 'var(--rr-bg-titleBar-inactive)' }}>
								<span style={{ fontSize: 13, color: 'var(--rr-text-secondary)' }}>
									Subscribe to unlock pipeline execution and deployment.
								</span>
								<button onClick={handleSubscribe} style={{ ...commonStyles.buttonPrimary, fontFamily: 'var(--rr-font-family)', fontWeight: 600, whiteSpace: 'nowrap' } as CSSProperties}>
									Subscribe to RocketRide
								</button>
							</div>
						)}
						{!hasAny && (
							<div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--rr-text-disabled)', fontSize: 14 }}>
								{query ? 'No settings match your search.' : 'No settings defined.'}
							</div>
						)}

						{visibleSections.map((sec) => (
							<section key={sec.id} style={styles.sectionCard}>
								<div style={styles.sectionHeader}>{sec.label}</div>
								<div style={styles.sectionBody as CSSProperties}>
									{sec.defs.map((def) => (
										<SettingField
											key={def.key}
											category={sec.label}
											def={def}
											value={getValue(def.key)}
											onChange={handleChange}
											services={services}
											envKeys={envKeys}
										/>
									))}
								</div>
							</section>
						))}
					</div>
				</div>
			</div>
		</div>
	);
};

export default SettingsPage;
