// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * TtlSettingsDialog — Pipeline Settings modal for the idle-timeout (TTL).
 *
 * Opened from the canvas toolbar's settings (cog) button. Offers preset
 * durations plus a custom integer minutes input. The chosen value is
 * returned in seconds; `undefined` means "use the server default" and
 * `0` means "no timeout".
 */

import React, { useState, useRef, useEffect, useCallback, CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// TYPES
// =============================================================================

interface ITtlSettingsDialogProps {
	/** Current idle-timeout in seconds. undefined = server default; 0 = no timeout. */
	ttlSeconds: number | undefined;
	onConfirm: (ttlSeconds: number | undefined) => void;
	onCancel: () => void;
}

// =============================================================================
// PRESETS
// =============================================================================

// Idle-timeout presets for the run control. `undefined` = server default; the
// engine treats 0 as "no timeout".
export const TTL_PRESETS: { label: string; value: number | undefined }[] = [
	{ label: 'Default (15 min)', value: undefined },
	{ label: '30 min', value: 30 * 60 },
	{ label: '1 hour', value: 60 * 60 },
	{ label: '2 hours', value: 2 * 60 * 60 },
	{ label: 'No timeout', value: 0 },
];

const CUSTOM_OPTION = 'custom';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	dialog: {
		...commonStyles.dialog,
		width: 360,
		display: 'flex', flexDirection: 'column',
		overflow: 'hidden',
	} as CSSProperties,
	header: {
		padding: '16px 20px 12px',
		borderBottom: '1px solid var(--rr-border)',
		fontSize: 15, fontWeight: 600, color: 'var(--rr-text-primary)',
	} as CSSProperties,
	body: {
		padding: '16px 20px',
		display: 'flex', flexDirection: 'column', gap: 8,
	} as CSSProperties,
	label: {
		fontSize: 13, color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	select: {
		...commonStyles.inputField,
		width: '100%',
	} as CSSProperties,
	customRow: {
		display: 'flex', alignItems: 'center', gap: 8,
	} as CSSProperties,
	customInput: {
		...commonStyles.inputField,
		width: 120,
	} as CSSProperties,
	hint: {
		fontSize: 12, color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	footer: {
		padding: '12px 20px',
		borderTop: '1px solid var(--rr-border)',
		display: 'flex', justifyContent: 'flex-end', gap: 8,
	} as CSSProperties,
	cancelBtn: commonStyles.buttonSecondary,
	applyBtn: (enabled: boolean): CSSProperties => ({
		...commonStyles.buttonPrimary,
		fontWeight: 600,
		...(enabled ? {} : commonStyles.buttonDisabled),
	}),
};

// =============================================================================
// COMPONENT
// =============================================================================

const TtlSettingsDialog: React.FC<ITtlSettingsDialogProps> = ({ ttlSeconds, onConfirm, onCancel }) => {
	// Track the preset index locally so `undefined` (server default) round-trips —
	// a <select> value attribute can't hold undefined. A non-preset ttl (set via
	// the custom input) selects the "Custom…" option instead.
	const [selected, setSelected] = useState<string>(() => {
		const idx = TTL_PRESETS.findIndex((p) => p.value === ttlSeconds);
		return idx === -1 ? CUSTOM_OPTION : String(idx);
	});
	const [customMinutes, setCustomMinutes] = useState<string>(() =>
		ttlSeconds !== undefined && TTL_PRESETS.every((p) => p.value !== ttlSeconds) ? String(Math.round(ttlSeconds / 60)) : ''
	);
	const selectRef = useRef<HTMLSelectElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	// Capture the opener synchronously during the initial render — before any
	// effect or the custom input's autoFocus can move focus into the dialog.
	const openerRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);

	const isCustom = selected === CUSTOM_OPTION;

	// Focus the select on open — unless the custom input is showing (it autofocuses).
	useEffect(() => { if (!isCustom) selectRef.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

	// Restore focus to the element that opened the dialog when it closes.
	useEffect(() => {
		return () => { openerRef.current?.focus?.(); };
	}, []);

	// Close on Escape and trap Tab focus inside the dialog while it is open.
	const handleTrapKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'Escape') { onCancel(); return; }
		if (e.key !== 'Tab') return;
		const root = dialogRef.current;
		if (!root) return;
		const focusables = root.querySelectorAll<HTMLElement>('select:not([disabled]), input:not([disabled]), button:not([disabled])');
		if (!focusables.length) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}, [onCancel]);

	const parsedMinutes = Number(customMinutes);
	const customValid = customMinutes.trim() !== '' && Number.isInteger(parsedMinutes) && parsedMinutes >= 1;
	const canConfirm = !isCustom || customValid;

	const handleConfirm = useCallback(() => {
		if (isCustom) {
			if (!customValid) return;
			onConfirm(parsedMinutes * 60);
			return;
		}
		onConfirm(TTL_PRESETS[Number(selected)]?.value);
	}, [isCustom, customValid, parsedMinutes, selected, onConfirm]);

	return createPortal(
		<div style={commonStyles.modalOverlay} onClick={onCancel}>
			<div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Pipeline Settings" style={styles.dialog} onClick={(e) => e.stopPropagation()} onKeyDown={handleTrapKeyDown}>

				<div style={styles.header}>Pipeline Settings</div>

				<div style={styles.body}>
					<label htmlFor="pipeline-ttl" style={styles.label}>Idle timeout</label>
					<select
						ref={selectRef}
						id="pipeline-ttl"
						style={styles.select}
						value={selected}
						onChange={(e) => setSelected(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') handleConfirm();
						}}
					>
						{TTL_PRESETS.map((p, i) => (
							<option key={p.label} value={String(i)}>
								{p.label}
							</option>
						))}
						<option value={CUSTOM_OPTION}>Custom…</option>
					</select>
					{isCustom && (
						<div style={styles.customRow}>
							<input
								type="number"
								min={1}
								step={1}
								autoFocus
								style={styles.customInput}
								value={customMinutes}
								onChange={(e) => setCustomMinutes(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter') handleConfirm();
								}}
								placeholder="Minutes"
							/>
							<span style={styles.hint}>minutes</span>
						</div>
					)}
					<span style={styles.hint}>Stops the pipeline after this long without activity. Applies to the next run.</span>
				</div>

				<div style={styles.footer}>
					<button style={styles.cancelBtn} onClick={onCancel}>Cancel</button>
					<button style={styles.applyBtn(canConfirm)} disabled={!canConfirm} onClick={handleConfirm}>Apply</button>
				</div>
			</div>
		</div>,
		document.body
	);
};

export default TtlSettingsDialog;
