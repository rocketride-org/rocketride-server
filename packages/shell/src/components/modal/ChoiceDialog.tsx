// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ChoiceDialog — the general N-action dialog, built on {@link Modal}.
 *
 * Where {@link ConfirmDialog} answers one question ("yes or no"), this
 * answers "which of these". The difference matters wherever a dismissal is
 * not the same fact as a refusal: closing a dirty document offers Save /
 * Discard / Cancel, and collapsing that to a boolean is what made the
 * tab-close path discard unsaved work silently.
 *
 * Options render left-to-right in declaration order, so the LAST one is the
 * rightmost — put the affirmative action there (`primary`) and it takes the
 * primary style and the initial focus, matching every platform dialog and
 * ConfirmDialog's own footer. Escape and the corner dismiss resolve through
 * `onCancel`, never through an option: a dialog must never be able to pick
 * a destructive answer on the user's behalf.
 *
 */

import React, { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Modal } from './Modal';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// TYPES
// =============================================================================

/** One selectable action in a {@link ChoiceDialog}. */
export interface IChoiceOption {
	/** Stable id resolved to the caller when this action is chosen. */
	id: string;
	/** Button label. */
	label: string;
	/** Render in the danger style (irreversible: discard, delete). */
	destructive?: boolean;
	/** Render as the affirmative action (primary style + initial focus). */
	primary?: boolean;
	/** Disable the button (e.g. an action unavailable in this state). */
	disabled?: boolean;
}

/** Props for the {@link ChoiceDialog} component. */
export interface IChoiceDialogProps {
	/** Dialog title. */
	title: string;
	/** Body message — a plain string or a custom node. */
	message: ReactNode;
	/** The actions, in left-to-right render order. */
	options: readonly IChoiceOption[];
	/** Fired with the chosen option's id. */
	onChoose: (id: string) => void;
	/** Fired on Escape, the corner ✕, or a dismiss that chose nothing. */
	onCancel: () => void;
	/** Box width in px (defaults to the modal default). */
	width?: number;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a dialog with any number of actions.
 *
 * @param props - {@link IChoiceDialogProps}.
 * @returns The dialog element.
 */
export function ChoiceDialog({ title, message, options, onChoose, onCancel, width }: IChoiceDialogProps): React.ReactElement {
	// Auto-focus the affirmative action (or the last one) on open, matching
	// native dialog behavior and ConfirmDialog.
	const focusRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		focusRef.current?.focus();
	}, []);

	const focusIdx = (() => {
		const primary = options.findIndex((o) => o.primary && !o.disabled);
		if (primary !== -1) return primary;
		for (let i = options.length - 1; i >= 0; i--) if (!options[i]!.disabled) return i;
		return -1;
	})();

	/** One option's button style. */
	const styleFor = (o: IChoiceOption): CSSProperties => ({
		...(o.destructive ? commonStyles.buttonDanger : o.primary ? commonStyles.buttonPrimary : commonStyles.buttonSecondary),
		...(o.primary ? { fontWeight: 600 } : null),
		...(o.disabled ? { opacity: 0.5, cursor: 'default' } : null),
	});

	return (
		<Modal
			title={title}
			onClose={onCancel}
			{...(width !== undefined ? { width } : {})}
			footer={
				<>
					{options.map((o, i) => (
						<button
							key={o.id}
							type="button"
							{...(i === focusIdx ? { ref: focusRef } : {})}
							style={styleFor(o)}
							onClick={() => onChoose(o.id)}
							disabled={o.disabled}
						>
							{o.label}
						</button>
					))}
				</>
			}
		>
			<div style={{ fontSize: 13, color: 'var(--rr-text-secondary)', lineHeight: 1.5 }}>{message}</div>
		</Modal>
	);
}
