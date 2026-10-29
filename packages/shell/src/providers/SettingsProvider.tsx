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
// - Left nav: a SidebarMenu — one entry per registry section; sections (and
//   host-injected RICH sections) that declare a `group` fold as children
//   under one expandable parent (dev tools under "Rocket Builder").
//   Selecting a section shows ONLY that section's settings.
// - SettingsPage (exported) is host-feedable: the cloud's SettingsProvider
//   wraps it over useWorkspace(); VS Code feeds it mirrored stores and
//   injects its Connections sections. Rich sections are SELF-MANAGED
//   (their own footer/apply semantics) and never touch the schema draft.
// - store routing: 'host'-scoped entries read/write through the hostStore
//   adapter (hidden entirely when the host provides none); everything else
//   rides updateSetting into the workspace.
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
import { labelFromKey, settingStoreOf } from '../components/workspace/settingsRegistry';
import type { RegistryEntry, RegistrySection, SettingsRegistry } from '../components/workspace/settingsRegistry';
import type { SettingValue } from '../components/workspace/types';
import { SidebarMenu } from '../components/sidebar-menu/SidebarMenu';
import type { ViewMenu, ViewMenuEntry } from '../types/viewMenu';
import EnvironmentProvider from './EnvironmentProvider';
import AccountProvider from './AccountProvider';
import { useAuthUser } from '../hooks/useAuthUser';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Manifest `mode` values meaning the app REQUIRES payment. A free app
 *  (mode 'free' or absent) never banners, whatever a local engine stamps
 *  into appStatus. */
const PAID_MODES = new Set(['paywall', 'subscription']);

/** Account-row statuses meaning the payment is ACTIVE — no banner. */
const SUBSCRIPTION_ACTIVE = new Set(['subscribed', 'trialing']);

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

/** The HOST's store adapter for 'host'-scoped settings (VS Code config).
 *  Entries declaring `store: 'host'` are HIDDEN when the page has none. */
export interface SettingsHostStore {
	/** The host store's current values (only host-scoped keys). */
	values: Record<string, SettingValue>;
	/** Writes one key (undefined = reset to default). */
	update(key: string, value: SettingValue | undefined): void;
}

/**
 * A host-injected RICH section: a self-managed body (Connections, Variables)
 * beside the schema sections. Rich sections own their whole pane INCLUDING
 * any footer (Save & Reconnect, per-card saves) — they never touch the
 * schema draft, and the schema Save/Cancel footer appears independently
 * whenever the draft is dirty.
 */
/** What a rich section's render receives from the page: in-page navigation
 *  and the schema draft's state — so a section can deep-link (the Billing
 *  workspace chip's "change…") and guard actions that must not run over an
 *  unsaved draft (the workspace switch). All optional to use. */
export interface ISettingsRichContext {
	/** Selects another nav section (registry or rich) in place. */
	navigate: (sectionId: string) => void;
	/** Whether the schema draft has unsaved edits right now. */
	isDirty: () => boolean;
	/** Discards the schema draft (the footer Cancel). */
	discardDraft: () => void;
}

export interface SettingsRichSection {
	/** Stable nav id (shares the id space with registry section ids). */
	id: string;
	/** Nav label — also the section's ONLY search-match surface. */
	title: string;
	/** Nav grouping, same semantics as a contribution's group. */
	group?: { id: string; label: string };
	/** Top-level nav position (default 100; lower = higher). A group sits at
	 *  its lowest member's order. */
	order?: number;
	/** Renders the section's whole pane. */
	render: (ctx?: ISettingsRichContext) => React.ReactNode;
}

/** Props for {@link SettingsPage} — everything a host feeds the page. */
export interface SettingsPageProps {
	/** The flattened settings registry (declarations). */
	registry: SettingsRegistry;
	/** Committed workspace overrides (deltas only, merged across partitions). */
	overrides: Record<string, SettingValue>;
	/** Workspace write (partition-routed by the caller's context). */
	updateSetting: (key: string, value: SettingValue | undefined) => void;
	/** Host store adapter for 'host'-scoped entries (VS Code only). */
	hostStore?: SettingsHostStore;
	/** Host-injected rich sections (Connections, Variables). */
	extraSections?: SettingsRichSection[];
	/** Deep link: the nav section to open on mount. */
	initialSectionId?: string;
}

/**
 * The one settings surface, VSCode-style, rendered from the registry — the
 * cloud mounts it via {@link SettingsProvider} (modal overlay), VS Code as an
 * editor tab over its mirrored stores.
 */
export const SettingsPage: React.FC<SettingsPageProps> = ({ registry, overrides, updateSetting, hostStore, extraSections, initialSectionId }) => {
	// ── Committed values: workspace overrides ⊕ host-store values ──────────
	// Host keys are disjoint from workspace keys (the registry routes each key
	// to exactly one store), so the merge cannot collide.
	const committed = useMemo<Record<string, SettingValue>>(
		() => ({ ...overrides, ...(hostStore?.values ?? {}) }),
		[overrides, hostStore?.values],
	);

	/** Whether a key is host-scoped (routes through the hostStore adapter). */
	const isHostKey = useCallback(
		(key: string): boolean => {
			const schema = registry.schemas.get(key);
			return schema !== undefined && settingStoreOf(schema) === 'host';
		},
		[registry],
	);

	// -- Buffered edit model (matches VSCode settings + DetailPanel) -----------
	// Edits collect in a local draft layered over the committed values; the
	// Save/Cancel footer commits or discards them (deltas-only, like updateSetting).
	const [draft, setDraft] = useState<Record<string, SettingValue>>(() => ({ ...committed }));

	// Unsaved edits exist when the draft diverges from the committed values.
	const dirty = useMemo(() => {
		const keys = new Set([...Object.keys(draft), ...Object.keys(committed)]);
		for (const k of keys) {
			if (draft[k] !== committed[k]) return true;
		}
		return false;
	}, [draft, committed]);

	// REBASE the draft when the committed values change externally: unedited
	// keys follow the new committed state, while the user's local edits (keys
	// where the draft diverged from the PREVIOUS committed values — including
	// staged deletions) carry forward on top. A plain "re-sync unless dirty"
	// guard deadlocks on async hydration (VS Code's mirrors replay AFTER
	// mount: committed gains keys, the empty draft reads as "dirty", and the
	// guard then refuses to ever re-sync), and a plain reset would clobber
	// in-progress edits when a background update lands mid-edit.
	const prevCommittedRef = useRef(committed);
	useEffect(() => {
		const prev = prevCommittedRef.current;
		if (prev === committed) return;
		prevCommittedRef.current = committed;
		setDraft((d) => {
			const next = { ...committed };
			const keys = new Set([...Object.keys(d), ...Object.keys(prev)]);
			for (const k of keys) {
				if (d[k] !== prev[k]) {
					// A local edit: keep the drafted value (or the staged deletion).
					if (k in d) next[k] = d[k];
					else delete next[k];
				}
			}
			return next;
		});
	}, [committed]);

	/**
	 * Stage a setting change in the draft with deltas-only semantics: a value
	 * equal to the schema default (or undefined) drops the key entirely.
	 */
	const handleDraftChange = useCallback(
		(key: string, value: SettingValue | undefined) => {
			setDraft((prev) => {
				const next = { ...prev };
				const def = registry.defaults[key];
				if (value === undefined || value === def) delete next[key];
				else next[key] = value;
				return next;
			});
		},
		[registry]
	);

	/** Commits ONE key to its store (host adapter or the workspace). */
	const commitKey = useCallback(
		(key: string, value: SettingValue | undefined) => {
			if (isHostKey(key)) hostStore?.update(key, value);
			else updateSetting(key, value);
		},
		[isHostKey, hostStore, updateSetting]
	);

	/** Commit the draft: write changed keys and reset removed keys to their default. */
	const handleSave = useCallback(() => {
		Object.keys(draft).forEach((k) => {
			if (draft[k] !== committed[k]) commitKey(k, draft[k]);
		});
		Object.keys(committed).forEach((k) => {
			if (!(k in draft)) commitKey(k, undefined);
		});
	}, [draft, committed, commitKey]);

	/** Discard the draft, reverting every control to the committed values. */
	const handleCancel = useCallback(() => setDraft({ ...committed }), [committed]);

	/**
	 * The typed effective value of a key: the raw draft value when present,
	 * otherwise the schema default.  The controls need the TYPED value (a
	 * boolean checkbox, a numeric input).
	 *
	 * @param key - The full dotted setting key.
	 * @returns The effective value, or undefined when neither is set.
	 */
	const effectiveValue = useCallback(
		(key: string): SettingValue | undefined => {
			return key in draft ? draft[key] : registry.schemas.get(key)?.default;
		},
		[draft, registry]
	);
	const { client, isConnected } = useShellConnection();
	const [search, setSearch] = useState('');
	const [selectedNav, setSelectedNav] = useState<string | null>(initialSectionId ?? null);
	// A deep link can arrive while the page is LIVE (VS Code's open command
	// re-fires with new focus args; the auth-error flow retargets Development)
	// — follow it without a remount, so an unsaved draft survives.
	useEffect(() => {
		if (initialSectionId) setSelectedNav(initialSectionId);
	}, [initialSectionId]);
	// Key of the row whose gear menu is open (null = none)
	const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);

	// ── Subscription banner (fully data-driven) ─────────────────────────────
	// A section advertises a subscription when any app it belongs to — its
	// contributors OR its storage owner (builtin tool sections store into the
	// subscribable product app) — has an account row whose appStatus says
	// "requires a subscription that is not active". No app ids are hardcoded;
	// a pinned store tool needing a subscription banners its own section.
	const accountApps: any[] = client?.getAccountInfo()?.apps ?? [];

	/** The app row a section's banner advertises, or undefined for none. */
	const subscriptionAppOf = useCallback(
		(sec: RegistrySection): any | undefined => {
			const ids = new Set<string>(sec.appIds);
			for (const entry of sec.entries) ids.add(entry.owner);
			for (const id of ids) {
				const row = accountApps.find((a) => a.id === id);
				// Banner = the app REQUIRES payment (manifest mode) and this
				// account's relationship to it is not active (appStatus).
				if (row && PAID_MODES.has(row.mode) && !SUBSCRIPTION_ACTIVE.has(row.appStatus)) return row;
			}
			return undefined;
		},
		[accountApps],
	);

	/** Opens the checkout modal via the shell:subscribe event. */
	const handleSubscribe = useCallback((app: any) => {
		// The SDK AppManifestEntry structurally satisfies the minimal
		// ShellAppEntry contract, so it is passed directly.
		ConnectionManager.getInstance().emit('shell:subscribe', { app });
	}, []);

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

	// ── Renderable sections ────────────────────────────────────────────────
	// Host-scoped entries are HIDDEN when the page has no host adapter (the
	// registry's shells filter removes them on foreign editions first — this
	// is the belt-and-braces for a same-edition page without the adapter).
	const sections = useMemo<RegistrySection[]>(() => {
		const all = registry.sections;
		if (hostStore) return all;
		return all
			.map((sec) => ({ ...sec, entries: sec.entries.filter((e) => settingStoreOf(e.schema) !== 'host') }))
			.filter((sec) => sec.entries.length > 0);
	}, [registry, hostStore]);
	const richSections = extraSections ?? [];
	const query = search.toLowerCase().trim();

	// The selected section — defaults to the first, falls back when apps change
	const effectiveNav = useMemo(() => {
		const known = (id: string): boolean => sections.some((s) => s.id === id) || richSections.some((r) => r.id === id);
		if (selectedNav && known(selectedNav)) return selectedNav;
		return sections[0]?.id ?? richSections[0]?.id ?? null;
	}, [selectedNav, sections, richSections]);

	/** The selected RICH section, when the nav points at one. */
	const activeRich = useMemo(() => (query ? undefined : richSections.find((r) => r.id === effectiveNav)), [richSections, effectiveNav, query]);

	// ── Rich-section context: in-page nav + the draft's state ───────────────
	// Stable identity (dirty read through a ref) so a render-prop consumer
	// isn't re-created per keystroke in an unrelated schema section.
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;
	const richCtx = useMemo<ISettingsRichContext>(() => ({
		navigate: (sectionId: string) => {
			setSearch('');
			setSelectedNav(sectionId);
		},
		isDirty: () => dirtyRef.current,
		discardDraft: handleCancel,
	}), [handleCancel]);

	// ── Nav menu: sections + rich sections, group-folded and ORDERED ───────
	// Entries sharing a group.id fold as children under one expandable parent
	// (SidebarMenu's one-level accordion); everything else is a flat entry.
	// Top-level position follows the declared `order` (default 100; a group
	// sits at its lowest member's order), ties ALPHABETICAL by label — the
	// product rule is Account, Environment Variables, Integrations,
	// Connections, then every other category A→Z.
	const navMenu = useMemo<ViewMenu>(() => {
		const ranked: Array<{ entry: ViewMenuEntry; order: number }> = [];
		const groupParents = new Map<string, { entry: ViewMenuEntry; order: number }>();
		const add = (id: string, label: string, group?: { id: string; label: string }, order = 100): void => {
			if (!group) {
				ranked.push({ entry: { id, label }, order });
				return;
			}
			let parent = groupParents.get(group.id);
			if (!parent) {
				parent = { entry: { id: `group:${group.id}`, label: group.label, children: [] }, order };
				groupParents.set(group.id, parent);
				ranked.push(parent);
			}
			parent.order = Math.min(parent.order, order);
			parent.entry.children!.push({ id, label });
		};
		for (const sec of sections) add(sec.id, sec.title, sec.group, sec.order);
		for (const rich of richSections) add(rich.id, rich.title, rich.group, rich.order);
		ranked.sort((a, b) => a.order - b.order || a.entry.label.localeCompare(b.entry.label));
		return { entries: ranked.map((r) => r.entry) };
	}, [sections, richSections]);

	// Visible sections: search spans ALL sections; otherwise only the selected
	// section renders — each nav entry is its own page.
	const visibleSections = useMemo<RegistrySection[]>(() => {
		if (query) {
			return sections.map((sec) => ({ ...sec, entries: sec.entries.filter((e) => matchesSearch(e, query)) })).filter((sec) => sec.entries.length > 0);
		}
		if (activeRich) return [];
		return sections.filter((sec) => sec.id === effectiveNav);
	}, [sections, effectiveNav, query, activeRich]);

	// Rich sections match a search on their TITLE only, rendered as nav cards.
	const richMatches = useMemo(() => (query ? richSections.filter((r) => r.title.toLowerCase().includes(query)) : []), [richSections, query]);

	// Total match count shown next to the search box while searching
	const matchCount = useMemo(
		() => (query ? visibleSections.reduce((n, sec) => n + sec.entries.length, 0) + richMatches.length : 0),
		[query, visibleSections, richMatches],
	);

	/** Selecting a section exits search mode and shows only that pane. */
	const handleNavSelect = useCallback((id: string) => {
		// Group parents only expand (SidebarMenu handles that) — not a page.
		if (id.startsWith('group:')) return;
		setSelectedNav(id);
		setSearch('');
	}, []);

	const hasAny = visibleSections.length > 0 || richMatches.length > 0 || activeRich !== undefined;

	// The banner app for the CURRENT view: the selected section's (or, while
	// searching, the first matched section that advertises one). Sections of
	// apps that are free, auth-only, or actively subscribed banner nothing —
	// a subscription banner only ever sits on the pages of the thing being
	// subscribed to (Rod, 2026-10-25).
	const bannerApp = useMemo(() => {
		const current = query ? visibleSections : sections.filter((sec) => sec.id === effectiveNav);
		for (const sec of current) {
			const app = subscriptionAppOf(sec);
			if (app) return app;
		}
		return undefined;
	}, [query, visibleSections, sections, effectiveNav, subscriptionAppOf]);

	return (
		<div style={styles.root}>
			{/* ── Page heading ───────────────────────────────────── */}
			<ContentHeader title="Settings" subtitle="Preferences for RocketRide and your installed apps. Only the values you change are saved. Everything else uses each app's default." />

			{/* ── Search row ─────────────────────────────────────── */}
			<div style={styles.searchRow}>
				<input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search settings" style={styles.searchInput} />
				{query && <span style={styles.searchCount}>{matchCount} Settings Found</span>}
			</div>

			{/* ── Body: nav + content ─────────────────────────────── */}
			<div style={styles.body}>
				<nav style={styles.sidebar} aria-label="Settings sections">
					<SidebarMenu menu={navMenu} activeId={query ? '' : (effectiveNav ?? '')} onSelect={handleNavSelect} collapsed={false} />
				</nav>

				<div style={styles.content}>
					{/* Subscribe prompt: data-driven off the section's app rows */}
					{bannerApp && (
						<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', margin: '16px 0 0 0', borderRadius: 10, border: '1px solid var(--rr-border)', background: 'var(--rr-bg-titleBar-inactive)' }}>
							<span style={{ fontSize: 13, color: 'var(--rr-text-secondary)' }}>{bannerApp.name ?? bannerApp.id} requires a subscription — these settings apply once it is active.</span>
							<button onClick={() => handleSubscribe(bannerApp)} style={{ ...commonStyles.buttonPrimary, fontFamily: 'var(--rr-font-family)', fontWeight: 600, whiteSpace: 'nowrap' } as CSSProperties}>
								Subscribe to {bannerApp.name ?? 'RocketRide'}
							</button>
						</div>
					)}

					{!hasAny && <div style={styles.noResults}>{query ? 'No settings matched your search.' : 'No settings defined.'}</div>}

					{/* A selected RICH section owns the whole pane (its own footer
					    included); the schema footer below still appears when the
					    DRAFT is dirty, so pending schema edits are never stranded. */}
					{activeRich && activeRich.render(richCtx)}

					{/* Rich sections matching a search render as section cards. */}
					{richMatches.map((rich) => (
						<div key={rich.id} style={styles.sectionHead}>
							<button style={{ ...styles.navItem(false), width: 'auto', fontSize: 15 } as CSSProperties} onClick={() => handleNavSelect(rich.id)}>
								{rich.title} — open section
							</button>
						</div>
					))}

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

// =============================================================================
// PROVIDER — the cloud overlay wrapper
// =============================================================================

/** Props for {@link SettingsProvider} (the overlay deep link). */
export interface ISettingsProviderProps {
	/** The nav section to open at (from shell:openOverlay's `section`). */
	initialSectionId?: string;
}

/**
 * Shell-owned settings overlay: {@link SettingsPage} fed from the workspace
 * context (registry, merged overrides, partition-routed updateSetting).
 */
/** The Account group's nav identity (Profile / Billing / API Keys children). */
const ACCOUNT_GROUP = { id: 'account', label: 'Account' };

/** The one subscribable product app (same identity CheckoutFlow consumers use). */
const PIPE_BUILDER_ID = 'rocketride.pipeBuilder';

/**
 * Builds the workspace-switch guard for one render: a dirty schema draft is
 * confirmed-and-discarded BEFORE the switch commits — a workspace-A draft
 * must never save into workspace B.
 */
function switchGuardOf(ctx?: ISettingsRichContext): () => boolean {
	return () => {
		if (!ctx?.isDirty()) return true;
		if (window.confirm('You have unsaved settings changes. Discard them and switch workspace?')) {
			ctx.discardDraft();
			return true;
		}
		return false;
	};
}

const SettingsProvider: React.FC<ISettingsProviderProps> = ({ initialSectionId }) => {
	const { settingsRegistry, settingsOverrides, updateSetting, appManifest } = useWorkspace();
	const authUser = useAuthUser();
	const isSaas = (authUser?.capabilities ?? []).includes('saas');

	// The cloud's rich sections: Environment Variables (the old standalone
	// overlay's body, unchanged) and — on SaaS — the Account group (the old
	// account overlay collapsed to Profile / Billing / API Keys). Section ids
	// are the deep-link vocabulary the legacy overlay ids map onto.
	// Nav order (product rule): Account (10), Environment Variables (20),
	// Integrations (30, VS Code), Connections (40, VS Code), then every other
	// category at the default (100).
	const extraSections = useMemo<SettingsRichSection[]>(() => {
		const sections: SettingsRichSection[] = [
			{ id: 'environment', title: 'Environment Variables', order: 20, render: () => <EnvironmentProvider /> },
		];
		if (isSaas) {
			const onSubscribe = (): void => {
				// Shell.tsx mounts the global CheckoutFlow — the emit is enough.
				const app = appManifest.find((a) => a.id === PIPE_BUILDER_ID);
				ConnectionManager.getInstance().emit('shell:subscribe', { app: app ?? { id: PIPE_BUILDER_ID, name: 'Rocket Builder' } } as never);
			};
			sections.push(
				{
					id: 'account:profile', title: 'Profile', group: ACCOUNT_GROUP, order: 10,
					render: (ctx) => <AccountProvider embeddedSection="profile" confirmWorkspaceSwitch={switchGuardOf(ctx)} {...(ctx ? { onNavigateSection: ctx.navigate } : {})} />,
				},
				{
					id: 'account:billing', title: 'Billing', group: ACCOUNT_GROUP, order: 10,
					render: (ctx) => <AccountProvider embeddedSection="billing" onSubscribe={onSubscribe} {...(ctx ? { onNavigateSection: ctx.navigate } : {})} />,
				},
				{
					id: 'account:keys', title: 'API Keys', group: ACCOUNT_GROUP, order: 10,
					render: (ctx) => <AccountProvider embeddedSection="api-keys" {...(ctx ? { onNavigateSection: ctx.navigate } : {})} />,
				},
			);
		}
		return sections;
	}, [isSaas, appManifest]);

	return <SettingsPage registry={settingsRegistry} overrides={settingsOverrides} updateSetting={updateSetting} extraSections={extraSections} {...(initialSectionId !== undefined ? { initialSectionId } : {})} />;
};

export default SettingsProvider;
