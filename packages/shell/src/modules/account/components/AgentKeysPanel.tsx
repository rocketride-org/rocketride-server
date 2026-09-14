// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AgentKeysPanel — the Agent Keys tab within AccountView.
 *
 * Lets the user bring their own inference key (Anthropic / OpenAI) for the
 * OpenCode Canvas Agent. Write-only UX: a pasted key is validated
 * server-side (one models-list call) and stored encrypted — it is NEVER
 * redisplayed, NEVER logged, and never lingers in component state past the
 * in-flight `onSetKey` call. The server only ever hands back a masked
 * status row (`provider` + `last4`), which is all this component holds
 * once a key is stored.
 *
 * One row per known provider:
 *  - stored   -> a masked chip (`•••• {last4}`) + a `danger` Remove button
 *                behind a ConfirmDialog
 *  - empty    -> a password-type paste field + a `primary` "Validate &
 *                Save" button, disabled while busy or empty
 *
 * A rejected save surfaces an inline, per-row Banner with copy specific to
 * the server's failure reason (`invalid_key` vs `provider_unreachable`);
 * the draft is always cleared in a `finally`, whether the save succeeded
 * or failed, so the pasted key never lingers.
 */

import React, { useState } from 'react';
import type { CSSProperties } from 'react';
import { Card } from '../../../components/card/Card';
import { Button } from '../../../components/button/Button';
import { Banner } from '../../../components/banner/Banner';
import { ConfirmDialog } from '../../../components/modal/ConfirmDialog';
import { Section } from '../../../components/section/Section';
import { commonStyles } from '../../../themes/styles';
import type { AgentKeyProvider, AgentKeyStatus } from '../types';
import { Badge, S } from './shared';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Horizontal padding matching the row list's own edge-to-edge rows. */
	about: {
		padding: '14px 18px 0',
	} as CSSProperties,

	/** Masked stored-key chip (`•••• {last4}`). */
	chip: {
		display: 'inline-flex',
		alignItems: 'center',
		padding: '3px 10px',
		borderRadius: 12,
		fontSize: 12,
		fontFamily: 'var(--rr-font-mono, monospace)',
		color: 'var(--rr-text-secondary)',
		background: 'var(--rr-bg-surface-alt)',
		border: '1px solid var(--rr-border)',
	} as CSSProperties,

	/** Paste field for the empty state — capped width so it doesn't stretch the row. */
	input: {
		...commonStyles.inputField,
		flex: 1,
		maxWidth: 320,
	} as CSSProperties,

	/** Wrapper for a row's inline error Banner, indented to match the row's own padding. */
	rowError: {
		padding: '0 18px 10px',
	} as CSSProperties,

	/** Wrapper for the panel-level error Banner (load failures). */
	panelError: {
		marginBottom: 12,
	} as CSSProperties,
};

// =============================================================================
// PROVIDERS
// =============================================================================

/** Known BYO inference providers, in display order. */
const PROVIDERS: { id: AgentKeyProvider; label: string; placeholder: string }[] = [
	{ id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…' },
	{ id: 'openai', label: 'OpenAI', placeholder: 'sk-…' },
];

/**
 * Translates a thrown DAP error message into the copy shown inline on a
 * rejected save. The server's message is a full sentence carrying a
 * parenthesized machine token — e.g. "The provided key was rejected
 * (invalid_key)" — so this matches by substring, not exact equality.
 *
 * Exported for direct unit testing (see AgentKeysPanel.test.tsx) — the
 * repo's `renderToStaticMarkup` idiom can't exercise the async
 * onSetKey-rejection → row-error state transition, so this pure mapping is
 * pinned on its own rather than through a simulated interaction.
 */
export function saveErrorMessage(raw: string): string {
	if (raw.includes('invalid_key')) return 'key rejected by provider';
	if (raw.includes('provider_unreachable')) return "couldn't reach provider — key NOT saved, try again";
	return raw;
}

// =============================================================================
// PROPS
// =============================================================================

/** Props accepted by the AgentKeysPanel component. */
export interface AgentKeysPanelProps {
	/** Masked server truth — provider + last4 only; never key material. */
	status: AgentKeyStatus[];
	/** True while a set/clear request is in flight (host-controlled). */
	busy: boolean;
	/** Panel-level error, e.g. a failed status load. */
	error?: string;
	/** Validates and stores a key for the given provider. */
	onSetKey: (provider: AgentKeyProvider, key: string) => Promise<void>;
	/** Removes the stored key for the given provider. */
	onClearKey: (provider: AgentKeyProvider) => Promise<void>;
}

// =============================================================================
// AGENT KEYS PANEL
// =============================================================================

/**
 * The Agent Keys tab: one row per known provider, each independently in
 * stored (masked chip + Remove) or empty (paste + Validate & Save) state.
 */
export const AgentKeysPanel: React.FC<AgentKeysPanelProps> = ({ status, busy, error, onSetKey, onClearKey }) => {
	// Per-provider pasted draft — lives ONLY while the field is focused / the
	// save is in flight; always cleared in the save handler's `finally`.
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	// Per-provider inline error from the last rejected save/clear, keyed by provider.
	const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
	// Provider pending a Remove confirmation, or null.
	const [confirmClear, setConfirmClear] = useState<AgentKeyProvider | null>(null);

	/** Updates a provider's draft and clears any stale row error as the user retypes. */
	const updateDraft = (provider: AgentKeyProvider, value: string): void => {
		setDrafts((prev) => ({ ...prev, [provider]: value }));
		setRowErrors((prev) => (prev[provider] ? { ...prev, [provider]: '' } : prev));
	};

	/** Validates + saves the draft for a provider; the draft never survives the call. */
	const handleSave = async (provider: AgentKeyProvider): Promise<void> => {
		const key = (drafts[provider] ?? '').trim();
		if (!key) return;
		setRowErrors((prev) => ({ ...prev, [provider]: '' }));
		try {
			await onSetKey(provider, key);
		} catch (e) {
			setRowErrors((prev) => ({ ...prev, [provider]: saveErrorMessage(e instanceof Error ? e.message : String(e)) }));
		} finally {
			// The pasted key must not linger in component state, success or not.
			setDrafts((prev) => ({ ...prev, [provider]: '' }));
		}
	};

	/** Removes the confirmed provider's key; the confirm gate always closes. */
	const handleClearConfirmed = async (): Promise<void> => {
		const provider = confirmClear;
		if (!provider) return;
		try {
			await onClearKey(provider);
			setRowErrors((prev) => ({ ...prev, [provider]: '' }));
		} catch (e) {
			setRowErrors((prev) => ({ ...prev, [provider]: e instanceof Error ? e.message : String(e) }));
		} finally {
			setConfirmClear(null);
		}
	};

	return (
		<section>
			{error && (
				<div style={styles.panelError}>
					<Banner variant="error">{error}</Banner>
				</div>
			)}

			<Card noBodyPadding>
				<div style={styles.about}>
					<Section label="About">
						<p style={commonStyles.textMuted}>Keys are validated with one models-list call, stored encrypted, and only ever shown masked.</p>
					</Section>
				</div>

				<div style={S.rowList}>
					{PROVIDERS.map(({ id, label, placeholder }) => {
						const stored = status.find((s) => s.provider === id);
						const draft = drafts[id] ?? '';
						const rowError = rowErrors[id];
						return (
							<React.Fragment key={id}>
								<div style={S.rowItem}>
									<Badge variant="member">{label}</Badge>
									<div style={S.rowInfo}>
										{stored ? (
											<span style={styles.chip}>{`•••• ${stored.last4}`}</span>
										) : (
											<input
												type="password"
												autoComplete="off"
												value={draft}
												placeholder={placeholder}
												onChange={(e) => updateDraft(id, e.target.value)}
												style={styles.input}
											/>
										)}
									</div>
									{stored ? (
										<Button variant="danger" small disabled={busy} onClick={() => setConfirmClear(id)}>
											Remove
										</Button>
									) : (
										<Button variant="primary" small disabled={busy || !draft} onClick={() => void handleSave(id)}>
											{busy ? 'Validating…' : 'Validate & Save'}
										</Button>
									)}
								</div>
								{rowError && (
									<div style={styles.rowError}>
										<Banner variant="error">{rowError}</Banner>
									</div>
								)}
							</React.Fragment>
						);
					})}
				</div>
			</Card>

			{confirmClear && (
				<ConfirmDialog
					title="Remove Agent Key"
					destructive
					confirmLabel={busy ? 'Removing…' : 'Remove'}
					confirmDisabled={busy}
					message={
						<>
							Remove the stored {PROVIDERS.find((p) => p.id === confirmClear)?.label} key? Any in-progress agent runs using it will lose access immediately.
						</>
					}
					onConfirm={() => void handleClearConfirmed()}
					onCancel={() => setConfirmClear(null)}
				/>
			)}
		</section>
	);
};
