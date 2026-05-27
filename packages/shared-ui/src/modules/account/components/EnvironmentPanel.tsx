// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * EnvironmentPanel — ROCKETRIDE_* environment variable editor.
 *
 * Renders a card per scope (Organization, Team, User) with a key-value
 * editor for encrypted pipeline secrets. Values are masked by default
 * with a reveal toggle. The full dict is read and written as a set —
 * no per-key server calls.
 *
 * Permission gating is handled server-side; the UI shows/hides scope
 * cards based on the `isOrgAdmin` / `isTeamAdmin` props.
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	row: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '8px 0',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,
	keyInput: {
		...commonStyles.inputField,
		width: 220,
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12,
	} as CSSProperties,
	valueInput: {
		...commonStyles.inputField,
		flex: 1,
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12,
	} as CSSProperties,
	iconBtn: {
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		color: 'var(--rr-text-secondary)',
		fontSize: 14,
		padding: '4px 6px',
		borderRadius: 4,
	} as CSSProperties,
	addRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '8px 0',
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

/** Props for the EnvironmentPanel component. */
export interface EnvironmentPanelProps {
	/** Whether the user has org admin permissions. */
	isOrgAdmin: boolean;
	/** Whether the user has team admin permissions on their active team. */
	isTeamAdmin: boolean;
	/** Org env dict (null while loading, empty object if none set). */
	orgEnv: Record<string, string>;
	/** Team env dict (null while loading or no active team). */
	teamEnv: Record<string, string>;
	/** User env dict (null while loading). */
	userEnv: Record<string, string>;
	/** Saves the full org env dict. */
	onSaveOrgEnv: (env: Record<string, string>) => Promise<void>;
	/** Saves the full team env dict. */
	onSaveTeamEnv: (env: Record<string, string>) => Promise<void>;
	/** Saves the full user env dict. */
	onSaveUserEnv: (env: Record<string, string>) => Promise<void>;
}

// =============================================================================
// ENV SCOPE CARD
// =============================================================================

/**
 * Renders a single scope's environment variables as an editable card.
 * Loads the dict on mount, edits locally, saves on button click.
 */
export const EnvScopeCard: React.FC<{
	/** Scope label (e.g. "Organization", "Team", "User"). */
	label: string;
	/** Current env dict. `undefined` = not yet loaded (shows loading state). */
	env: Record<string, string> | undefined;
	/**
	 * Called on mount to request the parent to load this scope's env data.
	 * The parent fetches the data and sets the `env` prop, which triggers
	 * a re-render with the loaded values.
	 */
	onRequestLoad?: () => void;
	/** Saves the full dict. */
	onSave: (env: Record<string, string>) => Promise<void>;
	/** Keys that must have non-empty values before save is allowed. */
	requiredKeys?: string[];
}> = ({ label, env, onRequestLoad, onSave, requiredKeys }) => {
	// Local draft state — clone from prop on load
	const [draft, setDraft] = useState<[string, string][]>([]);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());

	// Request data load on mount — the parent will set the env prop
	// when the data arrives, triggering the sync effect below
	useEffect(() => {
		if (env === undefined && onRequestLoad) onRequestLoad();
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	// Sync draft from prop when env changes externally (including initial load)
	useEffect(() => {
		if (env === undefined) return; // Not yet loaded — keep current draft
		setDraft(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
		setDirty(false);
	}, [env]);

	/** Updates a key or value at a given index. */
	const updateEntry = useCallback((idx: number, field: 'key' | 'value', val: string) => {
		setDraft((prev) => prev.map((entry, i) => (i === idx ? (field === 'key' ? [val, entry[1]] : [entry[0], val]) : entry)));
		setDirty(true);
		setSaved(false);
	}, []);

	/** Removes an entry by index. */
	const removeEntry = useCallback((idx: number) => {
		setDraft((prev) => prev.filter((_, i) => i !== idx));
		setDirty(true);
		setSaved(false);
	}, []);

	/** Adds a new empty entry. */
	const addEntry = useCallback(() => {
		setDraft((prev) => [...prev, ['ROCKETRIDE_', '']]);
		setDirty(true);
		setSaved(false);
	}, []);

	/** Toggles reveal for a key's value. */
	const toggleReveal = useCallback((key: string) => {
		setRevealedKeys((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	// Check if any required keys still have empty values
	const hasUnfilledRequired = useMemo(() => {
		if (!requiredKeys?.length) return false;
		const draftMap = new Map(draft.map(([k, v]) => [k.trim(), v.trim()]));
		return requiredKeys.some((key) => (draftMap.get(key) ?? '').length === 0);
	}, [requiredKeys, draft]);

	/** Saves the draft as a dict. */
	const handleSave = useCallback(async () => {
		setSaving(true);
		setError(null);
		try {
			// Build dict, skip empty keys
			const result: Record<string, string> = {};
			for (const [k, v] of draft) {
				const key = k.trim();
				if (key) result[key] = v;
			}
			await onSave(result);
			setDirty(false);
			setSaved(true);
			setTimeout(() => setSaved(false), 5000);
		} catch (err: any) {
			setError(err.message ?? String(err));
		} finally {
			setSaving(false);
		}
	}, [draft, onSave]);

	return (
		<div style={{ ...commonStyles.card, marginBottom: 14 }}>
			<div style={{ ...commonStyles.cardHeader, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
				<span style={commonStyles.labelUppercase}>{label} Variables</span>
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					{error && <span style={{ fontSize: 11, color: 'var(--rr-color-error)' }}>{error}</span>}
					{saved && <span style={{ fontSize: 11, color: 'var(--rr-color-success)' }}>Saved</span>}
					{dirty && (
						<>
							<button
								onClick={() => {
									setDraft(env ? Object.entries(env).sort(([a], [b]) => a.localeCompare(b)) : []);
									setDirty(false);
									setError(null);
								}}
								disabled={saving}
								style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardHeaderButton } as CSSProperties}
							>
								Cancel
							</button>
							<button
								onClick={handleSave}
								disabled={saving || hasUnfilledRequired}
								style={
									{
										...commonStyles.buttonPrimary,
										...commonStyles.cardHeaderButton,
										...(saving || hasUnfilledRequired ? commonStyles.buttonDisabled : {}),
									} as CSSProperties
								}
								title={hasUnfilledRequired ? 'Fill in all required variable values before saving' : undefined}
							>
								{saving ? 'Saving…' : 'Save'}
							</button>
						</>
					)}
				</div>
			</div>
			<div style={{ padding: '8px 18px 12px' }}>
				{/* Loading state — env hasn't arrived from the server yet */}
				{env === undefined ? (
					<div style={{ padding: '8px 0', fontSize: 12, color: 'var(--rr-text-disabled)' }}>Loading...</div>
				) : (
					<>
						{/* Existing entries */}
						{draft.map(([key, value], idx) => (
							<div key={idx} style={styles.row}>
								<input value={key} onChange={(e) => updateEntry(idx, 'key', e.target.value)} placeholder="ROCKETRIDE_KEY_NAME" style={styles.keyInput as CSSProperties} />
								<input type={revealedKeys.has(key) ? 'text' : 'password'} value={value} onChange={(e) => updateEntry(idx, 'value', e.target.value)} placeholder="••••••••" style={styles.valueInput as CSSProperties} />
								<button onClick={() => toggleReveal(key)} style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton } as CSSProperties}>
									{revealedKeys.has(key) ? 'Hide' : 'Show'}
								</button>
								<button onClick={() => removeEntry(idx)} style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton } as CSSProperties}>
									Delete
								</button>
							</div>
						))}

						{/* Add button */}
						<div style={styles.addRow}>
							<button onClick={addEntry} style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton } as CSSProperties}>
								+ Add Variable
							</button>
						</div>

						{/* Empty state */}
						{draft.length === 0 && <div style={{ padding: '8px 0', fontSize: 12, color: 'var(--rr-text-disabled)' }}>No environment variables set at this level.</div>}
					</>
				)}
			</div>
		</div>
	);
};

// =============================================================================
// ENVIRONMENT PANEL
// =============================================================================

/**
 * Renders environment variable cards for each scope the user has access to.
 * Placed within the Profile tab of AccountView.
 */
export const EnvironmentPanel: React.FC<EnvironmentPanelProps> = ({ isOrgAdmin, isTeamAdmin, orgEnv, teamEnv, userEnv, onSaveOrgEnv, onSaveTeamEnv, onSaveUserEnv }) => (
	<section>
		{/* Organization scope — only visible to org admins */}
		{isOrgAdmin && <EnvScopeCard label="Organization" env={orgEnv} onSave={onSaveOrgEnv} />}

		{/* Team scope — only visible to team admins */}
		{isTeamAdmin && <EnvScopeCard label="Team" env={teamEnv} onSave={onSaveTeamEnv} />}

		{/* User scope — always visible */}
		<EnvScopeCard label="User" env={userEnv} onSave={onSaveUserEnv} />
	</section>
);
