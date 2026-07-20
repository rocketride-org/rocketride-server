// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ApiKeysPanel — the API Keys tab within AccountView.
 *
 * THE EXEMPLAR of the record-panel standard:
 * the grid is PURE DATA — no Actions column — and every operation on a key
 * happens in ONE record surface, a contained DetailPanel sliding from the
 * Account dialog's edge:
 *
 *  - row click            -> the panel in VIEW mode: pure inspect plus the
 *                            record-level [Revoke Key] verb in the footer
 *                            (ConfirmDialog-guarded; header X / Escape are
 *                            the exits — keys are immutable, so no [Edit])
 *  - "+ New Key" (header) -> the SAME panel in CREATE mode (name / team
 *                            scope / permissions / expiry), which flips to
 *                            the one-time secret reveal (Present mode, [Done]
 *                            only) after the server returns the key
 *
 * Interaction standard (2026-07-18): [Create Key] MATERIALIZES on the first
 * change; a dirty Cancel / X / Escape raises the stock "Discard changes?"
 * confirm (the DetailPanel owns the X / Escape guard via the dirty / editing
 * props; the footer Cancel routes through its own check); errors render as an
 * in-panel Banner at the top of the body.
 *
 * The panel owns its whole lifecycle — form state, validation, saving,
 * errors, confirmation — through the two host actions it receives
 * (`onCreateKey`, `onRevokeKey`). No modals live in AccountView for keys.
 */

import React, { useMemo, useState } from 'react';
import type { CellComponent } from 'tabulator-tables';
import { Card } from '../../../components/card/Card';
import { Button } from '../../../components/button/Button';
import { Banner } from '../../../components/banner/Banner';
import { CardDataGrid } from '../../../components/data-grid/CardDataGrid';
import { autoFormatter } from '../../../components/data-grid/defaults';
import type { GridColumnDefinition } from '../../../components/data-grid/defaults';
import { DetailPanel } from '../../../components/detail-panel/DetailPanel';
import { ConfirmDialog } from '../../../components/modal/ConfirmDialog';
import { Section, LabelValue } from '../../../components/section/Section';
import { commonStyles } from '../../../themes/styles';
import type { ApiKeyRecord, TeamRecord } from '../types';
import { S, PermGrid, PermPill, ExpiryOpts, parseWireDate, relativeTime } from './shared';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Status / team badge shape (commonStyles.badge values + surface fill); text color set per variant. */
	badge: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		padding: '2px 8px',
		fontSize: '11px',
		fontWeight: '600',
		borderRadius: '10px',
		letterSpacing: '0.3px',
		background: 'var(--rr-bg-surface-alt)',
	} as Partial<CSSStyleDeclaration>,

	/** Glowing green dot inside the 'active' badge (commonStyles.indicatorSuccess clone). */
	activeDot: {
		width: '8px',
		height: '8px',
		borderRadius: '50%',
		backgroundColor: 'var(--rr-color-success)',
		boxShadow: '0 0 4px var(--rr-color-success)',
	} as Partial<CSSStyleDeclaration>,

	/** One-time secret reveal box (ported from the retired reveal-key modal). */
	revealBox: {
		background: 'var(--rr-bg-surface-alt)',
		border: '1px solid var(--rr-border)',
		borderRadius: 7,
		padding: '12px 14px',
		marginBottom: 14,
	} as React.CSSProperties,

	revealLabel: {
		fontSize: 10.5,
		fontWeight: 600,
		letterSpacing: '0.6px',
		textTransform: 'uppercase',
		color: 'var(--rr-text-secondary)',
		marginBottom: 6,
	} as React.CSSProperties,

	revealRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
	} as React.CSSProperties,

	revealKey: {
		flex: 1,
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12,
		wordBreak: 'break-all',
		color: 'var(--rr-text-primary)',
	} as React.CSSProperties,

	/** Copy affordance; flips to the success treatment for 2s after copying. */
	copyBtn: (copied: boolean): React.CSSProperties => ({
		padding: '7px 10px',
		background: 'var(--rr-bg-input)',
		border: `1px solid ${copied ? 'var(--rr-color-success)' : 'var(--rr-border-input)'}`,
		borderRadius: 5,
		color: copied ? 'var(--rr-color-success)' : 'var(--rr-text-secondary)',
		cursor: 'pointer',
		fontSize: 12,
		flexShrink: 0,
	}),

	revealWarn: {
		marginTop: 8,
		fontSize: 11,
		color: 'var(--rr-color-error)',
	} as React.CSSProperties,

	/** Spacing wrapper for the in-panel error Banner at the top of the body. */
	errorBanner: {
		marginBottom: 12,
	} as React.CSSProperties,

	/** Wrapping pill cluster in the view panel's Permissions section. */
	permsWrap: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: 6,
	} as React.CSSProperties,

	/** Left-anchored destructive slot in the panel footer (footer is flex-end). */
	footerDanger: {
		marginRight: 'auto',
	} as React.CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

/**
 * Flattened row shape fed to the API keys grid. Sortable / searchable values
 * are primitives; `status` and `team` are pre-computed display strings so
 * client-side sort operates on what the user sees.
 */
interface KeyRow extends Record<string, unknown> {
	/** Key id — resolves the record for the panel on row click. */
	id: string;
	/** Key display name. */
	name: string;
	/** Display status: 'Active' | 'Expired' | 'Interactive login'. */
	status: string;
	/** Team scope display string ('' for session keys). */
	team: string;
	/** ISO last-used timestamp, or null if never used. */
	lastUsedAt: string | null;
	/** ISO expiry timestamp, or null for no expiry. */
	expiresAt: string | null;
	/** ISO creation timestamp, or null (carries the newest-first default sort). */
	createdAt: string | null;
}

/** The record panel's mode: closed, viewing one key, or creating one. */
type PanelState = { mode: 'view'; keyId: string } | { mode: 'create' } | null;

// =============================================================================
// PROPS
// =============================================================================

/** Props accepted by the ApiKeysPanel component. */
export interface ApiKeysPanelProps {
	/** The list of API key records to display. */
	keys: ApiKeyRecord[];
	/** Teams available for the create form's scope select. */
	teams: TeamRecord[];
	/** Creates a key; resolves with the one-time raw key value. */
	onCreateKey: (params: { name: string; permissions: string[]; expiresAt?: string; teamId?: string }) => Promise<{ key: string }>;
	/** Revokes a key by id. */
	onRevokeKey: (keyId: string) => Promise<void>;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Derives the display status string for an API key record.
 *
 * @param k - The API key record.
 * @returns 'Interactive login' for session keys, else 'Active' / 'Expired'.
 */
function keyStatus(k: ApiKeyRecord): string {
	if (k.isSession) return 'Interactive login';
	return k.active ? 'Active' : 'Expired';
}

/**
 * Maps a display status string back to its badge variant.
 *
 * @param status - Display status produced by {@link keyStatus}.
 * @returns The badge variant carrying the current color treatment.
 */
function statusBadgeVariant(status: string): 'active' | 'expired' | 'member' {
	if (status === 'Interactive login') return 'member';
	return status === 'Active' ? 'active' : 'expired';
}

/** Per-variant badge text colors — mirrors the shared Badge's overrides. */
const BADGE_COLORS: Record<'active' | 'expired' | 'member' | 'pending', string> = {
	active: 'var(--rr-color-success)',
	expired: 'var(--rr-color-error)',
	member: 'var(--rr-text-secondary)',
	pending: 'var(--rr-color-warning)',
};

/**
 * Builds a status / team badge (DOM clone of the shared Badge component):
 * surface fill, variant text color, and the glowing green dot on 'active'.
 *
 * @param variant - Badge variant determining the text color.
 * @param label - Badge label text.
 * @returns The badge element.
 */
function keyBadgeEl(variant: 'active' | 'expired' | 'member' | 'pending', label: string): HTMLElement {
	const el = document.createElement('span');
	Object.assign(el.style, styles.badge);
	el.style.color = BADGE_COLORS[variant];
	// The active variant carries the glowing success dot before its label.
	if (variant === 'active') {
		const dot = document.createElement('span');
		Object.assign(dot.style, styles.activeDot);
		el.appendChild(dot);
	}
	el.appendChild(document.createTextNode(label));
	return el;
}

/**
 * Team scope display string for a key record. Keys off teamId (the source of
 * truth): session keys carry no scope; teamId null is genuinely org-wide;
 * a set-but-unresolved teamId must NOT read as org-wide.
 *
 * @param k - The API key record.
 * @returns The display string ('' for session keys).
 */
function teamScope(k: ApiKeyRecord): string {
	return k.isSession ? '' : k.teamId == null ? 'All Teams' : k.teamName ?? 'Unknown team';
}

// =============================================================================
// API KEYS PANEL
// =============================================================================

/**
 * The API Keys tab: a pure-data CardDataGrid plus the single record panel
 * that hosts view, create, and revoke. See the module doc for the standard
 * this file exemplifies.
 */
export const ApiKeysPanel: React.FC<ApiKeysPanelProps> = ({ keys, teams, onCreateKey, onRevokeKey }) => {
	// ── Record panel state ──────────────────────────────────────────────────
	const [panel, setPanel] = useState<PanelState>(null);
	// Create-form fields (reset on every open of create mode).
	const [formName, setFormName] = useState('');
	const [formTeamId, setFormTeamId] = useState('');
	const [formPerms, setFormPerms] = useState<string[]>([]);
	const [formExpiry, setFormExpiry] = useState<number | null>(90);
	// Async lifecycle shared by create and revoke.
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// One-time secret returned by a successful create (reveal presentation).
	const [revealed, setRevealed] = useState<{ key: string; expiresAt: string | null } | null>(null);
	const [copied, setCopied] = useState(false);
	// Revoke confirmation gate (stacks over the panel via the overlay stack).
	const [confirmRevoke, setConfirmRevoke] = useState(false);
	// Footer-Cancel discard confirm (the DetailPanel guards X / Escape itself;
	// the footer Cancel routes through this local gate per the standard).
	const [confirmDiscard, setConfirmDiscard] = useState(false);

	// The viewed record resolves LIVE from props so server refreshes (e.g. a
	// revoke flipping active -> false) update the open panel in place.
	const viewedKey = panel?.mode === 'view' ? keys.find((k) => k.id === panel.keyId) ?? null : null;

	// Create-form dirty flag: any field differs from its seeded default. It
	// drives the materializing [Create Key] and arms the discard guard; the
	// reveal step (Present mode) is never dirty — the record already exists.
	const createDirty = panel?.mode === 'create' && revealed == null && (formName.trim() !== '' || formTeamId !== '' || formPerms.length > 0 || formExpiry !== 90);

	// ── Table rows ──────────────────────────────────────────────────────────
	const rows = useMemo<KeyRow[]>(
		() =>
			keys.map((k) => ({
				id: k.id,
				name: k.name,
				status: keyStatus(k),
				team: teamScope(k),
				lastUsedAt: k.lastUsedAt,
				expiresAt: k.expiresAt,
				createdAt: k.createdAt,
			})),
		[keys]
	);

	// ── Columns (pure data — the record panel replaced the Actions column) ──
	// Contract flags (rrDefault, array order) declare the default layout. Created stays declared but
	// unindexed (hidden, toggleable) and carries the grid's newest-first
	// default sort — the server's own key ordering.
	const columns = useMemo<GridColumnDefinition[]>(
		() => [
			{ title: 'Name', field: 'name', rrType: 'string', rrDefault: true, rrDescription: 'Key label chosen at creation (e.g. "Production Server") — purely descriptive, not part of the secret.', headerSort: true },
			{
				title: 'Status',
				field: 'status',
				rrType: 'enum',
				rrDefault: true,
				rrDescription: 'Derived from the key lifecycle: Expired once the key is revoked or past its expiry, Active otherwise; keys minted by interactive sign-in show Interactive login.',
				headerSort: true,
				formatter: (cell: CellComponent) => {
					const status = cell.getValue() as string;
					return keyBadgeEl(statusBadgeVariant(status), status);
				},
			},
			{
				title: 'Team',
				field: 'team',
				rrType: 'enum',
				rrDefault: true,
				rrDescription: 'Key scope: a named team restricts the key to that team, All Teams inherits every team from the owner at auth time; session keys carry no scope.',
				headerSort: true,
				// Session keys show no team badge; named teams keep the amber badge,
				// the org-wide scope keeps the neutral badge.
				formatter: (cell: CellComponent) => {
					const team = cell.getValue() as string;
					return team === '' ? '' : keyBadgeEl(team === 'All Teams' ? 'member' : 'pending', team);
				},
			},
			{
				title: 'Last Used',
				field: 'lastUsedAt',
				rrType: 'date',
				rrDefault: true,
				rrDescription: 'When the key last authenticated successfully — stamped server-side on each use; empty when the key has never been used.',
				headerSort: true,
				formatter: (cell: CellComponent) => {
					const iso = cell.getValue() as string | null;
					return iso ? `Used ${relativeTime(iso)}` : 'Never used';
				},
			},
			{
				title: 'Expires',
				field: 'expiresAt',
				rrType: 'date',
				rrDefault: true,
				rrDescription: 'UTC instant after which the key stops authenticating; empty means the key never expires.',
				headerSort: true,
				// parseWireDate applies the platform contract (zone-less wire
				// datetimes ARE UTC) — a bare new Date(iso) would misparse them
				// as local and could show the wrong calendar day.
				formatter: (cell: CellComponent) => {
					const iso = cell.getValue() as string | null;
					return iso ? `Exp. ${parseWireDate(iso).toLocaleDateString()}` : 'No expiry';
				},
			},
			{ title: 'Created', field: 'createdAt', rrType: 'date', rrDefaultSort: 'desc', rrDescription: 'UTC creation time of the key; the grid sorts newest-first on it by default.', headerSort: true, formatter: autoFormatter },
		],
		[]
	);

	// ── Panel lifecycle ─────────────────────────────────────────────────────

	/** Open the record panel in CREATE mode with a fresh form. */
	const openCreate = (): void => {
		setFormName('');
		setFormTeamId('');
		setFormPerms([]);
		setFormExpiry(90);
		setError(null);
		setRevealed(null);
		setPanel({ mode: 'create' });
	};

	/** Close the panel and drop every transient state it owned. */
	const closePanel = (): void => {
		setPanel(null);
		setError(null);
		setRevealed(null);
		setConfirmRevoke(false);
		setConfirmDiscard(false);
	};

	/** Validate + submit the create form; success flips to the reveal step. */
	const handleCreate = async (): Promise<void> => {
		// Step 1: validation mirrors the retired modal's rules.
		if (!formName.trim()) {
			setError('Name is required');
			return;
		}
		if (formTeamId && formPerms.length === 0) {
			setError('Select at least one permission for a team-scoped key');
			return;
		}
		setSaving(true);
		setError(null);
		try {
			// Step 2: expiry days -> absolute ISO instant (server contract).
			const expiresAt = formExpiry ? new Date(Date.now() + formExpiry * 86400000).toISOString() : undefined;
			const params: { name: string; permissions: string[]; expiresAt?: string; teamId?: string } = {
				name: formName.trim(),
				permissions: formTeamId ? formPerms : [],
				...(expiresAt ? { expiresAt } : {}),
			};
			if (formTeamId) params.teamId = formTeamId;
			const body = await onCreateKey(params);
			// Step 3: show the one-time secret in place — the panel stays open.
			setRevealed({ key: body.key, expiresAt: expiresAt ?? null });
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to create key');
		} finally {
			setSaving(false);
		}
	};

	/** Revoke the viewed key after the ConfirmDialog's confirmation. */
	const handleRevoke = async (): Promise<void> => {
		if (!viewedKey) return;
		setSaving(true);
		setError(null);
		try {
			await onRevokeKey(viewedKey.id);
			setConfirmRevoke(false);
			// Keep the panel open: the live record resolve shows the key's new
			// Expired status immediately — better feedback than vanishing.
		} catch (e) {
			setConfirmRevoke(false);
			setError(e instanceof Error ? e.message : 'Failed to revoke key');
		} finally {
			setSaving(false);
		}
	};

	// ── Render ──────────────────────────────────────────────────────────────
	const isRevocable = viewedKey != null && !viewedKey.isSession && viewedKey.active;

	return (
		<section>
			{/* Pure-data grid: row click opens the record panel. */}
			<Card noBodyPadding>
				<CardDataGrid<KeyRow>
					title="API Keys"
					actions={
						<Button variant="primary" small onClick={openCreate}>
							+ New Key
						</Button>
					}
					columns={columns}
					data={rows}
					noSearch
					onRowClick={(row) => {
						setError(null);
						setPanel({ mode: 'view', keyId: row.id });
					}}
					emptyTitle="No API keys yet"
					emptyDescription="Create a key for programmatic access."
				/>
			</Card>

			{/* ── Record panel: VIEW mode — pure inspect plus the record-level
			    [Revoke Key] verb; header X / Escape are the exits (no footer
			    Close, no [Edit] — keys are immutable). No footer at all when
			    the key cannot be revoked. ─────────────────────────────────── */}
			{viewedKey != null && (
				<DetailPanel
					persistKey="panelDetailApiKeyWidth"
					contained
					open
					onClose={closePanel}
					title={viewedKey.name}
					subtitle={keyStatus(viewedKey)}
					busy={saving}
					footer={
						isRevocable ? (
							<div style={styles.footerDanger}>
								<Button variant="danger" small disabled={saving} onClick={() => setConfirmRevoke(true)}>
									Revoke Key
								</Button>
							</div>
						) : undefined
					}
				>
					{/* In-panel error surface (interaction standard): a stock Banner
					    at the top of the body. */}
					{error && (
						<div style={styles.errorBanner}>
							<Banner variant="error">{error}</Banner>
						</div>
					)}
					<Section label="Key">
						<LabelValue label="Status">{keyStatus(viewedKey)}</LabelValue>
						<LabelValue label="Team Scope">{teamScope(viewedKey) || 'Session'}</LabelValue>
						<LabelValue label="Created">{viewedKey.createdAt ? parseWireDate(viewedKey.createdAt).toLocaleString() : '--'}</LabelValue>
						<LabelValue label="Last Used">{viewedKey.lastUsedAt ? `Used ${relativeTime(viewedKey.lastUsedAt)}` : 'Never used'}</LabelValue>
						<LabelValue label="Expires">{viewedKey.expiresAt ? parseWireDate(viewedKey.expiresAt).toLocaleDateString() : 'No expiry'}</LabelValue>
					</Section>
					{(viewedKey.permissions?.length ?? 0) > 0 && (
						<Section label="Permissions">
							<div style={styles.permsWrap}>
								{viewedKey.permissions!.map((perm) => (
									<PermPill key={perm} perm={perm} />
								))}
							</div>
						</Section>
					)}
				</DetailPanel>
			)}

			{/* ── Record panel: CREATE mode (form, then one-time reveal).
			    Footer contract: [Create Key] MATERIALIZES on the first change,
			    LEFT of the stationary [Cancel]; a dirty Cancel routes through
			    the discard confirm. The reveal step is Present mode — [Done]
			    only. dirty/editing arm the component's own X / Escape guard;
			    onExitMode closes (create-mode panels close on mode exit). ── */}
			{panel?.mode === 'create' && (
				<DetailPanel
					persistKey="panelDetailApiKeyWidth"
					contained
					open
					onClose={closePanel}
					title={revealed ? 'Key Created' : 'New API Key'}
					subtitle={revealed ? 'Copy it now — it will not be shown again' : undefined}
					dirty={createDirty}
					editing={revealed == null}
					onExitMode={closePanel}
					busy={saving}
					footer={
						revealed ? (
							<Button variant="primary" small onClick={closePanel}>
								Done
							</Button>
						) : (
							<>
								{createDirty && (
									<Button variant="primary" small disabled={saving} onClick={() => void handleCreate()}>
										{saving ? 'Creating…' : 'Create Key'}
									</Button>
								)}
								<Button variant="ghost" small disabled={saving} onClick={() => (createDirty ? setConfirmDiscard(true) : closePanel())}>
									Cancel
								</Button>
							</>
						)
					}
				>
					{revealed ? (
						<>
							{/* One-time secret reveal (ported from the retired modal). */}
							<div style={styles.revealBox}>
								<div style={styles.revealLabel}>Your API Key</div>
								<div style={styles.revealRow}>
									<div style={styles.revealKey}>{revealed.key}</div>
									<button
										type="button"
										style={styles.copyBtn(copied)}
										onClick={() => {
											void navigator.clipboard.writeText(revealed.key);
											setCopied(true);
											setTimeout(() => setCopied(false), 2000);
										}}
									>
										{copied ? '✓ Copied' : '⎘ Copy'}
									</button>
								</div>
								<div style={styles.revealWarn}>Warning: store safely — it cannot be retrieved after closing.</div>
							</div>
							<Section label="Details">
								<LabelValue label="Expires">{revealed.expiresAt ? new Date(revealed.expiresAt).toLocaleDateString() : 'No expiry'}</LabelValue>
							</Section>
						</>
					) : (
						<>
							{/* In-panel error surface (interaction standard): a stock
							    Banner at the top of the body. */}
							{error && (
								<div style={styles.errorBanner}>
									<Banner variant="error">{error}</Banner>
								</div>
							)}
							{/* Create form (ported field-for-field from the retired modal). */}
							<div style={S.field}>
								<div style={S.fieldLabel}>Key Name</div>
								<input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. Production Server, CI Pipeline" style={commonStyles.inputField} data-rr-autofocus="true" />
							</div>
							<div style={S.field}>
								<div style={S.fieldLabel}>Team Scope</div>
								<select
									value={formTeamId}
									onChange={(e) => {
										setFormTeamId(e.target.value);
										// Permissions are team-relative; reset on scope change.
										setFormPerms([]);
									}}
									style={{ ...commonStyles.inputField, cursor: 'pointer' } as React.CSSProperties}
								>
									<option value="">All Teams</option>
									{teams.map((t) => (
										<option key={t.id} value={t.id}>
											{t.name}
										</option>
									))}
								</select>
								<div style={commonStyles.textMuted}>{formTeamId ? 'Key is restricted to this team only.' : 'Key inherits all teams from your account.'}</div>
							</div>
							{formTeamId && (
								<div style={{ ...S.field, marginBottom: 14 }}>
									<div style={S.fieldLabel}>Permissions</div>
									<PermGrid value={formPerms} onChange={setFormPerms} />
								</div>
							)}
							<div style={S.field}>
								<div style={S.fieldLabel}>Expiry</div>
								<ExpiryOpts value={formExpiry} onChange={setFormExpiry} />
							</div>
						</>
					)}
				</DetailPanel>
			)}

			{/* ── Revoke confirmation (stacks over the record panel) ────────── */}
			{confirmRevoke && viewedKey != null && (
				<ConfirmDialog
					title="Revoke API Key"
					destructive
					confirmLabel={saving ? 'Revoking…' : 'Revoke Key'}
					confirmDisabled={saving}
					message={
						<>
							<div style={{ fontSize: 13, fontWeight: 700, color: 'var(--rr-text-primary)', marginBottom: 2 }}>{viewedKey.name}</div>
							<div style={{ fontSize: 11, color: 'var(--rr-text-secondary)', marginBottom: 12 }}>
								{viewedKey.lastUsedAt ? `Last used ${relativeTime(viewedKey.lastUsedAt)}` : 'Never used'}
							</div>
							<strong>This cannot be undone.</strong> Any service using this key will immediately lose access.
						</>
					}
					onConfirm={() => void handleRevoke()}
					onCancel={() => setConfirmRevoke(false)}
				/>
			)}

			{/* ── Footer-Cancel discard confirm (stock dialog, same copy as the
			    DetailPanel's own X / Escape guard) ──────────────────────────── */}
			{confirmDiscard && (
				<ConfirmDialog
					title="Discard changes?"
					message="Your unsaved changes will be lost."
					confirmLabel="Discard"
					cancelLabel="Keep Editing"
					destructive
					onConfirm={() => {
						// The confirmed discard closes the create panel whole.
						setConfirmDiscard(false);
						closePanel();
					}}
					onCancel={() => setConfirmDiscard(false)}
				/>
			)}
		</section>
	);
};
