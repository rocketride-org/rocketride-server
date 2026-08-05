import React, { useEffect, useRef } from 'react';
import { commonStyles } from 'shared/themes/styles';

// =============================================================================
// TYPES
// =============================================================================

export interface ConfirmDialogProps {
	title: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	secondaryLabel?: string;
	onConfirm: () => void;
	onCancel: () => void;
	onSecondary?: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
	title: dialogTitle,
	message,
	confirmLabel = 'Save',
	cancelLabel = 'Cancel',
	secondaryLabel,
	onConfirm,
	onCancel,
	onSecondary,
}) => {
	const confirmRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		confirmRef.current?.focus();
		const handler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onCancel();
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, [onCancel]);

	return (
		/* Backdrop is inert: dismissal is deliberate-only (✕ / Cancel / Escape)
		   per the 2026-07-08 design decision — clicking outside must NOT close. */
		<div style={commonStyles.modalOverlay}>
			<div
				// Modal dialog semantics so assistive tech announces it as such.
				role="dialog"
				aria-modal="true"
				aria-label={dialogTitle}
				style={{ ...commonStyles.dialog, padding: '20px 24px', minWidth: 320, maxWidth: 420 }}
			>
				{/* No top-right ✕: this dialog dismisses via its Cancel button (and
				    Escape). Refined popup policy 2026-07-08 — no redundant ✕ when an
				    explicit dismiss control already exists. */}
				<div style={{ fontSize: 'var(--rr-font-size-h2)', fontWeight: 600, color: 'var(--rr-text-primary)', marginBottom: 8 }}>
					{dialogTitle}
				</div>
				<div style={{ fontSize: 'var(--rr-font-size-widget)', color: 'var(--rr-text-secondary)', lineHeight: 1.5, marginBottom: 16 }}>
					{message}
				</div>
				<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
					<button style={commonStyles.buttonSecondary} onClick={onCancel}>{cancelLabel}</button>
					{secondaryLabel && onSecondary && (
						<button style={{ ...commonStyles.buttonSecondary, color: 'var(--rr-text-primary)', fontWeight: 500 }} onClick={onSecondary}>
							{secondaryLabel}
						</button>
					)}
					<button ref={confirmRef} style={{ ...commonStyles.buttonPrimary, fontWeight: 600 }} onClick={onConfirm}>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
};

export default ConfirmDialog;
