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
// SETTINGS PAGE — VSCode-style settings editor rendered from the registry
// =============================================================================
//
// Declarations come from the settings registry (each desktop app's
// contributes.configuration flattened by WorkspaceContext); values are the
// per-user overrides in .workspace/settings.json (deltas only — defaults live
// in the schemas).
//
// Behaviour (per the approved design):
// - Left nav: one entry per registry section (= app / shared title).
//   Selecting a section shows ONLY that section's settings.
// - Search: switches to a cross-app results view spanning all sections.
// - Rows: "<Section>: <Derived Label>" — labels derive from the key, there is
//   no label field.  Description carries a muted "Default: x" hint.
// - Modified indicator: accent bar when the key is present in the overrides;
//   per-row gear menu offers Reset to default (deletes the key) and
//   Copy Setting ID.
// - Edits are BUFFERED in a local draft (the DetailPanel edit-mode pattern):
//   a bottom Save/Cancel footer appears once the draft diverges from the
//   committed overrides. Save commits each changed key via updateSetting
//   (deltas-only — a value equal to the schema default deletes the override);
//   Cancel discards the draft.
//
// =============================================================================

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../themes/styles';
import { ContentHeader } from '../components/content-header/ContentHeader';
import { useWorkspace } from '../components/workspace/WorkspaceContext';
import { useShellConnection } from '../connection/ConnectionContext';
import { ConnectionManager } from '../connection/connection';
import { labelFromKey } from '../components/workspace/settingsRegistry';
import type { RegistryEntry, RegistrySection } from '../components/workspace/settingsRegistry';
import type { SettingValue } from '../components/workspace/types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** App id of the Pipeline Builder — used for the subscribe banner. */
const PIPE_BUILDER_APP_ID = 'rocketride.pipeBuilder';

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
	searchRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		padding: '16px 24px 12px',
		borderBottom: '1px solid var(--rr-border)',
		flexShrink: 0,
	} as CSSProperties,
	searchInput: {
		...commonStyles.inputField,
		flex: 1,
		maxWidth: 480,
	} as CSSProperties,
	searchCount: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		whiteSpace: 'nowrap',
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
		padding: '12px 8px',
		backgroundColor: 'var(--rr-bg-surface-alt)',
	} as CSSProperties,
	// Selectable nav row — the shared listRow pill (same shape/inset as the
	// pipelines list and SidebarMenu) plus the button reset + active weight.
	navItem: (active: boolean): CSSProperties => ({
		...commonStyles.listRow(active),
		width: '100%',
		margin: '1px 0',
		border: 'none',
		textAlign: 'left',
		fontWeight: active ? 600 : 400,
		fontFamily: 'var(--rr-font-family)',
	}),
	content: {
		flex: 1,
		overflowY: 'auto',
		padding: '4px 28px 48px 20px',
	} as CSSProperties,
	sectionHead: {
		padding: '18px 0 2px 12px',
		display: 'flex',
		alignItems: 'baseline',
		gap: 8,
	} as CSSProperties,
	sectionTitle: {
		fontSize: 17,
		fontWeight: 500,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	sectionAppId: {
		fontSize: 11,
		color: 'var(--rr-text-disabled)',
	} as CSSProperties,
	row: (modified: boolean): CSSProperties => ({
		position: 'relative',
		margin: '6px 0',
		padding: '10px 12px 12px 12px',
		borderLeft: `3px solid ${modified ? 'var(--rr-accent)' : 'transparent'}`,
		borderRadius: 3,
	}),
	rowLabel: {
		fontSize: 13,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		paddingRight: 34,
	} as CSSProperties,
	rowCategory: {
		color: 'var(--rr-text-secondary)',
		fontWeight: 400,
	} as CSSProperties,
	rowDesc: {
		margin: '4px 0 8px 0',
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.5,
		maxWidth: 640,
	} as CSSProperties,
	rowDefaultHint: {
		color: 'var(--rr-text-disabled)',
	} as CSSProperties,
	requiredBadge: {
		marginLeft: 6,
		fontSize: 11,
		fontWeight: 600,
		color: 'var(--rr-color-error)',
	} as CSSProperties,
	control: {
		...commonStyles.inputField,
		maxWidth: 400,
	} as CSSProperties,
	checkRow: {
		display: 'flex',
		gap: 8,
		alignItems: 'flex-start',
		maxWidth: 640,
		marginTop: 6,
	} as CSSProperties,
	gearWrap: {
		position: 'absolute',
		top: 8,
		right: 8,
	} as CSSProperties,
	gearButton: {
		border: 'none',
		background: 'transparent',
		cursor: 'pointer',
		width: 26,
		height: 26,
		borderRadius: 4,
		color: 'var(--rr-text-secondary)',
		fontSize: 14,
		lineHeight: '26px',
		textAlign: 'center',
	} as CSSProperties,
	menu: {
		position: 'absolute',
		right: 0,
		top: 28,
		zIndex: 10,
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		boxShadow: '0 4px 14px rgba(0, 0, 0, 0.18)',
		minWidth: 170,
		padding: '4px 0',
	} as CSSProperties,
	menuItem: (disabled: boolean): CSSProperties => ({
		display: 'block',
		width: '100%',
		textAlign: 'left',
		padding: '6px 12px',
		border: 'none',
		background: 'transparent',
		fontSize: 13,
		fontFamily: 'var(--rr-font-family)',
		cursor: disabled ? 'default' : 'pointer',
		color: disabled ? 'var(--rr-text-disabled)' : 'var(--rr-text-primary)',
	}),
	manageLink: {
		fontSize: 12,
		color: 'var(--rr-color-info)',
		background: 'none',
		border: 'none',
		padding: 0,
		marginTop: 6,
		cursor: 'pointer',
		textAlign: 'left',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
	noResults: {
		padding: '40px 0',
		textAlign: 'center',
		color: 'var(--rr-text-disabled)',
		fontSize: 14,
	} as CSSProperties,
	footer: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		gap: 8,
		padding: '12px 20px',
		borderTop: '1px solid var(--rr-border)',
		flexShrink: 0,
		backgroundColor: 'var(--rr-bg-default)',
	} as CSSProperties,
	footerCancel: { ...commonStyles.buttonSecondary, fontFamily: 'var(--rr-font-family)' } as CSSProperties,
	footerSave: { ...commonStyles.buttonPrimary, fontFamily: 'var(--rr-font-family)' } as CSSProperties,
};

// =============================================================================
// SETTING ROW
// =============================================================================

/**
 * Renders a single setting: "<Section>: <Derived Label>", description with a
 * muted default hint, the schema-appropriate control, a modified accent bar,
 * and a gear menu (Reset to default / Copy Setting ID).
 *
 * Control selection by schema:
 * - `enum`                        — dropdown of the fixed choices
 * - `type: 'boolean'`             — checkbox with inline description
 * - `type: 'number' | 'integer'`  — numeric input
 * - `format: 'rocketride.envkey'` — Variable-name picker (never a secret value)
 * - `format: 'rocketride.service'`— service dropdown from the cached catalog
 * - otherwise                     — text input
 */
const SettingRow: React.FC<{
	category: string;
	entry: RegistryEntry;
	value: SettingValue | undefined;
	modified: boolean;
	menuOpen: boolean;
	envKeys: string[];
	services: Record<string, unknown>;
	onChange: (key: string, value: SettingValue | undefined) => void;
	onToggleMenu: (key: string | null) => void;
}> = ({ category, entry, value, modified, menuOpen, envKeys, services, onChange, onToggleMenu }) => {
	const { key, schema } = entry;
	const label = labelFromKey(key);
	const description = schema.description ?? schema.markdownDescription ?? '';
	// Hovering reveals the gear; menuOpen pins it
	const [hovered, setHovered] = useState(false);

	/** Opens the Variables overlay for envkey settings. */
	const openVariables = useCallback(() => {
		ConnectionManager.getInstance().emit('shell:openOverlay', { id: 'environment' });
	}, []);

	// ── Default hint appended to the description ──────────────────────────
	// Enum defaults show their friendly enumDescriptions label when declared
	const defaultEnumIndex = schema.enum && schema.default !== undefined ? schema.enum.findIndex((opt) => String(opt) === String(schema.default)) : -1;
	const defaultText = defaultEnumIndex >= 0 ? (schema.enumDescriptions?.[defaultEnumIndex] ?? String(schema.default)) : String(schema.default);
	const defaultHint = schema.default !== undefined && schema.default !== '' ? <span style={styles.rowDefaultHint}> Default: {defaultText}</span> : null;

	// ── Header: "<Section>: <Label>" + required badge ─────────────────────
	const header = (
		<div style={styles.rowLabel}>
			<span style={styles.rowCategory}>{category}: </span>
			{label}
			{schema.required && (value === undefined || value === '') && <span style={styles.requiredBadge}>Required</span>}
		</div>
	);

	// ── Gear menu (shared by all control types) ───────────────────────────
	const gear = (
		<div style={styles.gearWrap}>
			{(hovered || menuOpen) && (
				<button
					style={styles.gearButton}
					title="More actions"
					onClick={(e) => {
						e.stopPropagation();
						onToggleMenu(menuOpen ? null : key);
					}}
				>
					<svg width="14" height="14" viewBox="0 0 16 16" style={{ display: 'block', margin: '0 auto' }}>
						<path fill="currentColor" d="M9.1 4.4l.6-2.4H6.3l.6 2.4-1.2.7-2.1-1.2-1.7 3 2.1 1.2v1.8l-2.1 1.2 1.7 3 2.1-1.2 1.2.7-.6 2.4h3.4l-.6-2.4 1.2-.7 2.1 1.2 1.7-3-2.1-1.2V7.9l2.1-1.2-1.7-3-2.1 1.2zM8 10.3a2.3 2.3 0 110-4.6 2.3 2.3 0 010 4.6z" />
					</svg>
				</button>
			)}
			{menuOpen && (
				<div style={styles.menu}>
					<button
						style={styles.menuItem(!modified)}
						disabled={!modified}
						onClick={() => {
							onChange(key, undefined);
							onToggleMenu(null);
						}}
					>
						Reset to default
					</button>
					<button
						style={styles.menuItem(false)}
						onClick={() => {
							navigator.clipboard?.writeText(key).catch(() => {});
							onToggleMenu(null);
						}}
					>
						Copy Setting ID
					</button>
				</div>
			)}
		</div>
	);

	// ── Control by schema type/format ─────────────────────────────────────
	let control: React.ReactNode;

	if (schema.type === 'boolean') {
		// Boolean: checkbox with the description inline (VSCode-style)
		control = (
			<div style={styles.checkRow}>
				<input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(key, e.target.checked)} style={{ marginTop: 3, accentColor: 'var(--rr-accent)' }} />
				<p style={{ ...styles.rowDesc, margin: 0 }}>
					{description}
					{defaultHint}
				</p>
			</div>
		);
	} else if (schema.enum) {
		// Enum: dropdown of fixed choices — option text prefers the aligned
		// enumDescriptions entry (friendly label) over the raw value. Numeric
		// schemas store the selected value as a number, not its string form.
		const coerceEnum = (raw: string): SettingValue => (schema.type === 'integer' || schema.type === 'number' ? Number(raw) : raw);
		control = (
			<select value={String(value ?? '')} onChange={(e) => onChange(key, coerceEnum(e.target.value))} style={{ ...styles.control, cursor: 'pointer' }}>
				{schema.enum.map((opt, i) => (
					<option key={String(opt)} value={String(opt)}>
						{schema.enumDescriptions?.[i] ?? String(opt)}
					</option>
				))}
			</select>
		);
	} else if (schema.format === 'rocketride.envkey') {
		// Envkey: pick the NAME of a server-side Variable — never a secret value
		control = (
			<div style={{ display: 'flex', flexDirection: 'column', maxWidth: 400 }}>
				<select value={String(value ?? '')} onChange={(e) => onChange(key, e.target.value === '' ? undefined : e.target.value)} style={{ ...styles.control, cursor: 'pointer' }}>
					<option value="">(not set)</option>
					{envKeys.map((k) => (
						<option key={k} value={k}>
							{k}
						</option>
					))}
				</select>
				<button style={styles.manageLink} onClick={openVariables}>
					Manage variables
				</button>
			</div>
		);
	} else if (schema.format === 'rocketride.service') {
		// Service: dropdown from the cached service catalog, filtered by classType
		const filtered = Object.entries(services).filter(([, svc]) => {
			if (!schema.classType) return true;
			const ct = (svc as { classType?: string | string[] })?.classType;
			return Array.isArray(ct) ? ct.includes(schema.classType) : ct === schema.classType;
		});
		control = (
			<select value={String(value ?? '')} onChange={(e) => onChange(key, e.target.value)} style={{ ...styles.control, cursor: 'pointer' }}>
				{filtered.length === 0 && <option value="">No services available</option>}
				{filtered.map(([svcKey, svc]) => (
					<option key={svcKey} value={svcKey}>
						{(svc as { title?: string })?.title ?? svcKey}
					</option>
				))}
			</select>
		);
	} else if (schema.type === 'number' || schema.type === 'integer') {
		// Number: numeric input; clearing the field resets to default
		control = (
			<input
				type="number"
				value={value === undefined ? '' : String(value)}
				onChange={(e) => {
					const raw = e.target.value;
					if (raw === '') {
						onChange(key, undefined);
						return;
					}
					const num = Number(raw);
					if (!Number.isNaN(num)) onChange(key, num);
				}}
				style={{ ...styles.control, maxWidth: 140 }}
			/>
		);
	} else {
		// String (default): plain text input
		control = <input type="text" value={String(value ?? '')} onChange={(e) => onChange(key, e.target.value)} placeholder={schema.placeholder} style={styles.control} />;
	}

	return (
		<div style={styles.row(modified)} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
			{header}
			{/* Boolean rows carry the description inline next to the checkbox */}
			{schema.type !== 'boolean' && description && (
				<p style={styles.rowDesc}>
					{description}
					{defaultHint}
				</p>
			)}
			{schema.type !== 'boolean' && !description && defaultHint && <p style={styles.rowDesc}>{defaultHint}</p>}
			{control}
			{gear}
		</div>
	);
};

// =============================================================================
// SETTINGS PAGE
// =============================================================================

/**
 * Returns true when a registry entry matches the search query — matched
 * against the full key, the derived label, and the description.
 *
 * @param entry - The registry entry to test.
 * @param query - Lowercase search string.
 */
function matchesSearch(entry: RegistryEntry, query: string): boolean {
	const haystack = `${entry.key} ${labelFromKey(entry.key)} ${entry.schema.description ?? ''}`.toLowerCase();
	return haystack.includes(query);
}

/**
 * Shell-owned settings overlay, VSCode-style, rendered entirely from the
 * settings registry.
 *
 * Two view modes: with no search text only the nav-selected app's section
 * renders; typing a search switches to a cross-app results view spanning
 * every section.  All edits apply immediately (deltas-only persistence).
 */
const SettingsProvider: React.FC = () => {
	const { settingsRegistry, settingsOverrides, updateSetting } = useWorkspace();

	// -- Buffered edit model (matches VSCode settings + DetailPanel) -----------
	// Edits collect in a local draft layered over the committed overrides; the
	// Save/Cancel footer commits or discards them (deltas-only, like updateSetting).
	const [draft, setDraft] = useState<Record<string, SettingValue>>(() => ({ ...settingsOverrides }));

	// Unsaved edits exist when the draft diverges from the committed overrides.
	const dirty = useMemo(() => {
		const keys = new Set([...Object.keys(draft), ...Object.keys(settingsOverrides)]);
		for (const k of keys) {
			if (draft[k] !== settingsOverrides[k]) return true;
		}
		return false;
	}, [draft, settingsOverrides]);

	// Re-sync the draft when the committed overrides change externally, but only
	// while there are no local edits so a background update never clobbers them.
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;
	useEffect(() => {
		if (!dirtyRef.current) setDraft({ ...settingsOverrides });
	}, [settingsOverrides]);

	/**
	 * Stage a setting change in the draft with deltas-only semantics: a value
	 * equal to the schema default (or undefined) drops the key entirely.
	 */
	const handleDraftChange = useCallback(
		(key: string, value: SettingValue | undefined) => {
			setDraft((prev) => {
				const next = { ...prev };
				const def = settingsRegistry.defaults[key];
				if (value === undefined || value === def) delete next[key];
				else next[key] = value;
				return next;
			});
		},
		[settingsRegistry]
	);

	/** Commit the draft: write changed keys and reset removed keys to their default. */
	const handleSave = useCallback(() => {
		Object.keys(draft).forEach((k) => {
			if (draft[k] !== settingsOverrides[k]) updateSetting(k, draft[k]);
		});
		Object.keys(settingsOverrides).forEach((k) => {
			if (!(k in draft)) updateSetting(k, undefined);
		});
	}, [draft, settingsOverrides, updateSetting]);

	/** Discard the draft, reverting every control to the committed values. */
	const handleCancel = useCallback(() => setDraft({ ...settingsOverrides }), [settingsOverrides]);

	/**
	 * The typed effective value of a key: the raw override when present,
	 * otherwise the schema default.  The controls need the TYPED value (a
	 * boolean checkbox, a numeric input), so this reads the typed overrides and
	 * registry defaults rather than the stringified public `settings` map.
	 *
	 * @param key - The full dotted setting key.
	 * @returns The effective value, or undefined when neither is set.
	 */
	const effectiveValue = useCallback(
		(key: string): SettingValue | undefined => {
			return key in draft ? draft[key] : settingsRegistry.schemas.get(key)?.default;
		},
		[draft, settingsRegistry]
	);
	const { client, isConnected } = useShellConnection();
	const [search, setSearch] = useState('');
	const [selectedNav, setSelectedNav] = useState<string | null>(null);
	// Key of the row whose gear menu is open (null = none)
	const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);

	// ── Subscription status (pipeBuilder upsell banner) ────────────────────
	const info = client?.getAccountInfo();
	const pipeBuilderApp = (info?.apps ?? []).find((a: any) => a.id === PIPE_BUILDER_APP_ID);
	const isSubscribed = pipeBuilderApp?.appStatus === 'subscribed' || pipeBuilderApp?.appStatus === 'trialing';

	/** Opens the checkout modal via the shell:subscribe event. */
	const handleSubscribe = useCallback(() => {
		if (!pipeBuilderApp) return;
		// The SDK AppManifestEntry structurally satisfies the minimal
		// ShellAppEntry contract, so it is passed directly.
		ConnectionManager.getInstance().emit('shell:subscribe', { app: pipeBuilderApp });
	}, [pipeBuilderApp]);

	// ── Services from cached catalog (for format 'rocketride.service') ────
	const [services, setServices] = useState<Record<string, unknown>>({});

	useEffect(() => {
		// Read initial cached value
		const cached = ConnectionManager.getInstance().getCachedServices();
		setServices(cached.services);
		// Subscribe to updates (lazy fetch fires if cache was empty)
		return ConnectionManager.getInstance().on('shell:servicesUpdated', ({ services: s }) => {
			setServices(s);
		});
	}, []);

	// ── Variable names from account (for format 'rocketride.envkey') ──────
	const [envKeys, setEnvKeys] = useState<string[]>([]);

	useEffect(() => {
		if (!client || !isConnected) return;
		client.account
			.getEnvironmentKeys()
			.then((keys: string[]) => setEnvKeys(keys))
			.catch(() => {});
	}, [client, isConnected]);

	// ── Close any open gear menu on outside click ──────────────────────────
	useEffect(() => {
		if (!openMenuKey) return;
		const close = () => setOpenMenuKey(null);
		document.addEventListener('click', close);
		return () => document.removeEventListener('click', close);
	}, [openMenuKey]);

	// ── Section selection + view mode ──────────────────────────────────────
	const { sections } = settingsRegistry;
	const query = search.toLowerCase().trim();

	// The selected section — defaults to the first, falls back when apps change
	const effectiveNav = useMemo(() => {
		if (selectedNav && sections.some((s) => s.id === selectedNav)) return selectedNav;
		return sections[0]?.id ?? null;
	}, [selectedNav, sections]);

	// Visible sections: search spans ALL sections; otherwise only the selected
	// section renders — each nav entry is its own page.
	const visibleSections = useMemo<RegistrySection[]>(() => {
		if (query) {
			return sections.map((sec) => ({ ...sec, entries: sec.entries.filter((e) => matchesSearch(e, query)) })).filter((sec) => sec.entries.length > 0);
		}
		return sections.filter((sec) => sec.id === effectiveNav);
	}, [sections, effectiveNav, query]);

	// Total match count shown next to the search box while searching
	const matchCount = useMemo(() => (query ? visibleSections.reduce((n, sec) => n + sec.entries.length, 0) : 0), [query, visibleSections]);

	/** Selecting a section exits search mode and shows only that app's pane. */
	const handleNavSelect = useCallback((id: string) => {
		setSelectedNav(id);
		setSearch('');
	}, []);

	const hasAny = visibleSections.length > 0;

	return (
		<div style={styles.root}>
			{/* ── Page heading ───────────────────────────────────── */}
			<ContentHeader title="Settings" subtitle="Preferences for RocketRide and your installed apps. Only the values you change are saved — everything else uses each app's default." />

			{/* ── Search row ─────────────────────────────────────── */}
			<div style={styles.searchRow}>
				<input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search settings" style={styles.searchInput} />
				{query && <span style={styles.searchCount}>{matchCount} Settings Found</span>}
			</div>

			{/* ── Body: nav + content ─────────────────────────────── */}
			<div style={styles.body}>
				<nav style={styles.sidebar}>
					{sections.map((sec) => (
						<button key={sec.id} style={styles.navItem(!query && sec.id === effectiveNav)} onClick={() => handleNavSelect(sec.id)}>
							{sec.title}
						</button>
					))}
				</nav>

				<div style={styles.content}>
					{/* Subscribe prompt for unsubscribed users */}
					{info && pipeBuilderApp && !isSubscribed && (
						<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', margin: '16px 0 0 0', borderRadius: 10, border: '1px solid var(--rr-border)', background: 'var(--rr-bg-titleBar-inactive)' }}>
							<span style={{ fontSize: 13, color: 'var(--rr-text-secondary)' }}>Subscribe to unlock pipeline execution and deployment.</span>
							<button onClick={handleSubscribe} style={{ ...commonStyles.buttonPrimary, fontFamily: 'var(--rr-font-family)', fontWeight: 600, whiteSpace: 'nowrap' } as CSSProperties}>
								Subscribe to RocketRide
							</button>
						</div>
					)}

					{!hasAny && <div style={styles.noResults}>{query ? 'No settings matched your search.' : 'No settings defined.'}</div>}

					{visibleSections.map((sec) => (
						<section key={sec.id}>
							<div style={styles.sectionHead}>
								<span style={styles.sectionTitle}>{sec.title}</span>
								<span style={styles.sectionAppId}>{sec.appIds.join(', ')}</span>
							</div>
							{sec.entries.map((entry) => (
								<SettingRow key={entry.key} category={sec.title} entry={entry} value={effectiveValue(entry.key)} modified={entry.key in draft} menuOpen={openMenuKey === entry.key} envKeys={envKeys} services={services} onChange={handleDraftChange} onToggleMenu={setOpenMenuKey} />
							))}
						</section>
					))}
				</div>
			</div>

			{dirty && (
				<div style={styles.footer}>
					<button style={styles.footerCancel} onClick={handleCancel}>
						Cancel
					</button>
					<button style={styles.footerSave} onClick={handleSave}>
						Save
					</button>
				</div>
			)}
		</div>
	);
};

export default SettingsProvider;
