// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ConfirmDialog — the stock confirm/cancel dialog, built on {@link Modal}.
 *
 * A titled message with a Cancel button and a primary confirm button (plus an
 * optional third "secondary" action). Because it always carries a Cancel button,
 * it shows no top-right ✕ (the refined popup policy: no redundant close when an
 * explicit dismiss control exists). The confirm button auto-focuses; Escape and
 * Cancel both dismiss. Set `destructive` to render the confirm button in the
 * danger style for irreversible actions.
 *
 */

import React, { CSSProperties, ReactNode, useRef, useEffect } from 'react';
import { commonStyles } from '../../themes/styles';
import { Modal } from './Modal';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link ConfirmDialog} component. */
export interface IConfirmDialogProps {
	/** Dialog title. */
	title: string;
	/** Body message — a plain string or a custom node. */
	message: ReactNode;
	/** Primary confirm button label. Default "Save". */
	confirmLabel?: string;
	/** Cancel button label. Default "Cancel". */
	cancelLabel?: string;
	/** Optional third action button label (rendered between Cancel and confirm). */
	secondaryLabel?: string;
	/** Fired when the primary action is confirmed. */
	onConfirm: () => void;
	/** Fired when the dialog is cancelled (Cancel button or Escape). */
	onCancel: () => void;
	/** Fired when the optional secondary action is chosen. */
	onSecondary?: () => void;
	/** Render the confirm button in the danger style (irreversible actions). */
	destructive?: boolean;
	/** Disable the confirm button (e.g. while a required field is empty). */
	confirmDisabled?: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a confirm/cancel dialog.
 *
 * @param props - {@link IConfirmDialogProps}.
 * @returns The confirm dialog element.
 */
export function ConfirmDialog({ title, message, confirmLabel = 'Save', cancelLabel = 'Cancel', secondaryLabel, onConfirm, onCancel, onSecondary, destructive, confirmDisabled }: IConfirmDialogProps): React.ReactElement {
	// Auto-focus the confirm button on open, matching native dialog behavior.
	const confirmRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		confirmRef.current?.focus();
	}, []);

	// Confirm button style: danger for destructive actions, primary otherwise;
	// dimmed and non-interactive while disabled.
	const confirmStyle: CSSProperties = {
		...(destructive ? commonStyles.buttonDanger : commonStyles.buttonPrimary),
		fontWeight: 600,
		...(confirmDisabled ? { opacity: 0.5, cursor: 'default' } : null),
	};

	return (
		<Modal
			title={title}
			onClose={onCancel}
			footer={
				<>
					<button type="button" style={commonStyles.buttonSecondary} onClick={onCancel}>
						{cancelLabel}
					</button>
					{secondaryLabel && onSecondary && (
						<button type="button" style={commonStyles.buttonSecondary} onClick={onSecondary}>
							{secondaryLabel}
						</button>
					)}
					<button type="button" ref={confirmRef} style={confirmStyle} onClick={onConfirm} disabled={confirmDisabled}>
						{confirmLabel}
					</button>
				</>
			}
		>
			<div style={{ fontSize: 13, color: 'var(--rr-text-secondary)', lineHeight: 1.5 }}>{message}</div>
		</Modal>
	);
}
